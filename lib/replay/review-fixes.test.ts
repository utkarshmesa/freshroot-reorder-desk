// Tests for the Milestone 4 review findings (each test names its finding).
import { describe, expect, it } from "vitest";
import type { SalesRow, SkuInput } from "@/lib/engine/types";
import { addWeeks, type IsoWeek } from "@/lib/isoweek";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { parseCsv } from "@/lib/upload/parse";
import { readReplayFiles } from "./files";
import { replayAll, replaySku, robustVerdict, weekSpan, type SkuData } from "./replay";

const START: IsoWeek = "2025-W01";
const weeksOf = (n: number) => weekSpan(START, addWeeks(START, n - 1));
const sku = (o: Partial<SkuInput> = {}): SkuInput => ({
  id: "S1",
  name: "S1",
  category: null,
  status: "active",
  firstSaleWeek: null,
  launchEstimateWk: null,
  stdQty: 100,
  moq: null,
  packSize: null,
  leadTimeWks: 2,
  shelfLifeWks: null,
  perishable: false,
  unitCostInr: null,
  supplierId: "SUP",
  ...o,
});
const flat = (w: IsoWeek[], units: number | ((i: number) => number), id = "S1"): SalesRow[] =>
  w.map((wk, i) => ({ skuId: id, distributorId: "D1", week: wk, shipped: typeof units === "number" ? units : units(i), returns: 0 }));
const opts = (w: IsoWeek[]) => ({ rules: DEFAULT_RULES, weeks: w, events: [], distributors: [{ id: "D1", status: "active" as const, startWeek: null, endWeek: null }] });

// The perishable PASS fixture from replay.test.ts: lumpy actual receipts vs steady rule orders.
const W = weeksOf(13 + 64);
const lumpy: SkuData = {
  sku: sku({ perishable: true, shelfLifeWks: 8, moq: 100 }),
  sales: flat(W, 100),
  receipts: Object.fromEntries([13, 29, 45, 61].map((i) => [W[i]!, 1600])),
  stockHistory: { [W[12]!]: 200 },
};

describe("finding 1: duplicate receipt and stock rows are added, bad weeks stop the run", () => {
  it("sums one row per goods receipt", () => {
    const t = parseCsv("receipts.csv", "iso_week,sku_id,received_units\n2026-W10,S1,100\n2026-W10,S1,\"1,250\"\n2026-W11,S1,5\n");
    expect(readReplayFiles([t]).receipts.get("S1")).toEqual({ "2026-W10": 1350, "2026-W11": 5 });
  });

  it("sums stock across storage locations", () => {
    const t = parseCsv("stock.csv", "iso_week,sku_id,on_hand_units\n2026-W10,S1,40\n2026-W10,S1,60\n");
    expect(readReplayFiles([t]).stockHistory.get("S1")).toEqual({ "2026-W10": 100 });
  });

  it("rejects a week that doesn't exist", () => {
    const t = parseCsv("receipts.csv", "iso_week,sku_id,received_units\n2027-W53,S1,1\n");
    expect(readReplayFiles([t]).errors[0]).toMatch(/2027-W53/);
  });
});

describe("finding 2: no receipts history → no verdict", () => {
  it("is NOT DECIDABLE without a receipts file", () => {
    const s = replayAll([lumpy], { ...opts(W), receiptsKnown: false });
    expect(s.verdict.result).toBe("NOT DECIDABLE");
    expect(s.verdict.reasons.join(" ")).toMatch(/No receipts history/);
  });

  it("leaves out a SKU with no receipts at all", () => {
    const noRec: SkuData = { ...lumpy, sku: sku({ id: "S2" }), sales: flat(W, 100, "S2"), receipts: {} };
    const s = replayAll([lumpy, noRec], opts(W));
    expect(s.compared).toBe(1);
    expect(s.verdict.reasons.join(" ")).toMatch(/1 SKU\(s\) left out because of no receipts at all in the export: S2\./);
  });
});

