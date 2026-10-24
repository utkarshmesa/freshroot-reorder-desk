# Runbook: Freshroots Reorder Desk

**Owner:** IT admin · **Backup:** Deepa Nair (owner) · **Used:** as needed, when an alert arrives or someone reports a problem
**Last updated:** 24 Oct 2026 · **Applies to:** BUILD_PLAN v1.2 with CHANGES up to C-035

The everyday "what do I do" for Priya, Raghav and procurement is in the app (**How this works**). This runbook is for the person who keeps the system running. Every procedure here works through the app, the Vercel dashboard, the Supabase dashboard or Zoho, with no code changes.

## Before you need it

- [ ] Admin login to the app (`admin` role). You see Review desk, Settings and Outcomes.
- [ ] Access to the **Vercel** project (Production environment variables, deployments, logs).
- [ ] Access to the **Supabase** project (SQL editor, backups, logs).
- [ ] Access to **Zoho** as the integration user that owns the refresh token, plus the **Zoho API Console** (`api-console.zoho.in`).
- [ ] Access to **Resend** (alert email).
- [ ] This file and `docs/INSTRUCTIONS.md` open.

### Where things are

| Thing | Where |
|---|---|
| This week's run status and any block reason | App → **Review desk** (the banner at the top) |
| Alerts (sent and pending) | Supabase → Table editor → `alert` (newest first) |
| Every change to rules, SKUs, modes, re-runs | Supabase → `change_log`; rules also in App → Settings → Rules → Versions |
| Server logs | Vercel → Project → Logs (filter by `/api/run`, `/api/cron/noon`) |
| Scheduled jobs | `vercel.json`: `/api/run` every 5 min; `/api/cron/noon` daily 06:30 UTC (12:00 IST); `/api/cron/upload-check` Mon 04:30 UTC (10:00 IST) |
| Secrets | Vercel → Settings → Environment Variables (Production). Never in the repo, chat or email |

### Alerts and what they mean

