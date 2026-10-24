# Risk register: Freshroots Reorder Desk

**Owner:** Deepa Nair · **Last updated:** 24 Oct 2026 · **Review:** at each monthly outcomes review, and before the shadow → live switch

**Sources:**
- BUILD_PLAN §15 (accepted risks);
- STRESS_TEST_STEP1 (R1–R3);
- STRESS_TEST_REPLAY (synthetic, F1–F7);
- the Milestone 3–5 code reviews;
- CHANGES up to C-035.

**Risk level** = likelihood × impact:

| Likelihood ↓ / Impact → | Low | Medium | High |
|---|---|---|---|
| High | Medium | High | Critical |
| Medium | Low | Medium | High |
| Low | Low | Low | Medium |

**Status** is Open (action needed), Mitigated (controls in place, residual accepted), Accepted (BUILD_PLAN §15), or Closed (fixed and tested).

## Summary: what must happen before go-live

| # | Risk | Level | Action before live |
|---|---|---|---|
| K1 | Zoho scope check never run; the test org is deferred | **Critical** | Create the test org, run `ZOHO_LIVE=1 npm run test:zoho-live`, record real responses (ADR-0002) |
| K2 | No write-off data source (C-014) | **High** | SAP answer on write-offs; without it, half the success measure can't be shown |
| K3 | Perishable band narrower than the MOQ: most perishable weeks infeasible | **High** | Real perishable MOQs and shelf lives in Settings; Raghav agrees the infeasible-card practice (C-034) |
| K4 | Day-45 gate can't run on the data Freshroots has | ~~High~~ Replaced | C-037: shadow safety gate on 4 shadow weeks, compared with Raghav's actual orders (C-038) |
| K5 | Zoho API field and filter names unverified | Medium | Every PO is now listed and an unknown status blocks (F5). Confirm in the test org. If Zoho isn't available, the failsafe (C-039) runs the week from files |

## Register

### Data and measurement

| # | Risk | Likelihood | Impact | Level | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| K2 | **No source for write-off data** (C-014). Write-offs are half the success measure and half the day-45 gate, but no upload file carries them. | High | High | **High** | Outcomes shows write-offs as "not available" rather than guessing. The replay simulates expiry from shelf life (C-020). Decide C-014 with SAP before the gate. | Deepa / IT SAP admin | Open |
| K4 | **Day-45 gate on real data still to run.** The machinery is tested only on synthetic and case data (C-030). | High | High | **High** | `npm run replay` is ready, with drift, missing-receipt, shelf-life and MOQ guards (C-031–C-033) and the infeasible-card policy decided (C-034). Needs the 3-year export. | Utkarsh / Priya | Open |
| D1 | **Lost sales are estimated** unless `ordered_units` is supplied (BUILD_PLAN §15). The replay saw about half the true lost-sales weeks for manual planning (STRESS_TEST_REPLAY F2). | High | Medium | High | The bias works against the rules, so a PASS stays trustworthy; the report says so (C-033 item 6). Ask SAP for `ordered_units`. | Priya | Accepted |
| D2 | **Missing receipt rows make manual planning look worse** and flip the gate (F3). | Medium | High | High | Net unexplained-gain check: SKUs left out; the run is NOT DECIDABLE beyond 3% (C-033 item 1). | Utkarsh | Mitigated |
| D3 | **Blank shelf life invents write-offs** in the replay (F5). | Medium | High | High | Perishables without shelf life or MOQ are left out of the gate and listed (C-033 items 2–3). | Raghav | Mitigated |
| D4 | **Manual upload is the weakest link** (BUILD_PLAN §15): late, wrong file, Excel re-save. | Medium | Medium | Medium | Strict validation; missed-upload alert at 10:00 to the backup uploader, Raghav and Deepa; corrections within 12 weeks; RUNBOOK §1. | Priya | Accepted |
| D5 | **SAP and Zoho record a receipt on different days** (A3): stock briefly double-counted. | Medium | Medium | Medium | Position uses Zoho receipts dated Monday or later only. Shadow weeks check it; fix the cut-off with SAP if seen. | IT admin | Open (check in shadow) |
| D6 | **Holdout chosen by hand** biases pilot vs manual (C-019 proposed: stratified random draw). The statistical method is still pending. | Medium | High | High | Decide C-019 before go-live. Until then, pilot vs manual is shown as rates without significance. | Deepa | Open |
| D8 | **The only data is the 16-week case set** (STRESS_TEST_STEP4 §0): no history, receipts, write-offs, lead time, MOQ or shelf life. | High | High | **High** | C-040 accepts these layouts in production. Collect lead time, MOQ, pack size and shelf life from procurement before shadow. Gate on shadow evidence (C-037). Inferred loss as the write-off measure once weekly snapshots and receipts accumulate. | Raghav / Procurement | Open |
| D9 | **15 SKUs can't prove pilot beats manual** (about 3 manual SKUs). | High | Medium | High | Treat the pilot as a safety and workflow test; prove it at the 400-SKU rollout (C-019). The Outcomes page says so. | Deepa | Accepted |
| D7 | **Case data can't exercise distributor features** (BUILD_PLAN §15): one synthetic `ALL` distributor. | High | Low | Medium | Synthetic test files cover D2/D3 and holds (W44 golden, engine tests). | Utkarsh | Accepted |

