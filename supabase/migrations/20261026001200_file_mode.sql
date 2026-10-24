-- C-039 Zoho failsafe (file mode). A week whose Zoho read failed (or with no Zoho connection) can run on an open-PO
-- file instead, by an explicit owner action. In live mode its Send records per-supplier PO sheets (mode 'file')
-- instead of Zoho drafts; procurement confirms each as placed. The default stays fail-closed.

alter table public.run add column if not exists source text not null default 'zoho' check (source in ('zoho', 'file'));

alter table public.draft_po drop constraint if exists draft_po_mode_check;
alter table public.draft_po add constraint draft_po_mode_check check (mode in ('shadow', 'live', 'file'));
-- One sheet per supplier per week, like live drafts. 'created' = sheet sent, waiting; 'issued' = placed.
create unique index if not exists draft_po_supplier_week_file on public.draft_po (supplier_id, iso_week) where mode = 'file';
alter table public.draft_po add column if not exists placed_by uuid;

-- Owner only (Deepa, D17). Called only by the server (service role) after it has checked the owner's session and
-- parsed and validated the files itself (review M5b #10: a client must never hand the database its own position).
-- Refused while a worker holds the run (#2), once the queue exists, or once anything was sent this week (#1).
create or replace function public.use_file_mode(p_run_id uuid, p_doc jsonb, p_reason text, p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.run;
begin
  if not exists (select 1 from public.app_user where user_id = p_actor and is_owner) then
    raise exception 'Only the owner (Deepa) can run a week from files' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason (why Zoho can''t be used this week)'; end if;
  select * into r from public.run where id = p_run_id for update;
  if not found then raise exception 'Run not found'; end if;
  if r.superseded_by is not null then raise exception 'This run was replaced by a newer one'; end if;
  if r.locked_until is not null and r.locked_until > now() then
    raise exception 'The system is working on this run right now (retrying Zoho); try again in a minute';
  end if;
  if r.ready_at is not null or exists (select 1 from public.draft_po d where d.iso_week = r.iso_week and d.mode in ('live', 'file')) then
    raise exception 'This week already has its queue or sent orders; files can only replace Zoho before the position is read';
  end if;
  if not (r.status in ('queued', 'readback', 'zoho_read', 'mapping')
          or (r.status = 'blocked' and coalesce(r.error ->> 'reason', '') like 'zoho%')) then
    raise exception 'Files can replace Zoho only before the week''s position is read, or when Zoho blocked the run (this run is %)', r.status;
  end if;
  update public.run
     set source = 'file', zoho_read = p_doc, status = 'engine', error = null, step_attempts = 0
   where id = p_run_id;
  insert into public.change_log (entity, entity_id, field, old, new, by, reason)
  values ('run', r.iso_week, 'source', to_jsonb('zoho'::text), to_jsonb('file'::text), p_actor, trim(p_reason));
end $$;
revoke all on function public.use_file_mode(uuid, jsonb, text, uuid) from public, anon, authenticated;

-- Procurement (or the planner) confirms a sheet was placed with the supplier. The one write procurement has in the
-- app (C-039 note to C-013). It never touches Zoho.
create or replace function public.confirm_placed(p_draft_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.draft_po;
begin
  if not (public.has_role('procurement') or public.has_role('planner')) then raise exception 'Only procurement or the planner can confirm an order was placed' using errcode = '42501'; end if;
  select * into d from public.draft_po where id = p_draft_id for update;
  if not found then raise exception 'Sheet not found'; end if;
  if d.mode <> 'file' then raise exception 'Only file-mode PO sheets are confirmed here; Zoho drafts are read back from Zoho'; end if;
  if d.status <> 'created' then raise exception 'This sheet is already %', case d.status when 'issued' then 'confirmed as placed' else d.status end; end if;
  if d.needs_reapproval then raise exception 'This sheet is more than the allowed days old: Raghav must re-approve it before it is placed'; end if;
  update public.draft_po set status = 'issued', issued_at = now(), placed_by = auth.uid() where id = p_draft_id;
  insert into public.change_log (entity, entity_id, field, old, new, by, reason)
  values ('draft_po', d.reference, 'status', to_jsonb('created'::text), to_jsonb('placed'::text), auth.uid(), 'Placed with the supplier (file mode)');
end $$;
revoke all on function public.confirm_placed(uuid) from public, anon;
grant execute on function public.confirm_placed(uuid) to authenticated;
