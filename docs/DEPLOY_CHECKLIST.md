# Deploy checklist: first production deploy

**Release:** Freshroots Reorder Desk v1 (milestones 1–6) · **Target:** Vercel (Pro) + Supabase (hosted) · **Starting state:** **shadow mode**
**Deployer:** IT admin, with the AI build team · **Date:** ________ · Re-use this list for later deploys; sections marked *(first deploy)* are one-off.

> **Free plans (C-042).** This deploy can run entirely on free tiers:
> - **Vercel Hobby:** daily crons, already set in `vercel.json`. Hobby is for non-commercial use: right for the case study and a demo; Freshroots' production needs Pro.
> - **Supabase Free:** no automatic backups, so take a weekly dump (RUNBOOK §10).
> - **Resend Free:** 100 emails a day.
> - **No Anthropic key:** the app uses rule text throughout.
> - **No Zoho:** each week runs from files, the failsafe (RUNBOOK §12).
>
> Where this checklist says "Vercel Pro" or "paid plan", the free equivalent is fine for this deploy.

Shadow mode is the only safe starting state: no drafts reach Zoho until Deepa switches (RUNBOOK §7). The first deploy should also use a **read-only Zoho token**, so a write is impossible even by mistake. Swap in the create-scoped token only at go-live, after the Zoho scope check (risk K1).

---

## 1. Pre-deploy

### Code and tests
There is no CI yet, so run these locally on the commit being deployed. All must pass.
- [ ] `git status` is clean, and you're on the commit you intend to ship. No `.env*` file is tracked (`git ls-files | grep env` shows only `.env.example`).
- [ ] `npm run lint` and `npm run typecheck`
- [ ] `npm test`: unit tests, including the W43 reference and the Instructions bindings
- [ ] `npm run test:integration`: database, RLS, run, send and crons. Resets the **local** database.
- [ ] `npm run test:e2e`: browser, with a production build
- [ ] Every migration in `supabase/migrations` has been applied locally with `npx supabase db reset` and the tests above ran on it
- [ ] Known open items reviewed in `docs/RISK_REGISTER.md`. None of K1–K5 blocks a **shadow** deploy; K1 blocks going **live**.

### Accounts *(first deploy)*
- [ ] **Vercel Pro** team (C-022). Hobby cron can't keep the Monday 10:00 or Tuesday 12:00 schedule.
- [ ] **Supabase** project on a paid plan.
  - Pick a region close to India (e.g. Mumbai).
  - Note whether daily backups and point-in-time recovery are on (RUNBOOK §10; risk S7).
- [ ] **Resend:** sending domain verified; an API key with send-only access.
- [ ] **Anthropic:** API key for production.
- [ ] **Zoho:**
  - an integration user in the Freshroots org;
  - a Self Client in the API Console (India DC);
  - a **read-only** refresh token for the shadow period: all the `.READ` scopes and **no** `purchaseorders.CREATE` (RUNBOOK §6 lists the scopes).
- [ ] People: email addresses for IT admin, Deepa, Raghav, Priya, the backup uploader, the procurement head and the CEO.

### Supabase production project *(first deploy)*
1. [ ] Link and push the schema:
   ```bash
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```
   ```bash
   npx supabase db push
   ```
   This applies every migration, including RLS, functions and the private `uploads` bucket. **Never** run `db reset` against production: it would load the local test users.
2. [ ] SQL editor → run `supabase/bootstrap.sql` once. It adds shadow mode, rules v1 and reason codes, with no users. Running it twice does no harm.
3. [ ] Auth → URL configuration:
   - Site URL = the production URL (e.g. `https://reorder.freshroots.in`);
   - add the same URL to Redirect URLs.
4. [ ] Auth → Providers → Email: **turn off "Allow new users to sign up".** People are only ever added by an admin.
5. [ ] Auth → Email Templates:
   - paste `supabase/templates/magic_link.html` into **Magic Link**;
   - paste `supabase/templates/invite.html` into **Invite user**.
   - Both links go to `/auth/confirm?token_hash=…`. Without this, emailed sign-in links won't work.
