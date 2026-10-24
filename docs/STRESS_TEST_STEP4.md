# Stress test: the built system and the plan ahead (before building more)

**Date:** 24 Oct 2026 · **Asked by:** Utkarsh ("stress test the built and next plan once before building new things") · **Status:** decided and built (24 Oct 2026). F2–F11 fixed; C-037, C-038, C-039 (option B) and C-040 adopted and built. Decisions in CHANGES C-037…C-040.

## 0. The data we actually have

The files Utkarsh shared (`weekly_sales`, `sku_master`, `distributor_master`, `current_inventory`, `calendar`) are **byte-for-byte identical to `data/case/`**. This is all the Freshroots data there is.

| Have | Don't have |
|---|---|
| 16 weeks of SKU-level sales (2026-W27–W42), 15 SKUs | 3-year history; distributor-level sales; `ordered_units` |
| One stock snapshot (2026-10-19) | Weekly stock history; receipts; open POs; write-offs |
| SKU master: name, category, perishability (High/Low), standard qty, unit, supplier | Lead time, MOQ, pack size, shelf life, unit cost |
| 4 suppliers (the file calls them distributors, C-011) | Zoho item and vendor ids; a Zoho org |
| Festival months for 2025–2026 | 2027 festivals |

The system already runs on this. The W43 reference is reproduced exactly, and every missing field uses a D18 default marked "assumed". What the data **can't** support is set out in §2.

## 1. The built system

An independent reviewer walked realistic weeks through the code. I re-checked the serious findings in the code myself.

### Defects: the code doesn't do what the plan says (fix before shadow)

| # | Finding | Checked | Severity | Fix |
|---|---|---|---|---|
| F2 | **A SKU master re-upload wipes values typed in Settings.** `commit_upload` overwrites every column, so lead time, MOQ, shelf life, cost and **Zoho item id** become blank when the file doesn't carry them. Quantities then change silently to D18 defaults, and the SKU is blocked as unmapped. | ✔ `20261026000400_review_fixes.sql:163-167` | **High** | Keep the current value when the file's column is empty (`coalesce`), and list the changed fields in the validation report |
| F3 | **The "PO changed since Monday" hold (C-025) catches receipts.** Recording a receipt modifies the PO, so that SKU's line is held and dropped for the week. Nobody is alerted about held lines. | ✔ `lib/send/send.ts` changed-PO filter; noon note counts drafts only | **High** | Hold only if ordered quantities changed or a new or cancelled PO appeared since Monday's stored read. Alert the planner whenever lines are held |
| F4 | **A same-week correction after drafts were sent:** Raghav's decisions don't carry over (ARCHITECTURE §4.2 says they should when action and quantity are unchanged). "Already sent" suppliers aren't shown. Nobody is told that the sent draft no longer matches the corrected data. | ✔ no carry-over code; Send message omits `alreadySent` | High | Implement the §4.2 carry-over; show "already sent"; alert planner and procurement with old vs new quantity per sent supplier |
| F5 | **The open-PO read lists only the statuses we guessed.** A real Zoho status outside the list is never fetched, so it can't trip the "unknown status" guard. That open quantity is missed, and the system over-orders. | ✔ `lib/zoho/reader.ts` lists by `COUNTED_ZOHO_STATUSES` | High (until the test org confirms the statuses) | List POs for the mapped vendors without a status filter; fetch details only for non-final statuses; an unknown status blocks the run |
| F6 | **Shadow agreement is counted per card, not per unit** (C-018 says unit-weighted). It also isn't filtered to shadow weeks or current runs. | ✔ `lib/outcomes/index.ts` `agreement()`; outcomes page query | Medium | Weight by units; filter by mode and current runs. Superseded by C-038 if adopted |
| F7 | **A supplier whose draft procurement never issues goes quiet.** Its lines are `blocked_pending` every week; the stale alert fires once. | ✔ | Medium | A weekly "supplier still blocked" alert to procurement and Raghav |
| F8 | **A short Zoho outage on Monday blocks the week** after about 15 seconds of retries. Only an admin's Retry restarts it. | ✔ | Medium | Let `zoho_unavailable` retry on the next few 5-minute cron cycles before blocking |
| F9 | **The festival calendar runs out after 2026-12** with no warning. The 2027 March uplift would silently be missing. | ✔ | Medium | Warn on the desk and alert Raghav when the calendar doesn't cover the weeks being ordered for |
| F11 | **If the noon send fails** (e.g. token revoked), only the admin is told, not the planner. | ✔ | Low | Also alert the planner |

