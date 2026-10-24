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

/**
 * Shadow agreement (C-018, unit-weighted; stress test F6): units Raghav approved as recommended ÷ units on the
 * cards he decided. Units = the engine's quantity on the card. A changed or rejected card counts as disagreement.
 */
export function agreement(decisions: Array<{ status: string; units: number }>): { decided: number; approved: number; pct: number | null } {
  const decided = decisions.filter((d) => d.status === "approved" || d.status === "changed" || d.status === "rejected");
  const total = decided.reduce((a, d) => a + d.units, 0);
  const approved = decided.filter((d) => d.status === "approved").reduce((a, d) => a + d.units, 0);
  return { decided: total, approved, pct: total > 0 ? Math.round((approved / total) * 1000) / 10 : null };
}

export type PlacedLine = { poId: string; skuId: string; ordered: number; placedDate?: string | null; reference?: string | null };

/**
 * C-038: what Raghav actually ordered, per SKU, in one week: POs that are not system drafts (reference not FR-),
 * dated Monday to Sunday of that week, each PO line counted once however many reads saw it.
 * Limit: a PO placed and fully received between two Monday reads is never seen.
 */
export function manualOrders(lines: PlacedLine[], monday: string, sunday: string): Map<string, number> {
  const seen = new Map<string, PlacedLine>();
  for (const l of lines) {
    if (!l.placedDate || l.placedDate < monday || l.placedDate > sunday || (l.reference ?? "").startsWith("FR-")) continue;
    const key = `${l.poId}|${l.skuId}`;
    if ((seen.get(key)?.ordered ?? -1) < l.ordered) seen.set(key, l);
  }
  const out = new Map<string, number>();
  for (const l of seen.values()) out.set(l.skuId, (out.get(l.skuId) ?? 0) + l.ordered);
  return out;
}

/** C-038 per week: did the system and Raghav make the same call (order or not), and how many units each. */
export function shadowComparison(rows: Array<{ skuId: string; system: number; manual: number }>) {
  const same = rows.filter((r) => r.system > 0 === r.manual > 0).length;
  return {
    skuWeeks: rows.length,
    sameDecision: same,
    sameDecisionPct: rows.length ? Math.round((same / rows.length) * 1000) / 10 : null,
    systemUnits: rows.reduce((a, r) => a + r.system, 0),
    manualUnits: rows.reduce((a, r) => a + r.manual, 0),
    systemOnly: rows.filter((r) => r.system > 0 && r.manual === 0).map((r) => r.skuId),
    manualOnly: rows.filter((r) => r.manual > 0 && r.system === 0).map((r) => r.skuId),
  };
}
