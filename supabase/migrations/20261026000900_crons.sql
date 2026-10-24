-- Milestone 5 crons: when the Tuesday rule (D8) was applied to a run, so the noon cron applies it once.
alter table public.run add column if not exists deadline_applied_at timestamptz;

-- Runs from before this milestone count as already past their deadline, so the first noon firing never
-- applies the Tuesday rule to an old week (the noon job also only handles the latest week).
update public.run set deadline_applied_at = coalesce(ready_at, created_at) where deadline_applied_at is null and status in ('ready', 'llm', 'done');
