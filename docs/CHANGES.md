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
| C-005 | **Quantity order of operations:** std (×1.5 if HD) → raise in std steps until P + Q ≥ min_eff × F → round up to MOQ / pack → perishable cap `floor(max × F − P)`. **Infeasible** only if the cap is below MOQ. If a pack size is set and the capped qty isn't a multiple of it, add the flag `pack_mismatch` (goes to the queue anyway as perishable). | The reference gives 219 / 561, which are capped values that aren't MOQ multiples. | §8 step 5 |
| C-006 | **Borderline** = cover within ±5% of `min_eff` or of `max`. With the default 2-week lead time every perishable has band 4–4, so borderline will be common. The replay reports how often. | Definition was "±5%" without a reference point. | §8 flags, D7 |
| C-007 | **Zero-stock weeks:** dropped only when weekly stock history exists for that week. If it doesn't (case data, first live weeks), the run says "zero-stock exclusion skipped: no history". The replay uses the D20 rebuild. | Case data has one snapshot. | §8 step 4, D20 |
| C-008 | **Spot-checks** = min(5, number of auto-approved items). | W43 has only 2 auto items. | D9 |
| C-009 | **Draft older than 3 days "needs re-approval"** = an in-app *Re-approve* action for Raghav (logged, no Zoho write), plus the D11 email alert. Issuing remains a procurement-policy guard, not a code guard. | §13 acceptance test wording versus D11's "cannot technically stop". | D11, §13 |
| C-010 | **Reject reason codes:** fixed starter list (Disagree with rule · Known event not in holds · Supplier issue · Stock data wrong · Other), editable in Settings, every change logged. | Codes are referenced but not listed. | §8 step 8, §6 `decision.reason_code` |
| C-011 | **Case-data mapping:** `sku_master.Distributor_ID` → `sku.supplier_id` (these behave like suppliers); `Units_Sold` → `shipped_units`, `returns_units = 0`, `distributor_id = "ALL"`; `Perishability High` → `perishable = true`; missing lead time / MOQ / shelf life / cost → D18 defaults shown "assumed". Distributors outside Maharashtra/Goa show a validation **warning** (not an error). | Case files don't follow the §7 headers. | §7 case-data mode, D18 |
| C-012 | **Rounding:** the engine keeps full precision; values are rounded **half-to-even** to 2 dp only for display and comparison with the reference. | Brown Rice forward demand is exactly 188.125 and the reference says 188.12. | Tests, UI |

---

## C-013: Procurement edits supplier details (found in Step 1, 23 Oct 2026)

**Status: Proposed**, awaiting Utkarsh.

| What | Why | Affects |
|---|---|---|
| Procurement may edit only `sku.lead_time_wks`, `sku.moq`, `sku.pack_size`, `sku.zoho_item_id` and `supplier.zoho_vendor_id`, through a column-whitelisted server function. Everything else stays read-only for them. | BUILD_PLAN §3 ("Procurement for supplier details") and INSTRUCTIONS A5/A6 ("Procurement → Settings › SKUs") make procurement the owner of these fields. D19 says "Procurement (read-only in the app)". The two conflict. | D19, §3, INSTRUCTIONS A5/A6 |
| **Default if not approved:** procurement stays read-only, and the planner or admin enters these values on procurement's behalf. INSTRUCTIONS A5/A6 and §6 are then reworded ("Procurement sends to Raghav, who updates Settings"). | Keeps D19 exactly as written. | INSTRUCTIONS A5/A6 |

## C-014: No source for write-off data (Step 1; revised after the council)

**Status: Proposed**, awaiting Utkarsh. This is the most important open item: write-offs are half of the success metric (§1) and of the day-45 gate, but no file in the §7 upload contract carries them.

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

**Status: Applied in ARCHITECTURE / TEST_PLAN as in-scope clarifications. Please confirm.** None adds a component, screen, input or decision; each removes an ambiguity the council showed would cause a bug. INSTRUCTIONS.md will be updated to match once confirmed.

