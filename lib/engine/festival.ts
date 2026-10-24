// Festival uplift on forward demand (D6, C-004). History is never uplifted.
import { addWeeks, mondayOf, sundayOf, type IsoDate, type IsoWeek } from "@/lib/isoweek";
import type { EventInput } from "./types";

const DAY_MS = 86_400_000;
const minusDays = (d: IsoDate, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

/** The weeks being ordered for: run week + lead time … run week + lead time + min_eff − 1 (C-004). */
export function orderWeeks(runWeek: IsoWeek, leadTimeWks: number, minEff: number): IsoWeek[] {
  const lead = Math.ceil(leadTimeWks);
  const n = Math.max(1, Math.ceil(minEff));
  return Array.from({ length: n }, (_, i) => addWeeks(runWeek, lead + i));
}

/** Uplift % for a week if it touches a festival or its pre-load window; 0 otherwise. Highest wins if several overlap. */
export function weekUpliftPct(week: IsoWeek, festivals: EventInput[], defaultPct: number): number {
  const mon = mondayOf(week);
  const sun = sundayOf(week);
  let best = 0;
  for (const f of festivals) {
    if (f.type !== "festival") continue;
    const from = minusDays(f.startDate, f.preloadWks * 7);
    if (mon <= f.endDate && sun >= from) best = Math.max(best, f.upliftPct ?? defaultPct);
  }
  return best;
}

/**
 * "any" (production, C-004): the full uplift if any week being ordered for touches a festival/pre-load.
 * "share" (replay only, D6): uplift scaled by the share of those weeks that do.
 * "none" (replay only): no forward uplift; used when history has already been uplifted (Raghav's literal reading).
 */
export function festivalFactor(weeks: IsoWeek[], festivals: EventInput[], defaultPct: number, reading: "any" | "share" | "none" = "any"): number {
  if (reading === "none") return 1;
  const pcts = weeks.map((w) => weekUpliftPct(w, festivals, defaultPct));
  if (reading === "any") return 1 + Math.max(0, ...pcts) / 100;
  return 1 + pcts.reduce((a, p) => a + p, 0) / 100 / weeks.length;
}
