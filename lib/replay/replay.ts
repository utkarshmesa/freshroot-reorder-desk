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
  /** Units distributors ordered per week, when supplied (ordered_units): unconstrained demand, no imputation needed. */
  ordered?: Partial<Record<IsoWeek, number>>;
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
  /** Extra weeks every rules-arm order takes to arrive (sensitivity: real deliveries are late sometimes). */
  leadTimeExtraWks?: number;
  /** False when no receipts file was supplied: the actual arm can't be trusted, so no verdict (review M4, finding 2). */
  receiptsKnown?: boolean;
  /** Weeks inside the data span with no sales rows at all (a missing export week is not zero demand). */
  missingWeeks?: IsoWeek[];
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
  /** inferredLossSigned: Σ (last Sunday + receipts − net sales − this Sunday) over weeks with both Sundays known; receiptsChecked: receipts in those weeks. */
  qa: { trackingMeanAbs: number | null; trackingRelative: number | null; trackedWeeks: number; inferredLossSigned: number; receiptsChecked: number } | null;
  /** No receipts at all for this SKU across the data: left out of the comparison (it can't be told from a missing file). */
  noReceipts: boolean;
  /** Why the SKU is left out of the gate comparison (C-033), or null when it counts. */
  excluded: Exclusion | null;
};

/**
 * no_receipts: nothing received in the whole export (can't be told from a missing file).
 * no_shelf_life / no_moq: a perishable whose write-offs or orders would rest on a D18 default (C-033 items 2–3).
 * unexplained_gain: real stock rose more than receipts explain, so receipts are missing (C-033 item 1).
 */
export type Exclusion = "no_receipts" | "no_shelf_life" | "no_moq" | "unexplained_gain";

/** Stock that appears from nowhere beyond this share of receipts means receipts are missing (C-033 item 1). */
export const MAX_UNEXPLAINED_GAIN = 0.03;

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
  const assumed = sku.perishable ? [...(sku.shelfLifeWks === null ? ["shelf_life"] : []), ...(sku.moq === null ? ["moq"] : [])] : [];
  const idx = new Map(weeks.map((w, i) => [w, i]));

  // Actual net sales per week, and actual distributor rows per week (to rebuild the rules arm's history).
  const special = new Set<string>();
  for (const dist of o.distributors) if (dist.startWeek || dist.endWeek) special.add(dist.id);
  for (const e of o.events) if (e.type === "hold" && (e.skuIds.length === 0 || e.skuIds.includes(sku.id))) e.distributorIds.forEach((x) => special.add(x));
  const aggregate = o.aggregatePlainDistributors ?? true;
  const net = weeks.map(() => 0);
  const rowsByWeek = weeks.map((): SalesRow[] => []);
  const plain = weeks.map(() => 0);
  const plainPresent = weeks.map(() => false);
  for (const r of d.sales) {
    const i = idx.get(r.week);
    if (i === undefined) continue;
    net[i]! += r.shipped - r.returns;
    if (aggregate && !special.has(r.distributorId)) {
      plain[i]! += r.shipped - r.returns;
      plainPresent[i] = true;
    } else rowsByWeek[i]!.push(r);
  }
  // A row is pushed whenever plain rows existed, even if they net to 0, so the history starts where it did (finding 11).
  if (aggregate) weeks.forEach((w, i) => plainPresent[i] && rowsByWeek[i]!.push({ skuId: sku.id, distributorId: "_PLAIN", week: w, shipped: plain[i]!, returns: 0 }));
  const receipts = weeks.map((w) => d.receipts[w] ?? 0);
  const stock = rebuildStock(weeks, net, receipts, d.stockHistory);

  // Demand: units ordered when supplied (unconstrained); otherwise net sales, imputed in weeks the shelf was
  // empty (sales were capped by stock). Note: backlog shipped the following week can then count twice (§5).
  const demand: number[] = [];
  let imputedWeeks = 0;
  for (let i = 0; i < weeks.length; i++) {
    const ord = d.ordered?.[weeks[i]!];
    if (ord !== undefined) {
      demand.push(Math.max(0, ord));
      continue;
    }
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
    noReceipts: receipts.every((x) => x === 0),
    excluded: null,
  };
  result.excluded = result.noReceipts ? "no_receipts" : sku.perishable && sku.shelfLifeWks === null ? "no_shelf_life" : sku.perishable && sku.moq === null ? "no_moq" : null;
  if (weeks.length <= warmup || stock.source === "none") return result;
  const opening = stock.onHand[warmup - 1]!;
  const weeklyDemand = mean(demand.slice(0, warmup));

  // ---- Actual arm: Raghav's real receipts through the simulator.
  const actual = new Simulator({ opening, shelfLifeWks: shelfLife, weeklyDemand });
  let gap = 0;
  let realSum = 0;
  let gapWeeks = 0;
  for (let i = warmup; i < weeks.length; i++) {
    const row = actual.step({ week: weeks[i]!, receipt: receipts[i]!, demand: demand[i]!, reference: reference[i]! });
    const real = d.stockHistory[weeks[i]!];
    if (real !== undefined) {
      gap += Math.abs(row.onHand - real);
      realSum += real;
      gapWeeks++;
    }
  }
  result.actual = { ...actual.totals(), opening, orders: receipts.slice(warmup).filter((x) => x > 0).length, unitsOrdered: receipts.slice(warmup).reduce((a, b) => a + b, 0) };
  // Method QA (REPLAY_SPEC §4): how far the simulated actual arm drifts from the real SAP stock, and the
  // inferred loss in the real history (C-014 option A: positive residuals only shown here, signed in the JSON).
  let inferredLoss = 0;
  let receiptsChecked = 0;
  for (let i = warmup; i < weeks.length; i++) {
    const prev = d.stockHistory[weeks[i - 1]!];
    const now = d.stockHistory[weeks[i]!];
    if (prev !== undefined && now !== undefined) {
      inferredLoss += prev + receipts[i]! - net[i]! - now;
      receiptsChecked += receipts[i]!;
    }
  }
  result.qa = { trackingMeanAbs: gapWeeks ? gap / gapWeeks : null, trackingRelative: realSum > 0 ? gap / realSum : null, trackedWeeks: gapWeeks, inferredLossSigned: inferredLoss, receiptsChecked };
  // A negative loss is stock from nowhere: receipts the export doesn't have. The actual arm would starve
  // for no real reason and flatter the rules (stress test F3), so the SKU can't be judged.
  if (result.excluded === null && inferredLoss < -MAX_UNEXPLAINED_GAIN * Math.max(receiptsChecked, 1)) result.excluded = "unexplained_gain";

  // ---- Rules arm: the engine every Monday on what the rules would have seen.
  const sim = new Simulator({ opening, shelfLifeWks: shelfLife, weeklyDemand });
  const inTransit: Array<{ arrive: number; qty: number; placed: IsoWeek }> = [];
  // Orders Raghav placed before the replay started still arrive in its first lead-time weeks, in both arms
  // (review M4, finding 4): otherwise the rules arm starts with an empty pipeline.
  const lead0 = Math.ceil(sku.leadTimeWks ?? rules.defaults.leadTimeWks);
  for (let k = warmup; k < Math.min(weeks.length, warmup + lead0); k++) if (receipts[k]! > 0) inTransit.push({ arrive: k, qty: receipts[k]!, placed: weeks[warmup - 1]! });
  const extra = o.leadTimeExtraWks ?? 0;
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
      inTransit.push({ arrive: i + Math.ceil(rec.leadTimeWks) + extra, qty, placed: runWeek });
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

