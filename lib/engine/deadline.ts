// The Tuesday 12:00 rule (D8, C-023f), pure part. The cron applies it to lines still queued.
import type { Recommendation } from "./types";

export type LineState = "auto" | "queued" | "approved" | "changed" | "rejected" | "deadline_auto" | "rolled" | "sent" | "blocked_pending" | "held_changed";

export type DeadlineLine = { rec: Recommendation; state: LineState };
export type DeadlineResult = { skuId: string; state: LineState; qty: number };

/**
 * Unreviewed (queued) lines:
 *  - a spot-check keeps its auto-approved qty (it was auto-eligible and only queued as a sample);
 *  - a non-perishable stockout risk (reorder with cover below min_eff) is ordered at 1× std (at least MOQ);
 *  - everything else rolls to next week.
 * Lines in any other state are returned unchanged.
 */
export function applyDeadline(lines: DeadlineLine[], opts: { deadlineStdMultiple: number }): DeadlineResult[] {
  return lines.map(({ rec, state }) => {
    if (state !== "queued") return { skuId: rec.skuId, state, qty: rec.qty };
    if (rec.spotCheck && rec.triage === "auto") return { skuId: rec.skuId, state: "deadline_auto", qty: rec.qty };
    const stockoutRisk =
      rec.action === "reorder" && !rec.flags.includes("perishable") && !rec.flags.includes("infeasible") && rec.cover !== null && rec.cover < rec.minEff;
    if (stockoutRisk) return { skuId: rec.skuId, state: "deadline_auto", qty: Math.max(Math.round(opts.deadlineStdMultiple * rec.stdQty), rec.moq) };
    return { skuId: rec.skuId, state: "rolled", qty: 0 };
  });
}
