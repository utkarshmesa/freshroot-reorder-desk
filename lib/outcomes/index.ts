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
