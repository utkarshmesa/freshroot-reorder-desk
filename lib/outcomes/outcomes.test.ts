import { describe, expect, it } from "vitest";
import { isStockoutWeek, stockoutRate } from "./index";

describe("OC-01 stockout week (C-017)", () => {
  it("on-hand 0 is a stockout", () => expect(isStockoutWeek(0, 50)).toBe(true));
  it("on-hand below one week of raw demand is a stockout", () => expect(isStockoutWeek(40, 50)).toBe(true));
  it("one week or more of shelf stock is not", () => expect(isStockoutWeek(50, 50)).toBe(false));
  it("a large open PO can't hide it: only shelf stock is an input", () => {
    // The function has no position or open-PO argument at all; the caller passes SAP on-hand.
    expect(isStockoutWeek.length).toBe(2);
  });
  it("the festival uplift doesn't change it: raw a12, not forward demand", () => {
    expect(isStockoutWeek(110, 100)).toBe(false); // with a +25% forecast (125) this would wrongly count
  });

  it("OC-02 the same function gives identical results for both arms on mirrored data", () => {
    const pilot = [{ skuId: "P1", onHand: 0, rawA12: 10 }, { skuId: "P2", onHand: 100, rawA12: 10 }];
    const manual = pilot.map((r) => ({ ...r, skuId: r.skuId.replace("P", "M") }));
    expect(stockoutRate(pilot)).toEqual(stockoutRate(manual));
    expect(stockoutRate(pilot)).toEqual({ stockoutWeeks: 1, skuWeeks: 2, rate: 0.5 });
  });
});
