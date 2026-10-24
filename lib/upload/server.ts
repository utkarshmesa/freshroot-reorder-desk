import "server-only";
// Server-side upload flow: validate → stage (service role) → confirm → commit (user's JWT, RPC).
// Takes clients as arguments so integration tests can drive it without Next.js.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFile } from "./parse";
import { prepareUpload } from "./validate";
import type { InputFile, Report, UploadContext } from "./types";

const CHUNK = 5000;

export function toInputFile(name: string, bytes: Uint8Array): InputFile {
  return { name, hash: createHash("sha256").update(bytes).digest("hex"), table: parseFile(name, bytes) };
}

type Ctx = {
  latest_committed_week: string | null;
  current_run_week: string | null;
  last_as_of: string | null;
  previous_week_net_units: number | null;
  committed_hashes: string[];
  sku_ids: string[];
  active_sku_ids: string[];
  distributor_ids: string[];
  supplier_ids: string[];
  rules: { restatementWindowWks: number; volumeChangeConfirmPct: number; festivalUpliftPct: number; festivalPreloadWks: number };
};

export async function loadContext(user: SupabaseClient, hashes: string[], caseDataMode: boolean): Promise<UploadContext> {
  const { data, error } = await user.rpc("upload_context", { p_hashes: hashes });
  if (error) throw new Error(error.message);
  const c = data as Ctx;
  // Review M5b #8: per-SKU and per-distributor sales must never mix in the history (demand would double).
  const [skuLevel, distLevel] = await Promise.all([
    user.from("sales_fact").select("sku_id").eq("distributor_id", "ALL").limit(1),
    user.from("sales_fact").select("sku_id").neq("distributor_id", "ALL").limit(1),
  ]);
  const salesGranularity = distLevel.data?.length ? "distributor" : skuLevel.data?.length ? "sku" : null;
  return {
    salesGranularity,
    caseDataMode,
    knownSkuIds: new Set(c.sku_ids),
    activeSkuIds: new Set(c.active_sku_ids),
    knownDistributorIds: new Set(c.distributor_ids),
    knownSupplierIds: new Set(c.supplier_ids),
    committedHashes: new Set(c.committed_hashes),
    latestCommittedWeek: c.latest_committed_week,
    currentRunWeek: c.current_run_week,
    lastAsOf: c.last_as_of,
    previousWeekNetUnits: c.previous_week_net_units === null ? null : Number(c.previous_week_net_units),
    rules: {
      restatementWindowWks: c.rules.restatementWindowWks,
      volumeChangeConfirmPct: c.rules.volumeChangeConfirmPct,
      festivalUpliftPct: c.rules.festivalUpliftPct,
      festivalPreloadWks: c.rules.festivalPreloadWks,
    },
  };
}

/** Validates the files and records the upload with its report. Staging rows are written only if there are no errors. */
export async function stageUpload(args: {
  user: SupabaseClient;
  service: SupabaseClient;
  userId: string;
  files: InputFile[];
  caseDataMode: boolean;
}): Promise<{ uploadId: string; report: Report }> {
  const { user, service, userId, files, caseDataMode } = args;
  const ctx = await loadContext(user, files.map((f) => f.hash), caseDataMode);
  const prepared = prepareUpload(files, ctx);
  const { report } = prepared;

  const { data: up, error } = await service
    .from("upload")
    .insert({
      files: prepared.files,
      hashes: prepared.hashes,
      kinds: report.kinds,
      as_of_ts: report.asOf,
      weeks: report.newWeeks.concat(report.restatedWeeks),
      status: report.errors > 0 ? "rejected" : "staged",
      validation_report: report,
      case_data: caseDataMode,
      by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (report.errors === 0) {
    for (let i = 0; i < prepared.staging.length; i += CHUNK) {
      const chunk = prepared.staging.slice(i, i + CHUNK).map((s) => ({ upload_id: up.id, kind: s.kind, row: s.row }));
      const { error: e } = await service.from("upload_staging").insert(chunk);
      if (e) {
        await service.from("upload").update({ status: "rejected" }).eq("id", up.id);
        throw new Error(`Staging failed; nothing committed: ${e.message}`);
      }
    }
  }
  return { uploadId: up.id as string, report };
}

/** The uploader confirms every yellow item (e.g. ±40% volume) before commit. */
export async function confirmUpload(args: { user: SupabaseClient; service: SupabaseClient; userId: string; uploadId: string; confirmedCodes: string[] }): Promise<Report> {
  const { user, service, userId, uploadId, confirmedCodes } = args;
  // Only the uploader who staged it may confirm (admins can read every upload, so check the owner explicitly).
  const { data: up, error } = await user.from("upload").select("id, status, validation_report").eq("id", uploadId).eq("by", userId).single();
  if (error || !up) throw new Error("Upload not found");
  if (up.status !== "staged") throw new Error(`Upload is ${up.status}`);
  const report = up.validation_report as Report;
  const needed = report.issues.filter((i) => i.level === "confirm").map((i) => i.code);
  const missing = needed.filter((c) => !confirmedCodes.includes(c));
  const next: Report = { ...report, unconfirmed: missing.length };
  const { error: e } = await service.from("upload").update({ validation_report: next }).eq("id", uploadId).eq("by", userId).eq("status", "staged");
  if (e) throw new Error(e.message);
  return next;
}

export type CommitResult = { upload_id: string; run_id: string | null; run_week: string | null; restated_weeks: string[]; superseded_run: string | null };

/** All-or-nothing commit; runs as the user so the RPC's role check and audit apply. */
export async function commitUpload(user: SupabaseClient, uploadId: string): Promise<CommitResult> {
  const { data, error } = await user.rpc("commit_upload", { p_upload_id: uploadId });
  if (error) throw new Error(error.message);
  return data as CommitResult;
}
