// Decisions and Send to procurement through the database, against the in-memory Zoho.
// DS-01..03 (decide_line), ST-04 (shadow: no Zoho calls), ZO-04 (no duplicate draft after a lost response or a
// crash), ZO-14 (created PO isn't a draft), ST-01 (pending draft blocks the supplier), C-025 (changed PO holds
// the line), and two sends at once.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processRun } from "@/lib/run/worker";
import { sendToProcurement } from "@/lib/send/send";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { ZohoHttp } from "@/lib/zoho/http";
import { dbTokenSource } from "@/lib/zoho/token";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { as, resetData, service } from "./db";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const SKUS = Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`);
const SUPPLIERS = ["DIST001", "DIST002", "DIST003", "DIST004"];
const NOW = new Date("2026-10-20T06:30:00Z"); // Tue 12:00 IST
let z: FakeZoho;

const zohoFactory = (db: Parameters<typeof dbTokenSource>[0], budget: number) =>
  new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: dbTokenSource(db, CFG, z.fetch), budget, sleep: async () => {} });
const noZoho = () => {
  throw new Error("shadow mode must not build a Zoho client");
};
const live = (runId: string) => sendToProcurement(service(), runId, { now: NOW, zoho: zohoFactory, envMode: "live", sleep: async () => {} });
const shadow = (runId: string) => sendToProcurement(service(), runId, { now: NOW, zoho: noZoho, envMode: undefined, sleep: async () => {} });

async function newRun(mode: "shadow" | "live" = "shadow"): Promise<string> {
  const { data, error } = await service().rpc("supersede_or_start_run", { p_week: "2026-W43", p_upload: null });
  if (error) throw new Error(error.message);
  const runId = (data as { run_id: string }).run_id;
  await service().from("run").update({ mode }).eq("id", runId);
  expect((await processRun(service(), runId, { caseDataMode: true, llm: null, now: new Date("2026-10-19T03:30:00Z") })).status).toBe("done");
  return runId;
}
async function lines(runId: string) {
  const { data } = await service().from("recommendation").select("id, sku_id, qty, final_qty, line_state, inputs").eq("run_id", runId).order("sku_id");
  return (data ?? []).map((r) => ({ ...r, supplierId: (r.inputs as { supplierId: string }).supplierId }));
}
async function approveAll(runId: string) {
  const { client } = await as("raghav");
  for (const l of await lines(runId)) {
    if (l.line_state !== "queued") continue;
    const { error } = await client.rpc("decide_line", { p_rec_id: l.id, p_action: "approve" });
    if (error) throw new Error(error.message);
  }
}
const created = () => [...z.pos.values()].filter((p) => p.purchaseorder_id.startsWith("new-"));

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))),
  );
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  await commitUpload(client, staged.uploadId);
  const svc = service();
  for (const s of SKUS) await svc.from("sku").update({ zoho_item_id: `it-${s}`, uom: "Units" }).eq("id", s);
  for (const d of SUPPLIERS) await svc.from("supplier").update({ zoho_vendor_id: `v-${d}` }).eq("id", d);
});

beforeEach(async () => {
  z = new FakeZoho();
  for (const s of SKUS) z.items.set(`it-${s}`, { item_id: `it-${s}`, sku: s, unit: "Units", status: "active" });
  for (const d of SUPPLIERS) z.vendors.set(`v-${d}`, { contact_id: `v-${d}`, status: "active" });
  const svc = service();
  await svc.from("decision").delete().not("id", "is", null);
  await svc.from("draft_po").delete().not("id", "is", null);
  await svc.from("alert").delete().not("id", "is", null);
  await svc.from("zoho_token_cache").delete().eq("id", true);
  await svc.from("app_mode").update({ mode: "shadow" }).not("mode", "is", null);
});

describe("decide_line (DS-01..03)", () => {
  it("approve settles the card at the engine's quantity, once; a second click is refused", async () => {
    const runId = await newRun();
    const card = (await lines(runId)).find((l) => l.sku_id === "SKU004")!; // Almond Milk, queue
    const { client } = await as("raghav");
    const first = await client.rpc("decide_line", { p_rec_id: card.id, p_action: "approve" });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ state: "approved", final_qty: card.qty });
    const again = await client.rpc("decide_line", { p_rec_id: card.id, p_action: "approve" });
    expect(again.error?.message).toMatch(/no longer waiting/);
    const { data: d } = await service().from("decision").select("status, final_qty").eq("recommendation_id", card.id);
    expect(d).toEqual([{ status: "approved", final_qty: card.qty }]);
  });

  it("change needs a quantity above 0 (reason optional); reject needs a reason", async () => {
    const runId = await newRun();
    const [a, b] = (await lines(runId)).filter((l) => l.line_state === "queued");
    const { client } = await as("raghav");
    expect((await client.rpc("decide_line", { p_rec_id: a!.id, p_action: "change", p_final_qty: 0, p_reason_code: "other" })).error?.message).toMatch(/above 0/);
    expect((await client.rpc("decide_line", { p_rec_id: a!.id, p_action: "change", p_final_qty: 300, p_reason_code: "supplier_issue", p_note: "only 300 in stock" })).data).toEqual({ state: "changed", final_qty: 300 });
    expect((await client.rpc("decide_line", { p_rec_id: b!.id, p_action: "reject" })).error?.message).toMatch(/reason/);
    expect((await client.rpc("decide_line", { p_rec_id: b!.id, p_action: "reject", p_reason_code: "disagree_rule" })).data).toEqual({ state: "rejected", final_qty: 0 });
  });

  it("only the planner can decide (ST-06), and decisions can't be inserted directly", async () => {
    const runId = await newRun();
    const card = (await lines(runId)).find((l) => l.line_state === "queued")!;
    const { client: proc, id } = await as("procurement");
    expect((await proc.rpc("decide_line", { p_rec_id: card.id, p_action: "approve" })).error?.message).toMatch(/Only the planner/);
    const { client: raghav, id: rid } = await as("raghav");
    expect((await raghav.from("decision").insert({ recommendation_id: card.id, status: "approved", by: rid })).error).not.toBeNull();
    void id;
  });
});

describe("shadow mode (ST-04)", () => {
  it("writes shadow draft rows, marks lines sent, and never builds a Zoho client", async () => {
    const runId = await newRun("shadow");
    const before = await lines(runId);
    const queuedSuppliers = new Set(before.filter((l) => l.line_state === "queued").map((l) => l.supplierId));
    const r1 = await shadow(runId);
    expect(r1.mode).toBe("shadow");
    expect(r1.waiting.map((w) => w.supplierId).sort()).toEqual([...queuedSuppliers].sort());
    expect(r1.sent.every((s) => !queuedSuppliers.has(s.supplierId))).toBe(true);

    await approveAll(runId);
    const r2 = await shadow(runId);
    expect(r2.waiting).toEqual([]);
    const { data: drafts } = await service().from("draft_po").select("supplier_id, mode, status, reference, requested_lines").eq("run_id", runId);
    expect(drafts!.every((d) => d.mode === "shadow" && d.status === "shadow" && d.reference === `FR-2026-W43-${d.supplier_id}`)).toBe(true);
    const after = await lines(runId);
    for (const l of after.filter((x) => x.final_qty)) expect(l.line_state).toBe("sent");
    expect(z.requests).toEqual([]);

    const r3 = await shadow(runId);
    expect(r3.sent).toEqual([]);
  });
});

describe("live mode", () => {
  async function liveRun() {
    const runId = await newRun("live");
    await service().from("app_mode").update({ mode: "live" }).not("mode", "is", null);
    await approveAll(runId);
    return runId;
  }

  it("creates one draft per supplier with the settled quantities; nothing but drafts, no status in the payload", async () => {
    const runId = await liveRun();
    const settled = (await lines(runId)).filter((l) => (l.final_qty ?? 0) > 0);
    const res = await live(runId);
    expect(res.mode).toBe("live");
    const suppliers = [...new Set(settled.map((l) => l.supplierId))].sort();
    expect(res.sent.map((s) => s.supplierId).sort()).toEqual(suppliers);
    expect(created()).toHaveLength(suppliers.length);
    for (const po of created()) {
      expect(po.status).toBe("draft");
      const sup = po.reference_number!.replace("FR-2026-W43-", "");
      const want = settled.filter((l) => l.supplierId === sup).map((l) => `it-${l.sku_id}:${l.final_qty}`).sort();
      expect(po.line_items.map((l) => `${l.item_id}:${l.quantity}`).sort()).toEqual(want);
    }
    expect(z.writes().every((w) => w.method === "POST" && !JSON.parse(w.body!).status)).toBe(true);
    const { data: drafts } = await service().from("draft_po").select("status, zoho_po_id").eq("run_id", runId);
    expect(drafts!.every((d) => d.status === "created" && d.zoho_po_id)).toBe(true);
    expect((await live(runId)).sent).toEqual([]); // again: nothing new
    expect(created()).toHaveLength(suppliers.length);
  });

  it("ZO-04: a lost create response is adopted by reference, not created twice", async () => {
    const runId = await liveRun();
    z.loseNextCreateResponse = true;
    const res = await live(runId);
    const refs = created().map((p) => p.reference_number);
    expect(new Set(refs).size).toBe(refs.length);
    expect(res.sent).toHaveLength(refs.length);
  });

  it("ZO-04: a crash after the 'creating' row is resumed by adopting the existing PO", async () => {
    const runId = await liveRun();
    const sup = (await lines(runId)).find((l) => (l.final_qty ?? 0) > 0)!.supplierId;
    await service().from("draft_po").insert({ run_id: runId, supplier_id: sup, iso_week: "2026-W43", mode: "live", reference: `FR-2026-W43-${sup}`, status: "creating" });
    z.addPo({ purchaseorder_id: "crashed-1", status: "draft", vendor_id: `v-${sup}`, reference_number: `FR-2026-W43-${sup}`, line_items: [{ item_id: "it-SKU001", quantity: 1 }] });
    z.hiddenFromSearch.add("crashed-1"); // search lags on the first look
    let searches = 0;
    const inner = z.fetch;
    z.fetch = async (url, init) => {
      if (url.includes("reference_number=") && ++searches === 2) z.hiddenFromSearch.clear();
      return inner(url, init);
    };
    await live(runId);
    const { data } = await service().from("draft_po").select("status, zoho_po_id").eq("supplier_id", sup).eq("iso_week", "2026-W43").eq("mode", "live").single();
    expect(data).toEqual({ status: "created", zoho_po_id: "crashed-1" });
    expect(created().filter((p) => p.reference_number === `FR-2026-W43-${sup}`)).toEqual([]);
  });

  it("ZO-14: a created PO that isn't a draft stops the send, blocks the run and alerts", async () => {
    const runId = await liveRun();
    z.createStatus = "issued";
    const res = await live(runId);
    expect(res.stopped).toMatch(/not a draft/);
    expect(created()).toHaveLength(1);
    const { data: run } = await service().from("run").select("status, error").eq("id", runId).single();
    expect(run).toMatchObject({ status: "blocked", error: { reason: "zoho_not_draft" } });
    const { data: alerts } = await service().from("alert").select("kind").eq("run_id", runId);
    expect(alerts).toEqual([{ kind: "run_blocked" }]);
  });

  it("ST-01: an earlier unissued system draft blocks that supplier for the week; others are sent", async () => {
    const runId = await liveRun();
    const sups = [...new Set((await lines(runId)).filter((l) => (l.final_qty ?? 0) > 0).map((l) => l.supplierId))].sort();
    const blocked = sups[0]!;
    z.addPo({ purchaseorder_id: "old-1", status: "draft", vendor_id: `v-${blocked}`, reference_number: `FR-2026-W42-${blocked}`, line_items: [{ item_id: "it-SKU001", quantity: 5 }] });
    const res = await live(runId);
    expect(res.skippedPending).toEqual([blocked]);
    expect(res.sent.map((s) => s.supplierId).sort()).toEqual(sups.slice(1));
    const l = (await lines(runId)).filter((x) => x.supplierId === blocked && (x.final_qty ?? 0) > 0);
    expect(l.every((x) => x.line_state === "blocked_pending")).toBe(true);
    const { data: alert } = await service().from("alert").select("kind, dedupe_key").eq("kind", "pending_draft");
    expect(alert).toEqual([{ kind: "pending_draft", dedupe_key: `pending_draft:2026-W43:${blocked}` }]);
  });

  it("C-025: a PO changed in Zoho since Monday for a SKU being sent holds that line only", async () => {
    const runId = await liveRun();
    const settled = (await lines(runId)).filter((l) => (l.final_qty ?? 0) > 0);
    const target = settled[0]!;
    z.addPo({ purchaseorder_id: "manual-1", status: "issued", vendor_id: `v-${target.supplierId}`, reference_number: "phone order", last_modified_time: "2026-10-19T15:00:00+0530", line_items: [{ item_id: `it-${target.sku_id}`, quantity: 50 }] });
    const res = await live(runId);
    expect(res.held).toEqual([{ supplierId: target.supplierId, skuIds: [target.sku_id] }]);
    expect((await lines(runId)).find((l) => l.id === target.id)!.line_state).toBe("held_changed");
    const po = created().find((p) => p.reference_number === `FR-2026-W43-${target.supplierId}`);
    expect(po?.line_items.some((l) => l.item_id === `it-${target.sku_id}`) ?? false).toBe(false);
  });

  it("two sends at once: one runs, the other is refused; one draft per supplier", async () => {
    const runId = await liveRun();
    const results = await Promise.allSettled([live(runId), live(runId)]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/already in progress/)]);
    const refs = created().map((p) => p.reference_number);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("live is only live when the env says so: otherwise shadow rows and no Zoho calls", async () => {
    const runId = await liveRun();
    const res = await sendToProcurement(service(), runId, { now: NOW, zoho: noZoho, envMode: undefined });
    expect(res.mode).toBe("shadow");
    expect(z.requests).toEqual([]);
  });
});