6. [ ] Auth → SMTP: use Resend's SMTP so sign-in emails aren't held up by the default mailer's low limits.
7. [ ] First two people (an admin can't make an owner, by design):
   1. Auth → Users → **Invite user** for IT admin and for Deepa.
   2. SQL editor, with the user ids from the Users list:
      ```sql
      insert into public.app_user (user_id, name, email, roles, is_owner) values
        ('IT-ADMIN-USER-ID', 'IT admin', 'it@freshroots.in', array['admin'], false),
        ('DEEPA-USER-ID', 'Deepa Nair', 'deepa@freshroots.in', array['planner','admin'], true);
      ```
   3. Everyone else is invited from **Settings → People** by IT after the deploy.

### Vercel project
- [ ] Function region close to the Supabase region (Settings → Functions).
- [ ] **Production** environment variables (Settings → Environment Variables). Names are in `.env.example`:

  | Variable | Value |
  |---|---|
  | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | production project |
  | `SUPABASE_SERVICE_ROLE_KEY` | production project; server-only |
  | `ZOHO_ACCOUNTS_DOMAIN`, `ZOHO_API_DOMAIN` | `https://accounts.zoho.in`, `https://www.zohoapis.in` (India DC) |
  | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ORGANIZATION_ID` | from the Self Client and the org |
  | `ZOHO_REFRESH_TOKEN` | the **read-only** token for the shadow period |
  | `APP_MODE` | `shadow` |
  | `ANTHROPIC_API_KEY` | production key (`LLM_MODEL` empty = `claude-sonnet-5-5`) |
  | `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | Resend; from-address on the verified domain |
  | `CRON_SECRET` | a new random value, 32+ characters |
  | `CASE_DATA_MODE` | **not set**. Production still accepts Freshroots' current file layouts (C-040); case-data mode only means a demo project with Zoho skipped |

- [ ] **Preview** environment: a separate (non-production) Supabase project or none, and a read-only Zoho token or none (ADR-0005). Never the production service key.
- [ ] No secret appears in any `NEXT_PUBLIC_` variable.

### People told
- [ ] Deepa, Raghav, Priya and procurement know the date, that it starts in **shadow** (nothing reaches Zoho), and that the first real week is the next Monday upload.

---

## 2. Deploy

1. [ ] Deploy the tested commit to Production: push to the production branch if the repo is connected, or run `vercel deploy --prod`.
2. [ ] The build succeeds. Check that it lists `/instructions`; the build ships `docs/INSTRUCTIONS.md` with it.
3. [ ] Vercel → Settings → Cron Jobs shows **three** jobs from `vercel.json`:

   | Path | Schedule (UTC) | IST |
   |---|---|---|
   | `/api/run` | `30 3 * * *` | daily, 09:00–09:59 (safety net; pages also resume runs) |
   | `/api/cron/noon` | `0 7 * * *` | daily, 12:30–13:29 (Hobby fires within the hour) |
   | `/api/cron/upload-check` | `0 5 * * 1` | Mon 10:30–11:29 |

---

## 3. Verify (smoke tests, about 15 minutes)

- [ ] **Sign-in:** IT admin opens the production URL, chooses **Email me a sign-in link**, opens the email, and lands on Settings.
- [ ] **Mode:** Settings → Shadow / live shows **shadow** and "This deployment allows: shadow only". The header badge says "Shadow mode".
- [ ] **Instructions:** "How this works" opens. It says "rules version 1", ⚙ values show (e.g. "20% ⚙"), and there is no `{{` anywhere.
- [ ] **Cron security:**
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-DOMAIN/api/run
  ```
  This must print `401`. Then with the secret:
  ```bash
  curl -s -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/run
  ```
  This must return `{"results":[],"delivered":0}`.
- [ ] **Alert email:** SQL editor:
  ```sql
  insert into public.alert (kind, dedupe_key, payload) values ('cron_failed', 'deploy-smoke-test', '{"message":"Deploy smoke test: ignore."}');
  ```
  Within 5 minutes:
  - the IT admin gets the email;
  - `select sent_at, "to" from public.alert where dedupe_key = 'deploy-smoke-test';` shows both filled in.
- [ ] **People:** IT invites the rest from Settings → People with the right roles:
  - Raghav: planner;
  - Priya and the backup uploader: uploader;
  - procurement head: procurement;
  - CEO: viewer.

  Each signs in once through their invite link.
- [ ] **Settings data** (Raghav, with procurement's input): SKUs with supplier, Zoho item id, lead time, MOQ, shelf life, perishability; distributors; suppliers with Zoho vendor ids; festival dates; holdout list (Deepa).
- [ ] **No Zoho yet?** Leave the `ZOHO_*` variables unset. Each week will block with `zoho_not_connected`, and Deepa runs it from procurement's open-PO file (RUNBOOK §12). Nothing is ever written to Zoho.
- [ ] **Zoho read** (needs the Settings data): the first real run, after Monday's upload, reaches the queue without `zoho_*` blocks.
  - If it blocks, RUNBOOK §2.
  - Zoho's audit log for the integration user shows **only reads**.
- [ ] **Logs:** Vercel → Logs shows no 5xx from `/api/run` or the pages during the checks.

---

## 4. Rollback

**Triggers** (decide now, not during the incident):
- sign-in doesn't work for invited people after Auth is checked;
- `/api/run` or `/api/cron/*` return 5xx repeatedly;
- a run blocks for a code reason (`step_failed`) that a Retry doesn't clear;
- **any** non-GET call to the Zoho API by the integration user while in shadow. This should be impossible with a read-only token: treat it as an incident.

**Steps:**
1. **App:** Vercel → Deployments → the previous good deployment → **Instant Rollback** (or Promote).
   - For the very first deploy, there's nothing to roll back to: pause instead by disabling the cron jobs (Settings → Cron Jobs) and telling users.
2. **Database:** migrations only move forward.
   - Rolling back the app is safe as long as the schema stays compatible; the previous app version ignores new columns.
   - Restore from backup only for data damage (RUNBOOK §10), never for an app bug.
3. **Zoho:** nothing to undo in shadow. Live drafts already created stay for procurement to issue or delete; the system never deletes them.
4. Tell Deepa and Raghav. Week planning continues by hand until the fix is deployed.

---

## 5. After deploy

- [ ] Record the deploy (date, commit, deployer) in RUNBOOK → History.
- [ ] Update `docs/RISK_REGISTER.md`: S6 (alerts) and S7 (backups) become Mitigated once verified above.
- [ ] Shadow period starts with the next Monday upload. Going live later follows the go/no-go in RUNBOOK §7, which includes the Zoho scope check (K1), the day-45 gate, real MOQs, and the llm-council review "Is this ready to switch from shadow to live?"
