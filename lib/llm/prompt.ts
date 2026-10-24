// What Claude is shown (ARCHITECTURE §6). Pure. Numbers and anonymised distributor codes (D1..D3) only:
// names are put back after the check, and never leave the server.
import type { Allowlist } from "./numbers";
import { numbersIn } from "./numbers";

export type CardFacts = {
  skuId: string;
  name: string;
  action: "reorder" | "pause" | "none" | "blocked";
  qty: number;
  cover: number | null;
  coverAfter: number | null;
  flags: string[];
  assumed: string[];
  a12: number;
  a4: number;
  forwardDemand: number;
  position: number;
  minEff: number;
  max: number;
  leadTimeWks: number;
  moq: number;
  stdQty: number;
  festivalFactor: number;
  onHand: number | null;
  openPoQty: number;
  daysToStockout: number | null;
  infeasibleOptions: { orderMoq: { qty: number; coverAfter: number }; skip: { daysToStockout: number | null } } | null;
  blockedReason: string | null;
  /** Already anonymised: code is D1, D2, D3 in rank order. */
  topDistributors: Array<{ code: string; deltaUnits: number; pct: number }> | null;
};

export type BriefFacts = {
  isoWeek: string;
  mode: "shadow" | "live";
  autoLines: number;
  autoUnits: number;
  queueLines: number;
  queueUnits: number;
  pauses: number;
  blocked: number;
  atRisk: Array<{ skuId: string; name: string; daysToStockout: number }>;
  needsDeepa: string[];
};

/** Window lengths the rules use (12-week and 4-week averages): Claude may name them. */
const RULE_WINDOWS = [12, 4];

export function allowlist(c: CardFacts): Allowlist {
  const values = numbersIn(c).concat(RULE_WINDOWS);
  const pcts = [(c.festivalFactor - 1) * 100, c.a12 > 0 ? (c.a4 / c.a12 - 1) * 100 : NaN, ...(c.topDistributors ?? []).map((d) => d.pct)];
  return { values, pcts };
}

export function briefAllowlist(b: BriefFacts): Allowlist {
  return { values: numbersIn(b).concat(RULE_WINDOWS), pcts: [] };
}

export const REASON_SYSTEM =
  "You explain one reorder recommendation to Raghav, the supply planner at an Indian food distributor. " +
  "Write one or two plain sentences (under 60 words) saying why the rules recommend this. " +
  "Use only numbers that appear in the facts, written as they appear or rounded; never compute new numbers, totals or money. " +
  "Refer to distributors only by their codes (D1, D2, D3). Do not suggest a different quantity. No preamble, no lists.";

export const BRIEF_SYSTEM =
  "You write the weekly reorder brief for Deepa, the CEO of an Indian food distributor. " +
  "Three or four plain sentences: what was ordered automatically, what waits for the planner, what is at risk, anything that needs her. " +
  "Use only numbers that appear in the facts; never compute new numbers, totals or money. No preamble, no lists, no headings.";

export function reasonPrompt(c: CardFacts): string {
  return `Facts (JSON):\n${JSON.stringify(c)}`;
}

export function briefPrompt(b: BriefFacts): string {
  return `Facts (JSON):\n${JSON.stringify(b)}`;
}
