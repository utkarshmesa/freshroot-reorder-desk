# Freshroots Replenishment Loop: Locked Build Plan (v1.2, simplified + final stress test)

Owner: Deepa Nair (Head of Operations) · Rules owner: Raghav Kulkarni · Updated 23 Oct 2026
Status: **LOCKED** for build with Claude Code. Any change needs a short change note.
Companion: `freshroots-components-map-v3.png`

---

## 1. Outcome

> After this system runs, **pilot SKUs will have fewer stockout weeks and lower perishable write-offs than the SKUs kept on Raghav's manual process**, and approved orders will be **issued in Zoho within 2 working days of Monday's data** (today: 3–4 weeks).

- **Baseline:** stockouts ₹18–22L/qtr; perishable write-offs ₹10–12L/qtr; monthly cycle; ~2 planner days/month.
- **Day-45 gate:** the historical replay shows the weekly rules would have cut stockout weeks and write-off units vs what actually happened. If not, redesign before continuing.
- **Kill criterion (after 8 live weeks):** stop and redesign if any of these hold:
  - pilot is not beating manual SKUs on stockout weeks;
  - unit-weighted rejection rate is above 40%;
  - rejection rate is below 5% with spot-check errors missed (rubber-stamping).

## 2. Simplicity rule

The system must do four things:
1. **See** current stock and demand, counting each unit once.
2. **Decide** fast with Raghav's rules.
3. **Keep a person** where a mistake is costly.
4. **Prove** it worked.

Anything that doesn't serve one of these in the 90 days is out. AI explanations and the CEO brief stay because they make decisions faster to review and results visible to the CEO.

## 3. The 9 components (see map v3)

| # | Component | Does | Owner |
|---|---|---|---|
| 1 | **CSV upload** | Monday sales + stock files from SAP; master files when changed; validated before commit | Priya (backup: IT SAP admin) |
| 2 | **Zoho connector** | Reads open POs and receipts; creates draft POs only | IT owner |
| 3 | **Settings** | SKU details + Zoho mapping, Raghav's rules, festival calendar, holds | Raghav; Procurement for supplier details |
| 4 | **Rules engine** | Stock position, weeks of cover, rules, order quantity | Code |
| 5 | **Triage** | Routine orders auto-approve; exceptions to the queue; Tuesday deadline rule; 5 spot-checks | Code |
| 6 | **Claude (AI)** | Plain-English reason per queue card; weekly brief for Deepa and the CEO. Never sets quantities. | Code + Claude API |
| 7 | **Review desk** | Raghav approves / changes / rejects exceptions | Raghav (backup: Deepa) |
| 8 | **Procurement in Zoho** | Reviews and issues the drafts | Procurement head |
| 9 | **Outcomes** | Pilot vs manual SKUs, order speed, decision log, CEO brief | Deepa |

**Off the map:** a one-off script that replays 3 years of history for the day-45 gate.

## 4. Stack
- Next.js (TypeScript) on Vercel.
- Supabase: Postgres, auth, file storage.
- Vercel Cron for reminders and escalations, in IST.
- Claude API.

All Zoho calls happen server-side. The OAuth refresh token is stored server-side and belongs to a dedicated integration user. India data centre (`accounts.zoho.in`, `zohoapis.in`) unless Freshroots' Zoho is elsewhere.

The existing "Freshroots Reorder Desk" artifact is the UX reference for the review desk.

## 5. Locked decisions

