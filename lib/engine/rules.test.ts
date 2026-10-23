// Rule-by-rule tests (TEST_PLAN §3.2 RU-02…RU-19, §3.5 ST-03, ST-05). Small synthetic inputs, hand-checked numbers.
import { describe, expect, it } from "vitest";
import { addWeeks, mondayOf, sundayOf } from "@/lib/isoweek";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { oneSku } from "@/tests/helpers/engine";
import { runEngine } from "./index";
import type { EngineInput, EventInput, SalesRow } from "./types";

const RUN = "2026-W30";
const flat = (n: number, units: number) => Array<number>(n).fill(units);
const rec = (input: EngineInput, id = "S1") => runEngine(input).recommendations.find((r) => r.skuId === id)!;
/** Sales rows for one distributor; weekly[last] is the week before `runWeek`. */
const rows = (dist: string, weekly: number[], runWeek = RUN, sku = "S1"): SalesRow[] =>
  weekly.map((u, i) => ({ skuId: sku, distributorId: dist, week: addWeeks(runWeek, -(weekly.length - i)), shipped: u, returns: 0 }));
const hold = (from: string, to: string, skuIds: string[], distributorIds: string[] = []): EventInput => ({
  type: "hold",
  startDate: mondayOf(from),
  endDate: sundayOf(to),
  skuIds,
  distributorIds,
  upliftPct: null,
  preloadWks: 0,
});
const festival = (start: string, end: string): EventInput => ({ type: "festival", startDate: start, endDate: end, skuIds: [], distributorIds: [], upliftPct: 25, preloadWks: 3 });

describe("RU-02 perishable infeasible goes to the queue", () => {
  it("min_eff above max (lead time 4 → min 6 > max 4)", () => {
    const r = rec(oneSku({ perishable: true, leadTimeWks: 4 }, flat(12, 100), { onHand: { S1: 100 } }));
    expect([r.minEff, r.max]).toEqual([6, 4]);
    expect(r.flags).toContain("infeasible");
    expect(r.triage).toBe("queue");
    expect(r.qty).toBe(0);
  });

  it("perishable cap below MOQ, with both choices on the card (C-005, C-023i)", () => {
    const r = rec(oneSku({ perishable: true, stdQty: 500 }, flat(12, 100), { onHand: { S1: 250 } }));
    expect([r.minEff, r.max, r.forwardDemand, r.position]).toEqual([4, 4, 100, 250]);
    expect(r.flags).toEqual(expect.arrayContaining(["perishable", "infeasible"]));
    expect(r.qty).toBe(0);
    expect(r.triage).toBe("queue");
    expect(r.infeasibleOptions).toEqual({ orderMoq: { qty: 500, coverAfter: 7.5 }, skip: { daysToStockout: 17.5 } });
  });
});

describe("RU-03 high demand + pause gives the conflict flag", () => {
  it("a4 well above a12 while cover is above the band", () => {
    const r = rec(oneSku({}, [...flat(8, 100), ...flat(4, 150)], { onHand: { S1: 3000 } }));
    expect(r.a12).toBeCloseTo(116.667, 3);
    expect(r.a4).toBe(150);
    expect(r.action).toBe("pause");
    expect(r.flags).toEqual(expect.arrayContaining(["high_demand", "conflict"]));
    expect(r.triage).toBe("queue");
  });
});

