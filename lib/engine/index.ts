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
  const noHistory = skus.filter((s) => input.onHand[s.id] !== undefined && Object.keys(input.stockHistory[s.id] ?? {}).length === 0).length;
  if (noHistory > 0) notes.push(`Zero-stock exclusion skipped for ${noHistory} SKU(s): no weekly stock history yet (C-007).`);
  return { runWeek: input.runWeek, recommendations, notes };
}

export type * from "./types";
export { applyDeadline } from "./deadline";
export { position } from "./position";
export { round2, roundHalfEven } from "./round";
