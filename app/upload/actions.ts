"use server";
import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/me";
import { caseDataMode, serviceClient, userClient } from "@/lib/db/server";
import { commitUpload, confirmUpload, stageUpload, toInputFile, type CommitResult } from "@/lib/upload/server";
import type { Report } from "@/lib/upload/types";

export type ValidateResult = { ok: true; uploadId: string; report: Report } | { ok: false; error: string };

/** Downloads the just-uploaded files from the caller's own storage folder, validates and stages them. */
export async function validateUpload(paths: string[]): Promise<ValidateResult> {
  try {
    const session = await requireAction("upload.commit");
    if (paths.length === 0) return { ok: false, error: "Choose at least one file." };
    if (!paths.every((p) => p.startsWith(`${session.userId}/`))) return { ok: false, error: "Files must be in your own upload folder." };
    const service = serviceClient();
    const files = [];
    for (const p of paths) {
      const { data, error } = await service.storage.from("uploads").download(p);
      if (error || !data) return { ok: false, error: `Couldn't read ${p.split("/").pop()}: ${error?.message ?? "missing"}` };
      files.push(toInputFile(p.split("/").pop()!, new Uint8Array(await data.arrayBuffer())));
    }
    const { uploadId, report } = await stageUpload({ user: await userClient(), service, userId: session.userId, files, caseDataMode: caseDataMode() });
    revalidatePath("/upload");
    return { ok: true, uploadId, report };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CommitActionResult = { ok: true; result: CommitResult } | { ok: false; error: string };

/** Records the uploader's confirms, then commits all-or-nothing. */
export async function confirmAndCommit(uploadId: string, confirmedCodes: string[]): Promise<CommitActionResult> {
  try {
    await requireAction("upload.commit");
    const user = await userClient();
    if (confirmedCodes.length > 0) await confirmUpload({ user, service: serviceClient(), uploadId, confirmedCodes });
    const result = await commitUpload(user, uploadId);
    revalidatePath("/upload");
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
