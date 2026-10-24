import "server-only";
// The production LLM call (ARCHITECTURE §6): Anthropic SDK, key from env only. Null when no key is set, so
// every card keeps its template text. Model from LLM_MODEL, default a current Sonnet-class model.
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCall } from "./explain";

export const DEFAULT_LLM_MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 20_000;

export function productionLlm(): LlmCall | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const model = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
  return async (system, user) => {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
      // Short explanations: low effort. A safety decline is retried server-side on a fallback model.
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error(`LLM stopped: ${res.stop_reason}`);
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  };
}
