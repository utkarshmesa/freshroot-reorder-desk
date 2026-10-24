// C-031 (decided), C-032 (decided) and C-033 (stress-test refinements). Each test names its item.
import { describe, expect, it } from "vitest";
import type { SalesRow, SkuInput } from "@/lib/engine/types";
import { addWeeks, type IsoWeek } from "@/lib/isoweek";
import { isLowCoverWeek, isStockoutWeek } from "@/lib/outcomes";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { Simulator } from "./simulate";
import { replayAll, weekSpan, type SkuData } from "./replay";

const START: IsoWeek = "2025-W01";
const weeksOf = (n: number) => weekSpan(START, addWeeks(START, n - 1));
const W = weeksOf(13 + 64);
const sku = (o: Partial<SkuInput> = {}): SkuInput => ({
  id: "S1",
  name: "S1",
  category: null,
  status: "active",
  firstSaleWeek: null,
  launchEstimateWk: null,
  stdQty: 100,
  moq: 100,
  packSize: null,
  leadTimeWks: 2,
  shelfLifeWks: null,
  perishable: false,
  unitCostInr: null,
  supplierId: "SUP",
  ...o,
});
const flat = (w: IsoWeek[], units: number, id = "S1"): SalesRow[] => w.map((wk) => ({ skuId: id, distributorId: "D1", week: wk, shipped: units, returns: 0 }));
const opts = (w: IsoWeek[]) => ({ rules: DEFAULT_RULES, weeks: w, events: [], distributors: [{ id: "D1", status: "active" as const, startWeek: null, endWeek: null }] });

/** Non-perishable, 100 a week, 400 received every 4 weeks; a full, consistent Sunday stock history. */
function consistent(id = "S1", drop: number[] = []): SkuData {
  const receipts: Partial<Record<IsoWeek, number>> = {};
  const stockHistory: Partial<Record<IsoWeek, number>> = {};
  let oh = 500;
  W.forEach((wk, i) => {
    const r = i % 4 === 0 ? 400 : 0;
    oh += r - 100;
    if (r && !drop.includes(i)) receipts[wk] = r;
    stockHistory[wk] = oh;
  });
  return { sku: sku({ id }), sales: flat(W, 100, id), receipts, stockHistory };
}

/** Perishable, demand 100/wk; actual receipts lumpy (1,600 every 16 weeks): empty shelves and expiry. */
const lumpy = (o: Partial<SkuInput> = {}): SkuData => ({
  sku: sku({ perishable: true, shelfLifeWks: 8, ...o }),
  sales: flat(W, 100, o.id ?? "S1"),
  receipts: Object.fromEntries([13, 29, 45, 61].map((i) => [W[i]!, 1600])),
  stockHistory: { [W[12]!]: 200 },
});

describe("C-031 B: a stockout week is an empty shelf or a week with lost sales", () => {
  it("outcomes: on-hand under one unit, or at least one whole unit lost", () => {
    expect(isStockoutWeek(0, null)).toBe(true);
    expect(isStockoutWeek(0.4, 0)).toBe(true);
    expect(isStockoutWeek(40, 3)).toBe(true); // shelf restocked by Sunday, but sales were lost that week
    expect(isStockoutWeek(40, 0.5)).toBe(false); // C-033 item 5: a fraction of a unit isn't a lost sale
    expect(isStockoutWeek(40, null)).toBe(false); // lost sales unknown: only the empty shelf counts
  });

  it("outcomes: low cover (the old C-017) is reported separately", () => {
    expect(isLowCoverWeek(40, 50)).toBe(true);
    expect(isLowCoverWeek(50, 50)).toBe(false);
  });

  it("simulator: low cover alone is not a stockout", () => {
    const s = new Simulator({ opening: 0, shelfLifeWks: null });
    s.step({ week: "2026-W01", receipt: 100, demand: 60, reference: 100 }); // 40 left, < 1 week: low cover only
    s.step({ week: "2026-W02", receipt: 0, demand: 60, reference: 100 }); // 20 lost, shelf empty
    s.step({ week: "2026-W03", receipt: 100, demand: 99.6, reference: 100 }); // 0.4 left: empty shelf
    const t = s.totals();
    expect(t.stockoutWeeks).toBe(2);
    expect(t.lowCoverWeeks).toBe(3);
  });

  it("C-033 item 5: a week counts as lost sales only from one whole unit", () => {
    const s = new Simulator({ opening: 10, shelfLifeWks: null });
    s.step({ week: "2026-W01", receipt: 0, demand: 10.6, reference: 10 }); // 0.6 lost
    s.step({ week: "2026-W02", receipt: 5, demand: 7, reference: 10 }); // 2 lost
    expect(s.totals().lostSalesWeeks).toBe(1);
  });
});

