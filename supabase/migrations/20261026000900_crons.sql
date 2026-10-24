-- Milestone 5 crons: when the Tuesday rule (D8) was applied to a run, so the noon cron applies it once.
alter table public.run add column if not exists deadline_applied_at timestamptz;
