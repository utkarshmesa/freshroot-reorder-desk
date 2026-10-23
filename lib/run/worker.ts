import "server-only";
// The weekly run as a resumable state machine (ARCHITECTURE §4). Each call claims the run with a row
// lease, does the next steps, and releases it. Safe to call from the commit trigger and the cron at once.
//
// Milestone 2: case-data mode skips Zoho (the W43 reference assumes no open POs). Outside case-data
// mode the run fails closed until the Zoho reader lands in milestone 3.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runEngine } from "@/lib/engine";
import type { Recommendation } from "@/lib/engine/types";
import { loadEngineInput, type RunRow } from "./load";

export type ProcessResult = { runId: string; status: string; claimed: boolean; error?: string };

/** After this many failed attempts a run is blocked and the admin alerted, instead of retrying forever. */
export const MAX_ATTEMPTS = 3;

function lineState(r: Recommendation): string | null {
  if (r.holdout || r.action === "blocked") return null;
  if (r.triage === "auto") return r.spotCheck ? "queued" : "auto";
  if (r.triage === "queue") return "queued";
  return null;
}

export function toRow(runId: string, r: Recommendation) {
  const { skuId, action, qty, cover, coverAfter, flags, topDistributors, triage, assumed, holdout, daysToStockout, spotCheck, ...inputs } = r;
  return {
    run_id: runId,
    sku_id: skuId,
    action,
    qty,
    cover,
    cover_after: coverAfter,
    flags,
    top_distributors: topDistributors,
    triage,
    line_state: lineState(r),
    inputs,
    assumed,
    holdout,
    days_to_stockout: daysToStockout,
    spot_check: spotCheck,
  };
}

async function block(db: SupabaseClient, runId: string, reason: string, message: string) {
  await db.from("run").update({ status: "blocked", error: { reason, message } }).eq("id", runId);
  await db.from("alert").upsert({ kind: "run_blocked", dedupe_key: `run_blocked:${runId}`, run_id: runId, payload: { reason, message } }, { onConflict: "dedupe_key" });
}

export async function processRun(db: SupabaseClient, runId: string, opts: { caseDataMode: boolean; now?: Date }): Promise<ProcessResult> {
  const { data: claimed, error: claimError } = await db.rpc("claim_run", { p_run_id: runId });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) {
    const { data } = await db.from("run").select("status").eq("id", runId).single();
    return { runId, status: data?.status ?? "unknown", claimed: false };
  }
  const now = (opts.now ?? new Date()).toISOString();
  try {
    const { data: run, error } = await db.from("run").select("id, iso_week, rule_version_id, mode, spot_check_seed, status, step_attempts").eq("id", runId).single();
    if (error || !run) throw new Error(error?.message ?? "run not found");
    let status = (run as RunRow).status;

    if (status === "queued") {
      if (!opts.caseDataMode) {
        await block(db, runId, "zoho_not_connected", "Zoho isn't connected yet, so open POs and receipts can't be read. The run is blocked (fail closed).");
        return { runId, status: "blocked", claimed: true };
      }
      await db.from("run").update({ status: "engine", zoho_read: { skipped: "case_data", read_at: now } }).eq("id", runId);
      status = "engine";
    }

    if (status === "engine") {
      const input = await loadEngineInput(db, run as RunRow, { caseDataMode: opts.caseDataMode });
      // A missing stock file blocks the whole run (CLAUDE.md: fail closed), not just every SKU.
      if (Object.keys(input.onHand).length === 0) {
        await block(db, runId, "no_stock_snapshot", `No stock snapshot for the Sunday before ${(run as RunRow).iso_week}.`);
        return { runId, status: "blocked", claimed: true };
      }
      const out = runEngine(input);
      // Only write if this run is still the current one for its week (a correction may have superseded it).
      const current = await db.from("run").select("id").eq("id", runId).is("superseded_by", null).maybeSingle();
      if (!current.data) return { runId, status: "superseded", claimed: true };
      const del = await db.from("recommendation").delete().eq("run_id", runId);
      if (del.error) throw new Error(del.error.message);
      const ins = await db.from("recommendation").insert(out.recommendations.map((r) => toRow(runId, r)));
      if (ins.error) throw new Error(ins.error.message);
      const done = await db.from("run").update({ status: "ready", ready_at: now, notes: out.notes, error: null }).eq("id", runId).is("superseded_by", null).select("id");
      status = done.data?.length ? "ready" : "superseded";
    }
    return { runId, status, claimed: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { data } = await db.from("run").select("step_attempts").eq("id", runId).single();
    if ((data?.step_attempts ?? 0) >= MAX_ATTEMPTS) {
      await block(db, runId, "step_failed", `The run failed ${MAX_ATTEMPTS} times: ${message}`);
      return { runId, status: "blocked", claimed: true, error: message };
    }
    await db.from("run").update({ error: { reason: "step_failed", message } }).eq("id", runId);
    throw e;
  } finally {
    await db.rpc("release_run", { p_run_id: runId });
  }
}

/** Safety net: process every run that isn't finished (called by the cron route). */
export async function processPendingRuns(db: SupabaseClient, opts: { caseDataMode: boolean }): Promise<ProcessResult[]> {
  // Milestone 2 advances only these states; zoho_read/mapping/readback arrive with the Zoho reader.
  const { data, error } = await db.from("run").select("id").is("superseded_by", null).in("status", ["queued", "engine"]);
  if (error) throw new Error(error.message);
  const out: ProcessResult[] = [];
  for (const r of data ?? []) {
    // One failing run must not stop the others.
    try {
      out.push(await processRun(db, r.id as string, opts));
    } catch (e) {
      out.push({ runId: r.id as string, status: "error", claimed: true, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