describe("finding 3: a PASS must survive late deliveries", () => {
  it("robustVerdict downgrades a PASS that fails with deliveries a week late", () => {
    const main = replayAll([lumpy], opts(W));
    expect(main.verdict.result).toBe("PASS");
    const fakeLate = { ...main, verdict: { result: "FAIL" as const, reasons: [] } };
    expect(robustVerdict(main, fakeLate).result).toBe("INCONCLUSIVE");
    expect(robustVerdict(main, main).result).toBe("PASS");
  });

  it("late deliveries arrive a week later in the rules arm", () => {
    // 300 on hand at 100/wk and lead 3: an on-time order lands exactly as the shelf empties; a week late loses a week.
    const w = weeksOf(20);
    const on = replaySku({ sku: sku({ leadTimeWks: 3 }), sales: flat(w, 100), receipts: { [w[0]!]: 1 }, stockHistory: { [w[12]!]: 300 } }, opts(w));
    const late = replaySku({ sku: sku({ leadTimeWks: 3 }), sales: flat(w, 100), receipts: { [w[0]!]: 1 }, stockHistory: { [w[12]!]: 300 } }, { ...opts(w), leadTimeExtraWks: 1 });
    expect(on.rules!.lost).toBe(0);
    expect(late.rules!.lost).toBeGreaterThan(0);
  });
});

describe("finding 4: orders placed before the replay still arrive in the rules arm", () => {
  it("receipts due in the first lead-time weeks reach both arms", () => {
    const w = weeksOf(20);
    // Opening 100 only; Raghav's 500 arrives in the first simulated week. Without it the rules arm would run dry.
    const r = replaySku({ sku: sku({ leadTimeWks: 2 }), sales: flat(w, 100), receipts: { [w[13]!]: 500 }, stockHistory: { [w[12]!]: 100 } }, opts(w));
    expect(r.rules!.received).toBeGreaterThanOrEqual(500);
    expect(r.rules!.lost).toBe(0);
    expect(r.rules!.unitsOrdered).toBeLessThan(r.rules!.received); // Raghav's 500 isn't counted as a rules order
  });
});

describe("finding 5: significance", () => {
  it("INCONCLUSIVE when the totals improve but the interval includes no difference", () => {
    // One SKU where the rules win clearly, one where they lose almost as much.
    const worse: SkuData = {
      sku: sku({ id: "S2", perishable: true, shelfLifeWks: 8, moq: 100 }),
      sales: flat(W, 100, "S2"),
      receipts: Object.fromEntries(W.slice(13).map((x) => [x, 100])),
      stockHistory: { [W[12]!]: 200 },
    };
    const s = replayAll([lumpy, worse, worse, worse, worse], opts(W));
    expect(["INCONCLUSIVE", "FAIL"]).toContain(s.verdict.result);
    expect(s.verdict.result).not.toBe("PASS");
  });
});

describe("findings 6 and 7: missing weeks and simulator drift block the verdict (drift: c033.test.ts, C-032)", () => {
  it("a week with no sales rows at all is NOT DECIDABLE", () => {
    const s = replayAll([lumpy], { ...opts(W), missingWeeks: ["2025-W30"] });
    expect(s.verdict.result).toBe("NOT DECIDABLE");
    expect(s.verdict.reasons[0]).toMatch(/2025-W30/);
  });
});

describe("findings 9 and 11", () => {
  it("ordered units are used as demand when supplied (no imputation)", () => {
    const w = weeksOf(30);
    const r = replaySku({ sku: sku(), sales: flat(w, 100), receipts: { [w[0]!]: 1 }, stockHistory: Object.fromEntries(w.map((x) => [x, 1000])), ordered: Object.fromEntries(w.map((x) => [x, 130])) }, opts(w));
    expect(r.actual!.demand).toBe(17 * 130);
    expect(r.stats.imputedWeeks).toBe(0);
  });

  it("aggregation stays exact when plain rows net to zero in a week", () => {
    const w = weeksOf(30);
    const sales: SalesRow[] = [
      { skuId: "S1", distributorId: "D1", week: w[0]!, shipped: 5, returns: 5 }, // first row nets to zero
      ...w.slice(1).flatMap((wk) => [
        { skuId: "S1", distributorId: "D1", week: wk, shipped: 60, returns: 0 },
        { skuId: "S1", distributorId: "D2", week: wk, shipped: 40, returns: 0 },
      ]),
    ];
    const data: SkuData = { sku: sku(), sales, receipts: { [w[0]!]: 1 }, stockHistory: { [w[12]!]: 300 } };
    const a = replaySku(data, { ...opts(w), aggregatePlainDistributors: true });
    const b = replaySku(data, { ...opts(w), aggregatePlainDistributors: false });
    expect(a.rules).toEqual(b.rules);
    expect(a.weeklyTriage).toEqual(b.weeklyTriage);
  });
});