| # | What | Why | Affects |
|---|---|---|---|
| C-015 | **Send and re-run semantics** (ARCHITECTURE §4.1–4.2):<br>• line states `auto / queued / approved / changed / rejected / deadline_auto / rolled / sent / blocked_pending`;<br>• a supplier's single weekly draft is created only once that supplier has no queued lines;<br>• at Tue 12:00 the D8 rule runs, **then Send runs for every remaining supplier, including lines Raghav approved but didn't send**;<br>• Send re-checks Zoho live for the supplier's pending draft before creating;<br>• a pending draft makes the supplier's lines `blocked_pending` (shown + emailed, re-evaluated next Monday);<br>• a created PO is read back and must be a draft;<br>• a corrected upload re-runs only for suppliers with no draft yet, and decisions carry over only where action and qty are unchanged. | There's one draft per supplier per week and no update scope, so a second send in a week can't reach Zoho. "Approved, went home" would otherwise silently never reach procurement. The DB only learns of issued drafts at Monday readback. | D8, D11, §8 step 8, INSTRUCTIONS §2/§3 |
| C-016 | **Demand aggregation across distributors:** `a_k(SKU) = Σ over distributors of the mean over that distributor's last k eligible weeks`. Missing rows inside a distributor's active window count as 0; negative net (returns) is kept; `a_k` floors at 0. "Fewer than 8 clean weeks" is counted at SKU level (weeks not SKU-held and not zero-stock). | "Mean of the last 12 clean weeks" is ambiguous once single distributor-weeks are excluded. Sparse rows would inflate the mean. Identical to the current reading when the distributor is `ALL`, so W43 is unchanged. | §8 steps 4–5, D2, D4 |
| C-017 | **Outcome "cover"** in the stockout-week definition means shelf cover: SAP on-hand ÷ raw clean a12 (no open POs, no festival uplift). So stockout week = on-hand 0, or on-hand < 1 × raw a12. The queue's "days to stockout" also uses on-hand. | Using P (which includes open POs) and F (which includes the uplift) would let in-transit stock hide stockouts, and would make the metric depend on the engine's own forecast. That's unfair to manual SKUs. | §8.10, D8 sort |
| C-018 | **Shadow-mode "agreement"** (§12 weeks 8–11) is measured from Raghav's approve / change / reject on every card. Unit-weighted agreement = approved unchanged ÷ decided. | No input exists for a separate manual plan. | §12, INSTRUCTIONS A23 |

## C-019 … C-022: Proposals from the council (not applied)

**Status: Proposed.** Each needs your decision; for the scope ones I'll run nine-checks first if you want to pursue them.

| # | Proposal | Raised because | Scope impact | My recommendation |
|---|---|---|---|---|
| C-019 | **Pilot vs manual method:** pick the holdout by **stratified random draw** within category × perishability (Deepa still approves; logged seed). Compare as difference-in-differences against each arm's pre-period, with a pre-registered bootstrap-by-SKU rule for the 8-week kill decision. | A16's hand-picked holdout invites selection bias, and the kill criterion has no noise rule. | Refines A16 and §1 kill criterion | Adopt the random draw (fits A16's "by category and perishability"); decide the statistics with the data:statistical-analysis pass at M4 |
| C-020 | **Replay method spec** (`docs/REPLAY_SPEC.md`, before M4): a weekly simulator (orders arrive after lead time; perishables age FIFO and are written off past shelf life); lost-sales imputation in stockout weeks; the baseline is Raghav's **actual** receipts through the **same** simulator. | Comparing a simulation with reality is biased, and actual sales are censored in stockout weeks. | Implements the off-map replay (D20); no product change | Write the spec at M4 start; keep the simulator minimal |
| C-021 | **Non-working days** list in Settings: shifts Mon 08:30 / Tue 12:00 and counts "2 working days" correctly. | Holidays during the build and festival weeks. | New Settings item = scope change | Defer to v1.1. Interim: Deepa pauses the deadline cron for a holiday week via the runbook |
| C-022 | **Vercel Pro** is required: Hobby cron runs at most once a day and isn't minute-precise, so the Mon 10:00 / Tue 12:00 deadlines and the run safety net need Pro. | Platform limit. | Cost, not scope (~USD 20/user/month) | Confirm that Freshroots' Vercel account is or will be Pro |
