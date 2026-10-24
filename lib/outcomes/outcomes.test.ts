import { describe, expect, it } from "vitest";
import { agreement, isLowCoverWeek, isStockoutWeek, pilotVsManual, stockoutRate, workingDaysBetween } from "./index";

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
  it("agreement counts approved-as-recommended among decided cards", () => {
    expect(agreement([{ status: "approved" }, { status: "changed" }, { status: "rejected" }, { status: "reapproved" }])).toEqual({ decided: 3, approved: 1, pct: 33.3 });
    expect(agreement([]).pct).toBeNull();
  });
});
