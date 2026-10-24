-- Admin "Retry run" (ARCHITECTURE §4; RUNBOOK). After IT fixes the cause, a blocked run restarts:
--  - blocked before the queue existed (no ready_at): from the beginning, attempts reset;
--  - blocked after (e.g. ZO-14 at Send): back to "done", so the queue and Raghav's decisions are kept.
-- Logged in change_log with the admin's reason.
create or replace function public.retry_run(p_run_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare
  r public.run;
  st text;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can retry a run' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason (what was fixed)'; end if;
  select * into r from public.run where id = p_run_id for update;
  if not found then raise exception 'Run not found'; end if;
  if r.superseded_by is not null then raise exception 'This run was replaced by a newer one'; end if;
  if r.status <> 'blocked' then raise exception 'Only a blocked run can be retried (this one is %)', r.status; end if;

  st := case when r.ready_at is null then 'queued' else 'done' end;
  update public.run
     set status = st, error = null, locked_until = null, send_locked_until = null,
         step_attempts = case when st = 'queued' then 0 else step_attempts end
   where id = p_run_id;
  insert into public.change_log (entity, entity_id, field, old, new, by, reason)
  values ('run', r.iso_week, 'status', to_jsonb(r.status), to_jsonb(st), auth.uid(), trim(p_reason));
  return st;
end $$;
revoke all on function public.retry_run(uuid, text) from public, anon;
grant execute on function public.retry_run(uuid, text) to authenticated;
