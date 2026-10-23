# Case context: Deepa's 90-Day Mandate (MESA AI-Native Track, Term 2, Case 1)

## The company
- **Freshroots:** 200-person regional FMCG (packaged snacks and staples), Maharashtra and Goa, 12 years old.
- Grows through **1,200 distributors** and trade margins.
- **CEO's ask:** "I want something [AI] running by Q1. You have ₹15 lakhs and 90 days."
- **Deepa Nair,** Head of Operations, owns it.
- **Resources:** no AI team; a 3-person IT team running SAP; one data analyst (Priya Sharma).
- **Task:** use the Nine Checks + Pre-Build Decisions to choose one of three areas, then build it end to end.

## The chosen area: Demand Planning
**Current state:**
- Raghav Kulkarni, Senior Demand Planner (6 years), spends ~2 days a month pulling SAP sales/inventory into Excel to forecast **400 SKUs across 1,200 distributors**.
- His output goes to procurement, which places orders.
- POs are managed in **Zoho Inventory**, used alongside SAP.

**The problem:**
- The forecast is **3–4 weeks old** by the time procurement acts.
- Losses: stockouts **₹18–22L/qtr**; perishable overstock write-offs **₹10–12L/qtr**; total **₹28–34L/qtr**.
- Raghav: *"The cycle time isn't the bottleneck, the manual data work is. If the data were already organised for me, I could run the same analysis twice a week."*

**Raghav's documented rules** (about 80–85% of his decisions):
1. Last-4-week sales more than 20% above the 12-week average: high demand, reorder at **1.5×** the standard quantity.
2. Stock below **6 weeks** of average weekly sales: stockout risk, reorder immediately.
3. Stock above **14 weeks**: overstock risk, pause the next order.
4. Festival months (**Oct, Nov, Mar**): apply a **25%** demand uplift before threshold checks.
5. High-perishability SKUs: **max 4 weeks, min 3 weeks** of stock.

The other 15–20% is Raghav's judgement: new launches, unusual distributor behaviour, one-off market events.

**Data:** 3 years of distributor-level sales in SAP, exportable as structured files.

## The two rejected areas (context only)
- **Distributor Service** (WhatsApp, 4-person CS team): failed "input available". There's no query data at all, so it needs data collection first.
- **Operations Intelligence** (weekly CEO dashboard): the bottleneck is who acts on data, not the data itself.
  - Incident: a ₹22L order was approved Monday; two distributors cut orders on Wednesday; the PO went out Thursday anyway. Result: **₹9L write-off**.
  - The Reorder Desk's 3-day draft rule and weekly cycle address this pattern.

## The people (users of this system)
| Person | Role in the system |
|---|---|
| Raghav Kulkarni | Planner: owns rules, reviews exceptions, sets holds and festivals |
| Priya Sharma | Uploader: weekly SAP exports |
| Procurement head | Issues drafts in Zoho |
| Deepa Nair | Owner: outcomes, holdout, mode (shadow/live), backup approver |
| CEO | Reads the weekly brief |
| IT admin | Zoho connection, access, runbook |

## Case data provided (`data/case/`)
- 15 SKUs, 16 weeks (2026-W27 to W42).
- One warehouse (Pune), inventory as of 19 Oct 2026.
- Month-level festival flags.
- 4 "distributors" mapped one per SKU (these behave like suppliers).
- No distributor-level sales, prices/costs, lead times or open POs. **Use case-data mode and the D18 defaults.**
- Distributors DIST003 (Karnataka) and DIST004 (Gujarat) are outside the stated footprint; this shows as a validation warning.
