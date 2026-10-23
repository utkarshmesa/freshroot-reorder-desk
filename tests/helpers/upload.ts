import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseFile } from "@/lib/upload/parse";
import type { InputFile, UploadContext } from "@/lib/upload/types";
import { DEFAULT_RULES } from "@/lib/rules/defaults";

export const ROOT = path.resolve(__dirname, "../..");

export function fileFromBytes(name: string, bytes: Uint8Array): InputFile {
  return { name, hash: createHash("sha256").update(bytes).digest("hex"), table: parseFile(name, bytes) };
}

export function fixture(rel: string): InputFile {
  const p = path.join(ROOT, rel);
  return fileFromBytes(path.basename(p), new Uint8Array(readFileSync(p)));
}

export function csv(name: string, text: string): InputFile {
  return fileFromBytes(name, new TextEncoder().encode(text));
}

export function context(over: Partial<UploadContext> = {}): UploadContext {
  return {
    caseDataMode: false,
    knownSkuIds: new Set(["SKU001", "SKU002", "00123"]),
    knownDistributorIds: new Set(["D001"]),
    knownSupplierIds: new Set(["SUP1"]),
    committedHashes: new Set(),
    latestCommittedWeek: "2026-W43",
    lastAsOf: "2026-10-18T23:59:00+05:30",
    previousWeekNetUnits: null,
    rules: {
      restatementWindowWks: DEFAULT_RULES.restatementWindowWks,
      volumeChangeConfirmPct: DEFAULT_RULES.volumeChangeConfirmPct,
      festivalUpliftPct: DEFAULT_RULES.festivalUpliftPct,
      festivalPreloadWks: DEFAULT_RULES.festivalPreloadWks,
    },
    ...over,
  };
}

export const codes = (issues: Array<{ code: string; level: string }>, level?: string) =>
  issues.filter((i) => !level || i.level === level).map((i) => i.code);
