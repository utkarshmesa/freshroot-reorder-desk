# How the Freshroots Reorder Desk works

*This is the in-app **Instructions** page. Numbers marked ⚙ are read live from Settings, so this page always shows the values the system is actually using. (In the source file they are double-brace placeholders naming the setting and today's default.) If something here doesn't answer your question, ask the owner named in section 7, not the AI team.*

---

## 1. What this tool does

Every Monday it takes the latest SAP sales and stock files and the open purchase orders in Zoho, applies **Raghav's reorder rules**, and recommends for each SKU one of three things: **reorder**, **pause the next order**, or **no action**. Routine orders are approved automatically. Anything unusual goes to Raghav. Approved orders become **draft purchase orders in Zoho**, which procurement checks and issues.

**What it does not do:**
- It never issues, edits or deletes a purchase order. Only procurement does that, in Zoho.
- It does not forecast with machine learning. It applies written rules you can read in section 4.
- Claude (the AI) only **explains** recommendations and writes the weekly brief. **It never decides a quantity.** Every number Claude writes is checked against the rules engine.

---

## 2. The weekly rhythm

| When (IST) | What happens | Who |
|---|---|---|
| **Monday by 08:30** | Upload this week's SAP files (sales + stock). The run starts automatically when the upload is accepted. | Priya (backup: IT SAP admin) |
| Monday ~09:00 | Review queue and weekly brief are ready | System |
| **Tuesday by {{deadline.timeIST=12:00}} ⚙** | Review the queue and press **Send to procurement**. Drafts are created in Zoho. | Raghav (backup: Deepa) |
| **Within 1 working day** | Check and issue the drafts in Zoho | Procurement head |
| Monthly | Review outcomes, rule-change log and spot-check results | Deepa |
| Each January | Enter next year's festival dates | Raghav |

**If a step is missed:**
- **No upload by 10:00 Monday:** an alert goes to the backup uploader, Raghav and Deepa. There's no run until the upload is accepted.
- **Queue not cleared by Tuesday 12:00:**
  - unreviewed **non-perishable** items at risk of running out are auto-approved at {{deadlineStdMultiple=1}}× ⚙ standard quantity;
  - everything else is **not ordered this week**, and next Monday's run looks at it again;
  - cards Raghav already approved but didn't send **are sent to procurement automatically**;
  - Deepa gets an alert.
- **Upload late, so the queue is only ready after Tuesday 12:00:** the same rule applies at **12:00 the next day**, and Deepa gets an alert.
- **Draft not issued within {{draftStaleDays=3}} days ⚙:** procurement and Raghav get an alert. **Procurement must not issue a draft older than {{draftStaleDays=3}} days without Raghav's OK.**

---

## 3. Guides by role

**Signing in:** on the sign-in page, choose **Email me a sign-in link** and open the email on the same device. Each link works once. New people are added by the IT admin (Settings → People) and get an invitation email.

### Uploader (Priya)
1. Export from SAP using the saved layouts:
   - weekly sales: last complete week(s). Either per distributor (`sales_weekly`) or per SKU as today (`weekly_sales`: SKU_ID, Week, Units_Sold). With per-SKU sales the distributor features are off;
   - stock: **as at Sunday 23:59** (`stock_snapshot`, or `current_inventory` dated the Monday).
2. Go to **Upload**, drop both files and read the **validation report**.
3. Fix anything red. Yellow items need a **Confirm** (e.g. volume changed more than {{volumeChangeConfirmPct=40}}% ⚙ vs last week).
4. Press **Commit**. Either everything is accepted or nothing is.
5. **Made a mistake after commit?** Upload a corrected file for the same week(s). Corrections are allowed for the last {{restatementWindowWks=12}} weeks ⚙ and are logged.

**Never open the files in Excel and re-save them as CSV.** Excel strips leading zeros from SKU codes and changes dates. Upload the SAP export directly, or save as .xlsx.

### Planner (Raghav)
1. Open **Review desk**. The queue is sorted by **days until stockout**, most urgent first.
2. Each card shows:
   - the recommendation;
   - a **cover gauge** (weeks of stock now, after the order, and the target band);
   - Claude's explanation;
   - flags;
   - the **top 3 distributors** behind any change.
3. For each card: **Approve**, **Change quantity** (a reason is optional), or **Reject** (pick a reason and add a note). The reason is how the rules improve. A card that has already been settled (for example by the Tuesday 12:00 rule) can't be decided again; reload the desk.
4. **Spot-checks:** {{spotChecks=5}} cards ⚙ a week are routine orders the system would have auto-approved. Check them like any other.
5. **"Infeasible" cards** (usually perishables): the order the rules want is smaller than the supplier's minimum order. The card shows both choices with numbers: "order the minimum → cover after X weeks, above the maximum" or "skip → about N days to stockout". Pick one. Unreviewed infeasible cards are **not ordered** at Tuesday 12:00, so do these first.
6. Press **Send to procurement**. A supplier's draft is created once all of that supplier's cards are decided; the desk shows how many cards each supplier is still waiting on. Anything left goes at Tuesday 12:00.
7. **Re-approve** stale drafts: a draft procurement hasn't issued within {{draftStaleDays=3}} days ⚙ shows **Re-approve** in the desk's drafts table. Press it if the order is still right; procurement should not issue it before you do.
8. Use **Settings → Holds** for anything the rules can't know (see section 6).

### Procurement head
1. Open Zoho → Purchase Orders → Drafts. System drafts have references starting `FR-` (e.g. `FR-2026-W45-DIST001`).
2. Check supplier, quantities and dates, then **issue**.
3. **Editing quantities in Zoho is fine.** The system reads your change next Monday and logs it.
4. **Deleting a draft is fine.** It's logged as a rejection and won't be recreated that week.
5. **Pause** recommendations come as a **hold list** of open PO lines. Defer or cancel them in Zoho where you can.
6. Only one system draft per supplier exists at a time. **If last week's draft is still pending when Monday's run starts, no new draft is created for that supplier that week**, even if you issue the old one on Tuesday. This week's quantities were worked out without it, so creating one would order twice. Those items come back next Monday.
7. **Placing or changing a PO in Zoho on Monday or Tuesday** for a SKU in this week's run? That SKU's line is held back from the system draft and comes back next Monday, so nothing is ordered twice.
8. **Close or cancel PO lines that won't be delivered.** Open quantity counts as stock on order. Lines past their expected delivery date are flagged on Raghav's card.
9. Lead times, minimum order quantities and Zoho item mappings: send changes to **Raghav**, who updates **Settings › SKUs**. Procurement has read-only access in the app, except one button (below).
10. **Weeks when Zoho can't be used (Zoho failsafe):**
    - Deepa may ask you for the open purchase orders as at Monday 00:00 (the columns are in the runbook) and for your confirmation that the list is complete.
    - That week, orders come as **PO sheets** on the Review desk instead of Zoho drafts. **Download sheet**, place the order with the supplier, then press **Placed**.
    - A sheet not marked placed holds that supplier the next week.

### Head of Operations (Deepa)
- **Outcomes** page: pilot vs manual SKUs, stockout weeks, write-offs, order speed, rejection rate, spot-check results.
- Alarms to watch:
  - **rejection rate above {{rejectionAlarm.highPct=40}}% ⚙:** the rules don't fit;
  - **below {{rejectionAlarm.lowPct=5}}% ⚙:** reviews may be rubber-stamps;
  - drafts left un-issued.
- Monthly: read the **rule-change log**.
- **Shadow → live:** switching in Settings takes effect from **next Monday's run**, never mid-week.
- **Zoho failsafe:** if Zoho blocks a week and can't be fixed in time, you can run the week from procurement's open-PO file (Review desk → "Run this week from files"). Only you can, and it's logged.
- **Go-live gate:** 4 shadow weeks compared with Raghav's actual orders (Outcomes page), not a 3-year back-test: there isn't enough history for one.

### CEO
Read the **weekly brief** on the Outcomes page: what was ordered, what's at risk, and how the pilot SKUs are doing against the manually planned ones.

### IT admin
Owns the Zoho connection, user access, uploads failing for technical reasons, and the runbook. See section 7.

---

## 4. How a recommendation is made (Raghav's rules, in plain English)

1. **Clean the sales history.** Net sales = shipped − returns. These weeks are left out:
   - weeks under a **hold**;
   - weeks with **zero stock** (sales were low because there was nothing to sell);
   - a **new distributor's** first {{newDistributor.ignoreWks=4}} weeks ⚙;
   - an **inactive distributor's** weeks from their end date.
2. **Average sales:** last {{avgLongWks=12}} weeks ⚙ (`a12`) and last {{avgShortWks=4}} weeks ⚙ (`a4`).
3. **Forward demand** = 12-week average, **+{{festivalUpliftPct=25}}% ⚙** if the weeks being ordered for fall in a festival or its {{festivalPreloadWks=3}}-week ⚙ pre-load window.
4. **Stock position** = SAP stock (Sunday close) + open Zoho POs (issued, not yet received) + Zoho receipts dated after Sunday. **Drafts don't count.**
5. **Weeks of cover** = stock position ÷ forward demand.
6. **Target band:**
   - normal SKUs: **{{bands.nonPerishable.minWks=6}}–{{bands.nonPerishable.maxWks=14}} weeks ⚙**;
   - high-perishability SKUs: **{{bands.perishable.minWks=3}}–{{bands.perishable.maxWks=4}} weeks ⚙** (never more than half the shelf life).

   The minimum is raised to **lead time + {{leadTimeBufferWks=2}} weeks ⚙** where that's higher.
7. **Decision:**
   - above the band → **Pause next order**;
   - below the band, or sales in the last 4 weeks more than **{{highDemandRatio|pct=20}}% ⚙** above the 12-week average (high demand) → **Reorder**;
   - otherwise → **No action**.
8. **Order quantity:** standard quantity, **×{{highDemandMultiplier=1.5}} ⚙** if high demand, raised in standard steps until cover reaches the minimum, rounded up to MOQ / pack. For perishables it's capped so cover stays under the maximum.
9. **What goes to Raghav vs auto-approves:**
   - **Auto-approved:** a normal reorder for a non-perishable SKU with no flags, up to **{{autoApproveMaxStdMultiple=2}}× ⚙ standard quantity**.
   - **Raghav reviews:** every other reorder (perishables, high demand, new SKUs, holds, conflicts, borderline cases, anything flagged "infeasible" or over the auto-approve limit), and every pause that has open POs to defer.
   - **For information only:** a pause with no open POs to defer (nothing to act on). It's listed, not queued.

---

## 5. Assumptions (what the system takes as true)

If one stops being true, tell its owner. Most can be changed in Settings.

| # | Assumption | Default | Owner / how to change |
|---|---|---|---|
| A1 | Weeks are ISO weeks, Monday–Sunday. SAP sales weeks use the same definition. 2026 has a **week 53** (28 Dec–3 Jan). | — | IT admin |
| A2 | Stock file = SAP on-hand **as at Sunday 23:59**. Zoho receipts dated Monday or later are added on top. | — | Priya |
| A3 | SAP and Zoho record a goods receipt on the **same day**. If not, stock can be double-counted for a few days. | — | IT admin; the shadow period checks this |
| A4 | All quantities are in **base units**. The Zoho item unit matches the SKU master; a mismatch blocks that SKU. | — | Procurement |
| A5 | Missing **lead time** = **{{defaults.leadTimeWks=2}} weeks**, shown as "assumed" on the card. | {{defaults.leadTimeWks=2}} wks ⚙ | Procurement → Raghav → Settings › SKUs |
| A6 | Missing **MOQ** = the standard quantity. | = {{defaults.moq=std}} ⚙ | Procurement → Raghav |
| A7 | Missing **shelf life** for a perishable: maximum cover stays {{defaults.perishableMaxWks=4}} weeks. | {{defaults.perishableMaxWks=4}} wks ⚙ | Procurement → Raghav |
| A8 | Missing **unit cost**: outcomes show units, not ₹, for that SKU. | — | Finance |
| A9 | **Standard reorder quantity** in the SKU master is Raghav's normal batch. | — | Raghav |
| A10 | **Festival uplift** applies to demand for the weeks being ordered for, not to past sales. This is our reading of Raghav's Rule 4; the replay tests both readings. | +{{festivalUpliftPct=25}}% ⚙, {{festivalPreloadWks=3}}-wk pre-load ⚙ | Raghav |
| A11 | **New SKU**: launch estimate for weeks 1–{{newSku.launchEstimateWks=4}}, blended with actuals for weeks {{newSku.launchEstimateWks|+1=5}}–{{newSku.blendUntilWk=12}}, full rules from week {{newSku.blendUntilWk|+1=13}}. Always reviewed by Raghav until then. | ⚙ | Raghav |
| A12 | **New distributor**: first {{newDistributor.ignoreWks=4}} weeks ignored (shelf-filling); weeks {{newDistributor.ignoreWks|+1=5}}–{{newDistributor.noTrendUntilWk=12}} count toward demand but not the high-demand check. | ⚙ | Raghav |
| A13 | **Inactive** SKUs get no new orders. Inactive distributors' history is excluded from their end date. | — | Raghav |
| A14 | Things the rules can't know (promotions, competitor moves, credit holds, one-off bulk orders, pack changes) are entered by people as **holds**. | — | Raghav / Sales |
| A15 | A **hold** sends the SKU to Raghav and excludes the held weeks from averages. | — | Raghav |
| A16 | **Manual (holdout) SKUs**: ~20%, chosen at go-live by category and perishability. Raghav plans them by hand all pilot; the system hides its suggestions for them. | List in Settings | Deepa |
| A17 | **Tuesday {{deadline.timeIST=12:00}} rule**: unreviewed non-perishable stockout risks order {{deadlineStdMultiple=1}}× standard; approved cards are sent; everything else waits a week. If the queue is ready late, the rule applies at {{deadline.timeIST=12:00}} the next day. | ⚙ | Deepa |
| A18 | **Auto-approve limit**: {{autoApproveMaxStdMultiple=2}}× standard quantity; anything larger goes to Raghav. | {{autoApproveMaxStdMultiple=2}}× ⚙ | Deepa |
| A19 | **One system draft per supplier at a time**; drafts never count as stock. | — | — |
| A20 | Corrections allowed for the **last {{restatementWindowWks=12}} weeks** of sales. | {{restatementWindowWks=12}} wks ⚙ | IT admin |
| A21 | Claude receives **numbers only**, with distributors as codes (D1, D2…). Names are added afterwards by the system. | — | IT admin |
| A22 | Alerts go by **email** to the named owners. | — | IT admin |
| A23 | In **shadow mode** (the 4 weeks before go-live), no drafts are created in Zoho. Recommendations are compared with Raghav's manual plan. | Mode in Settings | Deepa |
| A24 | Success means **fewer stockout weeks and lower write-offs on pilot SKUs than manual SKUs**. Activity numbers (cards reviewed, AI text written) are not success. | — | Deepa |

---

## 6. What to do when…

| Situation | Do this |
|---|---|
| **Upload is rejected** | Read the red lines in the validation report: usually an old stock date, a missing week, an unknown SKU, or a file already uploaded. Fix in SAP and re-export. |
| **Unknown SKU or distributor in the upload** | Add it in **Settings** (with Zoho item, supplier, std qty, lead time and perishability for SKUs), or fix the code in the file. |
| **New SKU launching** | **Settings › SKUs › Add**. Fill every field, including the **launch estimate** (units/week). Until the Zoho item and supplier are set, the SKU is blocked from ordering. |
| **SKU being discontinued** | Set it **Inactive** with an end date. The hold list shows any open POs to cancel; excess stock appears on the clearance list for Sales. |
| **Pack size / SKU code change** | Add the new SKU, make the old one inactive, and add a **hold** on the new SKU so Raghav plans it by hand until it has 12 weeks of history. |
| **New distributor** | **Settings › Distributors › Add** with a start week. The system handles the first 12 weeks (A12). |
| **Distributor leaves or is on credit hold** | Leaving: set **Inactive** with an end week. Temporary: add a **hold** with dates. |
| **Freshroots runs a promotion / scheme** | Sales adds a **hold** for the SKUs and dates **before** it starts, so the spike isn't read as lasting demand. |
| **Competitor scheme spotted** | Raghav or field reps add a **hold** with a note; the SKU comes to Raghav. |
| **One-off bulk order** (institutional, event) | Add a **hold** on that distributor and week so it's left out of averages. |
| **Raghav on leave** | Deepa reviews as backup. Set the backup dates in **Settings › People**. |
| **Zoho is down on Monday** | The system retries every 5 minutes for about half an hour, then blocks the run and alerts IT. If Zoho can't be fixed in time, Deepa can run the week from procurement's open-PO file (Zoho failsafe). Otherwise Raghav plans that week by hand as before. |
| **Last week's draft still pending** | Procurement issues or deletes it. The new run won't create a second draft for that supplier until then. |
| **Wrong quantity ordered** | Procurement edits or cancels in Zoho. Raghav rejects similar cards with the reason "Disagree with the rule". If it's a rule problem, change the rule in Settings with a reason. |
| **Want to change a rule** | **Settings › Rules**. Edit and give a reason. It applies from the next run and is logged for Deepa. |
| **Claude's explanation looks wrong** | Trust the numbers on the card; they come from the rules engine. Each card says whether its text is "AI-written, numbers checked" or standard "rule text". Tell IT which card read wrong. |
| **Festival dates for next year** | **Settings › Festival calendar** each January. The run warns if next year is missing. |

---

## 7. Who to ask

| Topic | Owner |
|---|---|
| Rules, holds, review queue, festival dates | Raghav Kulkarni |
| Uploads and SAP files | Priya Sharma (backup: IT SAP admin) |
| Supplier details, MOQ, lead times (entered in Settings by Raghav), Zoho drafts | Procurement head |
| Unit costs | Finance |
| Outcomes, holdout list, deadlines, shadow/live mode | Deepa Nair |
| Logins, Zoho connection, errors, alerts | IT admin |

---

## 8. Words used on this page

| Word | Meaning |
|---|---|
| **Weeks of cover** | How many weeks the stock position lasts at forward demand |
| **Stock position** | Stock on hand + ordered and not yet received |
| **Band** | The target range of weeks of cover |
| **High demand** | Last {{avgShortWks=4}} weeks' sales more than {{highDemandRatio|pct=20}}% ⚙ above the {{avgLongWks=12}}-week average |
| **Hold** | A note that tells the system "something unusual is happening here; let a person decide" |
| **Draft** | A purchase order the system created in Zoho that procurement hasn't issued yet |
| **Spot-check** | A routine order shown to Raghav to make sure auto-approval is working |
| **Stockout week** | A week where the SKU's shelf was empty on Sunday, or sales were lost because there was no stock |
| **Low cover** | Less than a week of stock on the shelf on Sunday. A warning, not a stockout: lean perishable shelves dip below a week before each delivery by design |
| **Pilot / manual SKUs** | SKUs planned by the system vs by Raghav by hand, to prove the difference |
| **Shadow mode** | The system runs but sends nothing to Zoho, so its suggestions can be compared with Raghav's |
