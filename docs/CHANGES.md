# Change notes

BUILD_PLAN v1.2 is locked. This file records every clarification or proposed change, with what it touches and whether it was approved.

Status values: **Approved** (user said yes), **Proposed** (waiting for the user), **Rejected**.

---

## C-001 … C-012: Step 0 clarifications (23 Oct 2026)

These **clarify** the locked plan; none adds scope. They came from the Step 0 read-through, where `expected_2026-W43.json` was recomputed independently from the case CSVs and matched on all 15 SKUs.
**Status: Approved** by Utkarsh, 23 Oct 2026.

| # | What | Why | Affects |
|---|---|---|---|
| C-001 | **Pause triage:** a PAUSE with no open PO lines is informational (`info_no_open_po`), even if it is perishable or borderline. A PAUSE with open PO lines goes to the queue. `recommendation.triage` gains the values `none` and `info_no_open_po`. | `expected_2026-W43.json` (the acceptance test) triages Coconut Water (perishable, borderline, pause) as `info_no_open_po`. D8's "everything else is queued" and INSTRUCTIONS §4.9 read as if it should be queued. The acceptance test wins. | D8, §6 `recommendation.triage`, INSTRUCTIONS §4.9 |
| C-002 | **Auto-approve** means: action REORDER, non-perishable, not HD, no hold, not new, **no flags at all** (borderline, conflict, assumed-infeasible…), and qty ≤ 2× std (D16). | D8 and INSTRUCTIONS §4.9 differ slightly. Take the stricter reading. W43 output is unchanged. | D8, D16 |
| C-003 | **Case-data stock date:** in case-data mode, `As_Of_Date = 2026-10-19` (a Monday) is read as SAP close **Sunday 2026-10-18 23:59 IST**, with a banner. Real uploads keep the strict D15 check (must be Sunday 23:59 IST). | The case file is dated Monday; D15 would reject it. | D15, §7 case-data mode |
| C-004 | **"Weeks being ordered for"** = ISO weeks from (run week + lead time) to (run week + lead time + effective minimum − 1). Festival uplift applies if any of those weeks overlaps a festival or its 3-week pre-load window. Case month flags (Oct, Nov, Mar) are converted to festival events covering those months. The day-45 replay calibrates this and tests Raghav's literal reading (D6). | The plan doesn't define the window precisely. W43 is unaffected (every reading gives ×1.25). | D6, D4 |
| C-005 | *(Corrected by C-023a: MOQ is a minimum, not a multiple.)* **Quantity order of operations:** std (×1.5 if HD) → raise in std steps until P + Q ≥ min_eff × F → round up to MOQ / pack → perishable cap `floor(max × F − P)`. **Infeasible** only if the cap is below MOQ. If a pack size is set and the capped qty isn't a multiple of it, add the flag `pack_mismatch` (goes to the queue anyway as perishable). | The reference gives 219 / 561, which are capped values that aren't MOQ multiples. | §8 step 5 |
| C-006 | **Borderline** = cover within ±5% of `min_eff` or of `max`. With the default 2-week lead time every perishable has band 4–4, so borderline will be common. The replay reports how often. | Definition was "±5%" without a reference point. | §8 flags, D7 |
| C-007 | **Zero-stock weeks:** dropped only when weekly stock history exists for that week. If it doesn't (case data, first live weeks), the run says "zero-stock exclusion skipped: no history". The replay uses the D20 rebuild. | Case data has one snapshot. | §8 step 4, D20 |
| C-008 | **Spot-checks** = min(5, number of auto-approved items). | W43 has only 2 auto items. | D9 |
| C-009 | **Draft older than 3 days "needs re-approval"** = an in-app *Re-approve* action for Raghav (logged, no Zoho write), plus the D11 email alert. Issuing remains a procurement-policy guard, not a code guard. | §13 acceptance test wording versus D11's "cannot technically stop". | D11, §13 |
| C-010 | **Reject reason codes:** fixed starter list (Disagree with rule · Known event not in holds · Supplier issue · Stock data wrong · Other), editable in Settings, every change logged. | Codes are referenced but not listed. | §8 step 8, §6 `decision.reason_code` |
| C-011 | **Case-data mapping:** `sku_master.Distributor_ID` → `sku.supplier_id` (these behave like suppliers); `Units_Sold` → `shipped_units`, `returns_units = 0`, `distributor_id = "ALL"`; `Perishability High` → `perishable = true`; missing lead time / MOQ / shelf life / cost → D18 defaults shown "assumed". Distributors outside Maharashtra/Goa show a validation **warning** (not an error). | Case files don't follow the §7 headers. | §7 case-data mode, D18 |
| C-012 | **Rounding:** the engine keeps full precision; values are rounded **half-to-even** to 2 dp only for display and comparison with the reference. | Brown Rice forward demand is exactly 188.125 and the reference says 188.12. | Tests, UI |

