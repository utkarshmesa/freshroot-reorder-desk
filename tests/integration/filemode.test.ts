// C-039 Zoho failsafe (file mode) through the database: blocked by Zoho → Deepa runs the week from files → the
// rules count the file's open POs → live Send makes PO sheets (no Zoho call) → procurement confirms placed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFileMode } from "@/lib/filemode/server";
import { processRun } from "@/lib/run/worker";
import { sendToProcurement } from "@/lib/send/send";
import { parseCsv } from "@/lib/upload/parse";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { as, resetData, service } from "./db";

const MON = new Date("2026-10-19T03:30:00Z");
const TUE = new Date("2026-10-20T06:30:00Z");
const noZohoAtAll = () => null; // Zoho not connected in this environment
const mustNotCallZoho = () => {
  throw new Error("file mode must not call Zoho");
};
const OPEN_POS = parseCsv(
  "open_pos.csv",
  "po_number,supplier_id,sku_id,po_date,ordered_units,received_units,status,expected_date,reference\nPO-77,DIST001,SKU013,2026-10-14,300,0,open,2026-10-28,phone order\nPO-70,DIST002,SKU003,2026-10-01,600,600,closed,,\n",
);
let runId = "";

async function blockedRun(): Promise<string> {
  const { data, error } = await service().rpc("supersede_or_start_run", { p_week: "2026-W43", p_upload: null });
  if (error) throw new Error(error.message);
  const id = (data as { run_id: string }).run_id;
  expect((await processRun(service(), id, { caseDataMode: false, zoho: noZohoAtAll, llm: null, now: MON })).status).toBe("blocked");
  return id;
}
async function lines(id: string) {
  const { data } = await service().from("recommendation").select("id, sku_id, qty, line_state, inputs").eq("run_id", id).order("sku_id");
  return data ?? [];
}
const start = async (who: "deepa" | "raghav", over: Partial<Parameters<typeof startFileMode>[1]> = {}) =>
  startFileMode((await as(who)).client, { runId, openPos: OPEN_POS, receipts: null, reason: "Zoho org not available yet", certified: true, uploadedBy: "Deepa Nair", now: MON, ...over });

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))),
  );
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: false }); // C-040
  await commitUpload(client, staged.uploadId);
});

beforeEach(async () => {
  for (const t of ["decision", "draft_po", "alert"]) await service().from(t).delete().not("id", "is", null);
  await service().from("app_mode").update({ mode: "shadow" }).not("mode", "is", null);
  runId = await blockedRun();
});

describe("switching a week to files", () => {
  it("only the owner, only with procurement's confirmation, and it is logged", async () => {
    expect(await start("raghav")).toEqual({ ok: false, errors: [expect.stringMatching(/Only the owner/)] });
    expect(await start("deepa", { certified: false })).toEqual({ ok: false, errors: [expect.stringMatching(/procurement confirmed/)] });
    const r = await start("deepa");
    expect(r).toMatchObject({ ok: true, summary: { openLines: 1, openUnits: 300, pos: 2 } });
    const { data: run } = await service().from("run").select("status, source, error").eq("id", runId).single();
    expect(run).toEqual({ status: "engine", source: "file", error: null });
    const { data: log } = await service().from("change_log").select("reason").eq("entity", "run").eq("field", "source");
    expect(log!.map((l) => l.reason)).toContain("Zoho org not available yet");
  });

  it("a bad file is refused and nothing changes", async () => {
    const bad = parseCsv("open_pos.csv", "po_number,supplier_id,sku_id,po_date,ordered_units,received_units,status\nPO-1,DIST001,SKU999,2026-10-14,5,0,open\n");
    expect((await start("deepa", { openPos: bad })).ok).toBe(false);
    expect((await service().from("run").select("status, source").eq("id", runId).single()).data).toEqual({ status: "blocked", source: "zoho" });
  });
});

