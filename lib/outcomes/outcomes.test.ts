import { describe, expect, it } from "vitest";
import { agreement, isLowCoverWeek, manualOrders, shadowComparison, isStockoutWeek, pilotVsManual, stockoutRate, workingDaysBetween } from "./index";

describe("OC-01 stockout week (C-031 B)", () => {
  it("on-hand 0 is a stockout", () => expect(isStockoutWeek(0, null)).toBe(true));
  it("a week with at least one lost unit is a stockout, even if the shelf is restocked by Sunday", () => expect(isStockoutWeek(40, 1)).toBe(true));
  it("a lean shelf with nothing lost is not", () => expect(isStockoutWeek(40, 0)).toBe(false));
  it("a large open PO can't hide it: only shelf stock and lost units are inputs", () => {
    // The function has no position or open-PO argument at all; the caller passes SAP on-hand.
    expect(isStockoutWeek.length).toBe(2);
  });

  it("low cover (C-017) is a separate warning: below one week of raw demand, not forward demand", () => {
    expect(isLowCoverWeek(40, 50)).toBe(true);
    expect(isLowCoverWeek(110, 100)).toBe(false); // with a +25% forecast (125) this would wrongly count
  });

  it("OC-02 the same function gives identical results for both arms on mirrored data", () => {
    const pilot = [{ skuId: "P1", onHand: 0, lostUnits: null, rawA12: 10 }, { skuId: "P2", onHand: 5, lostUnits: 0, rawA12: 10 }];
    const manual = pilot.map((r) => ({ ...r, skuId: r.skuId.replace("P", "M") }));
    expect(stockoutRate(pilot)).toEqual(stockoutRate(manual));
    expect(stockoutRate(pilot)).toEqual({ stockoutWeeks: 1, lowCoverWeeks: 2, skuWeeks: 2, rate: 0.5 });
  });
});

describe("OC-03 order speed in working days", () => {
  it("commit Monday 08:30 IST, issued Tuesday = 1; Friday → Monday = 1 (weekend skipped)", () => {
    expect(workingDaysBetween("2026-10-19T03:00:00Z", "2026-10-20T09:00:00Z")).toBe(1);
    expect(workingDaysBetween("2026-10-23T05:00:00Z", "2026-10-26T05:00:00Z")).toBe(1);
    expect(workingDaysBetween("2026-10-19T03:00:00Z", "2026-10-19T12:00:00Z")).toBe(0);
  });
  it("uses IST dates: 23:00 UTC Monday is already Tuesday in IST", () => {
    expect(workingDaysBetween("2026-10-19T03:00:00Z", "2026-10-19T23:00:00Z")).toBe(1);
  });
});

describe("OC-04 pilot vs manual and shadow agreement", () => {
  it("splits by holdout with one definition", () => {
    const r = pilotVsManual([
      { skuId: "A", week: "2026-W43", holdout: false, onHand: 0, lostUnits: null, rawA12: 10 },
      { skuId: "A", week: "2026-W44", holdout: false, onHand: 50, lostUnits: null, rawA12: 10 },
      { skuId: "B", week: "2026-W43", holdout: true, onHand: 0, lostUnits: null, rawA12: 10 },
    ]);
    expect(r.pilot).toEqual({ stockoutWeeks: 1, lowCoverWeeks: 1, skuWeeks: 2, rate: 0.5 });
    expect(r.manual.rate).toBe(1);
  });
  it("F6: agreement is unit-weighted: approved-as-recommended units over decided units", () => {
    expect(agreement([{ status: "approved", units: 600 }, { status: "changed", units: 200 }, { status: "rejected", units: 200 }, { status: "reapproved", units: 999 }])).toEqual({ decided: 1000, approved: 600, pct: 60 });
    expect(agreement([]).pct).toBeNull();
  });
});

describe("C-038 shadow: the system against what Raghav actually ordered", () => {
  const lines = [
    { poId: "p1", skuId: "A", ordered: 300, placedDate: "2026-10-21", reference: "phone" },
    { poId: "p1", skuId: "A", ordered: 300, placedDate: "2026-10-21", reference: "phone" }, // seen again by a later read
    { poId: "p2", skuId: "B", ordered: 100, placedDate: "2026-10-27", reference: null }, // next week
    { poId: "p3", skuId: "C", ordered: 500, placedDate: "2026-10-20", reference: "FR-2026-W43-DIST001" }, // system draft
    { poId: "p4", skuId: "D", ordered: 50, placedDate: null, reference: null }, // no date: can't place it in a week
  ];
  it("manual orders: non-system POs dated in the week, each PO line once", () => {
    expect([...manualOrders(lines, "2026-10-19", "2026-10-25")]).toEqual([["A", 300]]);
  });
  it("compares the call (order or not) and the units", () => {
    expect(shadowComparison([{ skuId: "A", system: 750, manual: 300 }, { skuId: "B", system: 0, manual: 0 }, { skuId: "C", system: 200, manual: 0 }, { skuId: "D", system: 0, manual: 80 }])).toEqual({
      skuWeeks: 4, sameDecision: 2, sameDecisionPct: 50, systemUnits: 950, manualUnits: 380, systemOnly: ["C"], manualOnly: ["D"],
    });
  });
});