describe("C-031 tie rule: no worse on stockouts passes", () => {
  it("PASS when neither arm runs out and the rules write off less", () => {
    // Actual: 150 a week against demand 100 → no stockouts, the surplus expires. Rules: steady orders.
    const over: SkuData = { ...lumpy(), receipts: Object.fromEntries(W.slice(13).map((x) => [x, 150])) };
    const s = replayAll([over], opts(W));
    expect(s.actual.stockoutWeeks).toBe(0);
    expect(s.rules.stockoutWeeks).toBe(0);
    expect(s.rules.writeOff).toBeLessThan(s.actual.writeOff);
    expect(s.verdict.result).toBe("PASS");
  });

  it("FAIL when the rules run out more often (stress-test F1: an MOQ wider than the perishable band, cards skipped)", () => {
    // MOQ = 2 weeks of demand; the band (min 4, max 4 weeks of position) only fits it below 2 weeks → late orders.
    const perfect: SkuData = { ...lumpy({ stdQty: 200, moq: 200, shelfLifeWks: 10 }), receipts: Object.fromEntries(W.slice(13).map((x) => [x, 100])) };
    const skip = replayAll([perfect], { ...opts(W), infeasible: "skip" });
    expect(skip.actual.stockoutWeeks).toBe(0);
    expect(skip.rules.stockoutWeeks).toBeGreaterThan(0);
    expect(skip.verdict.result).toBe("FAIL");
    const moq = replayAll([perfect], { ...opts(W), infeasible: "moq" });
    expect(moq.rules.stockoutWeeks).toBeLessThan(skip.rules.stockoutWeeks);
  });
});

describe("C-033 item 4: a measure where both arms are zero is INCONCLUSIVE, never FAIL", () => {
  it("no write-offs in either arm → INCONCLUSIVE with the reason", () => {
    // Non-perishable: the actual arm runs dry, the rules don't; neither can write anything off.
    const dry: SkuData = { sku: sku(), sales: flat(W, 100), receipts: { [W[0]!]: 1 }, stockHistory: { [W[12]!]: 1000 } };
    const s = replayAll([dry], opts(W));
    expect(s.rules.stockoutWeeks).toBeLessThan(s.actual.stockoutWeeks);
    expect(s.actual.writeOff + s.rules.writeOff).toBe(0);
    expect(s.verdict.result).toBe("INCONCLUSIVE");
    expect(s.verdict.reasons.join(" ")).toMatch(/no write-offs in either arm/i);
  });
});

describe("C-032: the drift limit applies to non-perishables only", () => {
  it("a perishable whose real stock can't be tracked doesn't block the verdict", () => {
    const s = replayAll([{ ...lumpy(), stockHistory: { ...Object.fromEntries(W.map((x) => [x, 5000])) } }], opts(W));
    expect(s.verdict.reasons.join(" ")).not.toMatch(/drifts/);
  });

  it("a non-perishable that drifts does", () => {
    // Real stock 5,000 higher in the middle weeks only: the jumps cancel, so no receipts look missing, but the arm drifts.
    const d = consistent();
    const s = replayAll([{ ...d, stockHistory: Object.fromEntries(W.map((x, i) => [x, d.stockHistory[x]! + (i >= 20 && i < 60 ? 5000 : 0)])) }], opts(W));
    expect(s.verdict.result).toBe("NOT DECIDABLE");
    expect(s.verdict.reasons[0]).toMatch(/drifts/);
  });
});

