// Outcome maths shared by the Outcomes page and the replay (ARCHITECTURE §8). Pure; applied identically
// to pilot and manual SKUs so the comparison is fair.

/**
 * Stockout week (C-031 B): SAP on-hand at the Sunday snapshot is under one whole unit, or at least one whole
 * unit of demand was lost that week (C-033 item 5). `lostUnits` is null when lost sales aren't known (no
 * ordered_units): then only the empty shelf counts. Open POs and the forecast play no part.
 */
export function isStockoutWeek(onHand: number, lostUnits: number | null): boolean {
  return onHand < 1 || (lostUnits !== null && lostUnits >= 1);
}

/**
 * Low cover (C-017, reported alongside since C-031): Sunday on-hand 0 or below one week of raw clean demand.
 * A warning, not a stockout: a lean perishable shelf dips below a week just before each delivery by design.
 */
export function isLowCoverWeek(onHand: number, rawA12: number): boolean {
  return onHand <= 0 || onHand < rawA12;
}

export type SkuWeek = { skuId: string; onHand: number; lostUnits: number | null; rawA12: number };

/** Stockout and low-cover weeks per SKU-week observed, for one group of SKUs. */
export function stockoutRate(rows: SkuWeek[]): { stockoutWeeks: number; lowCoverWeeks: number; skuWeeks: number; rate: number } {
  const stockoutWeeks = rows.filter((r) => isStockoutWeek(r.onHand, r.lostUnits)).length;
  const lowCoverWeeks = rows.filter((r) => isLowCoverWeek(r.onHand, r.rawA12)).length;
  return { stockoutWeeks, lowCoverWeeks, skuWeeks: rows.length, rate: rows.length ? stockoutWeeks / rows.length : 0 };
}

const IST_MS = 330 * 60_000;
const istDate = (ts: string) => new Date(Date.parse(ts) + IST_MS).toISOString().slice(0, 10);

/**
 * Order speed (BUILD_PLAN §1: issued within 2 working days): Mon–Fri days after the commit's IST date up to and
 * including the issue's IST date. Commit Monday, issued Tuesday = 1. Public holidays aren't known, so not skipped.
 */
export function workingDaysBetween(fromTs: string, toTs: string): number {
  let d = new Date(`${istDate(fromTs)}T00:00:00Z`);
  const end = new Date(`${istDate(toTs)}T00:00:00Z`);
  let n = 0;
  while (d < end) {
    d = new Date(d.getTime() + 86_400_000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export type GroupWeek = SkuWeek & { week: string; holdout: boolean };

/** Pilot (rules) vs manual (holdout) SKUs, the same weeks, the same definitions (ARCHITECTURE §8). */
export function pilotVsManual(rows: GroupWeek[]) {
  return { pilot: stockoutRate(rows.filter((r) => !r.holdout)), manual: stockoutRate(rows.filter((r) => r.holdout)) };
}

/** Shadow agreement (C-018): share of Raghav's decided cards approved as recommended. */
export function agreement(decisions: Array<{ status: string }>): { decided: number; approved: number; pct: number | null } {
  const decided = decisions.filter((d) => d.status === "approved" || d.status === "changed" || d.status === "rejected");
  const approved = decided.filter((d) => d.status === "approved").length;
  return { decided: decided.length, approved, pct: decided.length ? Math.round((approved / decided.length) * 1000) / 10 : null };
}