---

## C-013: Procurement edits supplier details (found in Step 1, 23 Oct 2026)

**Status: Decided 23 Oct 2026: procurement stays read-only** (the default below; D19 unchanged). INSTRUCTIONS A5/A6 and §6 reworded.

| What | Why | Affects |
|---|---|---|
| Procurement may edit only `sku.lead_time_wks`, `sku.moq`, `sku.pack_size`, `sku.zoho_item_id` and `supplier.zoho_vendor_id`, through a column-whitelisted server function. Everything else stays read-only for them. | BUILD_PLAN §3 ("Procurement for supplier details") and INSTRUCTIONS A5/A6 ("Procurement → Settings › SKUs") make procurement the owner of these fields. D19 says "Procurement (read-only in the app)". The two conflict. | D19, §3, INSTRUCTIONS A5/A6 |
| **Default if not approved:** procurement stays read-only, and the planner or admin enters these values on procurement's behalf. INSTRUCTIONS A5/A6 and §6 are then reworded ("Procurement sends to Raghav, who updates Settings"). | Keeps D19 exactly as written. | INSTRUCTIONS A5/A6 |

## C-014: No source for write-off data (Step 1; revised after the council)

**Status: Proposed, waiting on SAP answers** (Utkarsh is asking Priya / the IT SAP admin, 23 Oct 2026). This is the most important open item: write-offs are half of the success metric (§1) and of the day-45 gate, but no file in the §7 upload contract carries them.

**What the council found:** the inferred-loss formula below (Option A) gives **exactly zero** on replay history when that history has been *rebuilt* (D20 fallback: opening + receipts − sales). Whether Option A works for the gate therefore depends on whether SAP can export **real weekly stock history**.

| Option | What | Scope impact |
|---|---|---|
| **A (recommended, if SAP weekly stock history exists)** | **Inferred loss** per SKU-week = `on_hand(prev Sun) + receipts in week − net sales in week − on_hand(this Sun)`. Keep the **signed** residual: a positive value is inferred loss; a large negative value is a data-quality warning (e.g. a D15 / A3 receipt-date mismatch). Labelled "inferred loss (includes shrinkage and miscounts)", never "write-off". Calibrated on the backfill against Finance's ₹10–12L/qtr before it's used in the gate. | Existing data only: a computation in `lib/outcomes`. |
| B | An optional `writeoffs_weekly` upload (iso_week, sku_id, writeoff_units) from SAP scrap movements. Option A becomes the cross-check. | **New input file = scope change.** Needs the nine-checks run, then approval. |
| C | If neither real stock history nor scrap data exists: the day-45 gate uses stockout weeks only, plus simulated write-offs from the replay method (C-020), and the report says so. | Changes how the gate is evidenced. Needs approval. |

**Question for Priya / the IT SAP admin (decides the option):** can SAP export (1) weekly closing stock per SKU for 3 years, and (2) scrap/write-off movements per SKU-week?

Until decided, Outcomes shows write-offs as "not available".

---

