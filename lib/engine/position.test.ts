// D5 / D15 stock position (ZO-01…03, ST-02, ZO-15, RN-15): count each unit once.
import { describe, expect, it } from "vitest";
import { position } from "./position";
import type { PoLine, Receipt } from "./types";

const RUN = "2026-W43"; // Monday 19 Oct 2026; snapshot Sunday 18 Oct 23:59
const line = (over: Partial<PoLine>): PoLine => ({ poId: "p1", poNumber: "PO-1", status: "open", skuId: "S1", ordered: 0, received: 0, expectedDate: null, ...over });
const receipt = (date: string, qty: number): Receipt => ({ poId: "p1", skuId: "S1", date, qty });

describe("position", () => {
  it("ZO-01 open PO counted; drafts never; an issued system (FR-) PO is counted", () => {
    const p = position("S1", 100, [line({ ordered: 300 }), line({ poNumber: "PO-2", status: "draft", ordered: 500 }), line({ poNumber: "FR-2026-W42-DIST001", ordered: 150 })], [], RUN);
    expect(p.openPoQty).toBe(450);
    expect(p.position).toBe(550);
  });

  it("ZO-03 partial, cancelled and over-received lines", () => {
    const p = position(
      "S1",
      0,
      [line({ status: "partially_received", ordered: 300, received: 100 }), line({ status: "cancelled", ordered: 400 }), line({ status: "received", ordered: 100, received: 120 })],
      [],
      RUN,
    );
    expect(p.openPoQty).toBe(200);
  });

  it("ZO-02 / ST-02 a receipt dated Monday is added back; Sunday's is not", () => {
    const p = position("S1", 100, [], [receipt("2026-10-18", 40), receipt("2026-10-19", 60), receipt("2026-10-21", 5)], RUN);
    expect(p.receiptsAfterSnapshot).toBe(65);
    expect(p.position).toBe(165);
  });

  it("ZO-15 a PO fully received on Monday still adds its Monday receipt", () => {
    const p = position("S1", 100, [line({ status: "received", ordered: 200, received: 200 })], [receipt("2026-10-19", 200)], RUN);
    expect(p.openPoQty).toBe(0);
    expect(p.position).toBe(300);
  });

  it("only counts the SKU asked for", () => {
    const p = position("S1", 0, [line({ skuId: "S2", ordered: 999 })], [{ poId: "x", skuId: "S2", date: "2026-10-20", qty: 9 }], RUN);
    expect(p.position).toBe(0);
  });

  it("RN-15 open quantity past its expected date is flagged overdue (C-026), and P is unchanged", () => {
    const p = position("S1", 0, [line({ ordered: 100, expectedDate: "2026-10-12" }), line({ poNumber: "PO-9", ordered: 50, expectedDate: "2026-10-30" })], [], RUN);
    expect(p.position).toBe(150);
    expect(p.lines.map((l) => l.overdue)).toEqual([true, false]);
  });
});
