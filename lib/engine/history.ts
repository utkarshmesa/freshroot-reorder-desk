// Clean the sales history and compute averages (BUILD_PLAN §8 step 4–5; D2, D3, D4; C-007, C-016, C-028).
//
// SKU level: a week is "clean" unless a SKU-wide hold covers it or the SKU's Sunday stock was 0 (only when
// that history exists). The last k clean weeks form the window for a_k.
// Distributor level, inside that window: each distributor's weeks are eligible unless held for that
// distributor, before its start week + 4 (D2), or from its end week (D3). Missing rows count as 0.
// a_k = Σ over distributors of (net units over eligible weeks ÷ number of eligible weeks), floored at 0.
// An inactive distributor whose end week has been reached contributes nothing (C-028).
import { addWeeks, compareWeeks, mondayOf, sundayOf, weekRange, type IsoWeek } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";
import type { DistributorInput, EventInput, SalesRow, TopDistributor } from "./types";

export type History = {
  cleanWeeks: IsoWeek[];
  historyStart: IsoWeek | null;
  a12: number;
  a4: number;
  trendA12: number;
  trendA4: number;
  topDistributors: TopDistributor[];
  usedStockHistory: boolean;
};

const overlaps = (e: EventInput, w: IsoWeek) => e.startDate <= sundayOf(w) && e.endDate >= mondayOf(w);
const coversSku = (e: EventInput, skuId: string) => e.skuIds.length === 0 || e.skuIds.includes(skuId);

export function history(args: {
  skuId: string;
  runWeek: IsoWeek;
  rules: RuleParams;
  sales: SalesRow[]; // this SKU's rows only
  distributors: Map<string, DistributorInput>;
  holds: EventInput[];
  stockHistory: Partial<Record<IsoWeek, number>> | undefined;
}): History {
  const { skuId, runWeek, rules, sales, distributors, holds, stockHistory } = args;
  const last = addWeeks(runWeek, -1);
  const lookbackStart = addWeeks(runWeek, -rules.lookbackWks);
  const inRange = sales.filter((r) => compareWeeks(r.week, lookbackStart) >= 0 && compareWeeks(r.week, last) <= 0);
  const empty: History = { cleanWeeks: [], historyStart: null, a12: 0, a4: 0, trendA12: 0, trendA4: 0, topDistributors: [], usedStockHistory: false };
  if (inRange.length === 0) return empty;

  const historyStart = inRange.map((r) => r.week).sort(compareWeeks)[0]!;
  const usedStockHistory = stockHistory !== undefined && Object.keys(stockHistory).length > 0;
  const skuHolds = holds.filter((h) => coversSku(h, skuId) && h.distributorIds.length === 0);
  const cleanWeeks = weekRange(historyStart, last).filter(
    (w) => !skuHolds.some((h) => overlaps(h, w)) && !(usedStockHistory && stockHistory![w] === 0),
  );

  // net units by distributor and week
  const net = new Map<string, Map<IsoWeek, number>>();
  for (const r of inRange) {
    if (!net.has(r.distributorId)) net.set(r.distributorId, new Map());
    const m = net.get(r.distributorId)!;
    m.set(r.week, (m.get(r.week) ?? 0) + r.shipped - r.returns);
  }
  const distHolds = holds.filter((h) => coversSku(h, skuId) && h.distributorIds.length > 0);

  const eligible = (d: string, w: IsoWeek, forTrend: boolean): boolean => {
    const dist = distributors.get(d);
    if (dist?.endWeek && compareWeeks(w, dist.endWeek) >= 0) return false;
    if (dist?.startWeek) {
      const skip = forTrend ? rules.newDistributor.noTrendUntilWk : rules.newDistributor.ignoreWks;
      if (compareWeeks(w, addWeeks(dist.startWeek, skip)) < 0) return false;
    }
    return !distHolds.some((h) => h.distributorIds.includes(d) && overlaps(h, w));
  };
  const gone = (d: string) => {
    const dist = distributors.get(d);
    return dist?.status === "inactive" && dist.endWeek !== null && compareWeeks(runWeek, dist.endWeek) >= 0;
  };

  const meanFor = (d: string, window: IsoWeek[], forTrend: boolean): number => {
    if (gone(d)) return 0;
    const ws = window.filter((w) => eligible(d, w, forTrend));
    if (ws.length === 0) return 0;
    const m = net.get(d)!;
    return ws.reduce((a, w) => a + (m.get(w) ?? 0), 0) / ws.length;
  };

  const w12 = cleanWeeks.slice(-rules.avgLongWks);
  const w4 = cleanWeeks.slice(-rules.avgShortWks);
  const ds = [...net.keys()].sort();
  const sumOf = (window: IsoWeek[], forTrend: boolean) => Math.max(0, ds.reduce((a, d) => a + meanFor(d, window, forTrend), 0));

  // D10: the distributors behind the change, by their own a4 − a12.
  const deltas = ds.map((d) => ({ distributorId: d, deltaUnits: meanFor(d, w4, false) - meanFor(d, w12, false) }));
  const total = deltas.reduce((a, x) => a + x.deltaUnits, 0);
  const topDistributors = deltas
    .filter((x) => x.deltaUnits !== 0)
    .sort((a, b) => Math.abs(b.deltaUnits) - Math.abs(a.deltaUnits) || a.distributorId.localeCompare(b.distributorId))
    .slice(0, 3)
    .map((x) => ({ ...x, pct: total === 0 ? 0 : (x.deltaUnits / total) * 100 }));

  return {
    cleanWeeks,
    historyStart,
    a12: sumOf(w12, false),
    a4: sumOf(w4, false),
    trendA12: sumOf(w12, true),
    trendA4: sumOf(w4, true),
    topDistributors,
    usedStockHistory,
  };
}
