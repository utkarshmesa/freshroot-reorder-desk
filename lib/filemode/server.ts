import "server-only";
// C-039: run a week from files when Zoho can't be used. The caller has already checked the owner's session
// (requireAction). This validates the open-PO (and receipts) files itself, then the service client calls
// use_file_mode with the owner's id, so no client can hand the database its own position (review M5b #10).
// The worker then runs the rules on the file exactly as on a Zoho read.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedTable } from "@/lib/upload/types";
import { readPositionFiles } from "./parse";

export type StartResult = { ok: true; summary: { openLines: number; openUnits: number; pos: number }; warnings: string[] } | { ok: false; errors: string[] };

export async function startFileMode(
  service: SupabaseClient,
  a: { runId: string; actorId: string; openPos: ParsedTable; receipts: ParsedTable | null; reason: string; certified: boolean; uploadedBy: string; now?: Date },
): Promise<StartResult> {
  if (!a.certified) return { ok: false, errors: ["Tick that procurement confirmed this list is complete as of Monday 00:00 IST."] };
  const { data: run, error: runError } = await service.from("run").select("iso_week").eq("id", a.runId).single();
  if (runError || !run) return { ok: false, errors: ["Run not found."] };
  const { data: skus } = await service.from("sku").select("id");
  const files = readPositionFiles({ openPos: a.openPos, receipts: a.receipts, runWeek: run.iso_week as string, skus: new Set((skus ?? []).map((s) => s.id as string)) });
  if (files.errors.length) return { ok: false, errors: files.errors };

  // One pending order per supplier, across both kinds (review M5b #3): an earlier week's Zoho draft still
  // unissued at its last read-back, or an earlier file-mode sheet not yet placed, holds the supplier.
  const { data: unsettled } = await service.from("draft_po").select("supplier_id").in("mode", ["live", "file"]).eq("status", "created").neq("iso_week", run.iso_week);
  const doc = {
    source: "file",
    read_at: (a.now ?? new Date()).toISOString(),
    calls: 0,
    po_lines: files.poLines,
    receipts: files.receipts,
    blocked: {},
    pending_suppliers: [...new Set((unsettled ?? []).map((d) => d.supplier_id as string))].sort(),
    file: { names: [a.openPos.name, ...(a.receipts ? [a.receipts.name] : [])], uploadedBy: a.uploadedBy, summary: files.summary },
  };
  const { error } = await service.rpc("use_file_mode", { p_run_id: a.runId, p_doc: doc, p_reason: a.reason, p_actor: a.actorId });
  if (error) return { ok: false, errors: [error.message] };
  return { ok: true, summary: files.summary, warnings: files.warnings };
}
