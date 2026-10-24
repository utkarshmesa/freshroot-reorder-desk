import "server-only";
// C-039: run a week from files when Zoho can't be used. Validates the open-PO (and receipts) files, then the owner's
// own client calls use_file_mode, which checks the owner role and the run state and logs the reason. The worker
// then runs the rules on the file exactly as it would on a Zoho read.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedTable } from "@/lib/upload/types";
import { readPositionFiles } from "./parse";

export type StartResult = { ok: true; summary: { openLines: number; openUnits: number; pos: number }; warnings: string[] } | { ok: false; errors: string[] };

export async function startFileMode(
  user: SupabaseClient,
  a: { runId: string; openPos: ParsedTable; receipts: ParsedTable | null; reason: string; certified: boolean; uploadedBy: string; now?: Date },
): Promise<StartResult> {
  if (!a.certified) return { ok: false, errors: ["Tick that procurement confirmed this list is complete as of Monday 00:00 IST."] };
  const { data: run, error: runError } = await user.from("run").select("iso_week").eq("id", a.runId).single();
  if (runError || !run) return { ok: false, errors: ["Run not found."] };
  const { data: skus } = await user.from("sku").select("id");
  const files = readPositionFiles({ openPos: a.openPos, receipts: a.receipts, runWeek: run.iso_week as string, skus: new Set((skus ?? []).map((s) => s.id as string)) });
  if (files.errors.length) return { ok: false, errors: files.errors };

  // An earlier week's sheet still not placed holds its supplier this week (C-023, file mode).
  const { data: unplaced } = await user.from("draft_po").select("supplier_id").eq("mode", "file").eq("status", "created").neq("iso_week", run.iso_week);
  const doc = {
    source: "file",
    read_at: (a.now ?? new Date()).toISOString(),
    calls: 0,
    po_lines: files.poLines,
    receipts: files.receipts,
    blocked: {},
    pending_suppliers: [...new Set((unplaced ?? []).map((d) => d.supplier_id as string))].sort(),
    file: { names: [a.openPos.name, ...(a.receipts ? [a.receipts.name] : [])], uploadedBy: a.uploadedBy, summary: files.summary },
  };
  const { error } = await user.rpc("use_file_mode", { p_run_id: a.runId, p_doc: doc, p_reason: a.reason });
  if (error) return { ok: false, errors: [error.message] };
  return { ok: true, summary: files.summary, warnings: files.warnings };
}
