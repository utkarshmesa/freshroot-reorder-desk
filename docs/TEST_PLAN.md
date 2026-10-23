# Test plan: Freshroots Reorder Desk

Status: **Draft for review** (Step 1, revised after the LLM council). Covers **every** acceptance test in BUILD_PLAN §13 (40 items), plus the clarifications in CHANGES C-001…C-018.
**Priority rule:** §13 IDs come first in every milestone. Extra tests never replace or water down a §13 test.
Rule: **never weaken a test to make it pass.** A failing reference test is a bug in the code or a gap to raise, never a tolerance to widen.

---

## 1. Strategy

```
           /  E2E (Playwright) \        ~15 · critical user paths, roles, shadow-mode network check
          /  Integration (Vitest) \     ~40 · upload→DB commit, run worker with mock Zoho + local Supabase, RLS
         /     Unit (Vitest)        \   ~200 · engine, isoweek, parsers, validators, number checker, Zoho mappers
```

| Layer | Tooling | Runs against | When |
|---|---|---|---|
| Unit | Vitest | Pure modules only (`lib/engine`, `lib/isoweek`, `lib/upload` parse/validate, `lib/llm` checker/templates, `lib/zoho` mappers) | Every save (watch), every commit, CI |
| Integration | Vitest + local Supabase (`supabase start`, `db reset` with seed) + **mock Zoho** (MSW/HTTP fixture server) + **mock Anthropic** | DB functions, RLS, run worker state machine, draft send | Every commit, CI |
| E2E | Playwright | `next build && next start` + local Supabase + mock Zoho + mock Anthropic. Five seeded users, one per role | CI on main, before each milestone exit |
| Zoho contract | Vitest, tagged `@zoho-live`, **opt-in** | Real Zoho **test org** (never production) | Manually in week 1 and before go-live |
| Replay | `npm run replay` + snapshot of the gate report | Backfill data | Milestone 4 |

**Coverage targets:** `lib/engine` and `lib/isoweek` 100% branches; `lib/upload`, `lib/llm`, `lib/zoho` ≥ 90% lines; the rest is covered by integration and e2e paths, not a line-coverage number.

**Determinism:** the engine takes `runWeek` and `spotCheckSeed` as inputs; tests never use the real clock. Integration tests freeze time with `vi.setSystemTime` in IST.

---

## 2. Fixtures

| Fixture | Path | Contents |
|---|---|---|
| Case data | `data/case/*.csv` (read-only) | 15 SKUs, W27–W42, inventory 2026-10-19 |
| W43 reference | `data/reference/expected_2026-W43.json` | Expected engine output |
| Engine builders | `tests/fixtures/engine/builders.ts` | `sku({...})`, `history(weeks, units)`, `distributorRows(...)`, `festival(...)`, `hold(...)`, `rules(overrides)`, defaults per D18 |
| Upload files | `tests/fixtures/upload/` | `sales_w44.csv`, `sales_w44_dup.csv` (same bytes), `stock_old_asof.csv`, `sales_gap_w46.csv`, `sku_leading_zero.csv` (`00123`), `sales_thousands.csv` (`"1,200"`), `partial_set/` (valid sales + invalid stock), `restate_w40.csv`, `restate_w30.csv`, `unknown_ids.csv`, `w52_w53_w01/` (three files: 2026-W52, 2026-W53, 2027-W01), `.xlsx` twin of each key file |
| Zoho | `tests/fixtures/zoho/*.json` + `tests/mocks/zoho-server.ts` | Open PO (full / partial / cancelled / over-received / draft / FR- draft), receipts dated Sun 2026-10-18 and Mon 2026-10-19, items (mapped/unmapped/unit mismatch), vendors, 401/429/503 sequences, a "create succeeded but response lost" sequence |
| Anthropic | `tests/mocks/anthropic.ts` | Good reply, reply with a wrong number, reply with an extra number, timeout, 500 |
| Users | `supabase/seed.sql` (test section) | One user per role + Deepa (planner + admin + `is_owner`) |

