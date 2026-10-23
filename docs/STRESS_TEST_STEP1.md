# Stress test of the Step 1 design (after the council)

Date: 23 Oct 2026 · Tested: `ARCHITECTURE.md`, `TEST_PLAN.md`, ADRs and `CHANGES.md` as revised by the council.

**Method**
1. **Numeric:** a forward simulation of the locked rules on the case data, week by week from 2026-W43 to 2027-W01. It crosses W53 and the end of the Oct/Nov festival.
2. **Scenarios:** 24 concrete situations traced through the design as written.

The simulator is in `docs/stress-test/sim.js` (a prototype, not production code).

**Result:** 1 acceptance-test-breaking bug, 1 double-order bug, 7 smaller gaps (all fixed in the docs as C-023), 4 new proposals (C-024…C-027) and 3 risks for the register. **No change to the locked BUILD_PLAN is needed.**

---

## 1. Forward simulation (case data, 12 weeks)

**Assumptions (stress test only):**
- Lead time 2 weeks; MOQ = std (D18); every recommendation is approved and issued the same week.
- True demand = pre-festival base (W27–W38), times the lift observed in W39–W42 in festival and pre-load weeks.
- Perishable shelf life 8 weeks (implied by D18's 4-week max = ½ shelf life).

**Check:** week 1 of the simulation reproduces the W43 reference exactly: 750 / 600 / 219 / 561 / 240, Quinoa and Coconut Water pauses.

### Finding N1: perishables are "infeasible" most weeks (HIGH, data plus process)
After the first top-up, the perishable band (min 4 = lead 2 + 2 under D7, max 4) needs about one week of demand per week. That is below MOQ when MOQ defaults to std (D18).

| SKU | Weeks infeasible (of 12) | If infeasible lines roll (D8 Tue rule) | If Raghav orders MOQ anyway |
|---|---|---|---|
| Almond Milk (MOQ 150, ~80/wk) | 6 | 1 stockout week | 0 stockouts |
| Coconut Water (MOQ 400, ~135/wk) | 9 | 3 stockout weeks, 255 units lost | 0 stockouts |
| Bread (MOQ 500, ~210/wk) | 8 | 2 stockout weeks, 207 units lost | 0 stockouts |
| **Total** | | **6 stockout weeks, 463 units lost** | **0; cover peaks ~5 wks, 0 write-off at 8-wk shelf life** |

**Meaning:**
- Perishable cards will be "infeasible" most weeks while MOQ is the assumed default.
- If Raghav misses the Tuesday deadline, D8 rolls them, and perishables then stock out within about 2 weeks.
- This doesn't contradict the plan (D7, D8 and D18 are working as written), but it's the biggest operational risk the numbers show.

**Actions:**
- C-023i: the card shows both options with numbers.
- Procurement must supply **real MOQs for perishables before shadow mode**.
- Risk R1 added.

### Finding N2: the C-005 wording breaks the W43 reference (HIGH, bug) → fixed (C-023a)
"Round up to MOQ", read as "round to a multiple", turns Mango Drink's 1.5 × 500 = 750 into 1,000. MOQ is a minimum. TEST_PLAN RU-14 had the same wrong invariant; corrected.

### Finding N3: the festival reading is pinned by the reference (MEDIUM, informs the replay)

| Reading | W43 matches reference? | Note |
|---|---|---|
| C-004: full +25% if any week being ordered for touches a festival or pre-load (approved) | **Yes** | Orders placed in W45–W47 for weeks that are mostly December still get the full +25%. Mango Drink ends the run with 7.1 base-weeks of cover vs 5.8 under the proportional reading |
| Proportional to festival weeks in the window | **No**: Brown Rice 300 ≠ 600 | Less post-festival overstock |
| De-seasonalised a12 (festival-week sales ÷ 1.25) + proportional | **No**: Mango a12 changes | Least overstock; Almond Milk and Bread end at 0.4 weeks' cover |

**Ruling:** production keeps C-004, because the locked acceptance test requires it. The replay compares all three readings (D6 already says the replay tests readings), and test RN-11 pins this. The post-festival overstock for non-perishables is the price of the locked reading; the day-45 gate will quantify it.

### Finding N4: calendar
- W53 is handled: the simulation runs 2026-W52 → W53 → 2027-W01.
- Festival windows end correctly: a W48 run has 0 of 6 festival weeks.
- Holidays aren't modelled (C-021 stays deferred).

---

## 2. Scenario walkthroughs

✅ = handled by the design · 🔧 = gap, fixed now (C-023) · 📝 = proposal (C-024…C-027) · ⚠ = accepted risk

| # | Scenario | Verdict | Detail / fix |
|---|---|---|---|
| S1 | Normal week, shadow mode, case data | ✅ | Upload → run → queue (Almond Milk, Bread, Mango first by days to stockout) → shadow rows |
| S2 | W43 draft still pending at Monday W44, then **issued Tue 10:00**, Send at 12:00 | 🔧 **double order** | W44 quantities were computed without the pending draft. C-015's live re-check would then create the W44 draft on top. Fix C-023b: block decided at run time, for the whole week. Test RN-07 |
| S3 | Deepa switches to live Tue 11:00 | 🔧 | Half the week would go live. Fix C-023c: mode stamped on the run. Test RN-08 |
| S4 | Raghav approves at 11:59:59 while the cron runs at 12:00 | 🔧 | Fix C-023e: conditional update. Test RN-09 |
| S5 | Raghav and Deepa approve the same card | 🔧 | Same fix |
| S6 | Unreviewed spot-check at the deadline | 🔧 | Would drop to 1× std. Fix C-023f. Test RN-10 |
| S7 | Priya re-uploads the corrected **stock** file for the same Sunday | 🔧 | Was rejected as "not newer". Fix C-023d. UP-02 updated |
| S8 | Restatement of W40 after the W43 run | ✅ | Logged; affects the next run's averages |
| S9 | Upload arrives Tue 15:00 (after the deadline) | 📝 | No rule today. C-024: deadline moves to the next noon |
| S10 | Procurement phones in an urgent PO on Monday, before Send | 📝 | Double count. C-025: hold changed lines at Send |
| S11 | Old partially received POs never closed in Zoho | 📝 ⚠ | Inflates P → silent stockouts, and can exhaust the 300-call budget. C-026 flag + week-1 count |
| S12 | Procurement deletes the W44 draft Tue 14:00 | ✅ | Logged as rejection; not recreated that week (D11); next Monday re-orders from the true position |
| S13 | Procurement edits the draft's reference | ✅ | Readback by `zoho_po_id` (council fix) |
| S14 | POST succeeds, response lost; crash before POST; search lag | ✅ | ZO-04 a/b/c |
| S15 | Zoho returns 401 Monday 09:00 | ✅ | Run blocked; admin alerted; Raghav plans manually if not fixed by Tuesday (INSTRUCTIONS §6) |
| S16 | Integration user deactivated in Zoho (staff change) | ⚠ | Same as S15. RUNBOOK must cover re-minting the token. Risk R3 |
| S17 | Preview deployment runs the Tuesday send by mistake | ✅ | Read-only token + env ceiling + run.mode |
| S18 | Claude writes "about 21% above the 12-week average" | ⚠ | 21% is derived, not in the allowlist → template. Correct but higher fallback. Track the fallback rate; add derived ratios (a4/a12 %, cover change) to the allowlist when building `lib/llm` |
| S19 | Claude writes "order 900 instead" | ✅ | Qty never read from LLM text (CL-02 adversarial) |
| S20 | 3-year backfill (19M rows) uploaded through the web UI | 🔧 | Not possible on serverless. Fix C-023g: replay script + `COPY` |
| S21 | SKU out of stock 5 of the last 12 weeks | 🔧 | Look-back defined (26 wks); fewer than 8 clean weeks → queue (C-023h) |
| S22 | Case-data demo in the production database | 🔧 | Non-production project only (C-023g) |
| S23 | Raghav changes the HD threshold on Tuesday | ✅ | Applies from the next run (D12). The Instructions page shows the current Settings; each card shows the rule version it used |
| S24 | Alerts need a sender | 📝 | C-027 email provider |

---

## 3. Risks for `RISK_REGISTER.md` (Step 3)

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | Perishables infeasible most weeks under assumed MOQ, and rolled on a missed deadline → stockouts | N1: 6 stockout weeks / 463 units in 12 weeks for 3 SKUs | Real perishable MOQs before shadow; infeasible cards first in the queue; the Tuesday brief lists rolled perishables for Deepa |
| R2 | Post-festival overstock from the locked festival reading (C-004) | N3 | Replay quantifies it; Raghav can add holds; revisit D6 after the gate |
| R3 | Zoho integration-user lifecycle (deactivation, token revoked) | S15–S16 | RUNBOOK; the alert names the cause |

## 4. What this changes for Milestone 1
Nothing blocks starting. Before shadow mode (week 8):
- real perishable MOQs from procurement;
- the week-1 count of open and partially received POs (C-026);
- the C-014 SAP answers (write-offs and stock history).