export type Totals = { stockoutWeeks: number; lowCoverWeeks: number; zeroStockWeeks: number; lostSalesWeeks: number; lost: number; writeOff: number; avgOnHand: number; unitsOrdered: number; orders: number };
export type Interval = { estimate: number; low: number; high: number };
type Diffs = { stockoutWeeks: Interval; lowCoverWeeks: Interval; lostSalesWeeks: Interval; writeOff: Interval; lost: Interval };
export type ReplaySummary = {
  reading: Reading;
  infeasible: "skip" | "moq";
  skus: SkuReplay[];
  compared: number;
  actual: Totals;
  rules: Totals;
  /** 95% bootstrap over SKUs: the verdict's intervals. */
  diff: Diffs;
  /** The same, resampling suppliers (C-033 item 7): a check on correlated demand, not part of the verdict. */
  diffBySupplier: Diffs;
  suppliers: number;
  replayWeeks: number;
  firstWeek: IsoWeek | null;
  lastWeek: IsoWeek | null;
  load: { avgQueue: number; maxQueue: number; avgAuto: number; avgSpotChecks: number };
  /**
   * unexplainedChange: Σ inferred loss / Σ receipts over SKUs with weekly stock history (+ = loss, − = stock from
   * nowhere; null = not checkable). drift: mean drift of the actual arm from real stock, non-perishables (C-032).
   */
  qa: { unexplainedChange: number | null; drift: number | null; orderedSupplied: boolean };
  verdict: Verdict;
  leadTimeExtraWks: number;
};

export type Verdict = { result: "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT DECIDABLE"; reasons: string[] };

/** Largest acceptable drift of the simulated actual arm from real SAP stock (non-perishables, C-032), as a share of real on-hand. */
export const MAX_TRACKING_GAP = 0.25;

