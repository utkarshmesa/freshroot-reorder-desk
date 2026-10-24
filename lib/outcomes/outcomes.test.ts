import { describe, expect, it } from "vitest";
import { isLowCoverWeek, isStockoutWeek, stockoutRate } from "./index";

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