describe("the week runs on the file", () => {
  it("the rules count the file's open POs; no Zoho call is made; the desk says where the position came from", async () => {
    expect((await start("deepa")).ok).toBe(true);
    expect((await processRun(service(), runId, { caseDataMode: false, zoho: mustNotCallZoho, llm: null, now: MON })).status).toBe("done");
    const sku13 = (await lines(runId)).find((l) => l.sku_id === "SKU013")!;
    expect((sku13.inputs as { openPoQty: number }).openPoQty).toBe(300);
    const { data: run } = await service().from("run").select("notes").eq("id", runId).single();
    expect((run!.notes as string[])[0]).toMatch(/^Zoho failsafe: open POs from open_pos\.csv \(uploaded by Deepa Nair\): 1 open lines, 300 units/);
  });

  it("live: Send makes one PO sheet per supplier, alerts procurement, and procurement confirms placed", async () => {
    expect((await start("deepa")).ok).toBe(true);
    await service().from("run").update({ mode: "live" }).eq("id", runId);
    await service().from("app_mode").update({ mode: "live" }).not("mode", "is", null);
    await processRun(service(), runId, { caseDataMode: false, zoho: mustNotCallZoho, llm: null, now: MON });
    const { client: raghav } = await as("raghav");
    for (const l of await lines(runId)) if (l.line_state === "queued") await raghav.rpc("decide_line", { p_rec_id: l.id, p_action: "approve" });

    const r = await sendToProcurement(service(), runId, { now: TUE, envMode: "live", zoho: mustNotCallZoho });
    expect(r.mode).toBe("file");
    expect(r.sent.length).toBeGreaterThan(0);
    const { data: sheets } = await service().from("draft_po").select("id, mode, status, reference, zoho_po_id").eq("run_id", runId);
    expect(sheets!.every((d) => d.mode === "file" && d.status === "created" && d.zoho_po_id === null && d.reference.startsWith("FR-2026-W43-"))).toBe(true);
    expect((await service().from("alert").select("kind").eq("kind", "po_sheets_ready")).data).toHaveLength(1);

    const { client: proc } = await as("procurement");
    expect((await proc.rpc("confirm_placed", { p_draft_id: sheets![0]!.id })).error).toBeNull();
    expect((await proc.rpc("confirm_placed", { p_draft_id: sheets![0]!.id })).error?.message).toMatch(/already confirmed as placed/);
    const { data: placed } = await service().from("draft_po").select("status, issued_at").eq("id", sheets![0]!.id).single();
    expect(placed!.status).toBe("issued");
    expect(placed!.issued_at).not.toBeNull();
    const { client: ceo } = await as("ceo");
    expect((await ceo.rpc("confirm_placed", { p_draft_id: sheets![1]!.id })).error?.message).toMatch(/Only procurement or the planner/);
  });

  it("an earlier week's sheet not yet placed holds that supplier (one pending order per supplier)", async () => {
    await service().from("draft_po").insert({ run_id: runId, supplier_id: "DIST001", iso_week: "2026-W42", mode: "file", reference: "FR-2026-W42-DIST001", status: "created" });
    expect((await start("deepa")).ok).toBe(true);
    await service().from("run").update({ mode: "live" }).eq("id", runId);
    await service().from("app_mode").update({ mode: "live" }).not("mode", "is", null);
    await processRun(service(), runId, { caseDataMode: false, zoho: mustNotCallZoho, llm: null, now: MON });
    const dist001 = (await lines(runId)).filter((l) => (l.inputs as { supplierId: string }).supplierId === "DIST001" && l.line_state !== null);
    expect(dist001.length).toBeGreaterThan(0);
    expect(dist001.every((l) => l.line_state === "blocked_pending")).toBe(true);
  });

  it("shadow: a file-mode week still sends nothing anywhere", async () => {
    expect((await start("deepa")).ok).toBe(true);
    await processRun(service(), runId, { caseDataMode: false, zoho: mustNotCallZoho, llm: null, now: MON });
    const { client: raghav } = await as("raghav");
    for (const l of await lines(runId)) if (l.line_state === "queued") await raghav.rpc("decide_line", { p_rec_id: l.id, p_action: "approve" });
    const r = await sendToProcurement(service(), runId, { now: TUE, envMode: undefined, zoho: mustNotCallZoho });
    expect(r.mode).toBe("shadow");
    expect((await service().from("alert").select("kind").eq("kind", "po_sheets_ready")).data).toEqual([]);
  });
});
