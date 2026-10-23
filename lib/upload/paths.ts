// Storage paths for raw upload files: uploads/{user id}/{batch uuid}/{file name}.
// Strict on purpose: no "..", no percent-encoding, no backslashes, no extra folders (code review finding 2).
const PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9 ._()-]{1,200})$/;

export function isOwnUploadPath(path: string, userId: string): boolean {
  const m = PATH.exec(path);
  return m !== null && m[1] === userId && !m[3]!.includes("..");
}

/** A file name that will pass isOwnUploadPath (other characters become "_"). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/\.\.+/g, ".").slice(0, 200);
  return cleaned || "file";
}