describe("RU-04 festival window follows the weeks being ordered for (C-004)", () => {
  // Festival 1–30 Nov 2026, pre-load from Sun 11 Oct. Non-perishable, lead 2, min_eff 6 → window = run+2 … run+7.
  const nov = festival("2026-11-01", "2026-11-30");
  const f = (runWeek: string) => rec(oneSku({}, flat(12, 100), { runWeek, events: [nov], onHand: { S1: 1000 } }));

  it.each([
    ["2026-W33", 1, "window W35–W40 ends Sun 4 Oct, before the pre-load"],
    ["2026-W34", 1.25, "window reaches W41 (5–11 Oct), which touches the pre-load start"],
    ["2026-W47", 1.25, "window starts W49 (Mon 30 Nov), the festival's last day"],
    ["2026-W48", 1, "window starts W50, after the festival"],
  ])("%s → ×%s (%s)", (runWeek, factor) => {
    expect(f(runWeek).festivalFactor).toBe(factor);
  });

  it("lists the weeks being ordered for", () => {
    expect(f("2026-W47").orderWeeks).toEqual(["2026-W49", "2026-W50", "2026-W51", "2026-W52", "2026-W53", "2027-W01"]);
  });

  it("never uplifts history: high demand uses raw sales", () => {
    const r = f("2026-W47");
    expect([r.a12, r.trendA12, r.forwardDemand]).toEqual([100, 100, 125]);
    expect(r.flags).not.toContain("high_demand");
  });

  it("the replay-only 'share' reading scales by festival weeks in the window (RN-11)", () => {
    const r = rec(oneSku({}, flat(12, 100), { runWeek: "2026-W47", events: [nov], onHand: { S1: 1000 }, festivalReading: "share" }));
    expect(r.festivalFactor).toBeCloseTo(1 + 0.25 / 6, 10);
  });
});

describe("RU-05 new SKU follows D1", () => {
  const newSku = (age: number, launch: number | null = 200) =>
    rec(oneSku({ firstSaleWeek: addWeeks(RUN, -age), launchEstimateWk: launch }, flat(age, 100), { onHand: { S1: 5000 } }));

  it("weeks 1–4: forward demand = launch estimate, always queued", () => {
    const r = newSku(2);
    expect(r.forwardDemand).toBe(200);
    expect(r.flags).toContain("new_sku");
    expect(r.flags).not.toContain("short_history");
    expect(r.triage).toBe("queue");
  });

  it("weeks 5–12: linear blend of estimate and actuals", () => {
    expect(newSku(6).forwardDemand).toBe(0.25 * 100 + 0.75 * 200);
    expect(newSku(12).forwardDemand).toBe(100);
  });

  it("week 13 on: full rules, no longer new", () => {
    const r = newSku(13);
    expect(r.flags).not.toContain("new_sku");
    expect(r.forwardDemand).toBe(100);
  });

  it("missing launch estimate: actuals, flagged", () => {
    const r = newSku(3, null);
    expect(r.forwardDemand).toBe(100);
    expect(r.flags).toEqual(expect.arrayContaining(["new_sku", "no_launch_estimate"]));
  });
});

describe("RU-06 new and inactive distributors follow D2 / D3 (C-016, C-028)", () => {
  const base = (over: Partial<EngineInput>) => oneSku({}, [], { onHand: { S1: 2000 }, ...over });

  it("a new distributor's first 4 weeks are ignored; weeks 5–12 count for demand but not the trend", () => {
    const start = addWeeks(RUN, -6); // 6 weeks of history: 4 ignored + 2 counted
    const r = rec(
      base({
        distributors: [
          { id: "D1", status: "active", startWeek: null, endWeek: null },
          { id: "D2", status: "active", startWeek: start, endWeek: null },
        ],
        sales: [...rows("D1", flat(12, 100)), ...rows("D2", [500, 500, 500, 500, 50, 50])],
      }),
    );
    expect(r.a12).toBe(150); // D1 100 + D2 mean of its 2 eligible weeks (50)
    expect(r.a4).toBe(150);
    expect([r.trendA12, r.trendA4]).toEqual([100, 100]);
    expect(r.flags).not.toContain("high_demand");
  });

  it("an inactive distributor contributes nothing once the run reaches its end week", () => {
    const input = (endWeek: string) =>
      base({
        distributors: [
          { id: "D1", status: "active", startWeek: null, endWeek: null },
          { id: "D3", status: "inactive", startWeek: null, endWeek },
        ],
        sales: [...rows("D1", flat(12, 100)), ...rows("D3", [...flat(9, 80), 0, 0, 0])],
      });
    expect(rec(input(addWeeks(RUN, -3))).a12).toBe(100);
    expect(rec(input(addWeeks(RUN, 2))).a12).toBe(160); // still active until W32: (9×80)/12 = 60 + 100
  });

  it("an inactive SKU gets no order", () => {
    const r = rec(oneSku({ status: "inactive" }, flat(12, 100), { onHand: { S1: 0 } }));
    expect(r.action).toBe("none");
    expect(r.qty).toBe(0);
    expect(r.flags).toContain("inactive");
  });
});

