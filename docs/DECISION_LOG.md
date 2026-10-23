# Decision log: how we got to the locked plan

## 1. Choosing what to build: Nine Checks
| | Demand Planning | Distributor Service | Ops Intelligence |
|---|---|---|---|
| Kill switches (problem real, repeated, input available) | All pass | **Input: No** (no query data) | Pass, but the problem is decision rights |
| Sizing (valuable, measurable, ROI) | Pass (₹28–34L/qtr) | Unknown | Output not acted on |
| Boundary (failure risk, judgement, owner) | Human at PO approval + judgement queue | Customer-facing risk (Air Canada) | No owner for "who acts" |
| **Verdict** | **Build** | Don't build yet (collect data first) | Build smaller later (PO-time re-check) |

**Five Pre-Build Decisions** (class version, then strengthened):
- **Outcome:** losses fall on pilot vs manual SKUs.
- **Baseline:** ₹18–22L + ₹10–12L per quarter.
- **Workflow:** Raghav reviews instead of producing the forecast.
- **Measurement:** pilot vs holdout, same weeks.
- **Kill:** rejection above 40%, or no improvement.

## 2. First-principles framing
Losses come from the **exposure window**: data age + review cycle + approval delay + lead time.
- Today: ~10 weeks. Weekly loop: ~4 weeks.
- Perishables (3–4 week band) are structurally impossible on a monthly cycle.

So the product is a **replenishment loop**, not a forecaster. Every link must be fast, and success is measured in stock and rupees.

## 3. LLM council (5 independent reviewers + peer review)
**Consensus adopted:**
- historical replay + shadow mode as hard gates;
- PO-time check;
- inventory position includes open POs;
- lead time;
- holdout + spot-checks instead of a raw rejection-rate kill;
- exception-only review;
- automated feed;
- SKU-level rules with distributor visibility;
- "rules, not AI" framing to the CEO, with AI for explanations.

**Rejected claims:**
- "lead time is inside Raghav's 6 weeks";
- "70% agreement with Raghav" as a gate (circular).

## 4. Stress tests that changed the plan
| Finding | Resulting decision |
|---|---|
| Festival uplift on past sales flags 13/15 SKUs as high demand (double count) | D6: uplift on forward demand only; replay tests the literal reading |
| Open POs ignored, so duplicate orders | D5 position includes Zoho open POs |
| Pending drafts duplicate | D11: one un-issued draft per supplier |
| Zoho receipts have dates, not times | D15: Sunday 23:59 snapshot boundary |
| 400 SKUs × ~47% exceptions means ~190 cards | D8 triage + Tuesday deadline rule |
| Auto-approve bug blast radius | D16: cap 2× std + batch total |
| Shadow weeks must not order | D17: mode switch |
| SKU/distributor lifecycle (new, discontinued, transfers, promotions) | D1–D4: simple statuses + "hold" events |
| Missing master data | D18: visible defaults |
| Over-complex v2 (15 components) | Simplified to 9 components / 5 screens; Thursday check, distributor algorithm, reconciliation file deferred |

## 5. User decisions (Utkarsh)
- Zoho **API** is in the MVP (not CSV).
- **No SAP integration**: CSV/XLSX upload instead.
- Keep **Claude explanations + weekly CEO brief**.
- Add an **Instructions** page with every assumption, so users don't need the AI team.
