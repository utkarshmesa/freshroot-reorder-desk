import "server-only";
// Scheduled jobs (ARCHITECTURE §4.1, §10). Service-role client. Each is idempotent: state is checked before
// acting and alerts are de-duplicated by key, so a double firing is harmless.
//   noon (daily 12:00 IST): Tuesday rule (D8, C-024) → send → rejection alarm; stale drafts (C-009)
//   uploadCheck (Mon 10:00 IST): no committed upload this week → alert
//   deliverAlerts (every 5 min with the run cron): email pending alerts via Resend (C-027)
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyDeadline, type LineState } from "@/lib/engine/deadline";
import { mondayOf, nextWeek, weekOfDate } from "@/lib/isoweek";
import type { RuleParams } from "@/lib/rules/defaults";
import { recFromRow } from "@/lib/run/worker";
import { sendToProcurement, type SendOptions } from "@/lib/send/send";
import { productionZoho } from "@/lib/zoho/client";
import { readback, type RequestedLine } from "@/lib/zoho/map";
import { readPo } from "@/lib/zoho/reader";
import { deadlineDue, isStale, recipientsFor, rejectionAlarm, uploadDue, type Recipient } from "./schedule";

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

export async function raiseAlert(db: SupabaseClient, kind: string, key: string, payload: Record<string, unknown>, runId: string | null = null) {
  await db.from("alert").upsert({ kind, dedupe_key: key, run_id: runId, payload }, { onConflict: "dedupe_key", ignoreDuplicates: true });
}

const istDay = (now: Date) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

type RunInfo = { id: string; iso_week: string; ready_at: string | null; rule_version_id: number; deadline_applied_at: string | null; created_at: string };

export type NoonResult = { applied: Array<{ runId: string; deadlineAuto: number; rolled: number; send: string }>; resent: string[]; stale: string[]; errors: string[] };

