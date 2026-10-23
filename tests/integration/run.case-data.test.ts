// RU-01 (integration part): case files → upload → commit → run worker → recommendation rows = the W43 reference.
// Also RN-01 (row lease) and fail-closed outside case-data mode.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { roundHalfEven } from "@/lib/engine/round";
import { processRun } from "@/lib/run/worker";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { as, resetData, service } from "./db";

const CASE = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"];
type Expected = { sku_id: string; a12: number; a4: number; forward_demand: number; position: number; cover_weeks: number; min_eff: number; max: number; action: string; qty: number; cover_after: number | null; flags: string[]; triage: string };
const expected = (JSON.parse(readFileSync("data/reference/expected_2026-W43.json", "utf8")) as { results: Expected[] }).results;

let runId = "";

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = CASE.map((f) => toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))));
  const { uploadId, report } = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  expect(report.errors).toBe(0);
  runId = (await commitUpload(client, uploadId)).run_id!;
});

describe("RU-01 through the database", () => {
  it("RN-01 two workers claim the same run: exactly one does the work", async () => {
    const [a, b] = await Promise.all([processRun(service(), runId, { caseDataMode: true }), processRun(service(), runId, { caseDataMode: true })]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const { data } = await service().from("run").select("status, zoho_read, notes, locked_until").eq("id", runId).single();
    expect(data!.status).toBe("ready");
    expect(data!.zoho_read).toMatchObject({ skipped: "case_data" });
    expect(data!.notes).toEqual(["Zero-stock exclusion skipped for 15 SKU(s): no weekly stock history yet (C-007)."]);
    expect(data!.locked_until).toBeNull();
  });

  it("stores one recommendation per SKU that matches the reference", async () => {
    const { data, error } = await service().from("recommendation").select("*").eq("run_id", runId);
    expect(error).toBeNull();
    expect(data).toHaveLength(15);
    for (const e of expected) {
      const r = data!.find((x) => x.sku_id === e.sku_id)!;
      const i = r.inputs as Record<string, number>;
      expect(
        {
          a12: roundHalfEven(i.a12!),
          a4: roundHalfEven(i.a4!),
          forward_demand: roundHalfEven(i.forwardDemand!),
          position: i.position,
          cover_weeks: roundHalfEven(Number(r.cover)),
          min_eff: i.minEff,
          max: i.max,
          action: r.action,
          qty: r.qty,
          cover_after: r.cover_after === null ? null : roundHalfEven(Number(r.cover_after)),
          flags: [...r.flags].sort(),
          triage: r.triage,
        },
        e.sku_id,
      ).toEqual({ ...e, flags: [...e.flags].sort(), sku_id: undefined, name: undefined } as unknown as Record<string, unknown>);
    }
  });

  it("puts queue items and the two spot-checked auto items in front of Raghav (C-008, C-028b)", async () => {
    const { data } = await service().from("recommendation").select("sku_id, triage, line_state, spot_check").eq("run_id", runId).order("sku_id");
    const by = Object.fromEntries((data ?? []).map((r) => [r.sku_id, r]));
    expect(by.SKU003).toMatchObject({ triage: "auto", spot_check: true, line_state: "queued" });
    expect(by.SKU013).toMatchObject({ triage: "auto", spot_check: true, line_state: "queued" });
    for (const id of ["SKU001", "SKU004", "SKU011"]) expect(by[id]).toMatchObject({ triage: "queue", line_state: "queued" });
    for (const id of ["SKU006", "SKU007"]) expect(by[id]).toMatchObject({ triage: "info_no_open_po", line_state: null });
  });

  it("a finished run isn't processed again", async () => {
    const r = await processRun(service(), runId, { caseDataMode: true });
    expect(r).toEqual({ runId, status: "ready", claimed: false });
  });
});

describe("fail closed outside case-data mode (milestone 2: no Zoho reader yet)", () => {
  it("blocks the run and records an alert", async () => {
    const svc = service();
    const { data: run } = await svc
      .from("run")
      .insert({ iso_week: "2026-W44", rule_version_id: (await svc.from("rule_version").select("id").eq("is_current", true).single()).data!.id, spot_check_seed: 1 })
      .select("id")
      .single();
    const r = await processRun(svc, run!.id, { caseDataMode: false });
    expect(r.status).toBe("blocked");
    const { data } = await svc.from("run").select("status, error").eq("id", run!.id).single();
    expect(data).toMatchObject({ status: "blocked", error: { reason: "zoho_not_connected" } });
    expect((await svc.from("recommendation").select("id").eq("run_id", run!.id)).data).toEqual([]);
    expect((await svc.from("alert").select("kind").eq("run_id", run!.id)).data).toEqual([{ kind: "run_blocked" }]);
  });
});