describe("RU-07 a hold excludes weeks and queues the SKU", () => {
  it("held distributor-weeks leave the averages; the SKU is flagged and queued", () => {
    const sales = rows("D1", [...flat(10, 100), 900, 900]); // one-off bulk order in the last 2 weeks
    const r = rec(oneSku({}, [], { sales, onHand: { S1: 1000 }, events: [hold(addWeeks(RUN, -2), addWeeks(RUN, -1), ["S1"], ["D1"])] }));
    expect(r.a4).toBe(100);
    expect(r.a12).toBe(100);
    expect(r.flags).toContain("hold");
    expect(r.flags).not.toContain("high_demand");
    expect(r.triage).toBe("queue");
  });

  it("a SKU-wide hold (promotion) drops those weeks for every distributor and looks further back", () => {
    const sales = rows("D1", [...flat(13, 100), 400]);
    const r = rec(oneSku({}, [], { sales, onHand: { S1: 1000 }, events: [hold(addWeeks(RUN, -1), addWeeks(RUN, -1), ["S1"])] }));
    expect(r.cleanWeeks).toBe(13);
    expect(r.a12).toBe(100);
  });

  it("a distributor-only hold (credit hold) trims averages but doesn't queue the SKU", () => {
    const r = rec(oneSku({}, [], { sales: rows("D1", flat(12, 100)), onHand: { S1: 500 }, events: [hold(addWeeks(RUN, -2), addWeeks(RUN, -1), [], ["D1"])] }));
    expect(r.flags).not.toContain("hold");
    expect(r.triage).toBe("auto");
  });
});

describe("RU-08 to RU-12", () => {
  it("RU-08 fewer than 8 clean weeks → queue", () => {
    const r = rec(oneSku({}, flat(7, 100), { onHand: { S1: 100 } }));
    expect(r.cleanWeeks).toBe(7);
    expect(r.flags).toContain("short_history");
    expect(r.triage).toBe("queue");
  });

  it("RU-09 D7: minimum cover is at least lead time + 2", () => {
    expect(rec(oneSku({ leadTimeWks: 5 }, flat(12, 100), { onHand: { S1: 2000 } })).minEff).toBe(7);
    expect(rec(oneSku({ leadTimeWks: 1 }, flat(12, 100), { onHand: { S1: 2000 } })).minEff).toBe(6);
  });

  it("RU-10 MOQ is a minimum, not a multiple (C-023a); pack size rounds up", () => {
    // need 6×100 − 100 = 500: std steps 100…500
    expect(rec(oneSku({}, flat(12, 100), { onHand: { S1: 100 } })).qty).toBe(500);
    expect(rec(oneSku({ moq: 650 }, flat(12, 100), { onHand: { S1: 100 } })).qty).toBe(650);
    expect(rec(oneSku({ packSize: 120 }, flat(12, 100), { onHand: { S1: 100 } })).qty).toBe(600);
  });

  it("RU-10 a capped perishable qty that isn't a pack multiple is flagged", () => {
    const r = rec(oneSku({ perishable: true, stdQty: 50, packSize: 40 }, flat(12, 100), { onHand: { S1: 190 } }));
    expect(r.qty).toBe(210); // cap = 4×100 − 190
    expect(r.flags).toEqual(expect.arrayContaining(["capped_at_perishable_max", "pack_mismatch"]));
  });

  it("RU-11 borderline: within 5% of min_eff or max", () => {
    expect(rec(oneSku({}, flat(12, 100), { onHand: { S1: 620 } })).flags).toContain("borderline"); // 6.2 vs 6
    expect(rec(oneSku({}, flat(12, 100), { onHand: { S1: 1380 } })).flags).toContain("borderline"); // 13.8 vs 14
    expect(rec(oneSku({}, flat(12, 100), { onHand: { S1: 700 } })).flags).not.toContain("borderline");
  });

  it("RU-12 zero-stock weeks are dropped only when stock history exists (C-007)", () => {
    const weekly = [...flat(11, 100), 10]; // last week sold 10 because the shelf was empty
    const last = addWeeks(RUN, -1);
    const withHistory = rec(oneSku({}, [...flat(1, 100), ...weekly], { onHand: { S1: 500 }, stockHistory: { S1: { [last]: 0 } } }));
    expect(withHistory.a12).toBe(100);
    const out = runEngine(oneSku({}, weekly, { onHand: { S1: 500 } }));
    expect(out.recommendations[0]!.a12).toBe(92.5);
    expect(out.notes).toContain("Zero-stock exclusion skipped for 1 SKU(s): no weekly stock history yet (C-007).");
  });
});

