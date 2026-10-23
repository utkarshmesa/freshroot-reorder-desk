// RU-18 "W44-synthetic" golden: hand-computed, covering what W43 can't (TEST_PLAN §3.2).
// Run week 2026-W44 (Mon 26 Oct 2026); snapshot Sun 25 Oct 23:59. Festival 1 Oct – 30 Nov, +25%, 3-week pre-load.
import { describe, expect, it } from "vitest";
import { weekRange } from "@/lib/isoweek";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { runEngine } from "./index";
import type { EngineInput, SalesRow, SkuInput } from "./types";

const W = weekRange("2026-W32", "2026-W43"); // the 12 weeks before the run
const sale = (skuId: string, distributorId: string, week: string, shipped: number): SalesRow => ({ skuId, distributorId, week, shipped, returns: 0 });
const sku = (s: Partial<SkuInput> & { id: string }): SkuInput => ({
  name: s.id,
  category: null,
  status: "active",
  firstSaleWeek: null,
  launchEstimateWk: null,
  stdQty: 100,
  moq: null,
  packSize: null,
  leadTimeWks: null,
  shelfLifeWks: null,
  perishable: false,
  unitCostInr: 10,
  supplierId: "SUP",
  ...s,
});

const input: EngineInput = {
  runWeek: "2026-W44",
  rules: DEFAULT_RULES,
  caseDataMode: false,
  skus: [
    sku({ id: "A", stdQty: 200, moq: 250, leadTimeWks: 3 }),
    sku({ id: "B", perishable: true, shelfLifeWks: 10, leadTimeWks: 1, unitCostInr: null }),
    sku({ id: "C", stdQty: 300, moq: 300, leadTimeWks: 6 }),
  ],
  distributors: [
    { id: "D1", status: "active", startWeek: null, endWeek: null },
    { id: "D2", status: "active", startWeek: "2026-W38", endWeek: null },
  ],
  events: [
    { type: "festival", startDate: "2026-10-01", endDate: "2026-11-30", skuIds: [], distributorIds: [], upliftPct: 25, preloadWks: 3 },
    // One-off bulk order by D1 for A in W43 (19–25 Oct).
    { type: "hold", startDate: "2026-10-19", endDate: "2026-10-25", skuIds: ["A"], distributorIds: ["D1"], upliftPct: null, preloadWks: 0 },
  ],
  sales: [
    // A: D1 100/wk, but 500 in the held W43. D2 started W38: shelf-fill 300/wk W38–W41, then 60, 40.
    ...W.map((w) => sale("A", "D1", w, w === "2026-W43" ? 500 : 100)),
    ...["2026-W38", "2026-W39", "2026-W40", "2026-W41"].map((w) => sale("A", "D2", w, 300)),
    sale("A", "D2", "2026-W42", 60),
    sale("A", "D2", "2026-W43", 40),
    // B: 50/wk W32–W39, 80/wk W40–W43.
    ...W.map((w, i) => sale("B", "D1", w, i < 8 ? 50 : 80)),
    // C: flat 100.
    ...W.map((w) => sale("C", "D1", w, 100)),
  ],
  onHand: { A: 300, B: 120, C: 500 },
  stockHistory: {},
  poLines: [
    { poId: "po1", poNumber: "PO-101", status: "partially_received", skuId: "A", ordered: 400, received: 150, expectedDate: "2026-11-02" },
    { poId: "po2", poNumber: "PO-102", status: "draft", skuId: "A", ordered: 999, received: 0, expectedDate: null },
  ],
  receipts: [
    { poId: "po1", skuId: "A", date: "2026-10-26", qty: 150 }, // Monday: not in Sunday's SAP stock → added
    { poId: "po0", skuId: "A", date: "2026-10-25", qty: 80 }, // Sunday: already in SAP stock → not added
  ],
  holdout: [],
  blocked: {},
  spotCheckSeed: 3,
};

const out = runEngine(input);
const r = (id: string) => out.recommendations.find((x) => x.skuId === id)!;

