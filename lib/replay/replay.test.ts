// REPLAY_SPEC §2–4 on synthetic SKUs whose right answer is known.
import { describe, expect, it } from "vitest";
import type { EventInput, SalesRow, SkuInput } from "@/lib/engine/types";
import { addWeeks, mondayOf, type IsoWeek } from "@/lib/isoweek";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { bootstrapSum, rebuildStock, replayAll, replaySku, weekSpan, type SkuData } from "./replay";

const START: IsoWeek = "2025-W01";
const weeksOf = (n: number) => weekSpan(START, addWeeks(START, n - 1));
const sku = (o: Partial<SkuInput> = {}): SkuInput => ({
  id: "S1",
  name: "S1",
  category: null,
  status: "active",
  firstSaleWeek: null,
  launchEstimateWk: null,
  stdQty: 300,
  moq: null,
  packSize: null,
  leadTimeWks: 2,
  shelfLifeWks: null,
  perishable: false,
  unitCostInr: null,
  supplierId: "SUP",
  ...o,
});
const flatSales = (weeks: IsoWeek[], units: number | ((i: number) => number), id = "S1"): SalesRow[] =>
  weeks.map((w, i) => ({ skuId: id, distributorId: "D1", week: w, shipped: typeof units === "number" ? units : units(i), returns: 0 }));
const opts = (weeks: IsoWeek[], events: EventInput[] = []) => ({ rules: DEFAULT_RULES, weeks, events, distributors: [{ id: "D1", status: "active" as const, startWeek: null, endWeek: null }] });

describe("stock history (D20)", () => {
  it("rebuilds forwards and backwards from one snapshot", () => {
    const w = weeksOf(4);
    // snapshot 500 at week 2 (index 1); net sales 100/wk; a 300 receipt arrives in week 3.
    const r = rebuildStock(w, [100, 100, 100, 100], [0, 0, 300, 0], { [w[1]!]: 500 });
    expect(r.onHand).toEqual([600, 500, 700, 600]);
    expect(r.source).toBe("rebuilt");
  });

  it("no snapshot at all → unknown (no actual arm)", () => {
    expect(rebuildStock(weeksOf(2), [1, 1], [0, 0], {}).source).toBe("none");
  });
});

describe("demand imputation in stockout weeks (REPLAY_SPEC §2)", () => {
  it("a week the shelf was empty uses the clean average, not the capped sales", () => {
    const w = weeksOf(30);
    const sales = flatSales(w, (i) => (i === 20 ? 10 : 100)); // week 20 sold only 10 because stock ran out
    const stockHistory = Object.fromEntries(w.map((x, i) => [x, i === 20 ? 0 : 1000]));
    const r = replaySku({ sku: sku(), sales, receipts: {}, stockHistory }, opts(w));
    expect(r.stats.imputedWeeks).toBe(1);
    expect(r.actual!.demand).toBe(17 * 100); // weeks 13–29, with week 20 imputed back to 100
  });
});

describe("rules arm vs actual arm", () => {
  it("orders arrive exactly after the lead time, and units are conserved in both arms", () => {
    const w = weeksOf(40);
    const sales = flatSales(w, 100);
    // Actual: no receipts after a 1,000 opening at the first simulated week → runs out.
    const r = replaySku({ sku: sku({ leadTimeWks: 3 }), sales, receipts: {}, stockHistory: { [w[12]!]: 1000 } }, opts(w));
    expect(r.stockSource).toBe("rebuilt");
    for (const arm of [r.actual!, r.rules!]) expect(1000 + arm.received).toBeCloseTo(arm.sold + arm.writeOff + arm.closingOnHand, 6);
    expect(r.actual!.stockoutWeeks).toBeGreaterThan(10);
    expect(r.rules!.stockoutWeeks).toBeLessThan(r.actual!.stockoutWeeks);
    expect(r.rules!.orders).toBeGreaterThan(0);
  });

  it("an order placed in week i arrives in week i + lead time", () => {
    const w = weeksOf(20);
    // Opening 400 at the first simulated week: cover 4 < 6 → order at once; lead 3.
    const r = replaySku({ sku: sku({ leadTimeWks: 3 }), sales: flatSales(w, 100), receipts: {}, stockHistory: { [w[12]!]: 400 } }, opts(w));
    expect(r.weeklyTriage[0]!.action).toBe("reorder");
    // 400 lasts 4 weeks (W14–W17 → 0 after week index 16); the first order lands in week index 16 and prevents the zero.
    expect(r.rules!.lost).toBe(0);
  });

  it("Raghav's literal festival reading double-counts: festival-month history looks like high demand (D6)", () => {
    const w = weekSpan("2025-W27", "2025-W52");
    const oct: EventInput = { type: "festival", startDate: "2025-10-01", endDate: "2025-11-30", skuIds: [], distributorIds: [], upliftPct: 25, preloadWks: 3 };
    // A real festival lift of 15%: under the production reading a4/a12 stays below 1.2 (no high demand);
    // uplifting that history by another 25% pushes it over (1.4375 vs about 1.15): the stress test's double count.
    const inFestival = (wk: IsoWeek) => { const m = mondayOf(wk); return m >= "2025-10-01" && m <= "2025-11-30"; };
    const data: SkuData = { sku: sku(), sales: flatSales(w, (i) => (inFestival(w[i]!) ? 115 : 100)), receipts: {}, stockHistory: { [w[12]!]: 5000 } };
    const any = replaySku(data, { ...opts(w, [oct]), reading: "any" });
    const literal = replaySku(data, { ...opts(w, [oct]), reading: "literal" });
    expect(any.stats.queueWeeks).toBe(0);
    expect(literal.stats.queueWeeks).toBeGreaterThan(0);
  });
});