### Data-fit finding (a decision, not a bug)

| # | Finding | Checked | Severity | Options |
|---|---|---|---|---|
| F1 | **Production accepts only the BUILD_PLAN §7 file layouts.** The case layouts are accepted only in case-data mode, and case-data mode skips Zoho (by design: C-011, C-023g). Freshroots has only ever produced the case layout. | ✔ `lib/upload/validate.ts:240`; worker skips Zoho in case mode | **Critical for go-live** | (a) Priya agrees the §7 export layouts with the SAP admin (no code); or (b) **C-040**: accept the case layouts in production too, mapped as now (SKU-level sales → one "ALL" distributor). Keep Zoho on, and drop the "case-data mode" link to file shape. Option (b) loses distributor-level features (D2, top-3 distributors) until a richer export exists |

### Held up well
- No double draft: a "creating" row is written first, there's one create attempt per row, an existing PO is adopted by reference, and creates aren't retried blindly.
- Read-back by stored Zoho id survives procurement re-referencing a PO, and "deleted" is told apart from other errors.
- Shadow mode can't write: deployment, Deepa's setting and the run's mode must all say live.
- Stock fails closed: a wrong snapshot time is rejected; a missing snapshot blocks the run; a missing SKU row blocks that SKU.
- Week boundaries: W52 → W53 → 2027-W01 is correct in code and SQL. A late upload is caught by the next noon.

Smaller notes, not acted on: deadline-rolled perishables while Raghav is away (by design; Deepa holds the planner role); Monday-dated stock (P7 below).

## 2. The plan ahead (BUILD_PLAN §12 weeks 5–13)

| # | Plan step | Stress | What breaks | Proposal |
|---|---|---|---|---|
| P1 | **Day-45 replay gate** (~7 Dec): "would the rules have produced fewer stockout weeks and write-offs than what happened?" | Needs 3 years of sales, receipts and weekly stock (REPLAY_SPEC §1). We have 16 weeks, no receipts, one snapshot. | The gate can only return **NOT DECIDABLE**. The replay already says so on this data: too few weeks, no receipts history. | **C-037:** replace the gate with a **shadow safety gate**: decided on evidence the shadow weeks can produce (§3), not on a back-test that can't run. Keep the replay tool for when history exists. |
| P2 | **Success metric: fewer stockout weeks _and_ lower write-offs**, pilot vs manual | No write-off source (C-014). Pilot vs manual at this scale: 15 SKUs × 20% holdout = **3 manual SKUs**. | Write-offs can't be shown. Any pilot-vs-manual difference across 3 SKUs is noise: no statistical test can separate 12 from 3 over a few months. | Write-offs: **inferred loss** from weekly snapshots + receipts (C-014 option A), which becomes possible once receipts arrive (from Zoho, or from the failsafe file). Proof: say plainly that the 15-SKU pilot tests **safety and workflow**, and the **400-SKU rollout** is where pilot vs manual can prove anything (C-019 still applies there). |
| P3 | **Shadow 4 weeks**: system alongside Raghav's manual plan | "Shadow agreement" is measured from Raghav's decisions **on the system's own cards** (C-018). He sees the suggestion first. | Anchoring and automation bias: agreement can look high because he saw the answer, not because the answer was right. And there is **no record of what he would have ordered by hand**. | Record Raghav's **actual manual orders** in the shadow weeks and compare per SKU-week. These are the POs he and procurement really place, which the open-PO read (Zoho, or the failsafe file) already shows. No blind-entry UI needed. **C-038.** |
| P4 | **Shadow on real SKU details** | Lead time, MOQ, shelf life are all assumed (D18). With MOQ = standard qty, most perishable weeks are "infeasible" (STRESS_TEST_REPLAY F1, risk K3). | Shadow would test invented numbers. Raghav would see a flood of infeasible perishable cards and learn to ignore the desk. | **Precursor, no code:** a one-page form for procurement (lead time, MOQ, pack size, shelf life per SKU), entered by Raghav in Settings → SKUs **before the first shadow Monday**. |
| P5 | **Go-live needs Zoho** (read open POs and receipts; create drafts) | No Zoho org could be created (C-030); the scope check never ran (risk K1). By design, a Zoho failure blocks the whole week (fail closed). | If Zoho stays unavailable, **every week is blocked**. The system never produces a recommendation, and the project fails for a reason that has nothing to do with the rules. | **Zoho failsafe (file mode), C-039**, below. |
| P6 | **W53 and the new year** | Festival calendar ends 2026-12. | 2027 festivals (March) would get no uplift. The run only warns. | Process: Raghav enters 2027 dates in January (already in the weekly process). No code. |
| P7 | **Weekly stock files** | The one snapshot is dated Monday 2026-10-19; the contract says Sunday 23:59 (C-003 staged it). | If Priya's real export is Monday-morning stock, receipts dated Monday are counted twice (A2/A3). | Confirm with Priya what time SAP's stock export reflects, before shadow. |

