// The weekly stock simulator (REPLAY_SPEC §3). Pure and deterministic.
// Order within a week: receipts arrive → demand is served oldest-first (FIFO) → lots age a week →
// perishable lots that reach the shelf life are written off → Sunday on-hand is recorded.
import { isStockoutWeek } from "@/lib/outcomes";
import type { IsoWeek } from "@/lib/isoweek";

export type SimWeek = { week: IsoWeek; receipt: number; demand: number; sold: number; lost: number; writeOff: number; onHand: number; stockout: boolean };
export type SimTotals = { weeks: number; received: number; demand: number; sold: number; lost: number; writeOff: number; stockoutWeeks: number; avgOnHand: number; closingOnHand: number };

export class Simulator {
  private lots: Array<{ qty: number; age: number }>;
  private readonly rows: SimWeek[] = [];
  private readonly shelfLife: number | null;

  /** Opening stock is treated as fresh (age 0): its real age isn't known. */
  constructor(o: { opening: number; shelfLifeWks: number | null }) {
    this.lots = o.opening > 0 ? [{ qty: o.opening, age: 0 }] : [];
    this.shelfLife = o.shelfLifeWks;
  }

  get onHand(): number {
    return this.lots.reduce((a, l) => a + l.qty, 0);
  }

  /** `reference` is one week of raw clean demand (a12) for the stockout test (C-017); the same for both arms. */
  step(w: { week: IsoWeek; receipt: number; demand: number; reference: number }): SimWeek {
    if (w.receipt > 0) this.lots.push({ qty: w.receipt, age: 0 });
    let need = Math.max(0, w.demand);
    for (const l of this.lots) {
      const take = Math.min(l.qty, need);
      l.qty -= take;
      need -= take;
      if (need === 0) break;
    }
    const sold = Math.max(0, w.demand) - need;
    this.lots = this.lots.filter((l) => l.qty > 0);
    for (const l of this.lots) l.age += 1;
    let writeOff = 0;
    if (this.shelfLife !== null) {
      for (const l of this.lots) if (l.age >= this.shelfLife) writeOff += l.qty;
      this.lots = this.lots.filter((l) => l.age < this.shelfLife!);
    }
    const onHand = this.onHand;
    const row: SimWeek = { week: w.week, receipt: w.receipt, demand: w.demand, sold, lost: need, writeOff, onHand, stockout: isStockoutWeek(onHand, w.reference) };
    this.rows.push(row);
    return row;
  }

  history(): readonly SimWeek[] {
    return this.rows;
  }

  totals(): SimTotals {
    const sum = (f: (r: SimWeek) => number) => this.rows.reduce((a, r) => a + f(r), 0);
    return {
      weeks: this.rows.length,
      received: sum((r) => r.receipt),
      demand: sum((r) => r.demand),
      sold: sum((r) => r.sold),
      lost: sum((r) => r.lost),
      writeOff: sum((r) => r.writeOff),
      stockoutWeeks: sum((r) => (r.stockout ? 1 : 0)),
      avgOnHand: this.rows.length ? sum((r) => r.onHand) / this.rows.length : 0,
      closingOnHand: this.onHand,
    };
  }
}
