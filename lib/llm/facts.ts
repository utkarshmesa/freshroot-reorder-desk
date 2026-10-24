// Engine output → what Claude may see (ARCHITECTURE §6). Pure. Distributor ids become D1..D3 in rank order;
// the id list comes back separately so names can be put in after the number check.
import type { Recommendation } from "@/lib/engine/types";
import type { BriefFacts, CardFacts } from "./prompt";

export function cardFacts(r: Recommendation): { facts: CardFacts; distributorIds: string[] } {
  const top = r.topDistributors ?? null;
  return {
    distributorIds: (top ?? []).map((d) => d.distributorId),
    facts: {
      skuId: r.skuId,
      name: r.name,
      action: r.action,
      qty: r.qty,
      cover: r.cover,
      coverAfter: r.coverAfter,
      flags: r.flags,
      assumed: r.assumed,
      a12: r.a12,
      a4: r.a4,
      forwardDemand: r.forwardDemand,
      position: r.position,
      minEff: r.minEff,
      max: r.max,
      leadTimeWks: r.leadTimeWks,
      moq: r.moq,
      stdQty: r.stdQty,
      festivalFactor: r.festivalFactor,
      onHand: r.onHand,
      openPoQty: r.openPoQty,
      daysToStockout: r.daysToStockout,
      infeasibleOptions: r.infeasibleOptions,
      blockedReason: r.blockedReason,
      topDistributors: top ? top.map((d, i) => ({ code: `D${i + 1}`, deltaUnits: d.deltaUnits, pct: d.pct })) : null,
    },
  };
}

export type BriefLine = { rec: Recommendation; lineState: string | null };

/**
 * Aggregates for the weekly brief. "At risk" = shelf stock runs out before an order placed now could arrive
 * (days to stockout under the lead time), so no new threshold is invented. Holdout SKUs are left out.
 */
export function briefFacts(isoWeek: string, mode: "shadow" | "live", lines: BriefLine[]): BriefFacts {
  const visible = lines.filter((l) => !l.rec.holdout);
  const sum = (xs: BriefLine[]) => xs.reduce((a, l) => a + l.rec.qty, 0);
  const auto = visible.filter((l) => l.lineState === "auto");
  const queue = visible.filter((l) => l.lineState === "queued");
  const pending = [...new Set(visible.filter((l) => l.lineState === "blocked_pending").map((l) => l.rec.supplierId ?? "?"))].sort();
  return {
    isoWeek,
    mode,
    autoLines: auto.length,
    autoUnits: sum(auto),
    queueLines: queue.length,
    queueUnits: sum(queue),
    pauses: visible.filter((l) => l.rec.action === "pause").length,
    blocked: visible.filter((l) => l.rec.action === "blocked").length,
    atRisk: visible
      .filter((l) => l.rec.daysToStockout !== null && l.rec.action !== "blocked" && l.rec.daysToStockout < l.rec.leadTimeWks * 7)
      .sort((a, b) => a.rec.daysToStockout! - b.rec.daysToStockout!)
      .map((l) => ({ skuId: l.rec.skuId, name: l.rec.name, daysToStockout: l.rec.daysToStockout! })),
    needsDeepa: pending.map((s) => `${s} still has an unissued draft from an earlier week, so its lines wait`),
  };
}