## C-015 … C-018: Council clarifications (23 Oct 2026)

**Status: Approved** by Utkarsh, 23 Oct 2026. None adds a component, screen, input or decision; each removes an ambiguity the council showed would cause a bug. INSTRUCTIONS.md will be updated to match once confirmed.

| # | What | Why | Affects |
|---|---|---|---|
| C-015 | **Send and re-run semantics** (ARCHITECTURE §4.1–4.2):<br>• line states `auto / queued / approved / changed / rejected / deadline_auto / rolled / sent / blocked_pending`;<br>• a supplier's single weekly draft is created only once that supplier has no queued lines;<br>• at Tue 12:00 the D8 rule runs, **then Send runs for every remaining supplier, including lines Raghav approved but didn't send**;<br>• Send re-checks Zoho live for the supplier's pending draft before creating;<br>• a pending draft makes the supplier's lines `blocked_pending` (shown + emailed, re-evaluated next Monday);<br>• a created PO is read back and must be a draft;<br>• a corrected upload re-runs only for suppliers with no draft yet, and decisions carry over only where action and qty are unchanged. | There's one draft per supplier per week and no update scope, so a second send in a week can't reach Zoho. "Approved, went home" would otherwise silently never reach procurement. The DB only learns of issued drafts at Monday readback. | D8, D11, §8 step 8, INSTRUCTIONS §2/§3 |
| C-016 | **Demand aggregation across distributors:** `a_k(SKU) = Σ over distributors of the mean over that distributor's last k eligible weeks`. Missing rows inside a distributor's active window count as 0; negative net (returns) is kept; `a_k` floors at 0. "Fewer than 8 clean weeks" is counted at SKU level (weeks not SKU-held and not zero-stock). | "Mean of the last 12 clean weeks" is ambiguous once single distributor-weeks are excluded. Sparse rows would inflate the mean. Identical to the current reading when the distributor is `ALL`, so W43 is unchanged. | §8 steps 4–5, D2, D4 |
| C-017 | **Outcome "cover"** in the stockout-week definition means shelf cover: SAP on-hand ÷ raw clean a12 (no open POs, no festival uplift). So stockout week = on-hand 0, or on-hand < 1 × raw a12. The queue's "days to stockout" also uses on-hand. | Using P (which includes open POs) and F (which includes the uplift) would let in-transit stock hide stockouts, and would make the metric depend on the engine's own forecast. That's unfair to manual SKUs. | §8.10, D8 sort |
| C-018 | **Shadow-mode "agreement"** (§12 weeks 8–11) is measured from Raghav's approve / change / reject on every card. Unit-weighted agreement = approved unchanged ÷ decided. | No input exists for a separate manual plan. | §12, INSTRUCTIONS A23 |

## C-019 … C-022: Proposals from the council

**Status:** C-020 **adopted for Milestone 4** on Utkarsh's go-ahead to move on (24 Oct 2026); spec in `docs/REPLAY_SPEC.md`. C-019 and C-021 are still **proposed**. C-022 is **approved** (23 Oct 2026). Each needs your decision; for the scope ones I'll run nine-checks first if you want to pursue them.