---

## 3. Acceptance tests → concrete tests

IDs are stable and become the test names (`it('UP-01 duplicate file rejected', …)`).

### 3.1 Upload (BUILD_PLAN §13 "Upload")

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| UP-01 | Duplicate file rejected | Integration | `tests/integration/upload.commit.test.ts` | `sales_w44.csv`, then `sales_w44_dup.csv` | 2nd validation has error `duplicate_hash`; `commit_upload` also refuses (DB-level unique) |
| UP-02 | Old as-of time rejected | Unit + Integration | `lib/upload/validate.test.ts` | `stock_old_asof.csv` (as-of ≤ last run's) | error `stale_as_of`; also non-Sunday-23:59 IST → error `as_of_not_sunday_close` (real mode) |
| UP-03 | Missing week rejected | Unit | `lib/upload/validate.test.ts` | `sales_gap_w46.csv` (W44, W46) | error `missing_week` naming 2026-W45 |
| UP-04 | Leading-zero SKU IDs preserved | Unit (CSV + XLSX) | `lib/upload/parse.test.ts` | `sku_leading_zero.csv/.xlsx` | id is the string `"00123"` end-to-end; DB row equals `"00123"` (integration) |
| UP-05 | "1,200" parsed as a number | Unit | `lib/upload/parse.test.ts` | `sales_thousands.csv` | `1200`; `"12a"`, `"1.5"` (units) → `not_a_number` / `not_an_integer` |
| UP-06 | Partial set not committed | Integration | `tests/integration/upload.commit.test.ts` | `partial_set/` | commit refused; zero rows in `sales_fact` and `stock_snapshot`; also: force a DB error mid-commit → full rollback |
| UP-07 | Restatement within 12 weeks accepted; older rejected | Integration | same | after W43 committed: `restate_w40.csv` ✔, `restate_w30.csv` ✘ | W40 upserted + `change_log` rows; W30 error `restatement_locked`; report lists restated weeks |
| UP-08 | Unknown ID prompts "add or fix" | Unit + E2E | `validate.test.ts`, `e2e/upload.spec.ts` | `unknown_ids.csv` | error `unknown_sku` / `unknown_distributor` with "add or fix" text and link to Settings + Instructions §6 |
| UP-09 | **W52 → W53 → W01** | Unit + Integration | `lib/isoweek/isoweek.test.ts`, `upload.commit.test.ts` | `w52_w53_w01/` | `next('2026-W52')='2026-W53'`, `next('2026-W53')='2027-W01'`, `'2027-W53'` invalid, `'2026-W53'` Monday = 2026-12-28, Sunday = 2027-01-03; three sequential uploads commit with no `missing_week`; skipping W53 → `missing_week 2026-W53`; 12-week restatement window counted across the year end |

Extra upload tests (from §7 and clarifications): `UP-10` ±40% volume needs confirm; `UP-11` negatives rejected; `UP-12` file type detected from headers (and unknown header set → error); `UP-13` case-data mode accepts case files, maps per C-011, reads Monday as Sunday close (C-003), shows banner, warns on DIST003/DIST004 footprint.

### 3.2 Rules (§13 "Rules")

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| RU-01 | **Case data W43 reproduces `expected_2026-W43.json`** | Unit (golden) + Integration | `lib/engine/w43.golden.test.ts`; `tests/integration/run.case-data.test.ts` | `data/case/*.csv` + D18 defaults, no open POs | For all 15 SKUs: `action`, `qty`, `flags` (as a set), `triage`, `min_eff`, `max` **exactly equal**; `a12, a4, forward_demand, cover_weeks, cover_after` equal after half-to-even 2 dp (C-012). Integration runs the same through upload → run worker → `recommendation` rows. Named checks: Peanut Butter 240 auto, Brown Rice 600 auto, Mango Drink 750 queue HD, Bread 561 + Almond Milk 219 queue capped, Quinoa pause, Coconut Water pause borderline, other 8 none |
| RU-02 | Perishable infeasible case goes to the queue | Unit | `lib/engine/qty.test.ts` | perishable, lead time 4 → min_eff 6 > max 4 | flag `infeasible`, triage `queue`, qty 0; and cap < MOQ variant → `infeasible` |
| RU-03 | HD + pause gives the conflict flag | Unit | `lib/engine/actions.test.ts` | a4 = 1.3 × a12, cover 16 | action `pause`, flags ⊇ {`high_demand`,`conflict`}, triage `queue` |
| RU-04 | Festival window follows the weeks being ordered for | Unit | `lib/engine/festival.test.ts` | festival 1–30 Nov; run weeks W40, W41, W45, W49; lead 2 | uplift applied iff the C-004 window overlaps festival or 3-wk pre-load; boundary week on each side; uplift never applied to history (HD on raw) |
| RU-05 | New SKU follows D1 | Unit | `lib/engine/newsku.test.ts` | first sale 2, 6, 12, 13 weeks ago; launch estimate 100 | wk ≤4: F = estimate; wk 5–12: blend; wk 13: full rules; flag `new_sku` and `queue` until 13 |
| RU-06 | New and inactive distributors follow D2 / D3 | Unit | `lib/engine/clean.test.ts` | distributor starting 6 weeks ago; distributor inactive from W40 | first 4 weeks dropped; weeks 5–12 in a12 but excluded from HD; inactive weeks from end week dropped; inactive SKU → no order |
| RU-07 | Hold excludes weeks and queues the SKU | Unit | `lib/engine/clean.test.ts` | hold on SKU+distributor W38–W39; SKU-only hold | held distributor-weeks excluded from a12/a4; SKU flagged `hold`, triage `queue` |

Extra engine tests:
- `RU-08` fewer than 8 clean weeks → queue.
- `RU-09` D7: min_eff = max(rule min, lead + 2).
- `RU-10` quantity order per C-005: MOQ/pack rounding, then floor cap; `pack_mismatch`.
- `RU-11` borderline: ±5% of min_eff and of max (C-006).
- `RU-12` zero-stock exclusion only when history exists (C-007).
- `RU-13` engine purity source scan.
- `RU-14` property test (kept; it's cheap and guards the only source of quantities). For random valid inputs:
  - `qty ≥ 0`;
  - REORDER ⇒ `P + qty ≥ min_eff × F`, unless capped or infeasible;
  - perishable ⇒ `P + qty ≤ max × F`;
  - `cover_after = (P + qty) / F`;
  - uncapped qty is a multiple of MOQ/pack.
- `RU-15` aggregation (C-016): two distributors, one excluded for weeks 38–39 → `a_k` = sum of each distributor's mean over its own eligible weeks.
- `RU-16` sparse rows: a missing distributor-week counts as 0 inside that distributor's active window.
- `RU-17` negative net (returns > shipped) is kept in sums; `a_k` floors at 0; history shorter than 12 weeks uses the available eligible weeks.
- `RU-18` **W44-synthetic golden**: a hand-computed fixture with open POs, receipts, a hold, a D2 distributor, a festival boundary and a perishable HD SKU. Values are worked out in the fixture's comments.
- `RU-19` days to stockout = on-hand / F × 7; queue sorted ascending.

Engine arithmetic uses JS numbers. Quantities are integers, and C-012 half-to-even display rounding already reproduces W43 exactly, so no decimal library is needed.

### 3.3 Zoho (§13 "Zoho")

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| ZO-01 | Open PO counted; draft not counted | Unit | `lib/zoho/position.test.ts` | open PO 300; draft 500; FR- draft 200; **issued FR- PO 150** | position adds 300 + 150; the issued system PO **is** counted (exclusion is by status, never by reference) |
| ZO-02 | Receipt after snapshot added back | Unit | same | receipt Mon 2026-10-19 of 100 | +100 |
| ZO-03 | Partial, cancelled and over-received lines | Unit | same | ordered 300/received 100 → 200; cancelled → 0; ordered 100/received 120 → 0 (not −20) | as stated |
| ZO-04 | Retry after outage creates no duplicate draft | Integration | `tests/integration/drafts.send.test.ts` | (a) POST succeeds, response lost → retry; (b) crash after `creating` insert, before POST → retry; (c) search lags the create by one call | exactly one PO in mock Zoho in all three; (a)/(c) adopted by reference or vendor-draft search, (b) POSTs once |
| ZO-05 | Deleted draft logged, not recreated that week | Integration | same + `run.readback.test.ts` | FR-2026-W43-DIST001 missing in readback | `draft_po.status='deleted'`, logged as procurement rejection; send again in W43 → no POST |
| ZO-06 | Edited draft read back | Integration | `run.readback.test.ts` | FR- draft qty 600 → 500; also the reference edited by procurement | `status='edited'`, `issued_lines` diff stored, logged as procurement override; a changed reference is still found (readback by `zoho_po_id`), not marked deleted |
| ZO-07 | Unmapped item blocked | Integration | `run.worker.test.ts` | SKU013 with no `zoho_item_id`; supplier without vendor; unit mismatch (A4) | those SKUs in blocked list, no recommendation to order; others continue |
| ZO-08 | Auth failure blocks the run and alerts | Integration | `run.worker.test.ts` | token endpoint 401 (invalid_grant) | `run.status='blocked'`, `alert` row to admin, no recommendations written |

Extra Zoho tests:
- `ZO-09` 429 with Retry-After honoured.
- `ZO-10` budget counter aborts at 300 calls (fail closed).
- `ZO-11` pagination.
- `ZO-12` refresh token never re-minted (no call to the grant-code endpoint); access token shared across invocations through `zoho_token_cache`.
- `ZO-13` `@zoho-live` scope and filter verification (ADR-0002 table). **Milestone 1 exit blocker.**
- `ZO-14` a created FR- PO that reads back as non-draft → send aborted, run `blocked`, admin alerted.
- `ZO-15` a PO fully received on Monday (no longer "open") still adds its Monday receipt.
- `ZO-16` live re-check at send: the DB says the earlier draft is `created`, but Zoho shows it issued → the new draft is created. Zoho still shows a draft → `skipped_pending`.

### 3.4 Triage & people (§13)

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| TR-01 | Auto-approve criteria exact | Unit (table-driven) | `lib/engine/triage.test.ts` | one case per criterion failing (perishable, HD, hold, new, any flag, qty > 2×std) + all-pass | only all-pass → `auto` (D8 + C-002) |
| TR-02 | 5 spot-checks present | Unit + Integration | `triage.test.ts` | 12 auto items, seed 42; 2 auto items | 5 `spotcheck` (deterministic for seed); with 2 → 2 (C-008); spot-checks drawn only from auto |
| TR-03 | Tue 12:00 rule applied | Integration | `tests/integration/cron.deadline.test.ts` | unreviewed queue: non-perishable C < min_eff; perishable; HD-only non-perishable with C ≥ min_eff; **plus lines approved but never sent**; supplier with all lines decided | 1st → `deadline_auto` at 1× std; others → `rolled`; then Send runs for all suppliers, so approved-unsent lines and `deadline_auto` lines reach the draft (C-015); alert to Deepa; time frozen at Tue 12:00 IST (= 06:30 UTC); shadow mode → `shadow` rows only, zero Zoho writes; the cron firing twice changes nothing the second time |
| TR-04 | Draft older than 3 days needs re-approval | Integration + E2E | `cron.stale-draft.test.ts`, `e2e/review.spec.ts` | `draft_po` created 4 days ago, still `created` | alert to procurement + Raghav; card shows "Re-approve"; re-approve writes decision `reapproved`, **no Zoho call** (C-009) |
| TR-05 | Rejection rate below 5% raises the alarm | Unit + Integration | `lib/outcomes/rates.test.ts` | 100 units decided, 4 rejected (unit-weighted); and 41% case | alarm `rubber_stamp` at < 5%; alarm `rules_dont_fit` at > 40% |

### 3.5 Final stress-test fixes (§13)

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| ST-01 | Pending draft blocks a new draft for the same supplier | Integration | `drafts.send.test.ts` | FR-2026-W42-DIST001 still draft in Zoho (live re-check); W43 send, by the button and by the Tue 12:00 cron | no POST for DIST001; `skipped_pending`; lines `blocked_pending`; message "issue or delete the pending draft FR-2026-W42-DIST001 first" on the desk and in the send result; email to procurement + Raghav; a supplier with queued lines left is not sent |
| ST-02 | Receipt dated Sunday not added; Monday added | Unit | `lib/zoho/position.test.ts` | receipts 2026-10-18 and 2026-10-19 | only the Monday one added |
| ST-03 | Auto qty over 2× std goes to the queue | Unit | `triage.test.ts` | otherwise-auto SKU needing 3× std | `queue`, reason "above auto-approve limit" |
| ST-04 | Shadow mode creates no Zoho calls with write permission | Unit + E2E + live check | `lib/zoho/writer.test.ts`, `e2e/shadow.spec.ts`, ADR-0002 | mode shadow; full Tuesday flow incl. the Tue 12:00 cron | `getDraftWriter('shadow')` throws; e2e: mock records **zero non-GET requests to the Zoho API host** (the token POST to the accounts host is the only allowed POST); `draft_po.status='shadow'`; DB `live` + `APP_MODE=shadow` → no writes; DB `live` + `APP_MODE` **unset** → no writes; preview/dev env holds a read-only-scope token (verified in the test org: a create with it is refused) |
| ST-05 | Missing lead time / MOQ / shelf life → D18 defaults, shown "assumed" | Unit + E2E | `lib/engine/defaults.test.ts`, `e2e/review.spec.ts` | SKU with nulls | lead 2, MOQ = std, perishable max 4; `assumed` contains each; card shows "assumed" tags linking to Instructions §5 |
| ST-06 | Each role sees only its screens and actions | Integration (RLS) + E2E | `tests/integration/rls.test.ts`, `e2e/roles.spec.ts` | 5 seeded users | RLS matrix in ARCHITECTURE §3.2 asserted table × role × (select/insert/update/delete); e2e: nav and buttons per role; direct URL to forbidden screen → 403 page; only `is_owner` can change mode/holdout |
| ST-07 | Instructions page shows current Settings after a rule change | Unit + E2E | `tests/unit/instructions-bindings.test.ts`, `e2e/instructions.spec.ts` | `docs/INSTRUCTIONS.md`; planner changes HD threshold 20% → 25% with reason | the unit test parses every ⚙ in INSTRUCTIONS.md and fails if one isn't bound to a `current_rules()` key; e2e: the page shows 25%; a `change_log` row exists |

### 3.6 Claude (§13)

| ID | Acceptance test | Type | Test file | Fixture | Assertion |
|---|---|---|---|---|---|
| CL-01 | Outage falls back to the template | Integration | `tests/integration/run.llm.test.ts` | Anthropic mock 500 / timeout / missing key | run reaches `done`; every card has template text, `reason_source='template'`; run time unaffected beyond timeout |
| CL-02 | Number mismatch falls back to the template | Unit + Integration | `lib/llm/check.test.ts`, `run.llm.test.ts` | reply says "orders 700" when qty 750; adds an unrelated "12%"; adds "2 weeks" not in the payload; contains "SKU013", "2026-W43", "D2" | template for the first three; identifiers alone don't fail; a correct reply with `750` and `3.35 weeks` passes. **Adversarial:** a reply saying "order 900 instead" leaves `recommendation.qty` and the draft lines unchanged |
| CL-03 | No distributor names in prompts | Unit | `lib/llm/prompt.test.ts` | card with top-3 distributors named | captured prompt contains `D1..D3` and none of the names/ids; names appear in final text after insertion |
| CL-04 | Brief generated each run | Integration | `run.llm.test.ts` | normal run; LLM outage run | `brief` row exists for each run (`llm` or `template` source) |

### 3.7 Run mechanics, re-runs and outcomes (from the council)

| ID | What | Type | Assertion |
|---|---|---|---|
| RN-01 | Row lease | Integration | Two workers claim the same run step concurrently: exactly one proceeds |
| RN-02 | Stuck `creating` draft row | Integration | Recovered by search-then-POST (see ZO-04 case b) |
| RN-03 | Re-run before any draft (C-015) | Integration | Unchanged action/qty keeps its decision; a changed one re-opens with "data changed, re-review" |
| RN-04 | Re-run after some drafts | Integration | Sent suppliers untouched; the others re-run |
| RN-05 | Spot-check seed | Unit | The seed is stored on `run`, and the same seed gives the same five |
| RN-06 | Blocked run | E2E | A blocked or unmapped-SKU run shows a status banner on Upload and Review with the reason and the blocked list |
| OC-01 | Stockout week (C-017) | Unit | on-hand 0 → stockout; on-hand < raw a12 → stockout; a large open PO doesn't hide it; the festival uplift doesn't change it |
| OC-02 | Pilot vs manual rates | Unit | The same function gives identical results for both arms on mirrored fixtures |
| OC-03 | Order speed | Unit | Working days from commit to `issued_at`; `skipped_pending` counted as not issued |
| OC-04 | Shadow agreement (C-018) | Unit | Agreement % = approved unchanged / decided, unit-weighted |
| OC-05 | Inferred loss, **only if C-014 Option A is approved** | Unit | A known on-hand identity fixture gives the expected signed residual |

---

## 4. End-to-end journeys (Playwright)

1. **Monday happy path (case-data mode):** uploader drops case files → report (banner + footprint warnings) → commit → run → planner sees queue in days-to-stockout order: Almond Milk / Bread / Mango first, auto batch line "auto-approved: 2 lines, 840 units", 2 spot-checks.
2. **Review:** approve, change qty (reason required), reject (reason code + note) → send to procurement (shadow) → `draft_po` shadow rows.
3. **Live send against mock Zoho:** owner switches live → send → one POST per supplier, references `FR-2026-W43-DIST00x`.
4. **Roles:** each of 5 users logs in, sees allowed screens only (ST-06).
5. **Instructions binding** (ST-07) and "How this works" link from every header.

---

## 5. Not tested by automation (and why)
- Real email delivery: integration tests assert `alert` rows and the mailer call; delivery is checked once manually.
- Real Zoho beyond the `@zoho-live` suite: production org is never touched by tests.
- Replay statistics: QA'd by the data:validate-data pass and the gate report. The engine and `lib/outcomes` inside it are unit-tested. The replay method itself is **[PENDING C-020]**: once it's decided, its simulator gets a hand-computed 3-SKU fixture test.

## 6. Exit checks per milestone
| Milestone | Must be green |
|---|---|
| 1 Upload/settings | UP-01…UP-13, RLS tests for settings tables, W53, **ZO-13 live scope check recorded in ADR-0002**, **a real SAP sample export (or a written layout contract from the IT SAP admin) parsed by UP fixtures** |
| 2 Engine | RU-01…RU-19, TR-01…TR-03 (pure parts), ST-02, ST-03, ST-05 (unit), OC-01 |
| 3 Zoho read | ZO-01…ZO-16 (mock fixtures recorded from the test org), RN-01 |
| 5 Desk/drafts/LLM | ZO-04…06, ZO-14, ZO-16, TR-*, ST-*, CL-*, RN-*, OC-*, e2e 1–4 |
| 6 Instructions | ST-07, e2e 5 |
