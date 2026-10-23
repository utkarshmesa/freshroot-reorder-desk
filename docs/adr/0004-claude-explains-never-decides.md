# ADR-0004: Claude explains, never decides, with number checking and a template fallback

**Status:** Accepted
**Date:** 23 Oct 2026
**Deciders:** Utkarsh, Deepa Nair

## Context
- The CEO wants "AI running by Q1".
- Raghav reviews faster with a plain-English reason on each card.
- An LLM must never change a quantity or invent a number.
- Distributor data is commercially sensitive.

## Decision
- Claude (Anthropic API, model set by `LLM_MODEL`) writes one or two sentences per queue or spot-check card, plus the weekly brief.
- Prompts contain numbers and distributor codes (D1..D3) only. Names are inserted after the check.
- Every number in the output must match the engine's values for that card, at the precision written. If any doesn't, the fixed template sentence is used.
- The run shows template text first and swaps in Claude's text once it passes the check, so **the LLM never blocks a run**. An outage, timeout or missing key all fall back to the template.
- `reason_source` is stored and the fallback rate is monitored.

## Options considered

### Option A: LLM explanation with a checker and template (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium (the number checker) |
| Cost | Small: tens of calls per week |
| Scalability | Concurrency 5, 20 s timeout |
| Team familiarity | New, but contained in `lib/llm` |

**Pros:** faster review and a readable CEO brief; no authority over numbers; works with no LLM at all.
**Cons:** the checker may reject good text that contains harmless numbers. That falls back to the template; the tests are used to tune it.

### Option B: Templates only
**Pros:** simplest.
**Cons:** a weaker brief, and it contradicts the user's decision to keep AI explanations (DECISION_LOG §5).

### Option C: LLM proposes quantities
Rejected. It breaks the core guardrail and can't be audited.

## Consequences
- **Easier:** a safe way to show AI value.
- **Harder:** keeping the checker's number normalisation right for Indian formats (₹1.2L, percentages, "6.1 weeks").
- **Revisit:** if more than 30% of texts fall back to the template for 3 weeks running.

## Action items
1. [ ] Number extractor and normaliser with unit tests (`1,200`, `₹1.2L`, `25%`, half-to-even).
2. [ ] A template for each action/flag combination.
3. [ ] Prompt-capture test: no distributor names in any prompt.
