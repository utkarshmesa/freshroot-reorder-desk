// Rules engine entry point (ADR-0003). Pure: same input → same output.
import { decide } from "./sku";
import { assignSpotChecks } from "./triage";
import type { EngineInput, EngineOutput } from "./types";
import { mondayOf } from "@/lib/isoweek";

export function runEngine(input: EngineInput): EngineOutput {
  const distributors = new Map(input.distributors.map((d) => [d.id, d]));
  const skus = [...input.skus].sort((a, b) => a.id.localeCompare(b.id));
  const decided = skus.map((s) => decide(s, input, distributors));
  const recommendations = assignSpotChecks(decided, input.spotCheckSeed, input.rules.spotChecks);

  const notes: string[] = [];
  const short = skus.filter((s) => input.onHand[s.id] !== undefined && Object.keys(input.stockHistory[s.id] ?? {}).length < input.rules.avgLongWks).length;
  if (short > 0) notes.push(`Zero-stock exclusion is partial for ${short} SKU(s): fewer than ${input.rules.avgLongWks} weeks of stock snapshots so far (C-007).`);
  // Stress test F9 (BUILD_PLAN §11 "run warns if missing"): a year the orders reach with no festival entered at
  // all means the festival uplift is silently missing for it.
  const years = new Set(recommendations.flatMap((r) => r.orderWeeks.map((w) => Number(mondayOf(w).slice(0, 4)))));
  const covered = new Set(input.events.filter((e) => e.type === "festival").flatMap((e) => [Number(e.startDate.slice(0, 4)), Number(e.endDate.slice(0, 4))]));
  const missingFestivalYears = [...years].filter((y) => !covered.has(y)).sort();
  if (missingFestivalYears.length) notes.push(`No festival dates entered for ${missingFestivalYears.join(", ")}: orders for those weeks get no festival uplift. Raghav: add them in Settings → Festivals & holds.`);
  return { runWeek: input.runWeek, recommendations, notes, missingFestivalYears };
}

export type * from "./types";
export { applyDeadline } from "./deadline";
export { position } from "./position";
export { round2, roundHalfEven } from "./round";
