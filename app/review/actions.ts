"use server";
// Review desk actions. Decisions and re-approval go through RPCs with the user's own client (role checked in
// the database too). Send runs server-side with the service role after the planner check here, because the
// Zoho writer isn't covered by RLS (ARCHITECTURE §3.2).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireAction } from "@/lib/auth/me";
import { caseDataMode, serviceClient, userClient } from "@/lib/db/server";
import { processRun } from "@/lib/run/worker";
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
      r.sent.length ? `${r.mode === "shadow" ? "Recorded (shadow mode, nothing sent to Zoho)" : "Draft created in Zoho"} for ${r.sent.map((s) => s.supplierId).join(", ")}.` : "No supplier was ready to send.",
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
