# Stress test: the day-45 replay method (C-031 / C-032)

**Synthetic data only. No Freshroots numbers.** 24 Oct 2026.

## Question

Can the replay's verdict be trusted? The method is the one in REPLAY_SPEC, with the choices made on 24 Oct:

- stockout week = Sunday on-hand 0 **or** a week with lost sales (C-031 B);
- "no worse" passes the stockout test;
- drift limit on non-perishables only;
- 52 weeks minimum, 95% intervals, must also pass with deliveries 1 week late.

## Method (first principles)

Only one way tests a measuring method: run it where the right answer is known.

`scripts/replay/stress/world.ts` builds a **ground-truth world**:

- 60 SKUs over 156 weeks, 30% of them perishable;
- 12 suppliers, with shared demand shocks inside each supplier;
- two festival seasons a year;
- a "Raghav" who orders every 4 weeks for 6 weeks of cover from censored sales.

The world records the **true** lost sales, write-offs and shrinkage. It then exports only what SAP would give us: weekly sales, receipts, Sunday stock and the SKU master.

The replay runs on that export. Two comparisons follow:

- the replay's *actual arm* against the truth, which tests the method;
- each scenario breaks one assumption, which tests robustness.

Run it with `npx tsx scripts/replay/stress/run.ts [scenario|all]`, and use `split.ts skip|moq` for the perishable/non-perishable breakdown.

## Results

| Scenario | Truth: lost-sales wks / write-off units | Replay actual arm | Replay rules arm | Current drift check (non-per. / per.) | Net unexplained change (% of receipts) |
|---|---|---|---|---|---|
| S0 clean | 100 / 3,617 | 56 / 1,927 | 554 / 99 | 0% / 10% | +0.4% |
| S1 shrinkage 2%/yr | 98 / 2,929 | 47 / 1,454 | 555 / 6 | 2% / 11% | +0.5% |
| S2 shrinkage 6%/yr | 108 / 3,636 | 42 / 2,594 | 717 / 45 | 6% / 13% | +0.8% |
| S3 10% of receipt rows missing | 100 / 3,617 | **1,014** / 771 | 554 / 99 | **23%** / 25% | **−10.7%** |
| S4 shelf life blank (true 12 wks) | 98 / 15 | 183 / **8,386** | 542 / 2,110 | 0% / 14% | 0.0% |
| S5 shelf life blank (true 6 wks) | 234 / 36,767 | 89 / 25,697 | 624 / 0 | 0% / 51% | +4.1% |
| S6 lean Raghav (weekly, 4 wks cover) | 0 / 0 | 0 / 0 | 495 / 0 | 0% / 0% | 0.0% |

The rules arm above uses "skip" for infeasible perishable cards, which is the rules as written.

### Perishable vs non-perishable (S0)

| | SKUs | Truth lost wks | Actual arm | Rules arm (skip) | Rules arm (order MOQ) | Infeasible SKU-weeks |
|---|---|---|---|---|---|---|
| Non-perishable | 39 | 56 | 42 | **0** (+27% average stock) | 0 | 0 |
| Perishable | 21 | 44 | 14 | **554** | **0** | 1,830 (skip) / 1,538 (MOQ) of ~3,000 |

## Findings

**F1. The rules lose on perishables because of how the rules are built, not because of the method.**
Take the defaults:

- perishable maximum = 4 weeks of position;
- D7 effective minimum = lead 2 + 2 = 4 weeks;
- MOQ defaults to the standard quantity, here 2 weeks of demand (D18).

The engine can only order when position drops below 4 weeks, and only if the order fits under 4 weeks. An MOQ of 2 weeks of demand fits only once position is below 2 weeks. By then the order lands as the shelf empties.

The result: about **61% of perishable SKU-weeks show an "infeasible" card**. If Raghav skips them (the rules as written), the rules arm loses sales in 554 weeks against 14 in the actual arm. It even loses against a lean Raghav whose true losses are zero (S6). If he orders the MOQ, losses drop to 0 and write-offs stay about 95% lower.

So the gate verdict on perishables depends on two things we don't have yet: the **real perishable MOQs** and **what Raghav does with an infeasible card**. The same issue will also flood the live queue (production impact, not only a replay issue).

**F2. The replay flatters manual planning.**
The actual arm sees about half the true lost-sales weeks (56 vs 100) and about half the true write-offs (1,927 vs 3,617). The causes:

- demand is imputed only in weeks that end at zero stock;
- mid-week stockouts are invisible;
- the opening stock age is assumed.

The bias works *against* the rules. A PASS is therefore conservative, but a real improvement may come back INCONCLUSIVE. `ordered_units` from SAP removes most of this bias, which makes it the single most valuable extra column.

**F3. Missing receipts make manual planning look terrible, and the chosen drift check doesn't catch it.**
With 10% of receipt rows missing (S3):

- the actual arm shows 1,014 lost-sales weeks against a truth of 100;
- the verdict tilts towards the rules for a false reason;
- non-perishable drift is 23%, just under the 25% limit, so the check passes.