| # | Decision | Why (first principles) |
|---|---|---|
| D1 | **New SKU** (first sale under 13 weeks ago): use Raghav's launch estimate for weeks 1–4, blend with actuals in weeks 5–12, full rules from week 13; always in the queue until then | Early sales are distributors filling shelves, not demand |
| D2 | **New distributor:** first 4 weeks ignored; weeks 5–12 count toward demand but not the trend check | The trend rule compares 4-wk and 12-wk averages; a newcomer skews it until they're in both |
| D3 | **Status is just active / inactive** for SKUs and distributors. Inactive excludes future orders (SKU) or excludes their history from the end date (distributor). Rare events (pack changes, territory transfers) are handled by Raghav with a hold. | Frequent events get a mechanism; rare ones get a person |
| D4 | **Two event types only:** festival (dated, with a 3-week pre-load window) and **hold** (SKU and/or distributor, dates, reason). A hold covers promotions, competitor moves, credit holds and one-off orders. Held SKUs go to the queue; held distributor-weeks are excluded from averages. | One flexible mechanism beats seven special cases |
| D5 | **Count each unit once:** stock = SAP on-hand at the snapshot time + Zoho open PO qty (issued, not cancelled, ordered − received) + Zoho receipts dated after the snapshot. Drafts never count. | Removes the goods-receipts file and reconciliation logic |
| D6 | **Festival uplift** (+25%) applies to forward demand when the weeks being ordered for overlap a festival or pre-load window. Trend detection uses raw sales. The replay also tests Raghav's literal reading. | Uplift describes future demand; applying it to past sales double-counts |
| D7 | **Minimum cover includes lead time:** effective minimum = max(rule minimum, lead time + 2 weeks). If that exceeds the perishable maximum, the SKU goes to the queue as "infeasible". | Less stock than lead time plus a review week guarantees a stockout |
| D8 | **Triage:** auto-approve = reorder, non-perishable, not high-demand, no hold, not new. Everything else is queued, sorted by days to stockout. **Tuesday 12:00 rule:** unreviewed non-perishable stockout risks auto-approve at 1× standard qty; the rest roll to next week with an alert to Deepa. | A stockout loses sales; one std batch of a non-perishable only costs storage; perishables need a person |
| D9 | **Rubber-stamping check:** 5 random auto-approved items are added to the queue each week, plus an alarm if Raghav's rejection rate drops below 5%. | One simple mechanism |
| D10 | **Distributor behaviour:** each queue card shows the top 3 distributors behind the change, as units and %. Raghav judges. | Keeps the judgement human with simple code |
| D11 | **Drafts:**<br>• **only one un-issued system draft per supplier at a time.** If last week's draft is still pending, the new run creates no new draft for that supplier and shows "issue or delete the pending draft first".<br>• Reference `FR-{isoWeek}-{supplierId}`, checked before creating.<br>• A draft older than 3 days triggers an alert to procurement and Raghav. **The system cannot technically stop an old draft being issued (no edit permission)**, so the rule is a procurement policy: no issuing drafts older than 3 days without Raghav's OK.<br>• A deleted draft is logged as a procurement rejection; an edited draft as a procurement override. | Two pending drafts for one supplier is a double order waiting to happen. Be honest about which guards are code and which are process. |
| D12 | **Rule changes:** Raghav edits; every change is logged with a reason and applies from the next run; Deepa reviews the log monthly. Outcomes are reported per rule version. | Simple and auditable |
| D13 | **AI data:** Claude gets per-SKU numbers and anonymised distributor labels; code inserts names afterwards. Every number in Claude's text is checked against the engine. On a mismatch or outage, a template sentence is used and the run never waits. | Minimum data; AI can't change a number |
| D14 | **Corrections:** an upload may restate any of the last 12 weeks (logged); older weeks are locked. | Corrections matter while they still affect decisions |
| D15 | **Snapshot boundary:** the stock file is SAP on-hand **as at Sunday 23:59**. Zoho receipts dated **Monday or later** are added to the position. | Zoho receipts carry a date, not a time, so the boundary must be a day boundary or units get double-counted or missed |
| D16 | **Auto-approve limit:** an auto-approved qty may not exceed **2× std qty**; anything larger goes to the queue. The review desk also shows a one-line batch total ("auto-approved: N lines, X units, ₹Y"). | Limits the damage a rule or data bug can do across 300+ SKUs before anyone sees it |
| D17 | **Mode switch:** `shadow` (recommendations and decisions recorded, **no Zoho drafts**) / `live`. Default `shadow`; only Deepa can switch. | Shadow weeks must not create real orders |
| D18 | **Defaults for missing SKU details**, each shown as "assumed" on the card:<br>• lead time 2 weeks<br>• MOQ = std qty<br>• perishable max 4 weeks if shelf life is missing<br>• missing unit cost: outcomes in units only | A missing field shouldn't block 400 SKUs; an assumed value must be visible |
| D19 | **Roles (5):**<br>• Uploader (Priya, IT backup)<br>• Planner (Raghav, Deepa backup)<br>• Procurement (read-only in the app; works in Zoho)<br>• Admin (IT owner; Deepa for mode, holdout and deadlines)<br>• Viewer (CEO)<br>Alerts go by **email**. | The smallest set that keeps approver ≠ issuer and gives every alert an owner |
| D20 | **Replay data:** 3-yr weekly sales plus weekly stock history from SAP. If stock history can't be exported, rebuild it from opening stock + receipts − sales, and say so in the gate report. | The day-45 gate needs stockout weeks, which need stock levels |

