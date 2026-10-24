// Binds the ⚙ values in docs/INSTRUCTIONS.md to the live rules (BUILD_PLAN §10.5). Pure.
// Syntax: {{path=default}} or {{path|transform=default}}. `path` is a key in the rule parameters (the same
// source the engine reads); `default` is what the document says today, shown if the rule can't be read.
// Transforms: pct (ratio → percent above 1, 1.2 → 20), +1 (the week after).
import { roundHalfEven } from "@/lib/engine/round";
import { getPath } from "@/lib/rules/form";

export type Binding = { raw: string; path: string; transform: string | null; fallback: string };

const TOKEN = /\{\{([^}=|]+)(?:\|([^}=]+))?=([^}]*)\}\}/g;

export function bindings(text: string): Binding[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ raw: m[0].slice(2, -2), path: m[1]!.trim(), transform: m[2]?.trim() ?? null, fallback: m[3]! }));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function format(v: unknown, transform: string | null): string | null {
  if (typeof v === "string") return transform ? null : v;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  let x = v;
  if (transform === "pct") x = (v - 1) * 100;
  else if (transform === "+1") x = v + 1;
  else if (transform) return null;
  return String(roundHalfEven(x, 2));
}

/** Replaces every binding with its live value. Unknown rules keep the written default and are reported. */
export function bindInstructions(text: string, params: unknown): { text: string; errors: string[] } {
  const errors: string[] = [];
  const out = text.replace(TOKEN, (_all, path: string, transform: string | undefined, fallback: string) => {
    const v = format(getPath(params, path.trim()), transform?.trim() ?? null);
    if (v === null) {
      errors.push(path.trim());
      return escapeHtml(fallback);
    }
    return escapeHtml(v);
  });
  return { text: out, errors };
}

/** Section ids that other screens link to: "6. What to do when…" → what-to-do-when. */
const SECTION_IDS: Record<string, string> = {
  "1": "what-it-does",
  "2": "weekly-rhythm",
  "3": "guides",
  "4": "rules",
  "5": "assumptions",
  "6": "what-to-do-when",
  "7": "who-to-ask",
  "8": "words",
};

export function headingId(text: string): string {
  const numbered = /^(\d+)\.\s/.exec(text);
  if (numbered && SECTION_IDS[numbered[1]!]) return SECTION_IDS[numbered[1]!]!;
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
