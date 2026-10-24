# Replay spec: the day-45 gate (C-020)

**Question the gate answers** (BUILD_PLAN §1): over the last 3 years, would the weekly rules have produced **fewer stockout weeks and fewer write-off units** than what actually happened? If not, redesign before continuing.

**Principle:** compare like with like. Both arms run through the **same** weekly simulator, with the same demand and the same perishable ageing. Only the receipts differ:

| Arm | Receipts |
|---|---|
| **Actual** | Raghav's real receipts, on the dates they arrived |
| **Rules** | What the engine would have ordered each Monday, arriving after the lead time |

Comparing a simulation of the rules against raw history would be biased: history has its own shrinkage, miscounts and censored sales.

## 1. Inputs (files; the replay reads them directly, with no database)

| File | Columns | Required |
|---|---|---|
| `backfill_sales` | as `sales_weekly` (§7): iso_week, sku_id, distributor_id, shipped_units, returns_units[, ordered_units] | Yes, 3 years |
| `receipts_history` | iso_week, sku_id, received_units (goods received that week, from SAP) | Yes |
| `stock_history` | iso_week, sku_id, on_hand_units (Sunday close) | Preferred (D20) |
| `sku_master` | §6 columns; lead time, shelf life, MOQ, pack | Yes; D18 defaults where blank, reported as "assumed" |
| festivals | case `calendar` format, or dated events | Yes |
| `distributor_master`, holds | as in the app | Optional |

**Stock history (D20):**
- If `stock_history` is missing, opening stock is the first week's on-hand, rebuilt as opening + receipts − net sales. The report says so.
- If it is missing **and** there is no write-off source, write-offs come from the simulator's ageing only (C-014 option C), and the report says that too.

## 2. Demand
- **Demand each week** = net units sold (shipped − returns, all distributors).
- **Stockout weeks in the history** (on-hand 0 at Sunday close): sales were capped by stock, so demand is **imputed** as max(sales, clean a12 at that week). This "lost sales" imputation stops the actual arm looking better than it was.
- Both arms face the same demand series.

## 3. The simulator (pure: `lib/replay/simulate.ts`)
Per SKU, per week, in order:
0. **Opening stock:** its real age is unknown. It is assumed to have arrived evenly over the previous weeks (one week's demand per lot, never older than the shelf life allows), the same for both arms. Treating it all as fresh made every opening lot expire on the same day, a simulator artefact.
1. Receipts due this week arrive as a new lot (age 0).
2. Demand is served from the oldest lot first (FIFO). Anything unmet is a lost sale.
3. Lots age one week. For perishables, a lot that reaches the shelf life is **written off**.
   - Shelf life is from the master.
   - If it's missing, it's 2 × the perishable max cover (D18: max = ½ shelf life, so 8 weeks by default), marked "assumed".
4. The Sunday on-hand is recorded.
5. **Stockout week**, reported three ways (C-031 is pending):
   - C-017: on-hand 0, or under one week of raw clean a12;
   - weeks with lost sales;
   - weeks with zero on-hand.

   Both arms use the same reference series.

**Speed:** distributors with nothing distributor-specific (no start or end week, no distributor hold) are summed into one stream before the engine sees them. This is exact, and a test checks it.

**Rules arm:** each Monday, the **real engine** (`lib/engine`, unchanged) runs on what the rules would have seen:
- that arm's own simulated sales history;
- that arm's on-hand;
- that arm's in-transit orders, which stand in for open POs.

It runs as a single SKU, with the real festivals and holds. Every recommendation is taken as approved at the engine's quantity, i.e. the rules as written. Two policies are reported separately:
- **Infeasible perishable cards:** "skip" (the default, as written) and "order MOQ" (Raghav's usual choice).
- **Tuesday deadline:** not modelled. All queue cards count as reviewed in time.

## 4. Outputs
Per SKU and in total, for each arm:
- stockout weeks;
- lost-sales units;
- write-off units (and ₹ where unit cost exists);
- average on-hand units;
- orders placed, and units ordered.

**Gate verdict:** the rules arm must have **fewer total stockout weeks** AND **fewer total write-off units** than the actual arm. Each difference is reported with a 95% bootstrap interval over SKUs (seeded, so it can be reproduced). The verdict is printed as PASS / FAIL / NOT DECIDABLE, plus the reason.

**Calibration (START_PROMPT: D6 and D8):**
- **D6 festival readings:**
  - "any" (production, C-004);
  - "share" (uplift in proportion to festival weeks in the window);
  - "literal" (Raghav's rule 4 as written: festival-month sales history uplifted before the checks).
- **D8 load:** queue cards per week, auto-approved per week, and spot-checks.
- How often **high demand** stacks with the festival uplift.
- How often the **high-demand quantity comes out below the normal quantity** (C-029).
- How often perishables are **infeasible**.

**Method QA** (data:validate-data, run on real data before you see the report):
- the actual arm simulated with real receipts should track the real stock history; the gap is the inferred loss (C-014);
- units are conserved: receipts in = sold + written off + change in on-hand;
- no negative stock, every week present, W53 included.

## 5. Limits stated in every report
- The simulation assumes approved orders arrive exactly after the lead time. Real supplier delays aren't modelled.
- Demand in each arm doesn't react to that arm's own stockouts. Customers lost for good aren't modelled.
- Before the real 3-year export arrives, any run is a **smoke test of the machinery only**.
