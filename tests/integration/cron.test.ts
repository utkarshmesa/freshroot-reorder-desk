// Crons through the database: TS-03 Tuesday 12:00 rule (D8) + send, C-024 late run, rejection alarm (TS-05),
// TS-04 stale draft re-approval (C-009), missed upload, alert delivery.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliverAlerts, noonJob, uploadCheck } from "@/lib/cron/jobs";
import { processRun } from "@/lib/run/worker";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { ZohoHttp } from "@/lib/zoho/http";
import { dbTokenSource } from "@/lib/zoho/token";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { as, resetData, service } from "./db";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const MON = new Date("2026-10-19T03:30:00Z");
const TUE_NOON = new Date("2026-10-20T06:30:00Z");
const WED_NOON = new Date("2026-10-21T06:30:00Z");
let z: FakeZoho;
const zoho = (db: Parameters<typeof dbTokenSource>[0], budget: number) =>
  new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: dbTokenSource(db, CFG, z.fetch), budget, sleep: async () => {} });
const noon = (now: Date) => noonJob(service(), now, { zoho, envMode: undefined, sleep: async () => {} });

async function newRun(readyAt = MON): Promise<string> {
  const { data, error } = await service().rpc("supersede_or_start_run", { p_week: "2026-W43", p_upload: null });
  if (error) throw new Error(error.message);
  const runId = (data as { run_id: string }).run_id;
  expect((await processRun(service(), runId, { caseDataMode: true, llm: null, now: readyAt })).status).toBe("done");
  return runId;
}
async function lines(runId: string) {
  const { data } = await service().from("recommendation").select("id, sku_id, qty, final_qty, line_state, flags, spot_check, cover, inputs").eq("run_id", runId).order("sku_id");
  return data ?? [];
}

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))),
  );
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  await commitUpload(client, staged.uploadId);
});

beforeEach(async () => {
  z = new FakeZoho();
  const svc = service();
  await svc.from("decision").delete().not("id", "is", null);
  await svc.from("draft_po").delete().not("id", "is", null);
  await svc.from("alert").delete().not("id", "is", null);
});

describe("TS-03 the Tuesday 12:00 rule", () => {
  it("does nothing before the deadline", async () => {
    await newRun();
    expect((await noon(MON)).applied).toEqual([]);
  });

  it("at the deadline: spot-checks keep their qty, non-perishable stockout risks get 1× std, the rest roll; then it sends", async () => {
    const runId = await newRun();
    const before = await lines(runId);
    const { client } = await as("raghav");
    const decidedByRaghav = before.find((l) => l.line_state === "queued" && !l.spot_check)!;
    await client.rpc("decide_line", { p_rec_id: decidedByRaghav.id, p_action: "approve" });

    const res = await noon(TUE_NOON);
    expect(res.applied).toHaveLength(1);
    expect(res.errors).toEqual([]);
    const after = Object.fromEntries((await lines(runId)).map((l) => [l.sku_id, l]));
    for (const l of before.filter((x) => x.line_state === "queued" && x.id !== decidedByRaghav.id)) {
      const a = after[l.sku_id]!;
      const i = l.inputs as { stdQty: number; moq: number; minEff: number };
      if (l.spot_check) expect(a, l.sku_id).toMatchObject({ line_state: "sent", final_qty: l.qty });
      else if (l.flags.includes("perishable")) expect(a, l.sku_id).toMatchObject({ line_state: "rolled", final_qty: 0 });
      else if (Number(l.cover) < i.minEff) expect(a, l.sku_id).toMatchObject({ line_state: "sent", final_qty: Math.max(i.stdQty, i.moq) });
      else expect(a.line_state, l.sku_id).toBe("rolled");
    }
    expect(after[decidedByRaghav.sku_id]!.line_state).toBe("sent"); // "approved, went home" still reaches procurement
    const { data: drafts } = await service().from("draft_po").select("mode").eq("run_id", runId);
    expect(drafts!.length).toBeGreaterThan(0);
    expect(drafts!.every((d) => d.mode === "shadow")).toBe(true);
    const { data: alert } = await service().from("alert").select("kind, payload").eq("dedupe_key", `deadline:${runId}`).single();
    expect(alert!.kind).toBe("deadline_applied");

    const again = await noon(TUE_NOON);
    expect(again.applied).toEqual([]); // applied once
    expect(again.resent).toEqual([runId]);
  });

  it("a click after the rule applied is refused", async () => {
    const runId = await newRun();
    await noon(TUE_NOON);
    const rolled = (await lines(runId)).find((l) => l.line_state === "rolled")!;
    const { client } = await as("raghav");
    expect((await client.rpc("decide_line", { p_rec_id: rolled.id, p_action: "approve" })).error?.message).toMatch(/Tuesday deadline/);
  });
});

describe("C-024 a run ready after the deadline", () => {
  it("alerts Deepa, and the rule waits for the next noon firing", async () => {
    const runId = await newRun(new Date("2026-10-20T07:00:00Z")); // Tue 12:30 IST
    const { data: late } = await service().from("alert").select("kind").eq("dedupe_key", `run_ready_late:${runId}`);
    expect(late).toEqual([{ kind: "run_ready_late" }]);
    expect((await noon(TUE_NOON)).applied).toEqual([]);
    expect((await noon(WED_NOON)).applied.map((a) => a.runId)).toEqual([runId]);
  });
});

