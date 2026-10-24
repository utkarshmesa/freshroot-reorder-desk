# Process: the weekly replenishment cycle

**Owner:** Deepa Nair (Head of Operations) · **Last updated:** 24 Oct 2026 · **Review:** monthly, at the outcomes review
**Matches:** BUILD_PLAN §11 (schedule and owners), with timing details from ARCHITECTURE §4.1 and CHANGES C-024 and C-035

## Purpose

Every week, turn the Monday SAP files and Zoho's open orders into reorder decisions and draft POs. By Tuesday noon:
- a person has looked at everything unusual;
- routine orders have gone through on their own.

Procurement then issues the drafts within one working day. The cycle exists to give pilot SKUs fewer stockout weeks and lower perishable write-offs than SKUs on manual planning. Approved orders should be issued within 2 working days.

## Scope

- **In:** the weekly upload, the run, the review queue, Send to procurement, issuing drafts, the Tuesday 12:00 rule, stale drafts, alerts, and the monthly and yearly reviews.
- **Out:**
  - SAP and Zoho themselves;
  - supplier negotiation;
  - manual planning of holdout SKUs (Raghav does that as before);
  - system fixes (see `docs/RUNBOOK.md`).

## People

| Code | Person | Role in the app |
|---|---|---|
| **P** | Priya Sharma | Uploader |
| **BU** | Backup uploader (IT SAP admin) | Uploader, on the dates in Settings → People |
| **R** | Raghav Kulkarni | Planner |
| **D** | Deepa Nair | Owner (mode, holdout, deadlines); planner backup |
| **PH** | Procurement head | Procurement (read-only in the app; issues POs in Zoho) |
| **IT** | IT admin | Admin |
| **C** | CEO | Viewer |

## RACI

R = Responsible (does it) · A = Accountable (owns the outcome; one per step) · C = Consulted · I = Informed

