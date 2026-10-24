// Template text (ARCHITECTURE §6): the deterministic fallback for every card and the brief. Pure.
// Shown first, replaced by checked LLM text when that arrives; used whenever the LLM is down or wrong.
import { round2, roundHalfEven } from "@/lib/engine/round";
import type { BriefFacts, CardFacts } from "./prompt";

const units = (x: number) => Math.round(x).toLocaleString("en-IN");
const wks = (x: number | null) => (x === null ? "–" : roundHalfEven(x, 1).toFixed(1));
const num = (x: number) => String(round2(x));
const days = (x: number | null) => (x === null ? "unknown" : String(Math.round(x)));

/** D1..D3 → names (null = case-data mode: codes stay). */
export function withNames(text: string, names: Record<string, string> | null): string {
  if (!names) return text;
  return text.replace(/\bD\d+\b/g, (code) => names[code] ?? code);
}

export function reasonTemplate(c: CardFacts, names: Record<string, string> | null): string {
  const f = new Set(c.flags);
  const parts: string[] = [];
  if (c.action === "blocked") return `Blocked: ${c.blockedReason ?? "see the blocked list"}.`;
  if (c.action === "reorder" && f.has("infeasible") && c.infeasibleOptions) {
    const o = c.infeasibleOptions;
    parts.push(`Cover is ${wks(c.cover)} weeks, but any order would push this perishable over its ${num(c.max)}-week maximum.`);
    parts.push(`Order the MOQ of ${units(o.orderMoq.qty)} (cover ${wks(o.orderMoq.coverAfter)} weeks, above the ${num(c.max)}-week maximum) or skip (about ${days(o.skip.daysToStockout)} days to stockout).`);
  } else if (c.action === "reorder") {
    parts.push(`Cover is ${wks(c.cover)} weeks against a minimum of ${num(c.minEff)}; ordering ${units(c.qty)} units brings it to ${wks(c.coverAfter)} weeks.`);
    if (f.has("capped_at_perishable_max")) parts.push(`Capped at the ${num(c.max)}-week perishable maximum.`);
  } else if (c.action === "pause") {
    parts.push(`Cover is ${wks(c.cover)} weeks, above the ${num(c.max)}-week maximum: no new order this week.`);
  } else {
    parts.push(`Cover is ${wks(c.cover)} weeks, inside the ${num(c.minEff)}–${num(c.max)} week band: no order needed.`);
  }
  if (f.has("high_demand")) {
    const top = c.topDistributors?.[0];
    parts.push(`Recent sales (${units(c.a4)} a week) are above the 12-week average (${units(c.a12)})${top ? `, mostly via ${top.code}` : ""}.`);
  }
  if (f.has("conflict")) parts.push("Stock is high but sales are rising: check before deferring open orders.");
  if (f.has("borderline")) parts.push("This is close to the band edge.");
  if (f.has("overdue_po")) parts.push("Some open PO lines are past their delivery date.");
  if (f.has("hold")) parts.push("A hold covers this SKU.");
  if (f.has("new_sku")) parts.push("New SKU: demand blends the launch estimate with actual sales.");
  if (f.has("short_history")) parts.push("Fewer than 8 clean weeks of history.");
  if (f.has("over_auto_limit")) parts.push("Above the auto-approve limit.");
  return withNames(parts.join(" "), names);
}

export function briefTemplate(b: BriefFacts): string {
  const parts = [
    `Week ${b.isoWeek} (${b.mode} mode): ${b.autoLines} lines (${units(b.autoUnits)} units) auto-approved; ${b.queueLines} cards (${units(b.queueUnits)} units) wait for Raghav; ${b.pauses} pauses.`,
  ];
  if (b.atRisk.length) parts.push(`At risk: ${b.atRisk.map((r) => `${r.name} (about ${Math.round(r.daysToStockout)} days of stock)`).join(", ")}.`);
  if (b.blocked) parts.push(`${b.blocked} SKUs are blocked and need fixing.`);
  if (b.needsDeepa.length) parts.push(`Needs you: ${b.needsDeepa.join("; ")}.`);
  return parts.join(" ");
}