export async function noonJob(db: SupabaseClient, now: Date, send: SendOptions = {}): Promise<NoonResult> {
  const out: NoonResult = { applied: [], resent: [], stale: [], errors: [] };
  // Only the latest week, and only until its week ends: an older week must never send after the next
  // week's run has read Zoho (review M5, finding 4).
  const latest = (await must(
    db.from("run").select("id, iso_week, ready_at, rule_version_id, deadline_applied_at, created_at, status").is("superseded_by", null).order("iso_week", { ascending: false }).limit(1),
    "runs",
  )) as unknown as Array<RunInfo & { status: string }>;
  const run = latest[0];
  const weekOver = run ? now.getTime() >= Date.parse(`${mondayOf(nextWeek(run.iso_week))}T00:00:00+05:30`) : true;

  if (run && !weekOver && ["ready", "llm", "done"].includes(run.status)) {
    try {
      const { params } = (await must(db.from("rule_version").select("params").eq("id", run.rule_version_id).single(), "rules")) as unknown as { params: RuleParams };
      if (deadlineDue({ isoWeek: run.iso_week, readyAt: run.ready_at }, now, params.deadline)) {
        // Applied on every firing after the deadline to whatever is still queued: the updates are conditional,
        // so a firing that crashed half-way is finished by the next one (review M5, finding 3).
        await db.from("run").update({ deadline_applied_at: now.toISOString() }).eq("id", run.id).is("deadline_applied_at", null);
        const rows = await must(db.from("recommendation").select("*").eq("run_id", run.id).eq("line_state", "queued"), "queued lines");
        const results = applyDeadline(rows.map((r) => ({ rec: recFromRow(r), state: "queued" as LineState })), { deadlineStdMultiple: params.deadlineStdMultiple });
        let deadlineAuto = 0;
        let rolled = 0;
        for (const [i, res] of results.entries()) {
          const updated = await must(db.from("recommendation").update({ line_state: res.state, final_qty: res.state === "deadline_auto" ? res.qty : 0 }).eq("id", rows[i]!.id).eq("line_state", "queued").select("id"), "deadline line");
          if (updated.length && res.state === "deadline_auto") deadlineAuto++;
          else if (updated.length) rolled++;
        }

        let sendNote = "nothing to send";
        try {
          // Wait for a planner's send that is running right now, then send what the rule just settled.
          const r = await sendToProcurement(db, run.id, { ...send, now, lockTries: send.lockTries ?? 6 });
          sendNote = r.stopped ?? `${r.mode}: ${r.sent.length} supplier draft(s)`;
        } catch (e) {
          sendNote = `send failed: ${e instanceof Error ? e.message : String(e)}`;
          out.errors.push(sendNote);
        }
        if (rows.length) {
          await raiseAlert(db, "deadline_applied", `deadline:${run.id}`, { week: run.iso_week, deadlineAuto, rolled, send: sendNote }, run.id);
          out.applied.push({ runId: run.id, deadlineAuto, rolled, send: sendNote });
        } else out.resent.push(run.id);

        const decided = await must(db.from("recommendation").select("qty, line_state, decision!inner(status)").eq("run_id", run.id).in("line_state", ["approved", "changed", "rejected", "sent"]), "decided");
        const alarm = rejectionAlarm(
          decided.map((d) => ({ state: (d.decision as Array<{ status: string }>).find((x) => x.status !== "reapproved")?.status ?? String(d.line_state), units: d.qty as number })),
          params.rejectionAlarm,
        );
        if (alarm.level) await raiseAlert(db, "rejection_rate", `rejection_rate:${run.id}`, { week: run.iso_week, ratePct: alarm.ratePct, level: alarm.level }, run.id);
      }
    } catch (e) {
      out.errors.push(`${run.iso_week}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    out.stale = await staleDrafts(db, now, send);
  } catch (e) {
    out.errors.push(`stale drafts: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Errors must reach a person, not only a JSON response (review M5, finding 3).
  if (out.errors.length) await raiseAlert(db, "cron_failed", `cron_failed:noon:${istDay(now)}`, { message: `The 12:00 job had errors: ${out.errors.join(" | ")}` });
  return out;
}

/** C-009: a live draft still unissued after draftStaleDays → re-check Zoho, then flag for re-approval and alert. */
async function staleDrafts(db: SupabaseClient, now: Date, send: SendOptions): Promise<string[]> {
  const { params: rules } = (await must(db.from("rule_version").select("params").eq("is_current", true).single(), "rules")) as unknown as { params: RuleParams };
  const drafts = await must(db.from("draft_po").select("id, reference, supplier_id, zoho_po_id, status, mode, created_at, needs_reapproval, requested_lines").eq("mode", "live").eq("status", "created"), "drafts");
  const candidates = drafts.filter((d) => isStale({ createdAt: d.created_at as string, status: d.status as string, mode: d.mode as string, needsReapproval: d.needs_reapproval as boolean }, now, rules.draftStaleDays));
  if (!candidates.length) return [];
  const http = (send.zoho ?? productionZoho)(db, 60);
  const flagged: string[] = [];
  for (const d of candidates) {
    // The Monday read-back may be days old: check Zoho first so an issued draft isn't flagged.
    if (http && d.zoho_po_id) {
      const rb = readback(await readPo(http, d.zoho_po_id as string), (d.requested_lines ?? []) as RequestedLine[]);
      if (rb.status === "deleted" || !rb.pending) {
        await db.from("draft_po").update(rb.status === "deleted" ? { status: "deleted", last_read_at: now.toISOString() } : { status: rb.status, issued_at: now.toISOString(), last_read_at: now.toISOString(), ...(rb.changed ? { issued_lines: rb.lines } : {}) }).eq("id", d.id).eq("status", "created");
        continue;
      }
    }
    await db.from("draft_po").update({ needs_reapproval: true }).eq("id", d.id).eq("needs_reapproval", false);
    await raiseAlert(db, "draft_stale", `draft_stale:${d.id}`, { reference: d.reference, supplier: d.supplier_id, message: `${d.reference} hasn't been issued in ${rules.draftStaleDays} days. Raghav must re-approve it before procurement issues it.` });
    flagged.push(d.reference as string);
  }
  return flagged;
}

/** Mon 10:00 IST: nothing committed since Monday 00:00 IST → alert the backup uploader, Raghav and Deepa. */
export async function uploadCheck(db: SupabaseClient, now: Date): Promise<boolean> {
  const last = await must(db.from("upload").select("committed_at").eq("status", "committed").order("committed_at", { ascending: false }).limit(1), "uploads");
  if (!uploadDue(now, (last[0]?.committed_at as string | undefined) ?? null)) return false;
  const week = weekOfDate(istDay(now));
  await raiseAlert(db, "upload_missed", `upload_missed:${week}`, { week, message: `No upload has been committed for ${week} by 10:00. The run can't start until it is.` });
  return true;
}

const SUBJECTS: Record<string, string> = {
  run_blocked: "Reorder Desk: this week's run is blocked",
  pending_draft: "Reorder Desk: a pending draft is holding a supplier",
  draft_unconfirmed: "Reorder Desk: a draft request isn't visible in Zoho yet",
  cron_failed: "Reorder Desk: a scheduled job had errors",
  draft_stale: "Reorder Desk: a draft needs re-approval",
  deadline_applied: "Reorder Desk: Tuesday 12:00 rule applied",
  rejection_rate: "Reorder Desk: rejection rate outside the expected range",
  upload_missed: "Reorder Desk: Monday upload missing",
  run_ready_late: "Reorder Desk: this week's queue was ready late",
  llm_fallback: "Reorder Desk: most AI reasons fell back to templates",
};

export type EmailSender = (to: string[], subject: string, text: string) => Promise<void>;

/** Resend (C-027), key server-side only. Null when not configured: alerts stay pending, visible to admins. */
export function resendSender(): EmailSender | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!key || !from) return null;
  return async (to, subject, text) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend: HTTP ${res.status}`);
  };
}

export async function deliverAlerts(db: SupabaseClient, sender: EmailSender | null, now: Date): Promise<number> {
  if (!sender) return 0;
  const pending = await must(db.from("alert").select("id, kind, payload").is("sent_at", null).order("id").limit(50), "alerts");
  if (!pending.length) return 0;
  const users = (await must(db.from("app_user").select("email, roles, is_owner, backup_for, backup_from, backup_to"), "users")).map(
    (u): Recipient => ({ email: u.email as string, roles: u.roles as string[], isOwner: u.is_owner as boolean, backupFor: (u.backup_for as string | null) ?? null, backupFrom: (u.backup_from as string | null) ?? null, backupTo: (u.backup_to as string | null) ?? null }),
  );
  let sent = 0;
  for (const a of pending) {
    const to = recipientsFor(a.kind as string, users, istDay(now));
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const text = typeof p.message === "string" ? p.message : JSON.stringify(p, null, 2);
    // Claim before sending so a parallel delivery doesn't email twice.
    const claimed = await must(db.from("alert").update({ sent_at: now.toISOString(), to }).eq("id", a.id).is("sent_at", null).select("id"), "claim alert");
    if (claimed.length !== 1) continue;
    if (!to.length) continue;
    try {
      await sender(to, SUBJECTS[a.kind as string] ?? `Reorder Desk: ${a.kind}`, text);
      sent++;
    } catch {
      await db.from("alert").update({ sent_at: null }).eq("id", a.id); // retry on the next firing
    }
  }
  return sent;
}
