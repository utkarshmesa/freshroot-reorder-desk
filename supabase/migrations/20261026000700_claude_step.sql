-- Milestone 5: run step 7 (Claude reasons + brief) runs after "ready", so a run at "ready" can be claimed
-- again to finish it (ARCHITECTURE §4). "done", "blocked" and "superseded" stay final.
create or replace function public.claim_run(p_run_id uuid, p_seconds int default 240) returns boolean
language sql security definer set search_path = public as $$
  with c as (
    update public.run set locked_until = now() + make_interval(secs => p_seconds), step_attempts = step_attempts + 1
    where id = p_run_id and superseded_by is null and status not in ('done', 'blocked', 'superseded')
      and (locked_until is null or locked_until < now())
    returning 1
  )
  select exists (select 1 from c)
$$;
revoke all on function public.claim_run(uuid, int) from public, anon, authenticated;
