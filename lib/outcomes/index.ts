// Outcome maths shared by the Outcomes page and the replay (ARCHITECTURE §8). Pure; applied identically
// to pilot and manual SKUs so the comparison is fair.

/**
 * Stockout week (C-017): SAP on-hand at the Sunday snapshot is 0, or below one week of raw clean demand
 * (shelf cover < 1). Open POs and festival uplift play no part, so the engine's own forecast can't move it.
 */
export function isStockoutWeek(onHand: number, rawA12: number): boolean {
  return onHand <= 0 || onHand < rawA12;
}

export type SkuWeek = { skuId: string; onHand: number; rawA12: number };

/** Stockout weeks per SKU-week observed, for one group of SKUs. */
export function stockoutRate(rows: SkuWeek[]): { stockoutWeeks: number; skuWeeks: number; rate: number } {
  const stockoutWeeks = rows.filter((r) => isStockoutWeek(r.onHand, r.rawA12)).length;
  return { stockoutWeeks, skuWeeks: rows.length, rate: rows.length ? stockoutWeeks / rows.length : 0 };
}
