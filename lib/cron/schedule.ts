// Crons, pure part (ARCHITECTURE §4.1, §10). IST has no DST: IST = UTC + 5:30 all year.
import { mondayOf, type IsoWeek } from "@/lib/isoweek";

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** The decision deadline of a run week as a UTC instant (rules.deadline, default Tue 12:00 IST). */
export function deadlineFor(isoWeek: IsoWeek, d: { weekday: string; timeIST: string }): Date {
  const [h, m] = d.timeIST.split(":").map(Number);
  const offset = WEEKDAYS.indexOf(d.weekday.toUpperCase());
  if (offset < 0 || h === undefined || m === undefined) throw new Error(`Bad deadline setting ${d.weekday} ${d.timeIST}`);
  return new Date(Date.parse(`${mondayOf(isoWeek)}T00:00:00Z`) + offset * DAY_MS + (h * 60 + m) * 60_000 - IST_MS);
}

/**
 * The noon cron applies D8 when the deadline has passed and the run was ready before this firing. A run that
 * became ready after Tuesday's firing is caught by the next one (C-024: e.g. Wed 12:00).
 */
export function deadlineDue(run: { isoWeek: IsoWeek; readyAt: string | null }, now: Date, d: { weekday: string; timeIST: string }): boolean {
  if (!run.readyAt) return false;
  return now.getTime() >= deadlineFor(run.isoWeek, d).getTime() && Date.parse(run.readyAt) <= now.getTime();
}

export function isStale(d: { createdAt: string; status: string; mode: string; needsReapproval: boolean }, now: Date, staleDays: number): boolean {
  return (d.mode === "live" || d.mode === "file") && d.status === "created" && !d.needsReapproval && now.getTime() - Date.parse(d.createdAt) > staleDays * DAY_MS;
}

/** Unit-weighted share of decided units that were rejected; units = the engine's quantity on the card. */
export function rejectionAlarm(decided: Array<{ state: string; units: number }>, a: { lowPct: number; highPct: number }): { ratePct: number | null; level: "low" | "high" | null } {
  const total = decided.reduce((s, d) => s + d.units, 0);
  if (total <= 0) return { ratePct: null, level: null };
  const ratePct = Math.round((decided.filter((d) => d.state === "rejected").reduce((s, d) => s + d.units, 0) / total) * 1000) / 10;
  return { ratePct, level: ratePct < a.lowPct ? "low" : ratePct > a.highPct ? "high" : null };
}

/** Monday 00:00 IST of the week containing `now`. */
export function weekStartIST(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const dow = (ist.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - dow * DAY_MS - IST_MS);
}

/** True when no upload has been committed since Monday 00:00 IST of this week. */
export function uploadDue(now: Date, lastCommittedAt: string | null): boolean {
  return !lastCommittedAt || Date.parse(lastCommittedAt) < weekStartIST(now).getTime();
}

export type AlertKind = "run_blocked" | "pending_draft" | "draft_unconfirmed" | "cron_failed" | "draft_stale" | "deadline_applied" | "rejection_rate" | "upload_missed" | "run_ready_late" | "llm_fallback";
export type Recipient = { email: string; roles: string[]; isOwner: boolean; backupFor: string | null; backupFrom: string | null; backupTo: string | null };

/** Who gets each alert (§10; BUILD_PLAN §11). `day` is today's IST date, for backup cover. */
export function recipientsFor(kind: string, users: Recipient[], day: string): string[] {
  const has = (r: string) => (u: Recipient) => u.roles.includes(r);
  const owner = (u: Recipient) => u.isOwner;
  const backupUploader = (u: Recipient) => u.backupFor === "uploader" && (!u.backupFrom || u.backupFrom <= day) && (!u.backupTo || u.backupTo >= day);
  const rules: Record<string, Array<(u: Recipient) => boolean>> = {
    run_blocked: [has("admin"), has("uploader"), has("planner")],
    pending_draft: [has("procurement"), has("planner")],
    draft_unconfirmed: [has("admin"), has("procurement"), has("planner")],
    cron_failed: [has("admin")],
    festival_missing: [has("planner")],
    supplier_blocked: [has("procurement"), has("planner")],
    correction_after_send: [has("procurement"), has("planner")],
    lines_held: [has("planner")],
    send_failed: [has("planner"), has("admin")],
    po_sheets_ready: [has("procurement"), has("planner")],
    draft_stale: [has("procurement"), has("planner")],
    deadline_applied: [owner],
    rejection_rate: [owner],
    run_ready_late: [owner],
    upload_missed: [backupUploader, has("planner"), owner],
    llm_fallback: [has("admin")],
  };
  const pick = rules[kind] ?? [has("admin")];
  return [...new Set(users.filter((u) => pick.some((p) => p(u))).map((u) => u.email))].sort();
}