describe("C-033 item 1: stock that appears from nowhere means missing receipts", () => {
  it("a consistent history passes the check", () => {
    const s = replayAll([consistent()], opts(W));
    expect(s.skus[0]!.excluded).toBeNull();
    expect(s.qa.unexplainedChange).toBeCloseTo(0, 6);
  });

  it("a SKU with a missing receipt is left out, and the run is NOT DECIDABLE when it is widespread", () => {
    const s = replayAll([consistent("S1", [20]), consistent("S2")], opts(W));
    expect(s.skus[0]!.excluded).toBe("unexplained_gain");
    expect(s.skus[1]!.excluded).toBeNull();
    expect(s.compared).toBe(1);
    expect(s.verdict.reasons.join(" ")).toMatch(/S1/);

    const all = replayAll([consistent("S1", [20]), consistent("S2", [24])], opts(W));
    expect(all.qa.unexplainedChange).toBeLessThan(-0.03);
    expect(all.verdict.result).toBe("NOT DECIDABLE");
    expect(all.verdict.reasons[0]).toMatch(/appeared from nowhere/);
  });

  it("losses (shrinkage, write-offs SAP doesn't export) don't trigger it", () => {
    const d = consistent();
    const lossy = { ...d, stockHistory: Object.fromEntries(Object.entries(d.stockHistory).map(([k, v], i) => [k, Math.max(0, v! - Math.floor(i / 4))])) };
    const s = replayAll([lossy], opts(W));
    expect(s.skus[0]!.excluded).toBeNull();
    expect(s.qa.unexplainedChange).toBeGreaterThan(0);
  });
});

describe("C-033 items 2 and 3: perishables need a real shelf life and MOQ to count", () => {
  it("a perishable with no shelf life in the master is left out and named", () => {
    const s = replayAll([lumpy({ shelfLifeWks: null }), lumpy({ id: "S2" })], opts(W));
    expect(s.skus[0]!.excluded).toBe("no_shelf_life");
    expect(s.compared).toBe(1);
    expect(s.verdict.reasons.join(" ")).toMatch(/shelf life.*: S1./);
  });

  it("a perishable with no MOQ in the master is left out and named", () => {
    const s = replayAll([lumpy({ moq: null }), lumpy({ id: "S2" })], opts(W));
    expect(s.skus[0]!.excluded).toBe("no_moq");
    expect(s.verdict.reasons.join(" ")).toMatch(/MOQ.*: S1./);
  });

  it("a non-perishable without an MOQ still counts (std qty is its order unit)", () => {
    const s = replayAll([{ ...consistent(), sku: sku({ moq: null }) }], opts(W));
    expect(s.skus[0]!.excluded).toBeNull();
  });

  it("the infeasible-card policy is stated in the verdict", () => {
    expect(replayAll([lumpy()], { ...opts(W), infeasible: "skip" }).verdict.reasons.join(" ")).toMatch(/infeasible perishable cards: skipped/i);
    expect(replayAll([lumpy()], { ...opts(W), infeasible: "moq" }).verdict.reasons.join(" ")).toMatch(/infeasible perishable cards: ordered at the MOQ/i);
  });
});

describe("C-033 item 6: the known bias is stated when ordered_units is missing", () => {
  it("states it without ordered units", () => {
    expect(replayAll([lumpy()], opts(W)).verdict.reasons.join(" ")).toMatch(/under-counted/);
  });
  it("doesn't with them", () => {
    const d = { ...lumpy(), ordered: Object.fromEntries(W.map((x) => [x, 100])) };
    expect(replayAll([d], opts(W)).verdict.reasons.join(" ")).not.toMatch(/under-counted/);
  });
});

describe("C-033 item 7: supplier-clustered intervals, as a check", () => {
  it("are reported with the same estimate as the SKU interval", () => {
    const s = replayAll([lumpy(), lumpy({ id: "S2", supplierId: "SUP2" }), lumpy({ id: "S3" })], opts(W));
    expect(s.diffBySupplier.stockoutWeeks.estimate).toBe(s.diff.stockoutWeeks.estimate);
    expect(s.diffBySupplier.writeOff.estimate).toBeCloseTo(s.diff.writeOff.estimate, 6);
    expect(s.suppliers).toBe(2);
  });
});