| # | Proposal | Raised because | Scope impact | My recommendation |
|---|---|---|---|---|
| C-019 | **Pilot vs manual method:** pick the holdout by **stratified random draw** within category × perishability (Deepa still approves; logged seed). Compare as difference-in-differences against each arm's pre-period, with a pre-registered bootstrap-by-SKU rule for the 8-week kill decision. | A16's hand-picked holdout invites selection bias, and the kill criterion has no noise rule. | Refines A16 and §1 kill criterion | Adopt the random draw (fits A16's "by category and perishability"); decide the statistics with the data:statistical-analysis pass at M4 |
| C-020 | **Replay method spec** (`docs/REPLAY_SPEC.md`, before M4): a weekly simulator (orders arrive after lead time; perishables age FIFO and are written off past shelf life); lost-sales imputation in stockout weeks; the baseline is Raghav's **actual** receipts through the **same** simulator. | Comparing a simulation with reality is biased, and actual sales are censored in stockout weeks. | Implements the off-map replay (D20); no product change | Write the spec at M4 start; keep the simulator minimal |
| C-021 | **Non-working days** list in Settings: shifts Mon 08:30 / Tue 12:00 and counts "2 working days" correctly. | Holidays during the build and festival weeks. | New Settings item = scope change | Defer to v1.1. Interim: Deepa pauses the deadline cron for a holiday week via the runbook |
| C-022 | **Approved** (Freshroots will use Vercel Pro). **Vercel Pro** is required: Hobby cron runs at most once a day and isn't minute-precise, so the Mon 10:00 / Tue 12:00 deadlines and the run safety net need Pro. | Platform limit. | Cost, not scope (~USD 20/user/month) | Confirm that Freshroots' Vercel account is or will be Pro |

---

## C-023: Stress-test clarifications (23 Oct 2026)

**Status: Approved** by Utkarsh, 23 Oct 2026. Source: `docs/STRESS_TEST_STEP1.md`.

| # | What | Why (stress-test finding) | Affects |
|---|---|---|---|
| a | **Corrects C-005:** MOQ is a **minimum**, not a multiple. `q = max(q, MOQ)`, then round up to a multiple of pack size only when one is set. | C-005 as worded ("round up to MOQ") turns Mango Drink's 750 into 1,000 and **fails the W43 reference**. | C-005, RU-10, RU-14 |
| b | **Pending-draft block is decided at run time.** If the run's readback finds an un-issued earlier draft, the supplier's lines are `blocked_pending` for the whole week, even if that draft is issued before Send. | This week's quantities were computed without the pending draft (drafts never count). Sending after it's issued would double-order. C-015's live re-check alone allowed exactly that. | D11, C-015 |
| c | **Mode is stamped on the run.** Live requires env + DB + `run.mode`, so a mid-week switch applies from next Monday. | Otherwise one week can be half shadow, half live. | D17, ADR-0005 |
| d | A stock file with the **same** as-of as the last run is a correction (re-run); only an older one is rejected. | "As-of newer than last run" would otherwise block every correction of the current week's stock. | §7, UP-02 |
| e | Decisions are **conditional on the line still being queued**. | Race between Raghav clicking at 11:59 and the 12:00 cron; two approvers on one card. | D8 |
| f | An unreviewed **spot-check** keeps its auto-approved qty at the deadline. | Otherwise sampling an item for review cuts its order from up to 2× std to 1× std. | D8, D9 |
| g | The **backfill** loads via the replay script (`COPY`) into its own table, not the web upload. **Case-data mode** runs only in a non-production Supabase project. | 19M rows can't go through a serverless upload; case SKUs mustn't mix with real data. | §7, D20 |
| h | **Look-back:** "last k clean weeks" are searched within 26 weeks; engine input batches are sized by row count. | Zero-stock or held weeks push the 12 clean weeks back in time; fixed SKU batches can exceed response limits. | §8 step 5 |
| i | **Infeasible perishable cards** show "order MOQ → cover X" and "skip → ~d days to stockout", both from engine numbers. | In the simulation, perishables were infeasible in 6–9 of 12 weeks while MOQ = std is assumed. | Review desk |

## C-024 … C-027: Stress-test proposals

**Status (23 Oct 2026):** C-024, C-025, C-026 **approved as recommended** and applied in ARCHITECTURE / TEST_PLAN / INSTRUCTIONS. C-027 **decided: Resend** for now.

| # | Proposal | Why | My recommendation |
|---|---|---|---|
| C-024 | **Late run** (ready after Tue 12:00): apply the D8 deadline rule at the next 12:00 IST cron after the run is ready (Wed), and alert Deepa. | No rule exists. Today a late run would wait for Raghav with no deadline. | Adopt. It uses the existing rule, just shifted; Deepa owns the deadline (A17). |
| C-025 | **POs placed outside the system between Monday's run and Send.** At Send, list the supplier's POs modified since `run.zoho_read.read_at`. If a new or changed line touches a SKU being sent, hold that line ("position changed since Monday, re-review") instead of sending. | Urgent phone orders or holdout planning in Zoho on Mon/Tue would be double-counted (D5 "count each unit once"). Costs ~1–3 calls per supplier. | Adopt. No invented threshold: any change to that SKU holds the line. |
| C-026 | **Overdue open PO lines:** flag `overdue_po` on a card when open qty sits on a line past its Zoho expected delivery date. P is unchanged; the card goes to the queue. | Partially received POs that never close are common in Zoho. They'd inflate P forever, causing silent stockouts, and could also exhaust the 300-call budget. | Adopt the flag. **Week 1:** IT counts open and partially received POs in the real org (read-only) to size the budget. |
| C-027 | **Email provider** for alerts (D19): Resend, or Freshroots' SMTP. Supabase Auth's mailer is only for login emails. | No sender is defined. | Your choice; Freshroots' SMTP if IT allows, else Resend. |

---

## C-028: Rules-engine interpretations (Milestone 2, 23 Oct 2026)

**Status: Approved** by Utkarsh, 23 Oct 2026 (a–e; f added after the M2 review, same principle). None adds scope; each pins down wording the engine had to read one way.

| # | What | Why | Affects |
|---|---|---|---|
| a | **Inactive distributor:** once the run week reaches its end week, it contributes nothing to forward demand. Before that, its weeks from the end week onward are left out. | With per-distributor averages (C-016), dropping only the weeks after the end date would leave a departed distributor's old average in demand indefinitely. | D3, §8 step 4 |
| b | **Spot-checks are a marker, not a triage value.** A spot-checked item keeps triage `auto` and is also shown to Raghav. Unreviewed at Tuesday 12:00, it is ordered at its auto quantity (C-023f). | The W43 reference lists Peanut Butter and Brown Rice as `auto`, while C-008 makes both spot-checks that week. D9 says spot-checks are auto items *added to* the queue. | D9, C-008 |
| c | **New SKUs (D1):** no festival uplift on the launch-estimate blend. The blend weight is linear: weight on actuals = (age − 4) ÷ 8 for weeks 5–12. A new SKU with no launch estimate uses actuals and is flagged. | §8 says "F = a12 × festival factor, or the D1 blend": the uplift attaches to a12 only. | D1, D6 |
| d | **Holds:** a hold that names the SKU and overlaps anything from its history to the weeks being ordered for flags it `hold` and queues it. A hold on all distributors removes those SKU-weeks entirely, and the 12 weeks are taken from further back. A hold on specific distributors only (e.g. a credit hold) removes those distributor-weeks but does not queue the SKU. | D4 says held SKUs go to the queue and held distributor-weeks are excluded. INSTRUCTIONS §6 uses SKU holds for promotions, whose spike must not count as demand. | D4, A14, A15 |
| e | **Needs a person, whatever the action:** hold, new SKU, short history, no demand, overdue PO line, infeasible, conflict. A reorder is auto only with **no** flags (C-002). Pauses otherwise follow C-001. | Consolidates D8, C-001, C-002 and C-026 into one rule. | D8 |
| f | **Days to stockout** (queue sort only) = SAP on-hand ÷ forward demand × 7. The numerator is shelf stock (C-017), and the denominator is the forecast **including** any festival uplift, so the sort reflects how fast stock will actually run down. The outcome metric (stockout week) still uses raw a12 (C-017). | The M2 code review asked whether C-017's "raw" applies to the sort too. For urgency, the forecast is the better denominator. | D8 sort, C-017 |

## C-029: High-demand quantity can come out below the normal quantity (found in the M2 review)

**Status: For information. No change possible without changing the locked reference.**

BUILD_PLAN §8 says: "Q = std × (1.5 if HD else 1); raise in std steps until P + Q ≥ min_eff × F". Starting at 1.5 × std and stepping in whole std can land *below* the result without high demand.

**The W43 reference itself shows this:** Mango Drink (HD) orders **750**. Without the HD flag the same SKU would order 1,000 (500 → 1,000). Any rule that stops HD ordering less than non-HD would change the locked acceptance test, so the engine keeps the literal rule.

**Recommendation:** the day-45 replay reports how often this happens and what it costs. Raghav decides afterwards whether to change the rule, through a rule-change proposal (nine-checks, then a new reference).

## C-030: Deferred and adjusted at the start of Milestone 4 (24 Oct 2026)

| # | What | Status |
|---|---|---|
| a | **Zoho test org deferred.** Creating a Zoho Inventory organisation failed with Zoho error 6063 on this account (two tries in the built-in browser). The ADR-0002 scope check (ZO-13), the recorded fixtures and the M1 exit item stay open until an org exists. The refresh token is saved in `.env.zoho-test` for when it does. | Deferred by Utkarsh |
| b | **The replay reads files directly** (`scripts/replay`), not the `backfill_sales` table. It's a one-off batch, so loading 19M rows into Postgres buys nothing. The table stays available. | Implementation detail; refines C-023g |

## C-031: The stockout-week definition (C-017) counts the plan's own perishable policy as stockouts

**Status: Proposed. Needs your decision before the day-45 gate is judged.** Found while building the replay (Milestone 4).

**What happens.** C-017 defines a stockout week as SAP on-hand at Sunday = 0 **or below one week of raw demand**. The perishable band (D7: 4 weeks of *position* with the default 2-week lead time) is designed to keep only about 1–2 weeks on the shelf, because the rest is on order. So the Sunday shelf routinely dips below one week just before the next delivery, **even though nothing runs out and no sale is lost**.

**Evidence** (synthetic replay, 100 SKUs × 3 years, *not* Freshroots data): the rules arm had **0 lost sales and 0 empty-shelf weeks**, but **1,299 C-017 "stockout weeks"**, all on perishables. Under C-017 as approved, a well-run perishable policy fails the gate.

| Option | Stockout week = | Live data needed | Effect |
|---|---|---|---|
| A: keep C-017 | on-hand 0 or < 1 week of demand | SAP on-hand | Penalises lean perishable stock; the gate may fail for the wrong reason |
| **B (recommended)** | on-hand 0 at the Sunday snapshot **or** a week with lost sales (ordered_units > shipped, when supplied) | SAP on-hand; ordered_units if available | Measures the harm the plan cares about (lost sales). "Low cover" (< 1 week on the shelf) is reported alongside as a warning, not counted as a stockout |
| C | the original §8.10 wording: on-hand 0 or position cover < 1 | SAP + Zoho | In-transit stock can hide a real empty shelf (why C-017 was adopted) |

The replay already reports all three numbers, and prints the verdict under both A and B.

**Tie rule (also needs a decision):** if both arms have 0 lost-sales weeks, "fewer" can't be met. **Recommended:** count the stockout test as passed when the rules arm has **no more** stockout weeks than the actual arm, and write-offs are strictly fewer.

## C-032: Replay method parameters (Milestone 4 review)

**Status: Proposed.** These are method choices, not business numbers. Confirm them, or give other values, before the gate runs on real data.

| Parameter | Value | Why |
|---|---|---|
| Minimum simulated weeks for a verdict | 52 | One full seasonal cycle (both festival seasons and W53) is the least that can speak for a 3-year history |
| Maximum drift of the simulated actual arm from real SAP stock | 25% of average on-hand | Beyond this, the simulator doesn't represent what happened well enough to judge |
| Significance | 95% bootstrap over SKUs, both differences clear of zero | A better total that could be noise is INCONCLUSIVE, not PASS |
| Robustness | must also pass with every rules-arm delivery 1 week late | Real suppliers are sometimes late; the rules arm otherwise gets perfect deliveries |