describe("RU-15 to RU-17 aggregation across distributors (C-016)", () => {
  it("RU-15 sums each distributor's mean over its own eligible weeks", () => {
    const r = rec(
      oneSku({}, [], {
        distributors: [
          { id: "D1", status: "active", startWeek: null, endWeek: null },
          { id: "D2", status: "active", startWeek: null, endWeek: null },
        ],
        sales: [...rows("D1", flat(12, 100)), ...rows("D2", [...flat(10, 40), 999, 999])],
        events: [hold(addWeeks(RUN, -2), addWeeks(RUN, -1), ["S1"], ["D2"])],
        onHand: { S1: 2000 },
      }),
    );
    expect(r.a12).toBe(140);
  });

  it("RU-16 a missing distributor-week counts as 0 inside its active window", () => {
    const sparse = rows("D1", [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]).filter((_, i) => i % 2 === 0);
    expect(rec(oneSku({}, [], { sales: sparse, onHand: { S1: 2000 } })).a12).toBe(50);
  });

  it("RU-17 negative net (returns) is kept; averages floor at 0; short history uses what exists", () => {
    const s: SalesRow[] = rows("D1", flat(12, 10)).map((r, i) => (i === 11 ? { ...r, returns: 200 } : r));
    expect(rec(oneSku({}, [], { sales: s, onHand: { S1: 50 } })).a4).toBe(0);
    expect(rec(oneSku({}, flat(9, 100), { onHand: { S1: 2000 } })).a12).toBe(100);
  });
});

describe("RU-19 and ST-05", () => {
  it("RU-19 days to stockout uses shelf stock only (the desk sorts by it, milestone 5)", () => {
    const input = oneSku({}, flat(12, 100), {
      onHand: { S1: 140 },
      poLines: [{ poId: "p", poNumber: "PO-1", status: "open", skuId: "S1", ordered: 900, received: 0, expectedDate: null }],
    });
    const r = rec(input);
    expect(r.position).toBe(1040);
    expect(r.daysToStockout).toBeCloseTo(9.8, 10);
  });

  it("ST-05 missing lead time / MOQ / shelf life / cost use D18 defaults and say so", () => {
    const r = rec(oneSku({ perishable: true }, flat(12, 100), { onHand: { S1: 380 } }));
    expect([r.leadTimeWks, r.moq, r.max]).toEqual([2, 100, 4]);
    expect(r.assumed.sort()).toEqual(["lead_time", "moq", "shelf_life", "unit_cost"]);
    const known = rec(oneSku({ perishable: true, leadTimeWks: 1, moq: 50, shelfLifeWks: 6, unitCostInr: 20 }, flat(12, 100), { onHand: { S1: 380 } }));
    expect(known.assumed).toEqual([]);
    expect(known.max).toBe(3); // min(4, 0.5 × 6)
  });

  it("missing stock row → blocked, never ordered (fail closed per SKU)", () => {
    const r = rec(oneSku({}, flat(12, 100), { onHand: {} }));
    expect([r.action, r.qty, r.flags]).toEqual(["blocked", 0, ["no_stock"]]);
  });

  it("an unmapped SKU passed in as blocked is never ordered", () => {
    const r = rec(oneSku({}, flat(12, 100), { onHand: { S1: 10 }, blocked: { S1: "No Zoho item" } }));
    expect([r.action, r.qty, r.blockedReason]).toEqual(["blocked", 0, "No Zoho item"]);
  });

  it("uses the rule parameters it is given (rule versions, D12)", () => {
    const r = rec(oneSku({}, flat(12, 100), { onHand: { S1: 650 }, rules: { ...DEFAULT_RULES, bands: { ...DEFAULT_RULES.bands, nonPerishable: { minWks: 8, maxWks: 14 } } } }));
    expect(r.minEff).toBe(8);
    expect(r.action).toBe("reorder");
  });
});
