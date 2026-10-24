// Claude explains, code decides (CLAUDE.md, D13). Pure orchestration over an injected LLM call: the text is
// used only if every number checks against the engine's facts; otherwise, or on any error, the template.
// Nothing here returns or changes a quantity.
import { checkNumbers } from "./numbers";
import { allowlist, BRIEF_SYSTEM, briefAllowlist, briefPrompt, REASON_SYSTEM, reasonPrompt, type BriefFacts, type CardFacts } from "./prompt";
import { briefTemplate, reasonTemplate, withNames } from "./template";

/** One completion: system + user text in, plain text out. Throws on outage. */
export type LlmCall = (system: string, user: string) => Promise<string>;
export type Explained = { text: string; source: "llm" | "template" };

const MAX_REASON_CHARS = 400;
const MAX_BRIEF_CHARS = 900;

async function attempt(llm: LlmCall | null, system: string, user: string, maxChars: number): Promise<string | null> {
  if (!llm) return null;
  try {
    const text = (await llm(system, user)).trim();
    return text && text.length <= maxChars ? text : null;
  } catch {
    return null; // the LLM never blocks a run
  }
}

export async function explainCard(c: CardFacts, llm: LlmCall | null, names: Record<string, string> | null): Promise<Explained> {
  const text = await attempt(llm, REASON_SYSTEM, reasonPrompt(c), MAX_REASON_CHARS);
  if (text && checkNumbers(text, allowlist(c), [c.name]).ok) return { text: withNames(text, names), source: "llm" };
  return { text: reasonTemplate(c, names), source: "template" };
}

export async function explainBrief(b: BriefFacts, llm: LlmCall | null): Promise<Explained> {
  const text = await attempt(llm, BRIEF_SYSTEM, briefPrompt(b), MAX_BRIEF_CHARS);
  if (text && checkNumbers(text, briefAllowlist(b), b.atRisk.map((r) => r.name)).ok) return { text, source: "llm" };
  return { text: briefTemplate(b), source: "template" };
}
