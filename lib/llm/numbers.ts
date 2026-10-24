// The number checker (ARCHITECTURE §6, D13). Pure. Every number in LLM text must be one the engine produced,
// at the precision written; anything else sends the card back to its template text.
import { roundHalfEven } from "@/lib/engine/round";

export type Token = { value: number; dp: number; pct: boolean };
export type Allowlist = { values: number[]; pcts: number[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Identifiers are not quantities: SKU and distributor codes, ISO weeks, draft references, and given names. */
function stripIdentifiers(text: string, names: string[]): string {
  let t = text;
  for (const n of names) if (n) t = t.replace(new RegExp(escape(n), "gi"), " ");
  return t
    .replace(/\bFR-\S+/g, " ")
    .replace(/\b\d{4}-W\d{2}\b/g, " ")
    .replace(/\b(?:SKU|DIST|SUP)\d+\b/gi, " ")
    .replace(/\bD\d+\b/g, " ");
}

export function extractNumbers(text: string, names: string[] = []): Token[] {
  const out: Token[] = [];
  const re = /₹?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|lakh\b|L\b|Cr\b|crore\b)?/gi;
  for (const m of stripIdentifiers(text, names).matchAll(re)) {
    const raw = m[1]!.replace(/,+$/, "");
    const dp = raw.includes(".") ? raw.split(".")[1]!.length : 0;
    let value = Number(raw.replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "l" || unit === "lakh") value *= 1e5;
    if (unit === "cr" || unit === "crore") value *= 1e7;
    out.push({ value: unit && unit !== "%" ? Math.round(value) : value, dp: unit && unit !== "%" ? 0 : dp, pct: unit === "%" });
  }
  return out;
}

/** Half-to-even at the precision written (C-012): 6.55 may be written "6.6" or "7", never "6.5". */
const matches = (t: Token, candidates: number[]) => candidates.some((a) => Number.isFinite(a) && roundHalfEven(a, t.dp) === t.value);

export function checkNumbers(text: string, allow: Allowlist, names: string[] = []): { ok: boolean; unmatched: string[] } {
  const unmatched: string[] = [];
  for (const t of extractNumbers(text, names)) {
    const pool = t.pct ? [...allow.pcts, ...allow.values] : allow.values;
    if (!matches(t, pool)) unmatched.push(t.dp ? t.value.toFixed(t.dp) : String(t.value));
  }
  return { ok: unmatched.length === 0, unmatched };
}

/** Every finite number anywhere inside a value (objects and arrays walked). */
export function numbersIn(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number" && Number.isFinite(x)) out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => numbersIn(v, out));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => numbersIn(v, out));
  return out;
}

/** Quantities written as words can't be checked, so they aren't allowed (review M5, finding 6). */
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|lakhs?|crores?|dozen|twice|double|doubled|triple|tripled|half)\b/i;
export const hasNumberWords = (text: string) => NUMBER_WORDS.test(text);

/** Numbers the text says to order ("order 750", "ordering 1,200 units"): each must be one of `allowed`. */
export function orderClaimsOk(text: string, allowed: number[]): boolean {
  for (const m of text.matchAll(/\border(?:s|ed|ing)?\s+(?:of\s+|about\s+|another\s+|an extra\s+)*(\d[\d,]*(?:\.\d+)?)/gi)) {
    const v = Number(m[1]!.replace(/,/g, ""));
    if (!allowed.includes(v)) return false;
  }
  return true;
}
