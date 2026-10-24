// The day-45 replay (REPLAY_SPEC). Pure: data in, results out. The rules arm calls the real engine
// (lib/engine, unchanged) every simulated Monday; both arms share one demand series and one simulator.
import { runEngine } from "@/lib/engine";
import { prng } from "@/lib/engine/triage";
import type { DistributorInput, EventInput, PoLine, Recommendation, SalesRow, SkuInput } from "@/lib/engine/types";
import { addWeeks, compareWeeks, mondayOf, type IsoWeek } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";
import { Simulator, type SimTotals } from "./simulate";

export type Reading = "any" | "share" | "literal";

export type SkuData = {
  sku: SkuInput;
  /** Distributor-level sales for this SKU, all weeks. */
  sales: SalesRow[];
  /** Goods actually received per week (arriving that week). */
  receipts: Partial<Record<IsoWeek, number>>;
  /** SAP Sunday-close on-hand per week; partial is fine (the rest is rebuilt, D20); empty = unknown. */
  stockHistory: Partial<Record<IsoWeek, number>>;
};

export type ReplayOptions = {
  rules: RuleParams;
  /** Every week in the data, contiguous and ordered (W53 included). */
  weeks: IsoWeek[];
  events: EventInput[];
  distributors: DistributorInput[];
  /** Weeks of history before the first simulated Monday (the engine needs 12+). */
  warmupWks?: number;
  reading?: Reading;
  /** What Raghav does with an infeasible perishable card: skip (rules as written) or order the MOQ. */
  infeasible?: "skip" | "moq";
  seed?: number;
  /**
   * Sum distributors with nothing distributor-specific (no start/end week, no distributor hold) into one stream
   * before the engine sees them. Exact: Σ over distributors of their mean over the same weeks = the mean of the sum.
   * Default true; false is for the equivalence test.
   */
  aggregatePlainDistributors?: boolean;
};

export type ArmResult = SimTotals & { opening: number; orders: number; unitsOrdered: number };

