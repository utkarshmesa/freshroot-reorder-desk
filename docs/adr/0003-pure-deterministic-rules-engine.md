# ADR-0003: The rules engine is a pure, deterministic TypeScript module

**Status:** Accepted
**Date:** 23 Oct 2026
**Deciders:** Utkarsh, Raghav Kulkarni (rules owner)

## Context
Quantities drive real money: ₹28–34L a quarter in losses today. The same rules must:
- reproduce `expected_2026-W43.json` exactly;
- run in the 3-year replay for the day-45 gate;
- be explainable line by line to Raghav, and checkable by a team with no AI specialists.

## Decision
- `lib/engine` is pure. Plain typed inputs go in: history rows, stock, position parts from Zoho, settings, rule parameters, events, run week and the spot-check seed. Recommendations come out, with every intermediate value.
- No I/O, clock, randomness or environment access inside the engine.
- The run worker and `scripts/replay` share it verbatim.
- Full precision internally; half-to-even rounding only for display (C-012).
- Purity is enforced by import lint rules and a source-scan test.

## Options considered

### Option A: Pure TypeScript module (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low–medium |
| Cost | None |
| Scalability | Loads in SKU batches; 400 SKUs in seconds |
| Team familiarity | Same language as the app |

**Pros:** fast Vitest tests for every §13 rule case; the replay equals production by construction; re-runs are deterministic.
**Cons:** data must be loaded into memory, in batches.

### Option B: SQL views / stored procedures
**Pros:** close to the data.
**Cons:** hard to unit-test, hard to reuse offline in the replay, and logic split across two languages.

### Option C: Spreadsheet model or ML forecaster
**Pros:** familiar (spreadsheet) or potentially more accurate (ML).
**Cons:** neither can be audited or tested in CI. ML is deferred (§14), and DECISION_LOG chose "rules, not AI".

## Trade-off analysis
Testability and replay equality outweigh the small cost of loading data into memory.

## Consequences
- **Easier:** test-first development (W43 before any review-desk UI); an exact replay; Instructions bound to the same `rule_version.params` the engine uses.
- **Harder:** every new input must be threaded explicitly through the types. That's intended.
- **Revisit:** only if a run takes more than 5 minutes for 400 SKUs.

## Action items
1. [ ] `lib/isoweek` with W52 → W53 → W01 tests.
2. [ ] Engine tests from TEST_PLAN, starting with W43.
3. [ ] Purity lint rule and source-scan test.