describe("TS-05 rejection-rate alarm", () => {
  it("approving everything (0% rejected) raises the low alarm at the deadline", async () => {
    const runId = await newRun();
    const { client } = await as("raghav");
    for (const l of await lines(runId)) if (l.line_state === "queued") await client.rpc("decide_line", { p_rec_id: l.id, p_action: "approve" });
    await noon(TUE_NOON);
    const { data } = await service().from("alert").select("payload").eq("dedupe_key", `rejection_rate:${runId}`).single();
    expect(data!.payload).toMatchObject({ level: "low", ratePct: 0 });
  });
});

describe("TS-04 a draft older than 3 days needs re-approval (C-009)", () => {
  async function liveDraft(runId: string, poId: string, createdAt: string) {
    const { data } = await service()
      .from("draft_po")
      .insert({ run_id: runId, supplier_id: "DIST001", iso_week: "2026-W42", mode: "live", reference: `FR-2026-W42-DIST001-${poId}`, zoho_po_id: poId, status: "created", created_at: createdAt, requested_lines: [{ sku_id: "SKU001", item_id: "it-SKU001", qty: 240 }] })
      .select("id")
      .single();
    return data!.id as string;
  }

  it("still a draft in Zoho → flagged and alerted; issued since Monday → marked issued, not flagged", async () => {
    const runId = await newRun();
    const stale = await liveDraft(runId, "po-stale", "2026-10-16T06:00:00Z");
    z.addPo({ purchaseorder_id: "po-stale", status: "draft", line_items: [{ item_id: "it-SKU001", quantity: 240 }] });
    const res = await noon(TUE_NOON);
    expect(res.errors).toEqual([]);
    expect(res.stale).toEqual(["FR-2026-W42-DIST001-po-stale"]);
    const { data: d } = await service().from("draft_po").select("needs_reapproval").eq("id", stale).single();
    expect(d!.needs_reapproval).toBe(true);
    expect((await service().from("alert").select("kind").eq("dedupe_key", `draft_stale:${stale}`)).data).toEqual([{ kind: "draft_stale" }]);
    expect(z.writes()).toEqual([]);

    // Procurement can't re-approve; Raghav can, once.
    const { client: proc } = await as("procurement");
    expect((await proc.rpc("reapprove_draft", { p_draft_id: stale })).error?.message).toMatch(/Only the planner/);
    const { client } = await as("raghav");
    expect((await client.rpc("reapprove_draft", { p_draft_id: stale, p_note: "still needed" })).error).toBeNull();
    expect((await client.rpc("reapprove_draft", { p_draft_id: stale })).error?.message).toMatch(/doesn't need/);
    const { data: after } = await service().from("draft_po").select("needs_reapproval, reapproved_at").eq("id", stale).single();
    expect(after!.needs_reapproval).toBe(false);
    expect(after!.reapproved_at).not.toBeNull();
  });

  it("issued in Zoho since the last read → recorded as issued, no alert", async () => {
    const runId = await newRun();
    const id = await liveDraft(runId, "po-issued", "2026-10-16T06:00:00Z");
    z.addPo({ purchaseorder_id: "po-issued", status: "issued", line_items: [{ item_id: "it-SKU001", quantity: 240 }] });
    expect((await noon(TUE_NOON)).stale).toEqual([]);
    const { data } = await service().from("draft_po").select("status, needs_reapproval, issued_at").eq("id", id).single();
    expect(data).toMatchObject({ status: "issued", needs_reapproval: false });
    expect(data!.issued_at).not.toBeNull();
  });
});

describe("missed upload (Mon 10:00 IST)", () => {
  it("alerts once when nothing was committed this week", async () => {
    const nextMonday = new Date("2026-11-02T04:30:00Z");
    expect(await uploadCheck(service(), nextMonday)).toBe(true);
    expect(await uploadCheck(service(), nextMonday)).toBe(true);
    const { data } = await service().from("alert").select("dedupe_key").eq("kind", "upload_missed");
    expect(data).toEqual([{ dedupe_key: "upload_missed:2026-W45" }]);
  });
});

describe("alert delivery", () => {
  it("emails each pending alert once to its recipients; a failed send is retried next time", async () => {
    await service().from("alert").insert([
      { kind: "deadline_applied", dedupe_key: "t1", payload: { message: "applied" } },
      { kind: "pending_draft", dedupe_key: "t2", payload: { message: "pending" } },
    ]);
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    let fail = true;
    const sender = async (to: string[], subject: string, text: string) => {
      if (text === "pending" && fail) {
        fail = false;
        throw new Error("smtp down");
      }
      sent.push({ to, subject, text });
    };
    expect(await deliverAlerts(service(), sender, TUE_NOON)).toBe(1);
    expect(await deliverAlerts(service(), sender, TUE_NOON)).toBe(1);
    expect(await deliverAlerts(service(), sender, TUE_NOON)).toBe(0);
    const owner = sent.find((s) => s.text === "applied")!;
    expect(owner.to).toEqual(["deepa@freshroots.test"]);
    const pend = sent.find((s) => s.text === "pending")!;
    expect(pend.to).toEqual(expect.arrayContaining(["raghav@freshroots.test", "procurement@freshroots.test"]));
  });

  it("no email configured → alerts stay pending", async () => {
    await service().from("alert").insert({ kind: "run_blocked", dedupe_key: "t3", payload: {} });
    expect(await deliverAlerts(service(), null, TUE_NOON)).toBe(0);
    expect((await service().from("alert").select("sent_at").eq("dedupe_key", "t3").single()).data!.sent_at).toBeNull();
  });
});