export type SkuReplay = {
  skuId: string;
  perishable: boolean;
  shelfLifeWks: number | null;
  assumed: string[];
  stockSource: "history" | "rebuilt" | "none";
  actual: ArmResult | null;
  rules: ArmResult | null;
  weeklyTriage: Array<{ week: IsoWeek; triage: Recommendation["triage"]; action: Recommendation["action"] }>;
  stats: { reorderWeeks: number; queueWeeks: number; autoWeeks: number; infeasibleWeeks: number; borderlineWeeks: number; hdWithUplift: number; hdBelowNormal: number; imputedWeeks: number };
  qa: { trackingMeanAbs: number | null; trackedWeeks: number; inferredLossSigned: number } | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** On-hand per week from a partial Sunday-close history, rebuilt forwards and backwards from the nearest snapshot (D20). */
export function rebuildStock(weeks: IsoWeek[], net: number[], receipts: number[], history: Partial<Record<IsoWeek, number>>): { onHand: Array<number | null>; source: SkuReplay["stockSource"] } {
  const known = weeks.map((w) => history[w]);
  const firstKnown = known.findIndex((v) => v !== undefined);
  if (firstKnown < 0) return { onHand: weeks.map(() => null), source: "none" };
  const h: number[] = new Array(weeks.length).fill(0);
  h[firstKnown] = known[firstKnown]!;
  for (let i = firstKnown + 1; i < weeks.length; i++) h[i] = known[i] ?? Math.max(0, h[i - 1]! + receipts[i]! - net[i]!);
  for (let i = firstKnown - 1; i >= 0; i--) h[i] = Math.max(0, h[i + 1]! - receipts[i + 1]! + net[i + 1]!);
  return { onHand: h, source: known.every((v) => v !== undefined) ? "history" : "rebuilt" };
}

/** Festival-month weeks (Monday inside a festival, no pre-load): Raghav's rule 4 as written (D6 "literal"). */
function festivalMonthUplift(week: IsoWeek, events: EventInput[], defaultPct: number): number {
  const mon = mondayOf(week);
  let pct = 0;
  for (const e of events) if (e.type === "festival" && mon >= e.startDate && mon <= e.endDate) pct = Math.max(pct, e.upliftPct ?? defaultPct);
  return 1 + pct / 100;
}

export function replaySku(d: SkuData, o: ReplayOptions): SkuReplay {
  const { rules, weeks } = o;
  const warmup = o.warmupWks ?? 13;
  const reading = o.reading ?? "any";
  const sku = d.sku;
  const shelfLife = sku.perishable ? (sku.shelfLifeWks ?? 2 * rules.defaults.perishableMaxWks) : null;
  const assumed = sku.perishable && sku.shelfLifeWks === null ? ["shelf_life"] : [];
  const idx = new Map(weeks.map((w, i) => [w, i]));

  // Actual net sales per week, and actual distributor rows per week (to rebuild the rules arm's history).
  const special = new Set<string>();
  for (const dist of o.distributors) if (dist.startWeek || dist.endWeek) special.add(dist.id);
  for (const e of o.events) if (e.type === "hold" && (e.skuIds.length === 0 || e.skuIds.includes(sku.id))) e.distributorIds.forEach((x) => special.add(x));
  const aggregate = o.aggregatePlainDistributors ?? true;
  const net = weeks.map(() => 0);
  const rowsByWeek = weeks.map((): SalesRow[] => []);
  const plain = weeks.map(() => 0);
  for (const r of d.sales) {
    const i = idx.get(r.week);
    if (i === undefined) continue;
    net[i]! += r.shipped - r.returns;
    if (aggregate && !special.has(r.distributorId)) plain[i]! += r.shipped - r.returns;
    else rowsByWeek[i]!.push(r);
  }
  if (aggregate) weeks.forEach((w, i) => plain[i] !== 0 && rowsByWeek[i]!.push({ skuId: sku.id, distributorId: "_PLAIN", week: w, shipped: plain[i]!, returns: 0 }));
  const receipts = weeks.map((w) => d.receipts[w] ?? 0);
  const stock = rebuildStock(weeks, net, receipts, d.stockHistory);

  // Demand: actual net sales, imputed in weeks the shelf was empty (sales were capped by stock).
  const demand: number[] = [];
  let imputedWeeks = 0;
  for (let i = 0; i < weeks.length; i++) {
    const s = Math.max(0, net[i]!);
    const out = stock.onHand[i] === 0;
    if (out) {
      const clean = demand.slice(Math.max(0, i - 12), i).filter((_, k) => stock.onHand[Math.max(0, i - 12) + k] !== 0);
      const a = mean(clean);
      if (a > s) imputedWeeks++;
      demand.push(Math.max(s, a));
    } else demand.push(s);
  }
  const reference = weeks.map((_, i) => mean(demand.slice(Math.max(0, i - 12), i)));

  const result: SkuReplay = {
    skuId: sku.id,
    perishable: sku.perishable,
    shelfLifeWks: shelfLife,
    assumed,
    stockSource: stock.source,
    actual: null,
    rules: null,
    weeklyTriage: [],
    stats: { reorderWeeks: 0, queueWeeks: 0, autoWeeks: 0, infeasibleWeeks: 0, borderlineWeeks: 0, hdWithUplift: 0, hdBelowNormal: 0, imputedWeeks },
    qa: null,
  };
  if (weeks.length <= warmup || stock.source === "none") return result;
  const opening = stock.onHand[warmup - 1]!;
  const weeklyDemand = mean(demand.slice(0, warmup));

  // ---- Actual arm: Raghav's real receipts through the simulator.
  const actual = new Simulator({ opening, shelfLifeWks: shelfLife, weeklyDemand });
  let gap = 0;
  let gapWeeks = 0;
  for (let i = warmup; i < weeks.length; i++) {
    const row = actual.step({ week: weeks[i]!, receipt: receipts[i]!, demand: demand[i]!, reference: reference[i]! });
    const real = d.stockHistory[weeks[i]!];
    if (real !== undefined) {
      gap += Math.abs(row.onHand - real);
      gapWeeks++;
    }
  }
  result.actual = { ...actual.totals(), opening, orders: receipts.slice(warmup).filter((x) => x > 0).length, unitsOrdered: receipts.slice(warmup).reduce((a, b) => a + b, 0) };
  // Method QA (REPLAY_SPEC §4): how far the simulated actual arm drifts from the real SAP stock, and the
  // inferred loss in the real history (C-014 option A: positive residuals only shown here, signed in the JSON).
  let inferredLoss = 0;
  for (let i = warmup; i < weeks.length; i++) {
    const prev = d.stockHistory[weeks[i - 1]!];
    const now = d.stockHistory[weeks[i]!];
    if (prev !== undefined && now !== undefined) inferredLoss += prev + receipts[i]! - net[i]! - now;
  }
  result.qa = { trackingMeanAbs: gapWeeks ? gap / gapWeeks : null, trackedWeeks: gapWeeks, inferredLossSigned: inferredLoss };

  // ---- Rules arm: the engine every Monday on what the rules would have seen.
  const sim = new Simulator({ opening, shelfLifeWks: shelfLife, weeklyDemand });
  const inTransit: Array<{ arrive: number; qty: number; placed: IsoWeek }> = [];
  const armSold: number[] = net.map((x) => Math.max(0, x)); // before the replay starts, history is the actual history
  const armOnHand: Array<number | null> = [...stock.onHand];
  let orders = 0;
  let unitsOrdered = 0;
  const lookback = rules.lookbackWks;

  for (let i = warmup; i < weeks.length; i++) {
    const runWeek = weeks[i]!;
    const from = Math.max(0, i - lookback);
    const sales: SalesRow[] = [];
    for (let k = from; k < i; k++) {
      const actualNet = net[k]!;
      const sold = armSold[k]!;
      const lit = reading === "literal" ? festivalMonthUplift(weeks[k]!, o.events, rules.festivalUpliftPct) : 1;
      if (k < warmup || sold === Math.max(0, actualNet)) {
        for (const r of rowsByWeek[k]!) sales.push({ ...r, shipped: (r.shipped - r.returns) * lit, returns: 0 });
      } else if (actualNet > 0) {
        const scale = sold / actualNet;
        for (const r of rowsByWeek[k]!) sales.push({ ...r, shipped: (r.shipped - r.returns) * scale * lit, returns: 0 });
      } else if (sold > 0) {
        sales.push({ skuId: sku.id, distributorId: "_SIM", week: weeks[k]!, shipped: sold * lit, returns: 0 });
      }
    }
    const stockHistory: Partial<Record<IsoWeek, number>> = {};
    for (let k = from; k < i; k++) if (armOnHand[k] !== null) stockHistory[weeks[k]!] = armOnHand[k]!;
    const poLines: PoLine[] = inTransit
      .filter((t) => t.arrive >= i)
      .map((t, n) => ({ poId: `sim-${n}`, poNumber: `SIM-${t.placed}`, status: "open", skuId: sku.id, ordered: t.qty, received: 0, expectedDate: null }));

    const out = runEngine({
      runWeek,
      rules,
      caseDataMode: true,
      skus: [sku],
      distributors: o.distributors,
      events: o.events,
      sales,
      onHand: { [sku.id]: sim.onHand },
      stockHistory: { [sku.id]: stockHistory },
      poLines,
      receipts: [],
      holdout: [],
      blocked: {},
      spotCheckSeed: o.seed ?? 1,
      festivalReading: reading === "literal" ? "none" : reading,
    });
    const rec = out.recommendations[0]!;
    result.weeklyTriage.push({ week: runWeek, triage: rec.triage, action: rec.action });
    const st = result.stats;
    if (rec.action === "reorder") st.reorderWeeks++;
    if (rec.triage === "queue") st.queueWeeks++;
    if (rec.triage === "auto") st.autoWeeks++;
    if (rec.flags.includes("infeasible")) st.infeasibleWeeks++;
    if (rec.flags.includes("borderline")) st.borderlineWeeks++;
    if (rec.flags.includes("high_demand") && rec.festivalFactor > 1) st.hdWithUplift++;
    if (rec.flags.includes("high_demand") && rec.action === "reorder" && rec.qty > 0 && !rec.flags.includes("capped_at_perishable_max")) {
      // C-029: what the same SKU would order without the high-demand multiplier.
      let q = sku.stdQty;
      while (rec.position + q < rec.minEff * rec.forwardDemand) q += sku.stdQty;
      q = Math.max(q, rec.moq);
      if (sku.packSize) q = Math.ceil(q / sku.packSize) * sku.packSize;
      if (rec.qty < q) st.hdBelowNormal++;
    }

    let qty = rec.action === "reorder" ? rec.qty : 0;
    if (qty === 0 && rec.flags.includes("infeasible") && o.infeasible === "moq" && rec.infeasibleOptions) qty = rec.infeasibleOptions.orderMoq.qty;
    if (qty > 0) {
      inTransit.push({ arrive: i + Math.ceil(rec.leadTimeWks), qty, placed: runWeek });
      orders++;
      unitsOrdered += qty;
    }
    const receipt = inTransit.filter((t) => t.arrive === i).reduce((a, t) => a + t.qty, 0);
    const row = sim.step({ week: runWeek, receipt, demand: demand[i]!, reference: reference[i]! });
    armSold[i] = row.sold;
    armOnHand[i] = row.onHand;
  }
  result.rules = { ...sim.totals(), opening, orders, unitsOrdered };
  return result;
}

// ---------- across SKUs ----------

export type Totals = { stockoutWeeks: number; zeroStockWeeks: number; lostSalesWeeks: number; lost: number; writeOff: number; avgOnHand: number; unitsOrdered: number; orders: number };
export type Interval = { estimate: number; low: number; high: number };
export type ReplaySummary = {
  reading: Reading;
  infeasible: "skip" | "moq";
  skus: SkuReplay[];
  compared: number;
  actual: Totals;
  rules: Totals;
  diff: { stockoutWeeks: Interval; lostSalesWeeks: Interval; writeOff: Interval; lost: Interval };
  replayWeeks: number;
  firstWeek: IsoWeek | null;
  lastWeek: IsoWeek | null;
  load: { avgQueue: number; maxQueue: number; avgAuto: number; avgSpotChecks: number };
  verdict: { result: "PASS" | "FAIL" | "NOT DECIDABLE"; reasons: string[] };
};

const total = (xs: ArmResult[]): Totals => ({
  stockoutWeeks: xs.reduce((a, x) => a + x.stockoutWeeks, 0),
  zeroStockWeeks: xs.reduce((a, x) => a + x.zeroStockWeeks, 0),
  lostSalesWeeks: xs.reduce((a, x) => a + x.lostSalesWeeks, 0),
  lost: xs.reduce((a, x) => a + x.lost, 0),
  writeOff: xs.reduce((a, x) => a + x.writeOff, 0),
  avgOnHand: xs.reduce((a, x) => a + x.avgOnHand, 0),
  unitsOrdered: xs.reduce((a, x) => a + x.unitsOrdered, 0),
  orders: xs.reduce((a, x) => a + x.orders, 0),
});

/** 95% bootstrap interval of the summed per-SKU difference (resampling SKUs), seeded. */
export function bootstrapSum(diffs: number[], seed = 20261207, iterations = 2000): Interval {
  const estimate = diffs.reduce((a, b) => a + b, 0);
  if (diffs.length === 0) return { estimate: 0, low: 0, high: 0 };
  const rand = prng(seed);
  const sums: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let k = 0; k < diffs.length; k++) s += diffs[Math.floor(rand() * diffs.length)]!;
    sums.push(s);
  }
  sums.sort((a, b) => a - b);
  return { estimate, low: sums[Math.floor(0.025 * iterations)]!, high: sums[Math.floor(0.975 * iterations) - 1]! };
}