describe("RU-18 W44-synthetic golden", () => {
  it("A: hold + new distributor + open PO + Monday receipt + festival", () => {
    // a12 = D1 100 (W32–W42, W43 held) + D2 50 (only W42, W43 eligible: (60+40)/2) = 150.
    // a4 (W40–W43) = D1 100 (W40–W42) + D2 50 = 150. Trend leaves D2 out until W50 → 100 / 100, no high demand.
    // lead 3, min 6 → min_eff max(6, 5) = 6; order weeks W47–W52, W47 is in November → ×1.25 → F = 187.5.
    // P = 300 on hand + (400 − 150) open + 150 Monday receipt = 700 (draft and Sunday receipt excluded). C = 3.733.
    // q: 200 → 400 → 600 (700 + 600 ≥ 6 × 187.5 = 1125); MOQ 250 → 600. Over 2 × 200 → over_auto_limit. Hold → queue.
    const a = r("A");
    expect([a.a12, a.a4, a.trendA12, a.trendA4]).toEqual([150, 150, 100, 100]);
    expect([a.minEff, a.max, a.festivalFactor, a.forwardDemand]).toEqual([6, 14, 1.25, 187.5]);
    expect(a.orderWeeks).toEqual(["2026-W47", "2026-W48", "2026-W49", "2026-W50", "2026-W51", "2026-W52"]);
    expect([a.onHand, a.openPoQty, a.receiptsAfterSnapshot, a.position]).toEqual([300, 250, 150, 700]);
    expect(a.cover).toBeCloseTo(3.7333333, 6);
    expect([a.action, a.qty, a.triage]).toEqual(["reorder", 600, "queue"]);
    expect(a.coverAfter).toBeCloseTo(1300 / 187.5, 10);
    expect([...a.flags].sort()).toEqual(["hold", "over_auto_limit"]);
    expect(a.daysToStockout).toBeCloseTo(11.2, 10);
    expect(a.assumed).toEqual([]);
    expect(a.topDistributors).toEqual([]); // no distributor's a4 differs from its a12
  });

  it("B: perishable with high demand, inside the cap", () => {
    // a12 = (8 × 50 + 4 × 80) / 12 = 60; a4 = 80 > 1.2 × 60 = 72 → high demand.
    // shelf 10 → max = min(4, 5) = 4; lead 1 → min_eff = max(3, 3) = 3; order weeks W45–W47 → ×1.25 → F = 75.
    // P = 120, C = 1.6. q = 1.5 × 100 = 150 (120 + 150 = 270 ≥ 225); cap = 4 × 75 − 120 = 180 ≥ 150 → 150.
    const b = r("B");
    expect([b.a12, b.a4, b.minEff, b.max, b.forwardDemand, b.position]).toEqual([60, 80, 3, 4, 75, 120]);
    expect([b.action, b.qty, b.triage]).toEqual(["reorder", 150, "queue"]);
    expect(b.coverAfter).toBeCloseTo(3.6, 10);
    expect([...b.flags].sort()).toEqual(["high_demand", "perishable"]);
    expect(b.assumed.sort()).toEqual(["moq", "unit_cost"]);
  });

  it("C: lead time pushes the order window past the festival; a routine auto order", () => {
    // lead 6 → min_eff = max(6, 8) = 8; order weeks W50–W57 start Mon 7 Dec, after 30 Nov → ×1.
    // F = 100, P = 500, C = 5 < 8 → q = 300 (500 + 300 = 800 ≥ 800), ≤ 2 × 300 → auto; the only auto item → spot-checked.
    const c = r("C");
    expect([c.minEff, c.festivalFactor, c.forwardDemand, c.position, c.cover]).toEqual([8, 1, 100, 500, 5]);
    expect(c.orderWeeks[0]).toBe("2026-W50");
    expect([c.action, c.qty, c.triage, c.spotCheck, c.flags]).toEqual(["reorder", 300, "auto", true, []]);
    expect(c.coverAfter).toBe(8);
  });
});
