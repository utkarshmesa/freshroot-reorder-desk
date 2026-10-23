// ISO-8601 week arithmetic. Pure: no clock, no time zone of the host.
// Week labels are "YYYY-Www" (e.g. "2026-W53"). Dates are "YYYY-MM-DD" calendar dates.

export type IsoWeek = string;
export type IsoDate = string;

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function toDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday of ISO week 1 of `year`, as UTC milliseconds. */
function week1Monday(year: number): number {
  const jan4 = utc(year, 1, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Mon=0
  return jan4 - dow * DAY_MS;
}

export function weeksInYear(year: number): 52 | 53 {
  // A year has 53 weeks iff 28 Dec falls in week 53, i.e. Thursday rule.
  return (week1Monday(year + 1) - week1Monday(year)) / (7 * DAY_MS) === 53 ? 53 : 52;
}

export function format(year: number, week: number): IsoWeek {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function isValidWeek(label: string): boolean {
  const m = WEEK_RE.exec(label);
  if (!m) return false;
  const w = Number(m[2]);
  return w >= 1 && w <= weeksInYear(Number(m[1]));
}

export function parseWeek(label: string): { year: number; week: number } {
  if (!isValidWeek(label)) throw new Error(`Not a valid ISO week: "${label}"`);
  const m = WEEK_RE.exec(label)!;
  return { year: Number(m[1]), week: Number(m[2]) };
}

function parseDate(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: "${date}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = utc(y, mo, d);
  if (toDate(ms) !== date) throw new Error(`Not a real date: "${date}"`);
  return ms;
}

function mondayMs(label: IsoWeek): number {
  const { year, week } = parseWeek(label);
  return week1Monday(year) + (week - 1) * 7 * DAY_MS;
}

export function mondayOf(label: IsoWeek): IsoDate {
  return toDate(mondayMs(label));
}

export function sundayOf(label: IsoWeek): IsoDate {
  return toDate(mondayMs(label) + 6 * DAY_MS);
}

/** SAP snapshot boundary for a week (D15): its Sunday at 23:59 IST. */
export function sundayCloseIST(label: IsoWeek): string {
  return `${sundayOf(label)}T23:59:00+05:30`;
}

export function weekOfDate(date: IsoDate): IsoWeek {
  const ms = parseDate(date);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  const thursday = ms + (3 - dow) * DAY_MS; // the ISO year is the year of this week's Thursday
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((ms - dow * DAY_MS - week1Monday(year)) / (7 * DAY_MS)) + 1;
  return format(year, week);
}

export function addWeeks(label: IsoWeek, n: number): IsoWeek {
  return weekOfDate(toDate(mondayMs(label) + n * 7 * DAY_MS));
}

export const nextWeek = (label: IsoWeek): IsoWeek => addWeeks(label, 1);
export const prevWeek = (label: IsoWeek): IsoWeek => addWeeks(label, -1);

/** Number of weeks from `a` to `b` (positive if b is later). */
export function weekDiff(a: IsoWeek, b: IsoWeek): number {
  return Math.round((mondayMs(b) - mondayMs(a)) / (7 * DAY_MS));
}

export function compareWeeks(a: IsoWeek, b: IsoWeek): number {
  return weekDiff(b, a);
}

/** Inclusive list of weeks from `from` to `to`. */
export function weekRange(from: IsoWeek, to: IsoWeek): IsoWeek[] {
  const n = weekDiff(from, to);
  if (n < 0) return [];
  return Array.from({ length: n + 1 }, (_, i) => addWeeks(from, i));
}
