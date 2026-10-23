# Freshroots Reorder Desk

The weekly replenishment loop for Freshroots: SAP exports (uploaded) and open Zoho POs go through Raghav's rules, then triage, then Raghav's review, then draft POs in Zoho, then outcomes vs manually planned SKUs.

- **For Claude Code:** start with `CLAUDE.md`, then `docs/BUILD_PLAN.md`. The kickoff prompt is in `START_PROMPT.md`.
- **For users:** `docs/INSTRUCTIONS.md` (also shown inside the app).
- **Architecture:** `docs/component-map-v3.png`.

| Folder | Contents |
|---|---|
| `docs/` | Plan, instructions, case context, decision log, component map |
| `data/case/` | Case CSVs (15 SKUs, 2026-W27…W42) |
| `data/reference/` | Expected engine output for 2026-W43 (acceptance test) |
| `prototype/` | Early review-desk prototype (UX reference only) |