## 6. Data model (Postgres)

| Table | Columns |
|---|---|
| `sku` | id (text), name, category, status, first_sale_week, launch_estimate_wk, std_qty, moq, pack_size, uom, lead_time_wks, shelf_life_wks, perishable, unit_cost_inr, supplier_id, zoho_item_id, updated_by, updated_at |
| `distributor` | id (text), name, region, status, start_week, end_week |
| `supplier` | id, name, zoho_vendor_id |
| `event` | id, type (festival/hold), start_date, end_date, sku_ids[], distributor_ids[], uplift_pct, reason, created_by |
| `rule_version` | id, params (jsonb), reason, created_by, created_at |
| `change_log` | entity, entity_id, field, old, new, by, at, reason |
| `upload` | id, files[], hashes[], as_of_ts, status, validation_report (jsonb), by |
| `sales_fact` | sku_id, distributor_id, iso_week, shipped_units, returns_units, ordered_units (optional) |
| `stock_snapshot` | sku_id, as_of_ts, on_hand_units |
| `run` | id, iso_week, upload_id, rule_version_id, zoho_read (jsonb), status, created_at |
| `recommendation` | run_id, sku_id, action, qty, cover, cover_after, flags[], top_distributors (jsonb), reason_text, triage (auto/queue/spotcheck/deadline_auto/rolled) |
| `decision` | recommendation_id, status, final_qty, reason_code, note, by, at |
| `draft_po` | run_id, supplier_id, reference, zoho_po_id, status (created/issued/edited/deleted), issued_lines (jsonb) |
| `holdout` | sku_id (fixed for the pilot) |
| `brief` | run_id, text, checked (bool) |

## 7. Upload contract (CSV or XLSX)

| File | Columns | When |
|---|---|---|
| `sales_weekly` | iso_week, sku_id, distributor_id, shipped_units, returns_units, ordered_units* | Monday (1+ complete weeks) |
| `stock_snapshot` | as_of_ts (must be Sunday 23:59 IST, per D15), sku_id, on_hand_units | Monday |
| `sku_master` / `distributor_master` | as section 6 | When changed |
| `backfill_sales` | as `sales_weekly`, 3 years | Once, for the replay |

\* `ordered_units` is optional and enables the fill-rate metric.

**Validation, shown before commit:**
- File type detected from headers.
- IDs read as text.
- ISO weeks, including W53.
- Strict numbers.
- Stock as-of time newer than the last run.
- Duplicate file hash rejected.
- No missing weeks.
- Unknown SKU or distributor: "add or fix".
- No negatives.
- Volume change over ±40% vs last week needs a confirm.
- Restatements within 12 weeks listed.

The commit is all-or-nothing.

**Case-data mode:** accepts the case files as they are (no distributor column; `distributor_id = "ALL"`). The top-3 distributor view is hidden and a banner says so.

## 8. Weekly run (triggered by a committed Monday upload)

1. **Read Zoho:** open POs (issued, not cancelled), receipts since the stock snapshot, items/vendors, the system's own drafts. Retry with backoff. Auth failure or outage blocks the run and alerts the admin.
2. **Mapping check:** a SKU with no active Zoho item or vendor is blocked and listed.
3. **Read back last run's drafts:** issued / edited / deleted, logged per D11.
4. **Clean the history:**
   - net = shipped − returns;
   - drop held distributor-weeks;
   - drop inactive distributors from their end week;
   - drop new distributors' first 4 weeks (D2);
   - drop zero-stock weeks.
