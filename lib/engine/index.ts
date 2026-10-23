// Rules engine entry point (ADR-0003). Pure: same input → same output.
import { decide } from "./sku";
import { assignSpotChecks } from "./triage";
import type { EngineInput, EngineOutput } from "./types";

export function runEngine(input: EngineInput): EngineOutput {
  const distributors = new Map(input.distributors.map((d) => [d.id, d]));
  const skus = [...input.skus].sort((a, b) => a.id.localeCompare(b.id));
  const decided = skus.map((s) => decide(s, input, distributors));
  const recommendations = assignSpotChecks(decided, input.spotCheckSeed, input.rules.spotChecks);

  const notes: string[] = [];
  const short = skus.filter((s) => input.onHand[s.id] !== undefined && Object.keys(input.stockHistory[s.id] ?? {}).length < input.rules.avgLongWks).length;
  if (short > 0) notes.push(`Zero-stock exclusion is partial for ${short} SKU(s): fewer than ${input.rules.avgLongWks} weeks of stock snapshots so far (C-007).`);
  return { runWeek: input.runWeek, recommendations, notes };
}

export type * from "./types";
export { applyDeadline } from "./deadline";
export { position } from "./position";
export { round2, roundHalfEven } from "./round";
