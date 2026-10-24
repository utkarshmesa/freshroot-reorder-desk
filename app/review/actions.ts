"use server";
// Review desk actions. Decisions and re-approval go through RPCs with the user's own client (role checked in
// the database too). Send runs server-side with the service role after the planner check here, because the
// Zoho writer isn't covered by RLS (ARCHITECTURE §3.2).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireAction } from "@/lib/auth/me";
import { caseDataMode, serviceClient, userClient } from "@/lib/db/server";
import { startFileMode } from "@/lib/filemode/server";
import { processRun } from "@/lib/run/worker";
import { parseFile } from "@/lib/upload/parse";
import { sendToProcurement } from "@/lib/send/send";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function back(kind: "saved" | "error", message: string, anchor = ""): never {
  redirect(`/review?${kind}=${encodeURIComponent(message)}${anchor}`);
}

export async function decide(form: FormData) {
  await requireAction("review.decide");
  const id = Number(str(form, "id"));
  const op = str(form, "op");
  const qty = str(form, "qty") === "" ? null : Number(str(form, "qty"));
  const { data, error } = await (await userClient()).rpc("decide_line", {
    p_rec_id: id,
    p_action: op,
    p_final_qty: op === "change" ? qty : null,
    p_reason_code: str(form, "reason") || null,
    p_note: str(form, "note") || null,
  });
  if (error) back("error", error.message, `#card-${id}`);
  revalidatePath("/review");
  const d = data as { state: string; final_qty: number };
  back("saved", d.state === "rejected" ? "Card rejected." : `Card ${d.state} at ${d.final_qty.toLocaleString("en-IN")} units.`);
}

export async function send(form: FormData) {
  await requireAction("review.decide");
  const runId = str(form, "run");
  let message: string;
  let failed = false;
  try {
    const r = await sendToProcurement(serviceClient(), runId);
    message = [
      r.sent.length ? `${r.mode === "shadow" ? "Recorded (shadow mode, nothing sent to Zoho)" : r.mode === "file" ? "PO sheet ready (Zoho failsafe)" : "Draft created in Zoho"} for ${r.sent.map((s) => s.supplierId).join(", ")}.` : "No supplier was ready to send.",
      r.alreadySent.length ? `Already sent this week (unchanged): ${r.alreadySent.join(", ")}.` : "",
      r.waiting.length ? `Waiting on cards: ${r.waiting.map((w) => `${w.supplierId} (${w.queued})`).join(", ")}.` : "",
      r.skippedPending.length ? `Held by an unissued earlier draft: ${r.skippedPending.join(", ")}.` : "",
      r.held.length ? `Lines held because a PO changed in Zoho since Monday: ${r.held.flatMap((h) => h.skuIds).join(", ")}.` : "",
      r.unconfirmed.length ? `Requested earlier but not yet visible in Zoho (won't be created twice; IT alerted): ${r.unconfirmed.join(", ")}.` : "",
      r.noSupplier.length ? `No supplier or Zoho mapping: ${r.noSupplier.join(", ")}.` : "",
      r.stopped ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    failed = Boolean(r.stopped);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
    failed = true;
  }
  revalidatePath("/review");
  back(failed ? "error" : "saved", message);
}

export async function reapprove(form: FormData) {
  await requireAction("review.decide");
  const { error } = await (await userClient()).rpc("reapprove_draft", { p_draft_id: str(form, "draft"), p_note: str(form, "note") || null });
  if (error) back("error", error.message);
  revalidatePath("/review");
  back("saved", "Draft re-approved: procurement can issue it.");
}

/** Admin: restart a blocked run after fixing its cause (RUNBOOK). A run blocked before the queue existed starts over. */
export async function retryRun(form: FormData) {
  await requireAction("run.retry");
  const runId = str(form, "run");
  const { data, error } = await (await userClient()).rpc("retry_run", { p_run_id: runId, p_reason: str(form, "reason") });
  if (error) back("error", error.message);
  if (data === "queued") {
    after(async () => {
      await processRun(serviceClient(), runId, { caseDataMode: caseDataMode() }).catch((e) => console.error(`run ${runId} failed; the cron will retry`, e));
    });
  }
  revalidatePath("/review");
  back("saved", data === "queued" ? "Run restarted from the beginning. Reload in a minute." : "Run unblocked; the queue and decisions are as they were.");
}

/** C-039 Zoho failsafe: Deepa runs this week from the open-PO file procurement gave her. */
export async function runFromFiles(form: FormData) {
  const session = await requireAction("owner.setMode");
  const runId = str(form, "run");
  const openPos = form.get("open_pos");
  const receipts = form.get("receipts");
  if (!(openPos instanceof File) || openPos.size === 0) back("error", "Choose the open-PO file.");
  const parse = async (f: File) => parseFile(f.name, new Uint8Array(await f.arrayBuffer()));
  const result = await startFileMode(await userClient(), {
    runId,
    openPos: await parse(openPos as File),
    receipts: receipts instanceof File && receipts.size > 0 ? await parse(receipts) : null,
    reason: str(form, "reason"),
    certified: form.get("certified") === "on",
    uploadedBy: session.name,
  });
  if (!result.ok) back("error", result.errors.slice(0, 5).join(" · "));
  after(async () => {
    await processRun(serviceClient(), runId, { caseDataMode: caseDataMode() }).catch((e) => console.error(`run ${runId} failed; the cron will retry`, e));
  });
  revalidatePath("/review");
  const s = result.ok ? result.summary : null;
  back("saved", `This week runs from the file: ${s?.openLines} open PO lines, ${s?.openUnits} units on order. ${result.ok ? result.warnings.join(" ") : ""} Reload in a minute for the queue.`);
}

/** C-039: procurement (or the planner) confirms a PO sheet was placed with the supplier. */
export async function confirmPlaced(form: FormData) {
  await requireAction("sheet.confirm");
  const { error } = await (await userClient()).rpc("confirm_placed", { p_draft_id: str(form, "draft") });
  if (error) back("error", error.message);
  revalidatePath("/review");
  back("saved", "Marked as placed.");
}