5. **Rules per SKU:**
   - `a12` = mean of the last 12 clean weeks; `a4` = mean of the last 4. Fewer than 8 clean weeks goes to the queue.
   - `F` (forward weekly demand) = a12 × festival factor (D6), or the D1 blend for new SKUs.
   - `P` (position) per D5. `C` (cover) = P / F.
   - Bands:
     - non-perishable: min 6, max 14;
     - perishable: min 3, max min(4, 0.5 × shelf life);
     - effective minimum per D7.
   - High demand (`HD`) = a4 > 1.20 × a12 on raw sales.
   - Action:
     - `C > max` → **PAUSE**. List open PO lines for procurement to defer; if there are none, it's informational.
     - else `C < min_eff` or HD → **REORDER**:
       - Q = std × (1.5 if HD else 1);
       - raise in std steps until P + Q ≥ min_eff × F;
       - round up to MOQ / pack;
       - perishables capped at max × F − P. If the cap is below MOQ, mark "infeasible" and queue it.
     - else **NONE**.
   - Flags: HD, perishable, new SKU, hold, infeasible, borderline (±5%), conflict (HD + pause).
6. **Triage** per D8 and D9.
7. **Claude:**
   - one-to-two-sentence reason per queue card;
   - weekly brief (what's ordered, what's at risk, pilot vs manual, anything needing Deepa);
   - numbers checked per D13.
8. **Review desk:** approve / change qty / reject (reason code + note).
   - "Send to procurement" creates the drafts; at Tue 12:00 the D8 rule applies.
   - Holdout SKUs are shown for information only. Raghav plans them manually and their recommendations are hidden.
9. **Save:** run inputs, recommendations, decisions, drafts.
10. **Outcomes:**
    - stockout weeks (on-hand 0 or cover < 1 at snapshot);
    - write-off units/₹;
    - fill rate if available;
    - pilot vs manual;
    - draft-to-issue time;
    - rejection rate and spot-check results.

## 9. Zoho
- **Scopes:** read purchaseorders, purchasereceives, items, contacts, settings. **Create purchaseorders only; no update or delete.**
- **Before build:** confirm in a Zoho test org that this scope set cannot issue a PO. If it can, add a code-level guard and note it as a risk.
- **Limits:** 100 requests/min per org; daily cap by plan. Design for ≤300 calls per run.
- **Refresh tokens:** never mint extra ones (Zoho keeps a maximum of 20 per user).
- **Development:** against a Zoho test org mirroring the 15 case SKUs.

## 10. Screens (5)
1. **Upload:** drop files, preview, validation report, commit, history.
2. **Review desk:**
   - queue cards with cover gauge, Claude's reason, flags, top-3 distributors;
   - approve / change / reject;
   - blocked list and hold list (PO lines);
   - send to procurement.
3. **Settings:**
   - SKUs and distributors (status, details, Zoho mapping);
   - rules (with change log);
   - festival calendar;
   - holds;
   - holdout list;
   - people and backups.
4. **Outcomes:** pilot vs manual, order speed, decision log, rule versions, the weekly brief (CEO view).
5. **Instructions:** renders `INSTRUCTIONS.md`.
   - What the tool does and doesn't do, the weekly rhythm, a guide per role, the rules in plain English, all assumptions (A1–A24) with owners, "what to do when…", who to ask, a glossary.
   - Every ⚙ value is **bound live to Settings**, so the page can never disagree with what the engine uses.
   - Linked from every screen's header ("How this works").
   - Each card's "assumed" tags and each validation error link to the matching section.

## 11. Schedule & owners (IST)

| When | What | Owner | If missed |
|---|---|---|---|
| Mon 08:30 | Upload committed (run starts automatically) | Priya | 10:00 alert to backup uploader, Raghav and Deepa |
| Tue 12:00 | Queue cleared, sent to procurement | Raghav | D8 deadline rule; alert to Deepa |
| +1 working day | Drafts issued in Zoho | Procurement head | Day 3: email alert to procurement and Raghav; policy says don't issue without Raghav's OK (D11) |
| Monthly | Outcomes and change-log review | Deepa | — |
| Each January | Next year's festival dates | Raghav | Run warns if missing |