| # | Step | When (IST) | P | BU | R | D | PH | IT | C |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Export SAP sales (last complete week) and stock (as at Sunday 23:59) | Mon by 08:30 | **R/A** | R if P away | | | | C | |
| 2 | Upload, read the validation report, confirm yellow lines, commit | Mon by 08:30 | **R/A** | R if P away | C (yellow lines) | | | C | |
| 3 | Missed-upload alert if nothing committed | Mon 10:00 (automatic) | I | **R** | I | **A** | | I | |
| 4 | Run: read Zoho, rules, queue, Claude reasons, brief | Starts on commit (automatic) | I | | I | | | **A** | |
| 5 | Fix a blocked run, then Retry run | As soon as alerted | I | | I | I | | **R/A** | |
| 6 | Review the queue: approve, change or reject each card, spot-checks included | Mon–Tue 12:00 | | | **R/A** | R as backup | C (supplier issues) | | |
| 7 | Send to procurement (drafts per supplier) | As soon as a supplier's cards are settled; by Tue 12:00 | | | **R/A** | R as backup | I | | |
| 8 | Tuesday 12:00 rule on unreviewed cards, then send the rest | Tue 12:00 (automatic) | | | I | **A** (informed by alert) | I | C if it fails | |
| 9 | Check and **issue** drafts in Zoho (edit or delete if needed) | Within 1 working day of send | | | C | I | **R/A** | | |
| 10 | Clear pending drafts from earlier weeks | Before Monday's run | | | C | I | **R/A** | | |
| 11 | Re-approve drafts un-issued for 3 days | Daily check at 12:00 (automatic alert); Raghav acts the same day | | | **R/A** | I | I (don't issue before re-approval) | | |
| 12 | Read the weekly brief | After the run | | | I | I | | | **R/A** (read) |
| 13 | Monthly outcomes review: pilot vs manual, order speed, rejection rate, spot-checks, rule-change log | First week of the month | | | C | **R/A** | C | I | I |
| 14 | Rule changes (with a reason) | As needed; applies from the next run | | | **R** | **A** (reviews monthly) | C | | |
| 15 | Holds for promotions, schemes, one-off orders | Before the event | | | **R/A** | I | C | | |
| 16 | Next year's festival dates | Each January | | | **R/A** | I | | | |
| 17 | Shadow → live switch | Once, after the go/no-go (RUNBOOK §7) | | | C | **R/A** | C | R (deployment) | I |

## Flow

```
Mon 08:30  Priya: export + upload + commit ──► run starts on its own
               │ no commit by 10:00 → alert (backup uploader, Raghav, Deepa)
               ▼
Mon ~09:00 Run: Zoho read → rules → queue (rule text) → Claude reasons + brief
               │ blocked → alert → IT fixes → Retry run
               ▼
Mon–Tue    Raghav: decide each card ──► Send (a supplier goes once nothing for it waits)
               ▼
Tue 12:00  Automatic: unreviewed non-perishable stockout risks ordered at 1× std;
           unreviewed spot-checks keep their qty; everything else waits a week;
           everything settled is sent; Deepa alerted
               ▼
Tue–Wed    Procurement: issue FR- drafts in Zoho (edit or delete is fine)
               │ un-issued after 3 days → alert → Raghav re-approves first
               ▼
Next Mon   Run reads back last week's drafts (issued / edited / deleted, logged)
```

## Detailed steps

### 1–2. Upload (Priya)
- **When:** Monday, done by 08:30 IST.
- **How:** follow Instructions → Guides by role → Uploader.
  - Export straight from SAP; never re-save CSVs in Excel.
  - Red lines must be fixed; yellow lines need a **Confirm**.
- **Output:** a committed upload. The run starts automatically.

### 4–5. Run (system; IT if blocked)
- **When:** on commit. The queue is usually visible within minutes.
- **Output:**
  - recommendations;
  - a queue for Raghav;
  - routine orders auto-approved (with 5 random spot-checks shown to Raghav);
  - the weekly brief.
- **If blocked:** a banner on the Review desk and an alert. Nothing goes to procurement until it's fixed (fail closed). IT follows RUNBOOK §2.

### 6–7. Review and send (Raghav)
- **When:** Monday after the run, done by Tuesday 12:00 IST.
- **How:** Instructions → Guides by role → Planner.
  - Infeasible perishable cards first: they are **not ordered** if left to the Tuesday rule.
  - Reject only with a reason.
  - Press **Send to procurement** whenever suppliers are ready. There's no need to wait until the end.
- **Output:** one draft per supplier per week, reference `FR-{week}-{supplier}`. In shadow mode these are recorded in the app only.

### 8. Tuesday 12:00 rule (automatic)
- Applies to cards still waiting. Raghav's settled cards are sent as they are.
- If the queue only became ready after Tuesday 12:00, the rule applies at 12:00 the next day (C-024), and Deepa is alerted when it becomes ready.

### 9–11. Issue drafts (Procurement head)
- **When:** within 1 working day of the send.
- **How:** Instructions → Guides by role → Procurement head.
  - Editing quantities or deleting a draft in Zoho is fine; the next run logs it.
  - Never issue a draft older than 3 days without Raghav's re-approval.
- **Output:** issued POs, counted as stock on order from the next run.

### 13. Monthly review (Deepa)
- **When:** first week of each month.
- **How:** Outcomes page plus the rule-change log (Settings → Rules → Versions).
- **Decide:** any rule changes (Raghav makes them, with a reason), holdout integrity (no changes during the pilot), and whether the alarms need action.

## Exceptions

| Scenario | What to do |
|---|---|
| Priya away | Backup uploader runs steps 1–2 (backup dates in Settings → People) |
| Raghav away | Deepa reviews and sends (she has the planner role) |
| Upload wrong after commit | Upload corrected files for the same week; the week's run is replaced (RUNBOOK §1) |
| Zoho down Monday and not fixed by Tuesday 12:00 | No drafts that week (fail closed). Raghav plans by hand as before |
| Last week's draft still pending on Monday | That supplier gets no new draft this week; procurement issues or deletes the old one; the lines return next Monday |
| A PO for a SKU placed or changed in Zoho on Monday or Tuesday | That SKU's line is held back from the system draft this week; it returns next Monday |
| Week 53 (2026) | Normal week: upload and review as usual. 2026-W53 runs 28 Dec–3 Jan |
| Festival dates missing for next year | The run warns. Raghav enters them in Settings → Festivals & holds |

## Metrics (Outcomes page)

| Metric | Target | How measured |
|---|---|---|
| Stockout weeks, pilot vs manual SKUs | Pilot lower | Empty Sunday shelf or lost sales (C-031), same weeks for both groups |
| Perishable write-offs, pilot vs manual | Pilot lower | Pending a write-off data source (C-014) |
| Order speed | Issued within 2 working days of Monday's upload | Upload commit → `issued_at` read back from Zoho |
| Rejection rate (unit-weighted) | Between 5% and 40% | Decisions per week; outside the band raises an alarm |
| Upload on time | Every Monday by 08:30 | Missed-upload alerts (zero is the target) |
| Shadow agreement (weeks 8–11) | Reported, no target | Share of cards approved as recommended |

Activity counts (cards shown, AI text written) are **not** success measures.

## Related documents

- `docs/INSTRUCTIONS.md` (in the app: **How this works**): what each person does, step by step.
- `docs/RUNBOOK.md`: what IT does when something breaks.
- `docs/RISK_REGISTER.md`: what could go wrong and how it's covered.
- `docs/BUILD_PLAN.md` §11: the schedule this document implements.