| Alert (`alert.kind`) | Goes to | Section |
|---|---|---|
| `upload_missed` | backup uploader, Raghav, Deepa | [1](#1-upload-missed-or-rejected) |
| `run_blocked` | admin, uploaders, planners | [2](#2-run-blocked-zoho-auth-failure-or-outage) (or [1](#1-upload-missed-or-rejected) if the reason is the stock snapshot) |
| `pending_draft` | procurement, planners | [3](#3-pending-or-stale-drafts) |
| `draft_stale` | procurement, planners | [3](#3-pending-or-stale-drafts) |
| `draft_unconfirmed` | admin, procurement, planners | [4](#4-draft-requested-but-not-visible-in-zoho) |
| `deadline_applied`, `rejection_rate`, `run_ready_late` | Deepa | Information; see Instructions |
| `llm_fallback` | admin | [8](#8-claudes-text-falls-back-to-templates) |
| `cron_failed` | admin | [9](#9-a-scheduled-job-had-errors) |

If `RESEND_API_KEY` or `ALERT_EMAIL_FROM` is missing, alerts are stored but not emailed (`sent_at` stays empty). Check the `alert` table after any deploy.

### Retry run (used by several procedures)

When a run is **blocked**, the Review desk shows a red banner with the reason. Admins also see a **Retry run** box under it.

1. Fix the cause first (the sections below say how).
2. Type what you fixed, e.g. "new Zoho refresh token installed", and press **Retry run**.
   - **Expected:**
     - If the run was blocked before the queue existed, it starts again from the beginning ("Run restarted"). Reload after a minute.
     - If it was blocked later (for example at Send), it goes back to normal with Raghav's decisions untouched ("Run unblocked").
   - **If it fails:** the message says why. "Only a blocked run…" means it is already running or done. "Replaced by a newer one" means a corrected upload superseded it; look at the newer run.
3. The retry is logged in `change_log` with your reason.

The cron also picks the run up within 5 minutes, so you don't need to trigger anything else.

---

## 1. Upload missed or rejected

**Symptoms:**
- `upload_missed` alert at Monday 10:00 IST; or
- Priya reports a red validation report; or
- the run is blocked with `no_stock_snapshot`.

**Steps:**

1. **Missed:** call Priya, then the backup uploader (Settings → People shows backup dates).
   - The run starts the moment an upload is committed; there is nothing else to trigger.
2. **Rejected:** open the upload's validation report with Priya. Each red line links to "What to do when…" in Instructions. The usual causes:

   | Red line | Cause | Fix |
   |---|---|---|
   | "already uploaded" | the same file (same hash) was committed before | export again only if the data changed |
   | "stock as-of is older than the last run" | an old stock file | export stock as at the most recent Sunday 23:59 |
   | "missing week" | a gap between the last committed week and this file | export the missing week(s) too, oldest first |
   | "unknown SKU / distributor" | not in Settings | Raghav adds it in Settings (with Zoho item and supplier), or fix the code in SAP |
   | leading zeros lost, odd dates | the file was opened and re-saved in Excel | export again straight from SAP, or save as .xlsx |

3. **Yellow lines** (e.g. volume changed more than the confirm threshold) need **Confirm** from Priya after checking with Raghav. They don't block the commit.
4. **Wrong data already committed for this week:** upload the corrected files for the same week.
   - Same stock as-of time = a correction: the week's run is replaced and re-run.
   - Corrections are allowed for the restatement window (Settings → Rules; 12 weeks by default).
   - **If drafts already exist for some suppliers this week,** those stay as sent; the correction applies to them from next week.

**Verification:** Review desk shows the week with a run in progress, then the queue.

**Escalation:** the SAP export itself is wrong or the layout changed → IT SAP admin. Not fixed by Tuesday 12:00 IST → tell Deepa; Raghav plans the week by hand as before.

---

## 2. Run blocked: Zoho auth failure or outage

**Symptoms:** `run_blocked` alert. The Review desk banner shows one of these reasons:

| Reason | Meaning |
|---|---|
| `zoho_auth` | Zoho refused the token, even after one refresh |
| `zoho_unavailable` | 5xx or 429 errors persisted after 5 tries with back-off |
| `zoho_budget` | more than 300 Zoho calls for one run |
| `zoho_unexpected` | a status or response the code doesn't know; fails closed |
| `zoho_not_connected` | `ZOHO_*` variables missing in this environment |
| `step_failed` | 3 attempts failed for another reason (see Vercel logs) |

**Steps:**

1. **`zoho_auth`:**
   1. Log in to Zoho as the integration user.
   2. Check that the user is active and still has access to the organisation (`ZOHO_ORGANIZATION_ID`).
   3. Check that the connected app wasn't removed (Zoho Accounts → Security → Connected Apps).
   4. If the token was revoked or has expired, follow [6. Rotating the Zoho token](#6-rotating-the-zoho-refresh-token), then **Retry run**.
2. **`zoho_unavailable`:**
   1. Check Zoho's status page and whether Zoho Inventory opens for you in a browser.
   2. When Zoho is back, press **Retry run**.
   3. A 429 means Zoho's rate limit (100 per minute per org; daily cap by plan). Look for another integration using the same org, then retry.
3. **`zoho_budget`:** the open-PO count has grown past what one run can read.
   - Retry once; calls already used are kept, so a resumed run only reads what's left.
   - If it recurs, it's time for the incremental PO cache (ARCHITECTURE §5 and §12). Raise it with the AI team.
4. **`zoho_unexpected`:** the message names the field or status, e.g. `Unknown Zoho status "…"`.
   - Do **not** work around it. It means Zoho changed something the position calculation depends on. Raise it with the AI team.
5. **`zoho_not_connected`:** set the `ZOHO_*` variables in Vercel (Production), redeploy, then **Retry run**.
6. **`step_failed`:** read the run's error and the Vercel logs (`/api/run`). If it's a temporary database or network error, retry. Otherwise escalate.

**Verification:** the banner disappears and the queue appears. The `zoho_read` on the run row has a fresh `read_at`.

**If it isn't fixed by Tuesday 12:00 IST:** no drafts go out for the week, by design (fail closed). Tell Deepa; Raghav plans manually. Nothing needs cleaning up afterwards.

---

## 3. Pending or stale drafts

**Pending draft** (`pending_draft` alert, or "Skipped: earlier draft unissued" in the desk's drafts table):
- Last week's system draft (`FR-…`) for that supplier was still un-issued, so no new draft was made this week.
- This is deliberate: the guardrail is one pending system draft per supplier.

1. Procurement issues the old draft in Zoho, or deletes it if it isn't wanted.
2. That supplier's lines this week stay held. They come back in next Monday's run, worked out with the issued PO counted as stock.
3. **Don't** create a draft by hand to make up for it. Next Monday covers it, and a manual one would double-order.

**Stale draft** (`draft_stale` alert; **Re-approve** in the desk's drafts table):
- A live draft has been un-issued longer than the setting (3 days by default).
- The noon job re-checks Zoho first, so this really is still a draft.

1. Raghav decides whether the order is still right, then presses **Re-approve**. That's logged, and nothing is written to Zoho.
2. Procurement issues it only after the re-approval (Instructions §2).
3. If it's no longer wanted, procurement deletes it in Zoho. Next Monday's read-back logs it as a procurement rejection.

---

## 4. Draft requested but not visible in Zoho

**Symptom:** `draft_unconfirmed` alert, or the Send message says "Requested earlier but not yet visible in Zoho".

**What happened:** the system sent the create request for `FR-{week}-{supplier}`, but the response was lost and Zoho's search doesn't show the PO yet. A draft row may only ever make **one** create attempt. Nothing is created twice. The supplier waits until the draft is confirmed.

1. In Zoho, search purchase orders for the reference `FR-{week}-{supplier}`.
2. **If it's there:**
   - Press **Send to procurement** again, or wait for the noon job. It adopts the PO and marks it created.
   - No other action is needed.
3. **If it isn't there after 15 minutes:** the create really failed. Reset the attempt in the Supabase SQL editor, using the exact reference:

   ```sql
   update public.draft_po
      set create_attempted_at = null
    where reference = 'FR-2026-W45-DIST001'   -- the reference from the alert
      and mode = 'live' and status = 'creating';
   ```

   It should update 1 row. Then press **Send to procurement** again.
4. **If there are two POs with that reference in Zoho:** stop. Delete the extra one in Zoho, keep the one the desk shows (or the older one), and tell the AI team. The system is designed never to do this.

---

## 5. Wrong quantity issued

The system never edits or deletes a PO. Corrections happen in Zoho.

1. **Procurement** edits or cancels the PO in Zoho.
   - The next Monday read-back logs the change as a procurement override or rejection (`change_log`, entity `draft_po`).
   - From then on the open quantity counts correctly in the stock position.
2. **Find the cause** (Raghav, with IT if needed):
   - **Wrong stock or sales data:** fix the upload (section 1). Corrections within the restatement window are logged.
   - **Wrong SKU master values** (lead time, MOQ, pack size, standard quantity): Raghav fixes them in Settings → SKUs. Look out for "assumed" tags: they mean a default was used.
   - **The rule itself:** Raghav changes it in Settings → Rules with a reason. It applies from the next run, and Deepa reviews the log.
   - **Raghav approved a wrong card:** decisions are logged with who and when (Outcomes → Decisions). Feed it back through the review, not the system.
3. **Don't** change past `recommendation` or `decision` rows. They are the evidence the pilot is judged on.

---

## 6. Rotating the Zoho refresh token

Do this once a year, when the integration user changes, if the token may have leaked, or after `zoho_auth`. Zoho keeps at most 20 refresh tokens per user; the system never mints new ones.

1. **Pick a quiet time:** not Monday 08:00 to Tuesday 13:00 IST, and not while a run is in progress.
2. In the **Zoho API Console** (`api-console.zoho.in`), as the integration user, open the Self Client and generate a grant code with exactly these scopes (no UPDATE or DELETE):
   ```
   ZohoInventory.purchaseorders.READ,ZohoInventory.purchaseorders.CREATE,ZohoInventory.purchasereceives.READ,ZohoInventory.items.READ,ZohoInventory.contacts.READ,ZohoInventory.settings.READ
   ```
   - For **preview and development** environments, leave out `purchaseorders.CREATE`: those must hold a read-only token (ADR-0005).
3. Exchange the code for a refresh token within its validity window, from a trusted machine:
   ```bash
   curl -s -X POST https://accounts.zoho.in/oauth/v2/token -d grant_type=authorization_code -d client_id=$ZOHO_CLIENT_ID -d client_secret=$ZOHO_CLIENT_SECRET -d code=PASTE_GRANT_CODE
   ```
   Copy only `refresh_token` from the reply. Don't paste the reply into chat, tickets or email.
4. In **Vercel → Settings → Environment Variables → Production**, replace `ZOHO_REFRESH_TOKEN`, then redeploy.
5. Clear the cached access token so the new refresh token is used at once (Supabase SQL editor):
   ```sql
   delete from public.zoho_token_cache;
   ```
6. **Verify:**
   - With the test org (`.env.zoho-test`): `ZOHO_LIVE=1 npm run test:zoho-live`. It checks that the scope set can read and can't issue.
   - In production: the next run reads Zoho without `zoho_auth`. If a run is blocked, press **Retry run** now and watch it reach the queue.
7. **Revoke the old token:** Zoho Accounts → Security → Connected Apps (or the API Console), as the integration user.
8. Record the rotation date in the History table below.

**Rollback:** if the new token fails and the old one wasn't revoked yet, put the old value back in Vercel, redeploy and clear `zoho_token_cache`.

---

## 7. Switching shadow → live

Only Deepa can switch (D17). It takes effect from the **next Monday's run**, never mid-week. Drafts reach Zoho only when all three say live:
- the deployment (`APP_MODE` in Vercel);
- Deepa's setting (Settings → Shadow / live);
- the mode stamped on that week's run.

**Before switching** (go/no-go, owned by Deepa):
- [ ] The Zoho scope check passed in the test org: `ZOHO_LIVE=1 npm run test:zoho-live`. This can't-issue check was a Milestone 1 exit blocker (ADR-0002), and the user deferred it (C-030).
- [ ] At least 4 shadow weeks reviewed, including W53. Agreement, overrides and speed are shown on Outcomes (BUILD_PLAN §12).
- [ ] Day-45 replay gate result recorded (REPLAY_SPEC; `npm run replay`).
- [ ] Holdout list fixed (Settings → Holdout, about 20% of SKUs). It doesn't change during the pilot.
- [ ] Real perishable MOQs and shelf lives entered; no "assumed" tags left on pilot SKUs that matter.
- [ ] Procurement briefed on `FR-` drafts (Instructions §3).
- [ ] llm-council run once more on the working system: "Is this ready to switch from shadow to live?" (START_PROMPT Step 3).
- [ ] Alert email working: a test alert reached the right inboxes (`sent_at` filled in).

**Steps:**

1. **IT,** any day before the target Monday:
   1. Vercel → Production → set `APP_MODE=live`.
   2. Install the **create-scoped** `ZOHO_REFRESH_TOKEN` (§6 procedure, with `purchaseorders.CREATE`). The shadow period runs on a read-only token (DEPLOY_CHECKLIST), so this swap is part of going live.
   3. Redeploy.
   - Settings → Shadow / live should now show "This deployment allows: live". The setting still says shadow.
2. **Deepa:** Settings → Shadow / live → choose **live**, give a reason, Save.
   - This is logged.
   - The current week stays shadow.
3. **The next Monday's run** is stamped live. Its sends create real drafts in Zoho.
4. **Verify on that Tuesday:**
   - the Review desk title says "Live run";
   - after Send, the drafts table shows mode `live` and status `created`;
   - Zoho shows matching `FR-` drafts, all as **Draft**.

**Rollback:** Deepa switches back to shadow in Settings. It applies from the next run. To stop writes at once, IT sets `APP_MODE=shadow` in Vercel and redeploys: every send falls back to shadow immediately (fail closed). Drafts already created stay in Zoho for procurement to issue or delete.

---

## 8. Claude's text falls back to templates

**Symptom:** `llm_fallback` alert (more than half of a run's card reasons fell back), or cards say "rule text" instead of "AI-written, numbers checked".

This is never urgent: quantities don't depend on Claude, and the run is never blocked by it.

1. Check that `ANTHROPIC_API_KEY` is set in Vercel (Production) and valid. `LLM_MODEL` empty means the default (`claude-sonnet-5-5`).
2. Check the Anthropic status page and the Vercel logs.
3. A persistent high fallback rate while the API works means Claude's text keeps failing the number check. Raise it with the AI team; don't loosen the checker.

---

## 9. A scheduled job had errors

**Symptom:** `cron_failed` alert; the message lists the errors.

1. **"send failed: A send for this week is already in progress":** someone was sending at 12:00. Nothing to do: the next noon firing, or Raghav pressing Send, finishes it.
2. **A Zoho error:** as in section 2.
3. **Anything else:** check the Vercel logs for `/api/cron/noon`. The job is safe to run again by hand:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/cron/noon
   ```
   It only applies the Tuesday rule to the latest week, after its deadline, to cards still waiting.

---

## 10. Restoring from backup

On paid Supabase plans, Supabase takes daily backups; point-in-time recovery is available if the add-on is enabled. **Confirm which you have before go-live** (Supabase → Database → Backups; deploy checklist).

**When:** data loss or corruption in the database. Not for a bad upload (use a correction, section 1) or a wrong rule (publish a new version).

1. **Stop new work:**
   - tell Priya and Raghav not to upload or decide;
   - IT sets `APP_MODE=shadow` in Vercel and redeploys, so nothing is written to Zoho while restoring.
2. **Note what will be lost:** everything after the restore point. That means uploads, runs, decisions, draft records, rule versions and change-log rows.
   - Export the `decision`, `draft_po` and `change_log` rows after the restore point (Table editor → Export CSV). They are evidence, and you'll need them to reconcile.
3. **Restore:** Supabase → Database → Backups → choose the point → Restore.
   - This replaces the database.
   - The app's migrations are already in the backup, so nothing to re-apply.
4. **Reconcile:**
   - **Uploads:** Priya re-commits each lost week's files in order. The file-hash record was restored too, so files committed after the backup are accepted again.
   - **Drafts already in Zoho** are not lost. A send for the same week adopts the existing `FR-` draft by reference; it never creates a second one. Drafts from earlier weeks are found by the pending-draft check.
   - **Decisions after the restore point:** Raghav re-decides the current week's cards. Attach the exported CSV to the week's notes for the pilot record.
5. **Put the mode back:** if the system was live, IT sets `APP_MODE=live` and redeploys. Deepa's setting is as it was at the restore point; check Settings → Shadow / live.
6. **Verify:**
   - Review desk shows the expected week;
   - Settings → Rules shows the expected current version;
   - `select count(*) from public.alert where sent_at is null;` isn't growing.

**Escalation:** Supabase support for restore failures.

---

## 11. Holiday week: pause the Tuesday rule

Non-working days aren't in Settings yet (C-021, deferred to v1.1). Interim rule: **Deepa decides; IT pauses the noon job** for a week where Monday or Tuesday is a holiday.

1. Vercel → Project → Settings → Cron Jobs → disable `/api/cron/noon`. Leave `/api/run` running.
   - While it is off, the Tuesday rule doesn't fire and stale-draft alerts pause.
   - Uploads, runs, decisions and Send work as normal.
2. Tell Raghav and procurement the new deadline (e.g. Wednesday 12:00).
3. Re-enable the job before that day. Its next 12:00 firing applies the rule to anything still waiting in the latest week, then sends.
   - If the week has already ended by then, nothing is applied; those cards come back in next Monday's run.
4. Record the pause in the History table below.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Queue never appears, no banner | Run stuck mid-step; the cron isn't firing | Vercel → Crons: is `/api/run` running every 5 min? `CRON_SECRET` set? Then look at the run row's `status` and `error` |
| "This deployment allows: shadow only" after going live | `APP_MODE` not exactly `live` in Production, or not redeployed | Fix the variable, redeploy |
| Everyone sees "You don't have permission" | `app_user` row missing or roles wrong | Admin: Settings → People |
| Card shows "assumed lead time" or "assumed MOQ" | Missing in the SKU master | Raghav: Settings → SKUs |
| A SKU is "Blocked: no Zoho item" | Unmapped, inactive item, unit mismatch, or item shared by two SKUs | Fix `zoho_item_id` and the unit in Settings → SKUs, or the item in Zoho |
| Alerts not arriving | Resend not configured or the domain isn't verified | Set `RESEND_API_KEY` and `ALERT_EMAIL_FROM`; check Resend logs |

## Escalation

| Situation | Contact | How |
|---|---|---|
| Rules, queue, holds, festival dates | Raghav Kulkarni | Phone or email |
| Shadow/live, holdout, deadlines | Deepa Nair | Phone |
| SAP export broken | IT SAP admin | Ticket |
| Zoho down or account problems | Zoho support (India DC) | Zoho admin console |
| Code defect, unexpected Zoho data, two drafts for one reference | AI build team | Email with the run's week and error |

## History

| Date | Run by | Notes |
|---|---|---|
| 24 Oct 2026 | AI build team | First version |