/** One year of simulated Mondays is the least that can speak for a 3-year history (smoke runs fall below it). */
export const MIN_DECIDABLE_WEEKS = 52;

export function replayAll(data: SkuData[], o: ReplayOptions): ReplaySummary {
  const reading = o.reading ?? "any";
  const infeasible = o.infeasible ?? "skip";
  const skus = data.map((d) => replaySku(d, { ...o, reading, infeasible }));
  const both = skus.filter((s) => s.actual && s.rules);
  const actual = total(both.map((s) => s.actual!));
  const rules = total(both.map((s) => s.rules!));
  const diffs = (f: (a: ArmResult) => number) => both.map((s) => f(s.rules!) - f(s.actual!));
  const warmup = o.warmupWks ?? 13;
  const replayWeeks = Math.max(0, o.weeks.length - warmup);

  // D8 load: queue cards and auto items per simulated Monday, across SKUs.
  const perWeek = new Map<IsoWeek, { queue: number; auto: number }>();
  for (const s of skus) for (const w of s.weeklyTriage) {
    const c = perWeek.get(w.week) ?? { queue: 0, auto: 0 };
    if (w.triage === "queue") c.queue++;
    if (w.triage === "auto") c.auto++;
    perWeek.set(w.week, c);
  }
  const counts = [...perWeek.values()];

  const reasons: string[] = [];
  let result: ReplaySummary["verdict"]["result"];
  if (replayWeeks < MIN_DECIDABLE_WEEKS) {
    result = "NOT DECIDABLE";
    reasons.push(`Only ${replayWeeks} simulated weeks (need at least ${MIN_DECIDABLE_WEEKS}): a smoke test of the machinery, not the gate.`);
  } else if (both.length === 0) {
    result = "NOT DECIDABLE";
    reasons.push("No SKU has both arms: the actual arm needs stock history (or one snapshot) and receipts history.");
  } else {
    const fewerStockouts = rules.stockoutWeeks < actual.stockoutWeeks;
    const fewerWriteOffs = rules.writeOff < actual.writeOff;
    result = fewerStockouts && fewerWriteOffs ? "PASS" : "FAIL";
    reasons.push(`Stockout weeks: rules ${rules.stockoutWeeks} vs actual ${actual.stockoutWeeks} (${fewerStockouts ? "fewer" : "not fewer"}).`);
    reasons.push(`Write-off units: rules ${round(rules.writeOff)} vs actual ${round(actual.writeOff)} (${fewerWriteOffs ? "fewer" : "not fewer"}).`);
    const altPass = rules.lostSalesWeeks < actual.lostSalesWeeks && fewerWriteOffs;
    reasons.push(`Under the alternative stockout definition (weeks with lost sales, C-031 proposed): rules ${rules.lostSalesWeeks} vs actual ${actual.lostSalesWeeks}, so the result would be ${altPass ? "PASS" : "FAIL"}.`);
  }
  const missing = skus.filter((s) => !(s.actual && s.rules)).length;
  if (missing) reasons.push(`${missing} SKU(s) left out of the comparison (no stock history or too few weeks).`);

  return {
    reading,
    infeasible,
    skus,
    compared: both.length,
    actual,
    rules,
    diff: { stockoutWeeks: bootstrapSum(diffs((a) => a.stockoutWeeks)), lostSalesWeeks: bootstrapSum(diffs((a) => a.lostSalesWeeks)), writeOff: bootstrapSum(diffs((a) => a.writeOff)), lost: bootstrapSum(diffs((a) => a.lost)) },
    replayWeeks,
    firstWeek: o.weeks[warmup] ?? null,
    lastWeek: o.weeks.at(-1) ?? null,
    load: {
      avgQueue: mean(counts.map((c) => c.queue)),
      maxQueue: Math.max(0, ...counts.map((c) => c.queue)),
      avgAuto: mean(counts.map((c) => c.auto)),
      avgSpotChecks: mean(counts.map((c) => Math.min(o.rules.spotChecks, c.auto))),
    },
    verdict: { result, reasons },
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

/** Contiguous ISO weeks covering the data (W53 included). */
export function weekSpan(first: IsoWeek, last: IsoWeek): IsoWeek[] {
  const out: IsoWeek[] = [];
  for (let w = first; compareWeeks(w, last) <= 0; w = addWeeks(w, 1)) out.push(w);
  return out;
}
