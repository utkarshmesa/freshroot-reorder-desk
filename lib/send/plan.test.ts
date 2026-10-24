// Send to procurement, pure part (ARCHITECTURE §4.1, C-015): which suppliers can be drafted now.
import { describe, expect, it } from "vitest";
import { draftReference, effectiveMode, planSend, type SendLine } from "./plan";

const line = (o: Partial<SendLine>): SendLine => ({ recId: 1, skuId: "SKU001", supplierId: "DIST001", state: "auto", qty: 100, ...o });

describe("planSend", () => {
  it("a supplier with any queued card waits; the others are ready", () => {
    const p = planSend(
      [
        line({ recId: 1, supplierId: "A", state: "auto" }),
        line({ recId: 2, supplierId: "A", state: "queued" }),
        line({ recId: 3, supplierId: "B", state: "approved" }),
        line({ recId: 4, supplierId: "B", state: "changed", qty: 40 }),
        line({ recId: 5, supplierId: "C", state: "deadline_auto" }),
      ],
      new Set(),
    );
    expect(p.waiting).toEqual([{ supplierId: "A", queued: 1 }]);
    expect(p.ready.map((r) => [r.supplierId, r.lines.map((l) => l.recId)])).toEqual([
      ["B", [3, 4]],
      ["C", [5]],
    ]);
  });

  it("rejected, rolled, held and zero-quantity lines are left out; a supplier with nothing to order gets no draft", () => {
    const p = planSend(
      [
        line({ recId: 1, supplierId: "A", state: "rejected", qty: 0 }),
        line({ recId: 2, supplierId: "A", state: "rolled", qty: 0 }),
        line({ recId: 3, supplierId: "B", state: "approved", qty: 0 }),
        line({ recId: 4, supplierId: "B", state: "held_changed" }),
        line({ recId: 5, supplierId: "B", state: "blocked_pending" }),
      ],
      new Set(),
    );
    expect(p.ready).toEqual([]);
    expect(p.waiting).toEqual([]);
  });

  it("a supplier already drafted this week is never drafted again", () => {
    const p = planSend([line({ supplierId: "A" })], new Set(["A"]));
    expect(p.ready).toEqual([]);
    expect(p.alreadySent).toEqual(["A"]);
  });

  it("lines without a supplier can't be drafted and are reported", () => {
    const p = planSend([line({ supplierId: null, skuId: "SKU009" })], new Set());
    expect(p.ready).toEqual([]);
    expect(p.noSupplier).toEqual(["SKU009"]);
  });
});

describe("effectiveMode (ARCHITECTURE §4.1: fail closed to shadow)", () => {
  it("live only when the env, the app setting and the run all say live", () => {
    expect(effectiveMode("live", "live", "live")).toBe("live");
    expect(effectiveMode(undefined, "live", "live")).toBe("shadow");
    expect(effectiveMode("LIVE", "live", "live")).toBe("shadow");
    expect(effectiveMode("live", "shadow", "live")).toBe("shadow");
    expect(effectiveMode("live", "live", "shadow")).toBe("shadow"); // switched mid-week: next Monday's run
  });
});

describe("draftReference", () => {
  it("is FR-{isoWeek}-{supplierId}", () => expect(draftReference("2026-W53", "DIST003")).toBe("FR-2026-W53-DIST003"));
});
