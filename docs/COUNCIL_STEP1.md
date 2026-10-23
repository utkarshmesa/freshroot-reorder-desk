# LLM council: "What must change before we write code?"

Date: 23 Oct 2026 · Material: `ARCHITECTURE.md`, `TEST_PLAN.md`, `adr/0001–0005`, `CHANGES.md`, against the locked BUILD_PLAN v1.2 and CLAUDE.md.

**Members** (blind stage 1, then anonymised peer review):

| Label | Lens | Model |
|---|---|---|
| A | Maintainer engineer (Vercel, Supabase, Zoho realities) | Opus |
| B | Supply-chain / data correctness | Opus |
| C | Skeptic (guardrails, contradictions, over-engineering) | Sonnet |
| D | Operators (Raghav, Priya, procurement, Deepa) | Sonnet |

**Cost:** 8 agent runs (4 answers + 4 peer reviews).

## Verdict

**Fix before code, then start Milestone 1.** The architecture is sound, but the first draft had **three bugs that would have caused double orders or lost orders in the first live week**, plus several platform limits it didn't account for. All of those are now fixed in the docs. Milestone 1 (upload, settings) can start; the open items below don't block it, except the two M1 exit conditions.

## Aggregate ranking (peer review)

| Response | Ranked by others | Overall |
|---|---|---|
| A (maintainer) | 1st, 1st, 1st | **1st**: concrete bugs and platform limits |
| C (skeptic) | 1st, 2nd, 2nd | **2nd**: guardrail gaps |
| D (operators) | 2nd, 3rd, 2nd | **3rd**: workflow gaps |
| B (data) | 3rd, 3rd, 3rd | **4th**: right questions, but over-scoped answers. Its D20 insight was rated by everyone as the most important single point they missed |

## Consensus changes (applied)

| # | Change | Raised / endorsed by | Where |
|---|---|---|---|
| 1 | **Issued FR- POs count as stock.** Exclude drafts by status only. ("Double-excluded by reference" would have caused a guaranteed double order.) | A; endorsed by B, C, D | ARCH §5, ZO-01 |
| 2 | **One draft per supplier per week + no update scope ⇒ define Send.** Line-state table; a supplier is sent only once nothing is queued; Tue 12:00 sends everything left, including approved-but-unsent lines; `blocked_pending` is visible and emailed. | A, D; endorsed by C | ARCH §4.1, C-015, TR-03, ST-01 |
| 3 | **Live Zoho re-check before create**, readback by `zoho_po_id`, recovery from a stuck `creating` row (search, then POST), read-back must be a draft. | A, C | ARCH §4.1, §5; ZO-04/06/14/16 |
| 4 | **Shadow-mode proof isn't circular any more:** read-only token in non-production; effective mode needs both env and DB to say live (unset = shadow); assertion scoped to the API host; the Tue 12:00 auto-send respects mode; `shadow` rows never block live rows. | C, A | ADR-0005, ARCH §3.1/§5, ST-04 |
| 5 | **Zoho scope check is a Milestone 1 exit blocker**, extended to filters, token limits and the read-only token; real responses become the fixtures. | C, A | ADR-0002, TEST_PLAN §6 |
| 6 | **Monday receipt on a fully received PO** still counts (receipts read by date, whatever the PO's status). | A; endorsed by B | ARCH §5, ZO-15 |
| 7 | **Platform realities:**<br>• row lease on `run`;<br>• `after()` instead of a DB "ping";<br>• RPCs for multi-step writes;<br>• `engine_inputs()` RPC (PostgREST's 1,000-row limit);<br>• `commit_upload` statement timeout and chunked staging;<br>• RLS rules (definer helpers, `security_invoker` views, `app_mode` table, role checks inside RPCs and Zoho routes). | A | ARCH §3, §4 |
| 8 | **LLM checker:** allowlist built from the payload only, no free small numbers, identifiers stripped; adversarial "order 900" test; qty never read from LLM text. | C | ARCH §6, CL-02 |
| 9 | **Re-runs after a correction** are defined (decisions carry over only if unchanged; suppliers with drafts are untouched). | D; endorsed by A | ARCH §4.2, RN-03/04 |
| 10 | **Stockout week is on shelf stock**, not position or uplifted forecast; one `lib/outcomes` shared by Outcomes and the replay. | B | ARCH §8, C-017, OC-01 |
| 11 | **Write-offs:** inferred loss is zero by construction on rebuilt history. C-014 rewritten; the question goes to Priya / IT SAP. | B; endorsed by A, C | C-014 |
| 12 | **Tests:** spot-check seed stored; cron double-fire idempotent; ST-07 parses every ⚙; W44-synthetic golden; aggregation tests; real SAP sample as an M1 exit condition. | C, B, D | TEST_PLAN |

## Contested points and rulings

| Point | For | Against | Ruling |
|---|---|---|---|
| Drop the 5-min cron, use a manual retry | C (too much machinery for 3 people) | A (a stuck run would wait for someone to notice; breaks fail-closed alerting) | **Keep the cron + lease**, and also add a manual Retry button. Requires Vercel Pro (C-022). |
| Access token cached in memory only | C (avoids an extra encryption key) | A (serverless would mint a token per invocation and hit Zoho's limit) | **DB table, service role only, no extra key.** The refresh token stays in env. The mint limit is verified in week 1. |
| Defer the property test RU-14 | C | B (cheap; guards the only source of quantities) | **Keep.** Trim nothing from §13. |
| Decimal arithmetic in the engine | C | B (quantities are integers; half-to-even reproduces W43) | **No decimal library.** |
| Aggregation formula C-016 "breaks W43" | A | — | **Wrong:** with distributor `ALL` the formula is identical. Applied as a clarification. |
| Stale position, warn at >5% change at Send | D | B (5% is an invented business number) | **Show "position as of …" instead.** The live re-check covers system drafts. |
| Tue 12:00 also sends approved lines | D (otherwise approved lines are lost) | B (changes D8) | **Applied as clarification C-015.** D8 governs *unreviewed* lines; approved lines going to procurement is the plan's intent. Flagged for your confirmation. |
| Random holdout + difference-in-differences | B | C, D, A (changes A16, new method) | **Proposed, not applied** (C-019). |
| Replay simulator spec | B (veto on the gate) | C, D (big new scope) | **Proposed** (C-020): write the spec at M4 start, keep it minimal. The gate's validity does depend on it. |

## Unique catches worth keeping
- D: get a **real SAP export sample** before M1 exit. A Monday-morning export may not be Sunday 23:59 stock, which would block Priya every week.
- D: holidays (C-021, deferred).
- B: report how often HD 1.5× stacks with the +25% festival uplift (D6 risk). Goes into the replay report.
- A: Zoho search may lag behind a create. The idempotent create retries the search after 5 s and also lists vendor drafts.

## Rejected claims
- "Approve C-014 Option A as is" (D): unsafe. It's zero on rebuilt history and biased if only positive residuals are counted.
- "C-016 changes W43" (A): it doesn't; see above.
- "Zoho mints ~10 tokens / 10 min" (A): unverified, so it's a week-1 check, not a fact.

## Final recommendation

**Must (done in the docs):** consensus items 1–12.

**Must decide (you):**
- C-014 write-off source (ask SAP);
- C-013 procurement edit rights;
- confirm C-015…C-018;
- C-022 Vercel Pro.

**Should (before M4):** C-019 random holdout; C-020 replay spec.

**Could (v1.1):** C-021 holidays.