## 3. Proposed shadow safety gate (C-037)

Go live only if all of these hold over **4 shadow weeks including W53**. Every item is measurable with the data the shadow weeks produce:
1. **No structural failure:** no week blocked for a code reason; every run reached the queue by Monday noon.
2. **No unsafe recommendation:** for each SKU-week, compare the system's recommendation with what Raghav actually ordered (C-038). Every case where the system would have ordered **nothing** while stock ran out before the next delivery is reviewed by Raghav and explained (rule, data or assumption). There must be **zero unexplained** ones.
3. **No runaway quantities:** no recommendation above the auto-approve limit got through without review (already enforced, D16), and no single recommendation exceeded max cover.
4. **Data is real:** no "assumed" lead time or MOQ left on pilot SKUs.
5. **People did their part:** uploads on time in at least 3 of 4 weeks; queue cleared by Tuesday 12:00 in at least 3 of 4 weeks.

This replaces "proof" with "safe to try" at 15 SKUs. Proof comes from the larger rollout.

## 4. Zoho failsafe (file mode): nine checks

**Idea (B):** when Zoho can't be used, a week can still run.
- **Read side:** procurement uploads an **open-PO lines** file (and receipts since Monday), exported from Zoho or kept by hand, instead of the Zoho API read.
- **Write side:** **Send to procurement** produces a per-supplier **PO sheet** (XLSX/CSV, `FR-` reference) and emails it, instead of creating Zoho drafts. Procurement marks each supplier **placed** in the app.
- **Switch:** moving a week to file mode is an explicit, logged owner action. The default stays fail-closed.

**Alternatives:**
- **(A)** Do nothing: stay fail-closed, and Raghav plans by hand in a Zoho-failure week.
- **(C)** Read side only (upload open POs), plus a plain export with no "placed" tracking.

| Check | A: do nothing | **B: file mode** | C: read-only file + export |
|---|---|---|---|
| **Kill switches** | | | |
| 01 Problem real? | Yes: the problem exists; A just accepts it | **Yes.** No Zoho org could be created (C-030); the scope check failed (ADR-0002, error 6063); by design one Zoho failure blocks the whole week | Yes |
| 02 Workflow repeated? | n/a | **Yes:** the weekly cycle. Every week if Zoho never becomes available | Yes |
| 03 Input available? | n/a | **Partial.** Procurement knows its open POs. A Zoho export is likely (to confirm), or a hand-kept list. The case data has **no** PO data, so the file must come from procurement | Partial (same) |
| **Sizing** | | | |
| 04 Output valuable? | No: a Zoho-down week produces nothing | **Yes.** The PO sheet is today's Excel handoff (CASE_CONTEXT), only fresher and rule-based | Yes |
| 05 Impact measurable? | n/a | **Yes:** "placed" confirmations give order speed and file-mode week counts | **No:** no record of whether an order was placed, so order speed and the one-pending-per-supplier rule are lost |
| 08 ROI worth it? | — | **Yes, if small:** reuses the upload validator and the send planner. New pieces: two file kinds, a run source, a sheet export, a "placed" button. Roughly 2–3 build days with tests | Cheaper, but loses 05 |
| **Boundary** | | | |
| 06 Failure risk OK? | Yes | **Only with a human gate.** A stale or incomplete open-PO file understates stock on order, which means a **double order** | Same risk, plus unplaced sheets reappear next week as new recommendations |
| 07 Judgment protected? | Yes (Raghav plans by hand) | **Yes:** Raghav still decides every card | Yes |
| 09 Owner clear? | Yes | **Yes, if named:** procurement head owns the file's completeness; Deepa owns the switch | Partial |