const total = (xs: ArmResult[]): Totals => ({
  stockoutWeeks: xs.reduce((a, x) => a + x.stockoutWeeks, 0),
  lowCoverWeeks: xs.reduce((a, x) => a + x.lowCoverWeeks, 0),
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
  return { estimate, low: sums[Math.floor(0.025 * (iterations - 1))]!, high: sums[Math.ceil(0.975 * (iterations - 1))]! };
}

/** One year of simulated Mondays is the least that can speak for a 3-year history (smoke runs fall below it). */
export const MIN_DECIDABLE_WEEKS = 52;

const EXCLUSION_TEXT: Record<Exclusion, string> = {
  no_receipts: "no receipts at all in the export",
  no_shelf_life: "perishable with no shelf life in the SKU master (write-offs would rest on an assumed shelf life)",
  no_moq: "perishable with no MOQ in the SKU master (orders would rest on an assumed MOQ)",
  unexplained_gain: `real stock rose more than receipts explain (over ${MAX_UNEXPLAINED_GAIN * 100}% of receipts): receipts are missing`,
};
const listIds = (ids: string[]) => (ids.length > 20 ? `${ids.slice(0, 20).join(", ")} and ${ids.length - 20} more` : ids.join(", "));

export function replayAll(data: SkuData[], o: ReplayOptions): ReplaySummary {
  const reading = o.reading ?? "any";
  const infeasible = o.infeasible ?? "skip";
  const skus = data.map((d) => replaySku(d, { ...o, reading, infeasible }));
  const both = skus.filter((s) => s.actual && s.rules && s.excluded === null);
  const actual = total(both.map((s) => s.actual!));
  const rules = total(both.map((s) => s.rules!));
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

  // Intervals over SKUs, and over suppliers (a SKU with no supplier is its own cluster).
  const supplierOf = new Map(data.map((d) => [d.sku.id, d.sku.supplierId ?? `_sku:${d.sku.id}`]));
  const clusters = [...new Set(both.map((s) => supplierOf.get(s.skuId)!))];
  const intervals = (bySupplier: boolean): Diffs => {
    const one = (f: (a: ArmResult) => number) => {
      const perSku = both.map((s) => ({ c: supplierOf.get(s.skuId)!, d: f(s.rules!) - f(s.actual!) }));
      return bootstrapSum(bySupplier ? clusters.map((c) => perSku.filter((x) => x.c === c).reduce((a, x) => a + x.d, 0)) : perSku.map((x) => x.d));
    };
    return { stockoutWeeks: one((a) => a.stockoutWeeks), lowCoverWeeks: one((a) => a.lowCoverWeeks), lostSalesWeeks: one((a) => a.lostSalesWeeks), writeOff: one((a) => a.writeOff), lost: one((a) => a.lost) };
  };
  const diff = intervals(false);
  const diffBySupplier = intervals(true);

  // Data QA. Missing receipts are judged on every SKU with weekly stock history, compared or not.
  const withHistory = skus.filter((s) => s.qa && s.qa.trackedWeeks > 0 && !s.noReceipts);
  const checkedReceipts = withHistory.reduce((a, s) => a + s.qa!.receiptsChecked, 0);
  const unexplainedChange = withHistory.length ? withHistory.reduce((a, s) => a + s.qa!.inferredLossSigned, 0) / Math.max(checkedReceipts, 1) : null;
  const tracked = both.filter((s) => !s.perishable && s.qa?.trackingRelative !== null && s.qa?.trackingRelative !== undefined);
  const drift = tracked.length ? mean(tracked.map((s) => s.qa!.trackingRelative!)) : null;
  const orderedSupplied = data.some((d) => d.ordered && Object.keys(d.ordered).length > 0);

  const reasons: string[] = [];
  let result: Verdict["result"];
  // C-031: stockouts must be no worse (the interval may not show the rules worse); write-offs strictly fewer and
  // clear of zero. A measure where both arms are 0 has nothing to show: INCONCLUSIVE, never FAIL (C-033 item 4).
  const decide = (): Verdict["result"] => {
    const noWorse = rules.stockoutWeeks <= actual.stockoutWeeks;
    const noWriteOffs = rules.writeOff === 0 && actual.writeOff === 0;
    const fewerWriteOffs = rules.writeOff < actual.writeOff;
    const significant = diff.stockoutWeeks.high <= 0 && diff.writeOff.high < 0;
    reasons.push(
      `Stockout weeks (C-031: empty shelf or lost sales): rules ${rules.stockoutWeeks} vs actual ${actual.stockoutWeeks} (${noWorse ? "no worse" : "worse"}); write-off units rules ${round(rules.writeOff)} vs actual ${round(actual.writeOff)} (${noWriteOffs ? "no write-offs in either arm: nothing to improve" : fewerWriteOffs ? "fewer" : "not fewer"}); ${significant ? "both clear at 95%" : "the 95% interval includes no difference or worse"}.`,
    );
    if (!noWorse) return "FAIL";
    if (noWriteOffs) return "INCONCLUSIVE";
    if (!fewerWriteOffs) return "FAIL";
    return significant ? "PASS" : "INCONCLUSIVE";
  };
  if (replayWeeks < MIN_DECIDABLE_WEEKS) {
    result = "NOT DECIDABLE";
    reasons.push(`Only ${replayWeeks} simulated weeks (need at least ${MIN_DECIDABLE_WEEKS}): a smoke test of the machinery, not the gate.`);
  } else if (o.receiptsKnown === false) {
    result = "NOT DECIDABLE";
    reasons.push("No receipts history was supplied, so the actual arm would only drain its opening stock: no fair comparison.");
  } else if (o.missingWeeks?.length) {
    result = "NOT DECIDABLE";
    reasons.push(`The export has no sales at all for ${o.missingWeeks.join(", ")}: a missing week would be read as zero demand. Re-export.`);
  } else if (unexplainedChange !== null && unexplainedChange < -MAX_UNEXPLAINED_GAIN) {
    result = "NOT DECIDABLE";
    reasons.push(`Across the export, stock appeared from nowhere equal to ${round(-unexplainedChange * 100)}% of receipts (limit ${MAX_UNEXPLAINED_GAIN * 100}%): receipts are missing, which would make manual planning look worse than it was. Re-export the receipts.`);
  } else if (both.length === 0) {
    result = "NOT DECIDABLE";
    reasons.push("No SKU can be compared: each needs stock history (or one snapshot), receipts and, for perishables, a shelf life and MOQ.");
  } else if (drift !== null && drift > MAX_TRACKING_GAP) {
    result = "NOT DECIDABLE";
    reasons.push(`The simulated actual arm drifts ${Math.round(drift * 100)}% from the real SAP stock on non-perishables (limit ${MAX_TRACKING_GAP * 100}%): the simulator doesn't represent the history well enough to judge.`);
  } else {
    result = decide();
  }
  reasons.push(infeasible === "skip" ? "Infeasible perishable cards: skipped (the rules as written)." : "Infeasible perishable cards: ordered at the MOQ.");
  if (!orderedSupplied) reasons.push("ordered_units was not supplied, so manual planning's lost sales are probably under-counted (about half in the stress test). This works against the rules: an INCONCLUSIVE may hide a real improvement.");
  const noArm = skus.filter((s) => !(s.actual && s.rules)).length;
  if (noArm) reasons.push(`${noArm} SKU(s) left out of the comparison (no stock history or too few weeks).`);
  for (const why of Object.keys(EXCLUSION_TEXT) as Exclusion[]) {
    const ids = skus.filter((s) => s.actual && s.rules && s.excluded === why).map((s) => s.skuId);
    if (ids.length) reasons.push(`${ids.length} SKU(s) left out because of ${EXCLUSION_TEXT[why]}: ${listIds(ids)}.`);
  }

  return {
    reading,
    infeasible,
    skus,
    compared: both.length,
    actual,
    rules,
    diff,
    diffBySupplier,
    suppliers: clusters.length,
    replayWeeks,
    firstWeek: o.weeks[warmup] ?? null,
    lastWeek: o.weeks.at(-1) ?? null,
    load: {
      avgQueue: mean(counts.map((c) => c.queue)),
      maxQueue: Math.max(0, ...counts.map((c) => c.queue)),
      avgAuto: mean(counts.map((c) => c.auto)),
      avgSpotChecks: mean(counts.map((c) => Math.min(o.rules.spotChecks, c.auto))),
    },
    qa: { unexplainedChange, drift, orderedSupplied },
    verdict: { result, reasons },
    leadTimeExtraWks: o.leadTimeExtraWks ?? 0,
  };
}

/** PASS only if it also survives every rules-arm delivery arriving a week late (review M4, finding 3). */
export function robustVerdict(main: ReplaySummary, late: ReplaySummary): Verdict {
  if (main.verdict.result !== "PASS") return main.verdict;
  if (late.verdict.result === "PASS") return { result: "PASS", reasons: [...main.verdict.reasons, "Still passes with every rules-arm delivery a week late."] };
  return { result: "INCONCLUSIVE", reasons: [...main.verdict.reasons, `With every rules-arm delivery a week late the result is ${late.verdict.result}: not robust to real supplier delays.`] };
}

const round = (x: number) => Math.round(x * 10) / 10;

/** Contiguous ISO weeks covering the data (W53 included). */
export function weekSpan(first: IsoWeek, last: IsoWeek): IsoWeek[] {
  const out: IsoWeek[] = [];
  for (let w = first; compareWeeks(w, last) <= 0; w = addWeeks(w, 1)) out.push(w);
  return out;
}