The **net unexplained change** check is: opening + receipts − sales − closing, summed over weeks, as a share of receipts. It shows **−10.7%** here: stock appeared from nowhere, which means receipts are missing. In every clean scenario the figure is ≥ 0.

**F4. Shrinkage is visible but small.**
2–6% a year gives 2–6% cumulative drift on non-perishables and +0.5–0.8% net loss. It doesn't flip any verdict. A positive net change mixes shrinkage with write-offs (SAP doesn't export write-offs), so it can be reported as "inferred loss" but can't be split.

**F5. A blank shelf life corrupts the write-off measure, and no data check catches it.**
When the master has no shelf life, the D18 default applies:

- with a true shelf life of 12 weeks (S4), the replay invents **8,386** actual-arm write-offs against a true 15, so the rules "win" write-offs falsely. Drift on perishables is 14%, net change 0.0%. Nothing flags it.
- with a true shelf life of 6 weeks (S5), drift reaches 51%.

The only safe rule is that **every perishable in the gate must have a shelf life in the master**.

**F6. "No worse passes" breaks when both arms are zero.**
In S6 (non-perishables), both arms have 0 write-offs. "Write-offs strictly fewer" then fails, and the verdict reads FAIL. A measure where both arms are zero has nothing to show, so it should give INCONCLUSIVE, not FAIL.

**F7. The statistics hold up.**
A bootstrap clustered by supplier gives intervals close to the by-SKU bootstrap (S0: [336, 663] vs [316, 693]), even with correlated supplier shocks. 52 weeks and 95% stand.

## Proposed refinements (C-033)

| # | Change | Fixes | Priority |
|---|---|---|---|
| 1 | Add a **net unexplained-gain check** on all SKUs. If stock appears from nowhere beyond 3% of receipts, the SKU (or the run, if widespread) is NOT DECIDABLE. Keep the non-perishable 25% drift limit as chosen. | F3 | Must |
| 2 | **Perishables need a shelf life in the master** to count in the gate. Blank means the SKU is left out, and the report lists it. | F5 | Must |
| 3 | **The infeasible-card policy becomes an explicit gate input.** The report shows the verdict under both "skip" and "order MOQ" and names which one is the headline. Real perishable MOQs are required before the gate. | F1 | Must |
| 4 | **A measure where both arms are zero → INCONCLUSIVE** ("nothing to improve"), never FAIL. | F6 | Must |
| 5 | Count a lost-sales week only when **≥ 1 whole unit** is lost (imputed demand is fractional). | noise | Should |
| 6 | Show the **known bias** in the report: "manual planning's losses are probably under-counted unless ordered_units is supplied". | F2 | Should |
| 7 | Report a supplier-clustered interval next to the SKU interval, as a check only. | F7 | Could |

Item 3 also raises a **design question for the live desk**, outside the replay. With the default band, most perishable weeks produce an infeasible card. Either the perishable maximum or MOQ defaults need real numbers, or the queue will be mostly infeasible cards. That is a business number (D18), so it's listed as a question, not a change.

## After C-033 (built 24 Oct 2026)

The same scenarios, re-run with C-031 B, the tie rule, the C-032 drift limit and every C-033 refinement. The synthetic master now carries an MOQ (= standard quantity), because perishables without one are left out.

| Scenario | Verdict, cards skipped | Verdict, MOQ ordered | What changed |
|---|---|---|---|
| S0 clean | FAIL (rules 573 stockout weeks vs 75) | **PASS** (0 vs 75; write-offs 99 vs 1,927) | The policy decides the perishable verdict (F1) |
| S1 shrinkage 2%/yr | FAIL | PASS | Same as S0 |
| S2 shrinkage 6%/yr | FAIL | PASS | Same as S0 |
| S3 10% of receipts missing | **NOT DECIDABLE** (stock from nowhere = 10.7% of receipts; 49 SKUs left out) | NOT DECIDABLE | Previously INCONCLUSIVE, tilted towards the rules (F3) |
| S4 shelf life blank (true 12) | INCONCLUSIVE (21 perishables left out; no write-offs left to compare) | INCONCLUSIVE | The invented write-offs no longer count (F5) |
| S5 shelf life blank (true 6) | INCONCLUSIVE (24 left out) | INCONCLUSIVE | Same as S4 |
| S6 lean Raghav | FAIL (rules worse: 505 vs 0) | **INCONCLUSIVE** (0 vs 0, 0 vs 0) | Previously FAIL on "0 vs 0 write-offs" (F6) |

Against the truth, the moq verdicts are right: in S0–S2 the rules really do have fewer lost-sales weeks and write-offs than history. The skip verdicts are right too: skipping infeasible cards really does lose sales.

## Limits of this test

- One synthetic world, one seed and simple demand (no promotions, no SKU launches). It tests the method's logic, not Freshroots' numbers.
- Raghav's policy is a stylised one. Real behaviour will differ.
- The rules arm uses the real engine with default rules. Every result here moves once real MOQs, lead times and shelf lives arrive.