describe("plain-distributor aggregation is exact", () => {
  it("gives the same results as running every distributor separately", () => {
    const w = weeksOf(40);
    const sales: SalesRow[] = [];
    w.forEach((wk, i) => {
      for (let d = 0; d < 6; d++) if ((i + d) % 3 !== 0) sales.push({ skuId: "S1", distributorId: `D${d}`, week: wk, shipped: 20 + ((i * 7 + d * 13) % 30), returns: d === 2 ? 1 : 0 });
    });
    const distributors = [
      { id: "D0", status: "active" as const, startWeek: null, endWeek: null },
      { id: "D5", status: "active" as const, startWeek: w[20]!, endWeek: null }, // a new distributor stays separate (D2)
    ];
    const data: SkuData = { sku: sku({ stdQty: 100 }), sales, receipts: {}, stockHistory: { [w[12]!]: 400 } };
    const base = { rules: DEFAULT_RULES, weeks: w, events: [], distributors };
    const a = replaySku(data, { ...base, aggregatePlainDistributors: true });
    const b = replaySku(data, { ...base, aggregatePlainDistributors: false });
    expect(a.rules).toEqual(b.rules);
    expect(a.weeklyTriage).toEqual(b.weeklyTriage);
  });
});

describe("the gate verdict", () => {
  // Perishable, demand 100/wk. Actual: a 1,600 lot every 16 weeks → half expires, then empty shelves.
  // Rules: steady small orders → fewer stockouts and fewer write-offs → PASS.
  const w = weeksOf(13 + 64);
  const receipts = Object.fromEntries([13, 29, 45, 61].map((i) => [w[i]!, 1600]));
  const data: SkuData = { sku: sku({ perishable: true, shelfLifeWks: 8, stdQty: 100, moq: 100 }), sales: flatSales(w, 100), receipts, stockHistory: { [w[12]!]: 200 } };

  it("PASS when the rules beat the actual arm on both measures over a long enough replay", () => {
    const s = replayAll([data], opts(w));
    expect(s.replayWeeks).toBe(64);
    expect(s.actual.writeOff).toBeGreaterThan(0);
    expect(s.rules.writeOff).toBeLessThan(s.actual.writeOff);
    expect(s.rules.stockoutWeeks).toBeLessThan(s.actual.stockoutWeeks);
    expect(s.verdict.result).toBe("PASS");
  });

  it("NOT DECIDABLE for a short (smoke) replay, whatever the numbers", () => {
    const short = weeksOf(30);
    const s = replayAll([{ ...data, sales: flatSales(short, 100) }], opts(short));
    expect(s.verdict.result).toBe("NOT DECIDABLE");
    expect(s.verdict.reasons[0]).toMatch(/smoke test/);
  });

  it("not a PASS when the actual arm is already perfect: nothing to improve (C-033 item 4; FAIL cases in c033.test.ts)", () => {
    // Actual receipts already perfect: 100 a week, no stockouts, nothing expires → rules can't do better.
    const perfect = Object.fromEntries(w.slice(13).map((x) => [x, 100]));
    const s = replayAll([{ ...data, receipts: perfect }], opts(w));
    expect(s.actual.stockoutWeeks + s.actual.writeOff).toBe(0);
    expect(s.verdict.result).toBe("INCONCLUSIVE");
  });
});

describe("bootstrap interval", () => {
  it("is deterministic and brackets the estimate", () => {
    const d = [-3, -1, -4, -1, -5, -9, -2, -6];
    const a = bootstrapSum(d);
    expect(a).toEqual(bootstrapSum(d));
    expect(a.estimate).toBe(-31);
    expect(a.low).toBeLessThanOrEqual(-31);
    expect(a.high).toBeGreaterThanOrEqual(-31);
    expect(a.high).toBeLessThan(0);
  });
});
