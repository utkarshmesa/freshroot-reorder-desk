// Strict value parsing. Every cell arrives as a string; nothing is guessed.
import { mondayOf, sundayOf, weekOfDate } from "@/lib/isoweek";

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const WESTERN = /^\d{1,3}(,\d{3})+$/; // 1,200 · 12,345,678
const INDIAN = /^\d{1,2}(,\d{2})*,\d{3}$/; // 1,20,000 · 12,34,567
const PLAIN = /^\d+$/;
const ZERO_DECIMALS = /^(\d+)\.0+$/; // "1200.0" from spreadsheet formatting

/** Non-negative whole units. "1,200" → 1200; "1.5", "12a", "-3" are errors. */
export function parseUnits(raw: string): Parsed<number> {
  const s = raw.trim().replace(/\s/g, "");
  if (s === "") return { ok: false, code: "missing_value", message: "Value is empty" };
  if (s.startsWith("-")) {
    return parseUnits(s.slice(1)).ok
      ? { ok: false, code: "negative_value", message: `Negative value "${raw}" is not allowed` }
      : { ok: false, code: "not_a_number", message: `"${raw}" is not a number` };
  }
  const zero = ZERO_DECIMALS.exec(s);
  if (zero) return { ok: true, value: Number(zero[1]) };
  if (PLAIN.test(s) || WESTERN.test(s) || INDIAN.test(s)) return { ok: true, value: Number(s.replace(/,/g, "")) };
  if (/^[\d,]*\.\d+$/.test(s)) return { ok: false, code: "not_an_integer", message: `"${raw}" must be a whole number of units` };
  return { ok: false, code: "not_a_number", message: `"${raw}" is not a number` };
}

/** Optional units: empty → null. */
export function parseOptionalUnits(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: null };
  return parseUnits(raw);
}

export function parseDecimal(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: null };
  const s = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, code: "not_a_number", message: `"${raw}" is not a number` };
  return { ok: true, value: Number(s) };
}

export function parseBool(raw: string | undefined): Parsed<boolean> {
  const s = (raw ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return { ok: true, value: true };
  if (["false", "no", "n", "0"].includes(s)) return { ok: true, value: false };
  return { ok: false, code: "not_a_boolean", message: `"${raw ?? ""}" must be true/false` };
}

/**
 * Stock as-of (D15): must be Sunday 23:59 IST. Accepts
 *   2026-10-18T23:59:00+05:30 · 2026-10-18 23:59 (read as IST) · 2026-10-18 (date only = SAP close, 23:59 IST).
 * Returns the canonical "YYYY-MM-DDT23:59:00+05:30".
 */
export function parseAsOf(raw: string): Parsed<string> {
  const s = raw.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return { ok: false, code: "bad_as_of", message: `"${raw}" is not a date/time (use YYYY-MM-DD or YYYY-MM-DDTHH:MM+05:30)` };
  const [, date, hh, mm, , tz] = m;
  let istDate = date!;
  let istTime = "23:59";
  try {
    weekOfDate(istDate);
  } catch {
    return { ok: false, code: "bad_as_of", message: `"${raw}" is not a real date` };
  }
  if (hh !== undefined) {
    const offsetMin = tz === undefined ? 330 : tz === "Z" ? 0 : sign(tz) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(-2)));
    const utcMs = Date.parse(`${date}T${hh}:${mm}:00Z`) - offsetMin * 60_000;
    const ist = new Date(utcMs + 330 * 60_000).toISOString();
    istDate = ist.slice(0, 10);
    istTime = ist.slice(11, 16);
  }
  if (sundayOf(weekOfDate(istDate)) !== istDate || istTime !== "23:59") {
    return {
      ok: false,
      code: "as_of_not_sunday_close",
      message: `Stock must be SAP on-hand as at Sunday 23:59 IST; this file says ${istDate} ${istTime} IST. Re-export the stock_snapshot layout for Sunday ${previousSunday(istDate)}.`,
    };
  }
  return { ok: true, value: `${istDate}T23:59:00+05:30` };
}

function sign(tz: string): number {
  return tz.startsWith("-") ? -1 : 1;
}

/** The Sunday on or before `date`. */
function previousSunday(date: string): string {
  const wk = weekOfDate(date);
  if (sundayOf(wk) === date) return date;
  return new Date(Date.parse(`${mondayOf(wk)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
