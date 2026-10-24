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
    expect(data!.status).toBe("done");
    expect(data!.zoho_read).toMatchObject({ skipped: "case_data" });
    expect(data!.notes).toEqual(["Zero-stock exclusion is partial for 15 SKU(s): fewer than 12 weeks of stock snapshots so far (C-007)."]);
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
    expect(r).toEqual({ runId, status: "done", claimed: false });
  });
});

describe("step 7: Claude reasons and the brief (LL-01..LL-04 through the database)", () => {
  it("every card has a template reason, and a template brief exists, with no key configured", async () => {
    const { data } = await service().from("recommendation").select("sku_id, reason_text, reason_source").eq("run_id", runId);
    expect(data!.every((r) => r.reason_text && r.reason_source === "template")).toBe(true);
    const { data: brief } = await service().from("brief").select("*").eq("run_id", runId).single();
    expect(brief).toMatchObject({ source: "template", checked: false });
    expect(brief!.text).toContain("Week 2026-W43 (shadow mode)");
  });

  it("checked LLM text replaces the template on cards Raghav sees; a wrong number keeps the template; qty never changes", async () => {
    await service().from("run").update({ status: "ready" }).eq("id", runId);
    const before = await service().from("recommendation").select("sku_id, qty, reason_text").eq("run_id", runId);
    const llm = async (system: string, user: string) => {
      if (system.includes("weekly reorder brief")) return "A quiet week.";
      if (user.includes("\"skuId\":\"SKU004\"")) return "Order 9999 units."; // invented number
      if (user.includes("\"skuId\":")) return "The rules order this because cover is below the minimum.";
      throw new Error("unexpected prompt");
    };
    expect((await processRun(service(), runId, { caseDataMode: true, llm })).status).toBe("done");
    const { data } = await service().from("recommendation").select("sku_id, qty, reason_text, reason_source, line_state").eq("run_id", runId);
    const by = Object.fromEntries(data!.map((r) => [r.sku_id, r]));
    expect(by.SKU001).toMatchObject({ reason_source: "llm", reason_text: "The rules order this because cover is below the minimum." });
    expect(by.SKU004!.reason_source).toBe("template");
    expect(by.SKU006!.reason_source).toBe("template"); // not a card Raghav reviews: never sent to Claude
    for (const r of before.data!) expect(by[r.sku_id]!.qty).toBe(r.qty);
    const { data: brief } = await service().from("brief").select("text, source").eq("run_id", runId).single();
    expect(brief).toEqual({ text: "A quiet week.", source: "llm" });
  });
});

describe("review M5 #2: the Claude step never blocks the run", () => {
  it("out of time: every card keeps its template, no LLM call is made, and the run is done", async () => {
    await service().from("run").update({ status: "ready", step_attempts: 99 }).eq("id", runId); // claims past the limit
    await service().from("recommendation").update({ reason_source: "template" }).eq("run_id", runId);
    let calls = 0;
    const llm = async () => {
      calls++;
      return "x";
    };
    expect((await processRun(service(), runId, { caseDataMode: true, llm, llmBudgetMs: -1 })).status).toBe("done");
    expect(calls).toBe(0);
    const { data: brief } = await service().from("brief").select("source").eq("run_id", runId).single();
    expect(brief!.source).toBe("template");
  });
});

describe("loader: last week's zero stock is excluded (review finding 2, RU-12 through the database)", () => {
    it("a Sunday on-hand of 0 drops that week from the averages", async () => {
      // W43: SKU002 sells 10 because it ran out (on-hand 0 on Sunday 25 Oct); everything else normal.
      const { client, id } = await as("priya");
      const sales = `iso_week,sku_id,distributor_id,shipped_units,returns_units\n${Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`)
        .map((s) => `2026-W43,${s},ALL,${s === "SKU002" ? 10 : 100},0`)
        .join("\n")}\n`;
      const stock = `as_of_ts,sku_id,on_hand_units\n${Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`)
        .map((s) => `2026-10-25,${s},${s === "SKU002" ? 0 : 500}`)
        .join("\n")}\n`;
      const files = [toInputFile("sales_w43.csv", new TextEncoder().encode(sales)), toInputFile("stock_w43.csv", new TextEncoder().encode(stock))];
      const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
      expect(staged.report.errors).toBe(0);
      if (staged.report.unconfirmed) {
        const { confirmUpload } = await import("@/lib/upload/server");
        await confirmUpload({ user: client, service: service(), userId: id, uploadId: staged.uploadId, confirmedCodes: ["volume_change"] });
      }
      const res = await commitUpload(client, staged.uploadId);
      expect(res.run_week).toBe("2026-W44");
      expect((await processRun(service(), res.run_id!, { caseDataMode: true })).status).toBe("done");
      const { data } = await service().from("recommendation").select("sku_id, inputs").eq("run_id", res.run_id!).in("sku_id", ["SKU002", "SKU003"]);
      const a12 = Object.fromEntries((data ?? []).map((r) => [r.sku_id, (r.inputs as { a12: number; cleanWeeks: number }).a12]));
      const clean = Object.fromEntries((data ?? []).map((r) => [r.sku_id, (r.inputs as { cleanWeeks: number }).cleanWeeks]));
      // SKU002: W43 dropped → a12 over W31–W42 = 84.17 (unchanged by the 10); 16 clean weeks of 17.
      expect(clean.SKU002).toBe(16);
      expect(a12.SKU002).toBeCloseTo((91 + 78 + 89 + 82 + 80 + 79 + 82 + 89 + 80 + 86 + 86 + 83) / 12, 6);
      expect(clean.SKU003).toBe(17);
    });
  });

describe("fail closed when there is no stock snapshot", () => {
  it("blocks the whole run, not just every SKU", async () => {
    const svc = service();
    const { data: run } = await svc
      .from("run")
      .insert({ iso_week: "2026-W50", rule_version_id: (await svc.from("rule_version").select("id").eq("is_current", true).single()).data!.id, spot_check_seed: 1 })
      .select("id")
      .single();
    const r = await processRun(svc, run!.id, { caseDataMode: true });
    expect(r.status).toBe("blocked");
    const { data } = await svc.from("run").select("error").eq("id", run!.id).single();
    expect(data!.error).toMatchObject({ reason: "no_stock_snapshot" });
  });
});

describe("fail closed outside case-data mode (milestone 2: no Zoho reader yet)", () => {
  it("blocks the run and records an alert", async () => {
    const svc = service();
    const { data: run } = await svc
      .from("run")
      .insert({ iso_week: "2026-W51", rule_version_id: (await svc.from("rule_version").select("id").eq("is_current", true).single()).data!.id, spot_check_seed: 1 })
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