## 12. Milestones (13 weeks from 26 Oct 2026)

| Weeks | Deliverable | Exit check |
|---|---|---|
| 1–2 | Schema; upload + validation; settings; case-data mode; Zoho test org + scope check | Case files load; W53 test passes |
| 3–4 | Rules engine + tests; Zoho read; D5 position | Reference outputs reproduced |
| 5–6 | Backfill + replay; calibrate D6 / D8 | **Day-45 gate (~7 Dec)** |
| 7 | Triage, review desk, drafts to the Zoho test org, Claude reasons + brief | End-to-end on the test org |
| 8–11 | **Shadow mode**, 4 weeks including W53: system alongside Raghav's manual plan | Agreement, override and speed reported |
| 12–13 | Go-live on ~80% of SKUs, 20% kept manual; runbook; handover | Live drafts issued within SLA |

## 13. Acceptance tests

**Upload:**
- Duplicate file rejected.
- Old as-of time rejected.
- Missing week rejected.
- Leading-zero SKU IDs preserved.
- "1,200" parsed as a number.
- Partial set not committed.
- Restatement within 12 weeks accepted; older rejected.
- Unknown ID prompts "add or fix".
- **W52 → W53 → W01.**

**Rules:**
- Case data, week 2026-W43, with the D18 defaults (lead time 2 wks, MOQ = std, no open POs) reproduces `data/reference/expected_2026-W43.json`:
  - Peanut Butter 240 (auto)
  - Brown Rice 600 (auto)
  - Mango Drink 750 (queue, high demand)
  - Multigrain Bread 561 and Almond Milk 219 (queue, capped at the perishable max, because D7 lifts the perishable minimum to 4 wks)
  - Quinoa pause
  - Coconut Water pause (borderline)
  - the other 8 SKUs: no action
  - The earlier prototype values (500 / 150) came from before D7 and are superseded.
- Perishable infeasible case goes to the queue.
- HD + pause gives the conflict flag.
- Festival window follows the weeks being ordered for.
- New SKU follows D1.
- New and inactive distributors follow D2 / D3.
- Hold excludes weeks and queues the SKU.

**Zoho:**
- Open PO counted; draft not counted.
- Receipt after the snapshot added back.
- Partial, cancelled and over-received lines handled.
- Retry after an outage creates no duplicate draft.
- Deleted draft logged and not recreated that week.
- Edited draft read back.
- Unmapped item blocked.
- Auth failure blocks the run and alerts.

**Triage & people:**
- Auto-approve criteria exact.
- 5 spot-checks present.
- Tue 12:00 rule applied.
- Draft older than 3 days needs re-approval.
- Rejection rate below 5% raises the alarm.

**Final stress-test fixes:**
- A pending draft blocks a new draft for the same supplier.
- Receipt dated Sunday is not added; receipt dated Monday is added.
- Auto qty over 2× std goes to the queue.
- Shadow mode creates no Zoho calls with write permission.
- Missing lead time / MOQ / shelf life uses the D18 defaults and shows "assumed".
- Each role sees only its screens and actions.
- Instructions page shows current Settings values after a rule change.

**Claude:**
- Outage falls back to the template.
- A number mismatch falls back to the template.
- No distributor names in prompts.
- Brief generated each run.

## 14. Deferred to v1.1+ (deliberately)
- Thursday mid-week check.
- Automatic distributor-spread detection.
- SAP API instead of CSV.
- Successor SKUs and territory transfers as features (manual holds for now).
- ML challenger.
- Multi-warehouse.
- Messaging distributors.

## 15. Risks accepted
- **Manual upload is the weakest link.** Mitigated by alerts and a backup uploader.
- **Lost sales are estimated** unless `ordered_units` is supplied.
- **Case data can't exercise distributor features;** synthetic test files cover them.
