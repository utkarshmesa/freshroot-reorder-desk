// REPLAY_SPEC §3: the weekly simulator, on a hand-computed fixture.
import { describe, expect, it } from "vitest";
import { Simulator } from "./simulate";

describe("Simulator (REPLAY_SPEC §3)", () => {
  it("non-perishable: receipts arrive first, demand is served, shortfall is lost, nothing expires", () => {
    const s = new Simulator({ opening: 100, shelfLifeWks: null });
    // week 1: no receipt, demand 60 → on-hand 40
    expect(s.step({ week: "2026-W01", receipt: 0, demand: 60, reference: 50 })).toMatchObject({ sold: 60, lost: 0, writeOff: 0, onHand: 40, stockout: true }); // 40 < 50 = less than a week's cover
    // week 2: receipt 100 arrives first, demand 150 → 140 available, sell 140, lose 10
    expect(s.step({ week: "2026-W02", receipt: 100, demand: 150, reference: 50 })).toMatchObject({ sold: 140, lost: 10, onHand: 0, stockout: true });
    // week 3: receipt 200, demand 50 → 150 left, more than a week of cover
    expect(s.step({ week: "2026-W03", receipt: 200, demand: 50, reference: 50 })).toMatchObject({ sold: 50, lost: 0, onHand: 150, stockout: false });
  });

  it("perishable: oldest stock sells first and lots expire at the shelf life", () => {
    // Shelf life 2 weeks: a lot that has aged 2 weeks unsold is written off at the end of that week.
    const s = new Simulator({ opening: 100, shelfLifeWks: 2 });
    // W1: opening 100 (age 0), sell 30 → 70 left (age 1)
    expect(s.step({ week: "2026-W01", receipt: 0, demand: 30, reference: 10 })).toMatchObject({ sold: 30, writeOff: 0, onHand: 70 });
    // W2: +50 new; sell 30 from the old lot (FIFO) → old 40 reaches age 2 → written off; new 50 (age 1) stays
    expect(s.step({ week: "2026-W02", receipt: 50, demand: 30, reference: 10 })).toMatchObject({ sold: 30, writeOff: 40, onHand: 50 });
    // W3: sell 20 of the 50 → 30 reaches age 2 → written off
    expect(s.step({ week: "2026-W03", receipt: 0, demand: 20, reference: 10 })).toMatchObject({ sold: 20, writeOff: 30, onHand: 0, stockout: true });
  });

  it("conserves units: opening + receipts = sold + written off + closing", () => {
    const s = new Simulator({ opening: 37, shelfLifeWks: 3 });
    const weeks = [
      [10, 25],
      [0, 40],
      [90, 5],
      [0, 0],
      [15, 70],
    ];
    const rows = weeks.map(([receipt, demand], i) => s.step({ week: `2026-W${String(i + 1).padStart(2, "0")}`, receipt: receipt!, demand: demand!, reference: 20 }));
    const t = s.totals();
    expect(37 + t.received).toBe(t.sold + t.writeOff + rows.at(-1)!.onHand);
    expect(rows.every((r) => r.onHand >= 0)).toBe(true);
    expect(t.lost).toBe(rows.reduce((a, r) => a + r.lost, 0));
  });

  it("counts stockout weeks with the C-017 definition (on-hand 0 or under one week of raw demand)", () => {
    const s = new Simulator({ opening: 0, shelfLifeWks: null });
    s.step({ week: "2026-W01", receipt: 0, demand: 0, reference: 0 }); // on-hand 0 → stockout even with no demand
    s.step({ week: "2026-W02", receipt: 100, demand: 0, reference: 100 }); // exactly one week of cover → not a stockout
    s.step({ week: "2026-W03", receipt: 0, demand: 1, reference: 100 }); // 99 < 100 → stockout
    expect(s.totals().stockoutWeeks).toBe(2);
  });
});
