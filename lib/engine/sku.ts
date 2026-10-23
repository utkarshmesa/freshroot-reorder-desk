// One SKU's recommendation (BUILD_PLAN §8 step 5; D1, D5, D7, D8, D16, D18; C-001, C-002, C-005/C-023a, C-006, C-017).
import { mondayOf, sundayOf, weekDiff, type IsoWeek } from "@/lib/isoweek";
import { festivalFactor, orderWeeks } from "./festival";
import { history } from "./history";
import { position } from "./position";
import type { Assumed, DistributorInput, EngineInput, EventInput, Flag, Recommendation, SkuInput, Triage } from "./types";

/** Flags that always need a person, whatever the action. */
const NEEDS_PERSON: Flag[] = ["hold", "new_sku", "short_history", "no_demand", "overdue_po", "infeasible", "conflict", "no_launch_estimate"];

export function decide(sku: SkuInput, input: EngineInput, distributors: Map<string, DistributorInput>): Recommendation {
  const { rules, runWeek } = input;
  const assumed: Assumed[] = [];
  if (sku.leadTimeWks === null) assumed.push("lead_time");
  if (sku.moq === null) assumed.push("moq");
  if (sku.perishable && sku.shelfLifeWks === null) assumed.push("shelf_life");
  if (sku.unitCostInr === null) assumed.push("unit_cost");

  const lead = sku.leadTimeWks ?? rules.defaults.leadTimeWks;
  const moq = sku.moq ?? sku.stdQty;
  const band = sku.perishable
    ? {
        min: rules.bands.perishable.minWks,
        max:
          sku.shelfLifeWks === null
            ? Math.min(rules.bands.perishable.maxWks, rules.defaults.perishableMaxWks)
            : Math.min(rules.bands.perishable.maxWks, rules.bands.perishable.maxShelfLifeFraction * sku.shelfLifeWks),
      }
    : { min: rules.bands.nonPerishable.minWks, max: rules.bands.nonPerishable.maxWks };
  const minEff = Math.max(band.min, lead + rules.leadTimeBufferWks); // D7
  const max = band.max;
  const weeks = orderWeeks(runWeek, lead, minEff);

  const base: Recommendation = {
    skuId: sku.id,
    name: sku.name,
    supplierId: sku.supplierId,
    action: "none",
    qty: 0,
    triage: "none",
    spotCheck: false,
    stdQty: sku.stdQty,
    packSize: sku.packSize,
    flags: [],
    assumed,
    holdout: input.holdout.includes(sku.id),
    a12: 0,
    a4: 0,
    trendA12: 0,
    trendA4: 0,
    festivalFactor: 1,
    forwardDemand: 0,
    onHand: null,
    openPoQty: 0,
    receiptsAfterSnapshot: 0,
    position: 0,
    cover: null,
    coverAfter: null,
    minEff,
    max,
    leadTimeWks: lead,
    moq,
    cleanWeeks: 0,
    daysToStockout: null,
    orderWeeks: weeks,
    openPoLines: [],
    infeasibleOptions: null,
    topDistributors: null,
    blockedReason: null,
  };

  // Fail closed per SKU: blocked before the engine, or no stock row.
  const blockedReason = input.blocked[sku.id];
  if (blockedReason) return { ...base, action: "blocked", flags: ["unmapped"], blockedReason };
  const onHand = input.onHand[sku.id];
  if (onHand === undefined) {
    // An inactive SKU orders nothing anyway; don't list it as blocked.
    if (sku.status === "inactive") return { ...base, flags: ["inactive"] };
    return { ...base, action: "blocked", flags: ["no_stock"], blockedReason: "No stock row in this week's snapshot" };
  }

  const holds = input.events.filter((e) => e.type === "hold");
  const festivals = input.events.filter((e) => e.type === "festival");
  const h = history({
    skuId: sku.id,
    runWeek,
    rules,
    sales: input.sales.filter((r) => r.skuId === sku.id),
    distributors,
    holds,
    stockHistory: input.stockHistory[sku.id],
    firstSaleWeek: sku.firstSaleWeek,
  });
  const pos = position(sku.id, onHand, input.poLines, input.receipts, runWeek);
  const flags = new Set<Flag>();
  if (sku.perishable) flags.add("perishable");

  // D1: new SKU (first sale under 13 weeks ago): launch estimate, then a linear blend, then full rules.
  const age = sku.firstSaleWeek ? weekDiff(sku.firstSaleWeek, runWeek) : null;
  const isNew = age !== null && age <= rules.newSku.blendUntilWk;
  const factor = festivalFactor(weeks, festivals, rules.festivalUpliftPct, input.festivalReading ?? "any");
  let F: number;
  if (isNew) {
    flags.add("new_sku");
    const est = sku.launchEstimateWk;
    if (est === null) {
      flags.add("no_launch_estimate");
      F = h.a12;
    } else if (age <= rules.newSku.launchEstimateWks) {
      F = est;
    } else {
      const w = (age - rules.newSku.launchEstimateWks) / (rules.newSku.blendUntilWk - rules.newSku.launchEstimateWks);
      F = w * h.a12 + (1 - w) * est;
    }
  } else {
    F = h.a12 * factor;
    if (h.cleanWeeks.length < rules.minCleanWeeks) flags.add("short_history");
  }

  const P = pos.position;
  const C = F > 0 ? P / F : P > 0 ? Number.POSITIVE_INFINITY : 0;
  const HD = !isNew && h.trendA4 > rules.highDemandRatio * h.trendA12; // D6: raw sales

  // A hold naming this SKU anywhere from the 12-week window in use to the weeks being ordered for (C-028d).
  const span = { from: mondayOf(h.windowStart ?? runWeek), to: sundayOf(weeks.at(-1) as IsoWeek) };
  if (holds.some((e: EventInput) => e.skuIds.includes(sku.id) && e.startDate <= span.to && e.endDate >= span.from)) flags.add("hold");
  if (pos.lines.some((l) => l.overdue)) flags.add("overdue_po");
  if (HD) flags.add("high_demand");
  if (minEff > max) flags.add("infeasible");

  let action: Recommendation["action"] = "none";
  let qty = 0;
  let coverAfter: number | null = null;
  let infeasibleOptions: Recommendation["infeasibleOptions"] = null;
  const daysToStockout = F > 0 ? (onHand / F) * 7 : null;

  if (sku.status === "inactive") {
    flags.add("inactive");
    action = pos.openPoQty > 0 ? "pause" : "none"; // D3: no new orders; list open lines to cancel
  } else if (F <= 0) {
    flags.add("no_demand");
    action = P > 0 ? "pause" : "none";
  } else if (C > max) {
    action = "pause";
    if (HD) flags.add("conflict");
  } else if (C < minEff || HD) {
    action = "reorder";
    if (flags.has("infeasible")) {
      // D7: min_eff above the maximum. Nothing is ordered automatically; Raghav gets both choices (C-023i).
      infeasibleOptions = { orderMoq: { qty: moq, coverAfter: (P + moq) / F }, skip: { daysToStockout } };
    } else {
      let q = sku.stdQty * (HD ? rules.highDemandMultiplier : 1);
      while (P + q < minEff * F) q += sku.stdQty;
      q = Math.max(q, moq); // MOQ is a minimum (C-023a)
      if (sku.packSize) q = Math.ceil(q / sku.packSize) * sku.packSize;
      if (sku.perishable) {
        const cap = Math.floor(max * F - P);
        if (cap < moq) {
          flags.add("infeasible");
          infeasibleOptions = { orderMoq: { qty: moq, coverAfter: (P + moq) / F }, skip: { daysToStockout } };
          q = 0;
        } else if (q > cap) {
          q = cap;
          flags.add("capped_at_perishable_max");
          if (sku.packSize && q % sku.packSize !== 0) flags.add("pack_mismatch");
        }
      }
      qty = q;
      coverAfter = qty > 0 ? (P + qty) / F : null;
    }
  }

  // C-006: borderline = within ±5% of min_eff or max.
  if (Number.isFinite(C) && F > 0) {
    const near = (edge: number) => Math.abs(C - edge) <= (rules.borderlinePct / 100) * edge;
    if (near(minEff) || near(max)) flags.add("borderline");
  }

  const overLimit = action === "reorder" && qty > rules.autoApproveMaxStdMultiple * sku.stdQty;
  if (overLimit) flags.add("over_auto_limit");

  const triage = ((): Triage => {
    if (base.holdout) return "none";
    if (NEEDS_PERSON.some((f) => flags.has(f))) return "queue";
    if (action === "reorder") {
      // C-002: auto only with no flags at all (perishable, high demand, borderline, … all queue) and within D16.
      return flags.size === 0 ? "auto" : "queue";
    }
    if (action === "pause") return pos.openPoQty > 0 ? "queue" : "info_no_open_po"; // C-001
    return "none";
  })();

  return {
    ...base,
    action,
    qty,
    triage,
    flags: [...flags],
    a12: h.a12,
    a4: h.a4,
    trendA12: h.trendA12,
    trendA4: h.trendA4,
    festivalFactor: isNew ? 1 : factor,
    forwardDemand: F,
    onHand,
    openPoQty: pos.openPoQty,
    receiptsAfterSnapshot: pos.receiptsAfterSnapshot,
    position: P,
    cover: Number.isFinite(C) ? C : null,
    coverAfter,
    cleanWeeks: h.cleanWeeks.length,
    daysToStockout,
    openPoLines: pos.lines,
    infeasibleOptions,
    topDistributors: input.caseDataMode ? null : h.topDistributors,
  };
}
