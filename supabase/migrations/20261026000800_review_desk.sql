-- Milestone 5: decisions, send and drafts (ARCHITECTURE §4.1).

-- The quantity that goes into the supplier's draft: the engine's for auto lines, Raghav's for approved or
-- changed lines, the deadline rule's for deadline_auto lines. Null until a line is settled.
alter table public.recommendation add column if not exists final_qty integer check (final_qty is null or final_qty >= 0);
update public.recommendation set final_qty = qty where line_state = 'auto' and final_qty is null;

-- Shadow runs get one shadow draft row per supplier per week too, so a double-click or the Tuesday cron
-- can't record a supplier twice. Shadow rows still never block live rows (separate partial index).
create unique index if not exists draft_po_supplier_week_shadow on public.draft_po (supplier_id, iso_week) where mode = 'shadow';

-- C-009: a draft not issued within draftStaleDays needs Raghav's re-approval (no Zoho write).
alter table public.draft_po add column if not exists needs_reapproval boolean not null default false;
alter table public.draft_po add column if not exists reapproved_at timestamptz;
alter table public.decision add column if not exists draft_id uuid references public.draft_po (id);

-- Decisions only through decide_line: the state change and the decision row are one transaction, and the
-- update is conditional on the line still being queued (a click after the Tuesday rule gets an error).
drop policy if exists planner_insert on public.decision;

create or replace function public.decide_line(p_rec_id bigint, p_action text, p_final_qty integer default null, p_reason_code text default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.recommendation;
  st text;
  q integer;
begin
  if not public.has_role('planner') then raise exception 'Only the planner can decide cards' using errcode = '42501'; end if;
  if p_action not in ('approve', 'change', 'reject') then raise exception 'Unknown action %', p_action; end if;

  select * into r from public.recommendation where id = p_rec_id for update;
  if not found then raise exception 'Card not found'; end if;
  if not exists (select 1 from public.run where id = r.run_id and superseded_by is null and status in ('ready', 'llm', 'done')) then
    raise exception 'This week''s run was replaced or isn''t ready; reload the desk';
  end if;
  if r.line_state is distinct from 'queued' then
    raise exception 'This card is no longer waiting (state: %). The Tuesday deadline may already have applied to it.', coalesce(r.line_state, 'none');
  end if;

  if p_action = 'approve' then
    st := 'approved';
    q := r.qty;
  elsif p_action = 'change' then
    if p_final_qty is null or p_final_qty <= 0 then raise exception 'A changed quantity must be above 0 (reject the card to order nothing)'; end if;
    if p_reason_code is null then raise exception 'Pick a reason for the change'; end if;
    st := 'changed';
    q := p_final_qty;
  else
    if p_reason_code is null then raise exception 'Pick a reason for the rejection'; end if;
    st := 'rejected';
    q := 0;
  end if;
  if p_reason_code is not null and not exists (select 1 from public.reason_code where code = p_reason_code and active) then
    raise exception 'Unknown reason code %', p_reason_code;
  end if;

  update public.recommendation set line_state = st, final_qty = q where id = p_rec_id and line_state = 'queued';
  insert into public.decision (recommendation_id, status, final_qty, reason_code, note, by)
  values (p_rec_id, st, q, p_reason_code, nullif(trim(p_note), ''), auth.uid());
  return jsonb_build_object('state', st, 'final_qty', q);
end $$;
revoke all on function public.decide_line(bigint, text, integer, text, text) from public, anon;
grant execute on function public.decide_line(bigint, text, integer, text, text) to authenticated;

-- C-009 re-approval: one decision row per line in the draft; clears the flag. No Zoho write.
create or replace function public.reapprove_draft(p_draft_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.draft_po;
begin
  if not public.has_role('planner') then raise exception 'Only the planner can re-approve drafts' using errcode = '42501'; end if;
  select * into d from public.draft_po where id = p_draft_id for update;
  if not found then raise exception 'Draft not found'; end if;
  if not d.needs_reapproval then raise exception 'This draft doesn''t need re-approval'; end if;
  update public.draft_po set needs_reapproval = false, reapproved_at = now() where id = p_draft_id;
  insert into public.decision (recommendation_id, status, final_qty, note, by, draft_id)
  select rec.id, 'reapproved', rec.final_qty, nullif(trim(p_note), ''), auth.uid(), d.id
  from public.recommendation rec
  where rec.run_id = d.run_id and rec.line_state = 'sent' and rec.inputs ->> 'supplierId' = d.supplier_id;
end $$;
revoke all on function public.reapprove_draft(uuid, text) from public, anon;
grant execute on function public.reapprove_draft(uuid, text) to authenticated;

-- One Send at a time per run (planner button and the Tuesday cron can overlap): a row lease like claim_run.
-- Without it two sends could both find no draft for a supplier and both create one.
alter table public.run add column if not exists send_locked_until timestamptz;

create or replace function public.claim_send(p_run_id uuid, p_seconds int default 420) returns boolean
language sql security definer set search_path = public as $$
  with c as (
    update public.run set send_locked_until = now() + make_interval(secs => p_seconds)
    where id = p_run_id and (send_locked_until is null or send_locked_until < now())
    returning 1
  )
  select exists (select 1 from c)
$$;
revoke all on function public.claim_send(uuid, int) from public, anon, authenticated;

create or replace function public.release_send(p_run_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.run set send_locked_until = null where id = p_run_id
$$;
revoke all on function public.release_send(uuid) from public, anon, authenticated;
