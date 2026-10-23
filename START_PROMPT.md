# Kickoff prompt for Claude Code

Open Claude Code in this folder (`Freshroot`) and paste everything between the lines.

---

You're building the **Freshroots Reorder Desk** in this folder. Everything you need is here.

**Step 0: Orient (no code yet)**
1. Read `CLAUDE.md` fully. It holds the guardrails and working rules for every session.
2. Read `docs/BUILD_PLAN.md` (locked v1.2), `docs/CASE_CONTEXT.md`, `docs/DECISION_LOG.md` and `docs/INSTRUCTIONS.md`. Look at `docs/component-map-v3.png`.
3. Inspect `data/case/*.csv` and `data/reference/expected_2026-W43.json`.
4. Reply with:
   - a 10-line summary of what you'll build;
   - the milestone order;
   - any contradictions or gaps you found in the docs.

   Don't redesign. If something truly blocks you, propose the smallest fix as a change note.

**Step 1: Design before code, using our installed skills**
- Use **engineering:system-design** to write `docs/ARCHITECTURE.md`:
  - Supabase schema (from BUILD_PLAN §6) with RLS per role (D19);
  - module boundaries (pure `lib/engine`, server-only `lib/zoho`, `lib/upload`, `lib/llm`);
  - the run pipeline (§8) as a sequence;
  - Zoho call budget.
- Use **engineering:architecture** to write short ADRs in `docs/adr/`:
  1. CSV upload instead of SAP integration;
  2. direct Zoho API with read + create-draft scopes only;
  3. rules engine as a pure, deterministic module;
  4. Claude explains and never decides, with number-checking + template fallback;
  5. shadow/live mode.
- Use **engineering:testing-strategy** to write `docs/TEST_PLAN.md`, mapping **every** acceptance test in BUILD_PLAN §13 to a concrete test (unit / integration / e2e) and fixture. Include W52 → W53 → W01 and `expected_2026-W43.json`.
- Run **llm-council** on `ARCHITECTURE.md` + `TEST_PLAN.md`: "What must change before we write code?" Apply only fixes that stay inside the locked scope; log the rest in `docs/CHANGES.md` for me.
- **Stop and show me** the architecture, ADRs, test plan and council verdict before coding.

**Step 2: Build, milestone by milestone (BUILD_PLAN §12)**
- Scaffold Next.js (TypeScript strict) + Supabase + Vitest + Playwright. Fill in the Commands section of `CLAUDE.md`.
- Milestone order:
  1. Upload + validation + settings + case-data mode.
  2. **Rules engine**, test-first, until `expected_2026-W43.json` passes exactly.
  3. Zoho read against a **Zoho test org** (ask me for test credentials; use mocks until then).
  4. Replay script.
  5. Triage + review desk + Claude reasons and brief + outcomes.
  6. **Instructions screen** rendering `docs/INSTRUCTIONS.md`, with ⚙ values bound live to Settings.
- **Week-1 must-do:** verify in the Zoho test org that our scope set (no UPDATE/DELETE) **cannot** issue or edit a PO. Record the result in an ADR. If it can, add a code-level guard and flag it to me.
- After each milestone:
  - run **engineering:code-review** on the diff;
  - run all tests;
  - report the exit check from §12;
  - wait for my go-ahead.
- Use **engineering:debug** when a test fails for a non-obvious reason. Don't weaken a test to make it pass.
- For the replay (day-45 gate):
  - use **data:statistical-analysis** to compare weekly-rules vs actual stockout weeks and write-off units, and to calibrate the D6 festival mode and the D8 thresholds;
  - then use **data:validate-data** to QA the method before I see the gate report (`docs/REPLAY_REPORT.md`).
- If the Supabase or Vercel connectors are available, use them for migrations, logs and deploys. Otherwise use the CLIs.

**Step 3: Make it runnable by Freshroots without us**
- Use **operations:runbook** to write `docs/RUNBOOK.md`. Cover:
  - upload rejected or missed;
  - Zoho auth failure or outage;
  - pending or stale drafts;
  - wrong quantity issued;
  - switching shadow → live;
  - rotating the Zoho token;
  - restoring from backup.
- Use **operations:process-doc** to write `docs/WEEKLY_PROCESS.md`: a RACI for the Mon/Tue/procurement/monthly cycle, matching BUILD_PLAN §11.
- Use **operations:risk-assessment** to turn BUILD_PLAN §15 plus anything you discovered into `docs/RISK_REGISTER.md`.
- Use **engineering:deploy-checklist** before the first Vercel deploy.
- Keep `docs/INSTRUCTIONS.md` updated whenever behaviour or defaults change.
- Before go-live, run **llm-council** once more on the working system: "Is this ready to switch from shadow to live?"

**Rules for the whole build**
- **Scope:** BUILD_PLAN v1.2 is locked. For anything not in it, first run **nine-checks-build-decision** on the idea, write a change note in `docs/CHANGES.md`, and ask me.
- **Guardrails in `CLAUDE.md` override convenience,** especially:
  - no Zoho update/delete;
  - one pending draft per supplier;
  - shadow mode by default;
  - the LLM never sets numbers;
  - secrets server-side only.
- **Never invent business data.** Use the D18 defaults and show "assumed".
- **Commit** small with clear messages; never commit `.env.local`.

Start with Step 0 now.

---