**Verdicts:**
- **A:** don't build anything, but the project fails outright if Zoho never becomes available.
- **B: build, with a human exactly at the file.** Procurement certifies "complete as of Monday 00:00" on upload. Deepa switches the week. In file-mode weeks, the app shows the PO total against last week's file for a sanity check.
- **C:** build smaller, but it fails 05 and keeps the double-order risk without a way to see it.

**Recommendation: B.** It keeps the guardrails' intent. There is still one pending order per supplier (an unconfirmed sheet blocks the next one, like C-023), still no automatic writes, and the default is still fail-closed. It also turns "no Zoho" from a project-killer into a weekly fallback. As a side effect, the open-PO file records what Raghav actually orders, which C-038 needs.

### Five pre-build decisions for B
1. **Outcome:** in a week when Zoho can't be used, Raghav's settled orders still reach procurement by Tuesday 12:00 IST and are placed within 2 working days, with **no double order caused by the fallback**.
2. **Baseline:** today, fail-closed means nothing reaches procurement in such a week. Raghav plans by hand in Excel, from a forecast already 3–4 weeks old (CASE_CONTEXT).
3. **Workflow change:**
   - **Monday:** procurement uploads the open-PO and receipts file and ticks "complete as of Monday 00:00". Deepa switches the week to file mode.
   - **Monday–Tuesday:** Raghav reviews as usual. Send produces the sheet and emails procurement.
   - **Within 1 working day:** procurement places the orders and clicks **Placed** per supplier.
4. **Measurement:**
   - primary: share of file-mode orders placed within 2 working days;
   - secondary: double orders traced to the file (same SKU ordered twice inside its lead time);
   - instrument: "placed" timestamps and the next week's open-PO file.
5. **Kill criterion:** if a file-mode week causes a double order traced to a wrong or stale open-PO file **twice** in the pilot, stop file mode and return to fail-closed plus manual planning.

**System type:** workflow automation (deterministic). No LLM involved.

### Open questions for B
- Can procurement export open POs and receipts from Zoho's UI (columns: PO number, supplier, item/SKU, ordered, received, status, expected date)? Or will they keep the list by hand?
- Who sends the sheet: an email to the procurement head, or a download on the desk, or both?
- Should file-mode weeks put **every** reorder card in front of Raghav (no auto-approve)? Safer, but at 400 SKUs every week would be manual if Zoho never comes.

## 5. Summary of proposals

| # | Proposal | Type | Needs |
|---|---|---|---|
| C-037 | Shadow safety gate replaces the day-45 back-test | Plan change (gate) | Your decision |
| C-038 | Shadow compares against Raghav's actual orders, not only his decisions on cards | Measurement change | Your decision; data comes from the open-PO read |
| C-039 | Zoho failsafe (file mode), option B | Scope addition | Your decision; then build (~2–3 days) |
| C-040 | Accept the case file layouts in production (SKU-level sales), separate from case-data mode | Scope change (upload contract) | Your decision, **or** Priya gets the §7 layouts from SAP |
| F2–F11 | Fix the 9 verified defects in §1 | Bug fixes inside the plan | Your go-ahead (about 2 days with tests) |
| — | Collect lead time, MOQ, pack size, shelf life from procurement before shadow | Precursor task, no code | Procurement |
| — | Confirm the stock export time (Sunday 23:59?) | Precursor task, no code | Priya |