### Ordering and money

| # | Risk | Likelihood | Impact | Level | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| K3 | **Perishable band narrower than the MOQ.** With MOQ = standard quantity (D18), about 60% of perishable weeks give an infeasible card. Skipping them loses sales (R1; F1). | High | High | **High** | Real MOQs before shadow; infeasible cards say so first; the gate headline assumes the MOQ is ordered (C-034) and also shows the skip result; unreviewed infeasible cards are not ordered at Tuesday 12:00, which the Instructions tell Raghav. | Raghav / Procurement | Open |
| O1 | **Post-festival overstock** from the locked festival reading (C-004; R2). | Medium | Medium | Medium | The replay measures the readings; Raghav can add holds; revisit D6 after the gate. | Raghav | Accepted |
| O2 | **Two drafts for one supplier-week** after a lost Zoho response or a crash. | Low | High | Medium | One create attempt per draft row, adopt by reference, send lease; `draft_unconfirmed` alert; RUNBOOK §4. Tested (ZO-04, M5 review #1). | IT admin | Closed |
| O3 | **An old week sends drafts** after the next week's run has read Zoho. | Low | High | Medium | The noon job handles only the latest week, until its week ends (M5 review #4). Tested. | — | Closed |
| O4 | **Double order** when a PO changes in Zoho between Monday's read and Send, or an old draft is issued mid-week. | Medium | High | High | C-025 line hold; C-023 pending-draft block for the whole week; drafts never count as stock. Tested. | — | Mitigated |
| O5 | **Deadline rule fires during a holiday** (C-021 proposed; deferred to v1.1). | Medium | Medium | Medium | Interim: pause the noon job for a holiday week (RUNBOOK §11). | Deepa | Accepted |
| O7 | **Zoho failsafe week with an incomplete open-PO file** understates stock on order, causing a double order (C-039). | Low | High | Medium | Owner-only switch with a reason; procurement certifies "complete as of Monday 00:00"; the desk shows the file's totals; an unplaced earlier sheet holds its supplier; kill criterion in RUNBOOK §12. | Deepa / Procurement head | Mitigated |
| O8 | **Same-week data correction after drafts were sent** (F4). | Low | Medium | Low | Decisions carry over where unchanged; sent drafts stay; planner and procurement alerted with old vs new quantities. | Raghav | Mitigated |
| O6 | **Rubber-stamp reviews** hide bad recommendations. | Medium | Medium | Medium | 5 random spot-checks a week; rejection-rate alarm below 5% or above 40%; monthly review. | Deepa | Mitigated |

### Systems and security

| # | Risk | Likelihood | Impact | Level | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| K1 | **Zoho scope check never run** (ADR-0002, error 6063; test org deferred, C-030). Until it is, it's unproven that the token's scopes can't issue a PO. | Medium | High | **Critical** before live, Low in shadow | Code layers already in place: the writer can only create; there's no status field; it can't exist unless the effective mode is live; read-back aborts if a created PO isn't a draft (ZO-14). Shadow is the default and is enforced by env + setting + run. **Run the live check before switching.** | IT admin | Open |
| K5 | **Zoho field and filter names are assumptions** (status values, reference search, vendor filter, receipt dates). | Medium | High | High | Unknown statuses fail closed (run blocked, `zoho_unexpected`; pending drafts count as pending). Record real responses in the test org. | IT admin | Open |
| S1 | **Integration-user lifecycle**: user deactivated or token revoked (R3). | Medium | Medium | Medium | Run blocks with `zoho_auth` and alerts; RUNBOOK §6 rotation; one refresh token, never minted by code. | IT admin | Mitigated |
| S2 | **Zoho outage or rate limit on Monday.** | Low | Medium | Low | Back-off, a 300-call budget per run, fail closed, Retry run; Raghav plans by hand if it isn't fixed by Tuesday. | IT admin | Mitigated |
| S3 | **Secrets leak** (Zoho, Supabase service key, Anthropic, Resend). | Low | High | Medium | Server-only modules; secrets only in Vercel env and `.env.local` (git-ignored); log redaction; preview environments hold a read-only Zoho token (ADR-0005). | IT admin | Mitigated |
| S4 | **Role misuse**: someone other than the planner decides, or an admin makes themselves owner. | Low | High | Medium | RLS on every table; decisions only through `decide_line` (planner check inside); owner set only by the service role. Tested (ST-06). | IT admin | Mitigated |
| S5 | **Claude unavailable or wrong.** | Medium | Low | Low | Claude never sets numbers; every number is checked; template fallback; own time budget, never blocks a run (M5 review #2); `llm_fallback` alert. | IT admin | Mitigated |
| S6 | **Alert email not configured**, so nobody hears about a block. | Medium | High | High | Alerts are stored even without Resend. The deploy checklist requires a test alert before go-live. | IT admin | Open (until checked) |
| S7 | **Database loss.** | Low | High | Medium | Supabase backups (check the plan and whether point-in-time recovery is enabled); RUNBOOK §10 restore and reconcile; Zoho remains the record of POs. | IT admin | Open (confirm backups) |
| S8 | **Platform limits on free plans** (C-042): daily cron fired within the hour; no 5-minute safety net. | Medium | Medium | Medium | Noon job scheduled in the 12:30–13:29 IST window (always after the deadline); runs and alerts also resume on page opens and after each upload. Pro restores exact timing. | IT admin | Mitigated |
| S10 | **Vercel Hobby is for non-commercial use.** | High | Medium | High | Fine for the MESA case study and a demo. Before Freshroots relies on it, move to Pro (C-022). | Deepa | Accepted for the case study |
| S11 | **Supabase Free: no backups, and the project pauses after a week of inactivity.** | Medium | High | High | Weekly manual dump (RUNBOOK §10); weekly uploads and the daily cron keep it active; Supabase emails before pausing. | IT admin | Mitigated |
| S9 | **Run volume at full rollout** (400 SKUs): open-PO reads approach the 300-call budget. | Low | Medium | Low | Budget enforced (`zoho_budget` block); incremental PO cache is the documented next step (ARCHITECTURE §12). | AI build team | Accepted |

## Changes to this register

| Date | Change |
|---|---|
| 24 Oct 2026 | First version, from BUILD_PLAN §15, STRESS_TEST_STEP1 R1–R3, STRESS_TEST_REPLAY F1–F7, the M5 review and CHANGES up to C-035 |
| 24 Oct 2026 | Step 4 stress test: K4 replaced by C-037; K5 lowered (F5, C-039); D8, D9, O7, O8 added |
