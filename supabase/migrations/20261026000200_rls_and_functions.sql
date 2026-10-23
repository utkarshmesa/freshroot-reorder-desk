-- RLS per role (D19, ARCHITECTURE §3.2) and the RPCs that own multi-step writes (§3.3).

-- ---------- role helpers: security definer so they don't recurse through app_user's RLS ----------
create or replace function public.has_role(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where user_id = auth.uid() and r = any (roles))
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where user_id = auth.uid() and is_owner and 'admin' = any (roles))
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where user_id = auth.uid() and cardinality(roles) > 0)
$$;

-- Actor for change_log: the signed-in user, or an explicit actor set by server-side code (service role).
create or replace function public.current_actor() returns uuid
language sql stable as $$
  select coalesce(auth.uid(), nullif(current_setting('app.actor', true), '')::uuid)
$$;

-- ---------- change_log trigger (append-only audit, D12) ----------
create or replace function public.log_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  n jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  k text;
  pk text := coalesce(n ->> tg_argv[0], o ->> tg_argv[0]);
  why text := nullif(current_setting('app.reason', true), '');
begin
  for k in select jsonb_object_keys(o || n) loop
    continue when k in ('updated_at', 'updated_by', 'changed_at', 'changed_by', 'created_at', 'created_by');
    if (o -> k) is distinct from (n -> k) then
      insert into public.change_log (entity, entity_id, field, old, new, by, reason)
      values (tg_table_name, pk, k, o -> k, n -> k, public.current_actor(), why);
    end if;
  end loop;
  return coalesce(new, old);
end $$;

create trigger sku_log after insert or update or delete on public.sku for each row execute function public.log_changes('id');
create trigger distributor_log after insert or update or delete on public.distributor for each row execute function public.log_changes('id');
create trigger supplier_log after insert or update or delete on public.supplier for each row execute function public.log_changes('id');
create trigger event_log after insert or update or delete on public.event for each row execute function public.log_changes('id');
create trigger holdout_log after insert or delete on public.holdout for each row execute function public.log_changes('sku_id');
create trigger app_mode_log after update on public.app_mode for each row execute function public.log_changes('id');
create trigger app_setting_log after update on public.app_setting for each row execute function public.log_changes('id');
create trigger reason_code_log after insert or update or delete on public.reason_code for each row execute function public.log_changes('code');
create trigger app_user_log after insert or update or delete on public.app_user for each row execute function public.log_changes('user_id');

create or replace function public.touch_updated() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := public.current_actor();
  return new;
end $$;
create trigger sku_touch before insert or update on public.sku for each row execute function public.touch_updated();
create trigger supplier_touch before insert or update on public.supplier for each row execute function public.touch_updated();

-- ---------- enable RLS everywhere ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- policies (ARCHITECTURE §3.2) ----------
-- Members read master data, rules, events, change log, reason codes, mode.
create policy members_read on public.sku for select to authenticated using (public.is_member());
create policy members_read on public.distributor for select to authenticated using (public.is_member());
create policy members_read on public.supplier for select to authenticated using (public.is_member());
create policy members_read on public.event for select to authenticated using (public.is_member());
create policy members_read on public.rule_version for select to authenticated using (public.is_member());
create policy members_read on public.change_log for select to authenticated using (public.is_member());
create policy members_read on public.reason_code for select to authenticated using (public.is_member());
create policy members_read on public.holdout for select to authenticated using (public.is_member());
create policy members_read on public.app_mode for select to authenticated using (public.is_member());

-- Master data: planner and admin write (procurement read-only, C-013).
create policy planner_admin_write on public.sku for insert to authenticated with check (public.has_role('planner') or public.has_role('admin'));
create policy planner_admin_update on public.sku for update to authenticated using (public.has_role('planner') or public.has_role('admin')) with check (public.has_role('planner') or public.has_role('admin'));
create policy planner_admin_write on public.distributor for insert to authenticated with check (public.has_role('planner') or public.has_role('admin'));
create policy planner_admin_update on public.distributor for update to authenticated using (public.has_role('planner') or public.has_role('admin')) with check (public.has_role('planner') or public.has_role('admin'));
create policy planner_admin_write on public.supplier for insert to authenticated with check (public.has_role('planner') or public.has_role('admin'));
create policy planner_admin_update on public.supplier for update to authenticated using (public.has_role('planner') or public.has_role('admin')) with check (public.has_role('planner') or public.has_role('admin'));

-- Festivals and holds: planner.
create policy planner_write on public.event for insert to authenticated with check (public.has_role('planner'));
create policy planner_update on public.event for update to authenticated using (public.has_role('planner')) with check (public.has_role('planner'));
create policy planner_delete on public.event for delete to authenticated using (public.has_role('planner'));

-- Reason codes and settings: admin.
create policy admin_write on public.reason_code for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy admin_read on public.app_setting for select to authenticated using (public.has_role('admin'));
create policy admin_update on public.app_setting for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- People: everyone sees their own row; admin manages all.
create policy self_read on public.app_user for select to authenticated using (user_id = auth.uid() or public.has_role('admin'));
create policy admin_write on public.app_user for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- Uploads: uploader creates and reads own; planner/admin read all. Staging rows follow their upload.
create policy uploader_insert on public.upload for insert to authenticated with check (public.has_role('uploader') and by = auth.uid());
create policy upload_read on public.upload for select to authenticated
  using ((public.has_role('uploader') and by = auth.uid()) or public.has_role('planner') or public.has_role('admin'));
create policy uploader_update_own on public.upload for update to authenticated
  using (public.has_role('uploader') and by = auth.uid() and status = 'staged')
  with check (public.has_role('uploader') and by = auth.uid() and status in ('staged', 'rejected'));
create policy staging_rw on public.upload_staging for all to authenticated
  using (exists (select 1 from public.upload u where u.id = upload_id and u.by = auth.uid() and u.status = 'staged') and public.has_role('uploader'))
  with check (exists (select 1 from public.upload u where u.id = upload_id and u.by = auth.uid() and u.status = 'staged') and public.has_role('uploader'));

-- Facts: read by uploader, planner, procurement, admin. Writes only via commit_upload().
create policy facts_read on public.sales_fact for select to authenticated
  using (public.has_role('uploader') or public.has_role('planner') or public.has_role('procurement') or public.has_role('admin'));
create policy facts_read on public.stock_snapshot for select to authenticated
  using (public.has_role('uploader') or public.has_role('planner') or public.has_role('procurement') or public.has_role('admin'));

-- Runs and outputs: written by the service role only.
create policy members_read on public.run for select to authenticated using (public.is_member());
create policy outputs_read on public.recommendation for select to authenticated
  using (public.has_role('planner') or public.has_role('procurement') or public.has_role('admin') or public.has_role('viewer'));
create policy outputs_read on public.draft_po for select to authenticated
  using (public.has_role('planner') or public.has_role('procurement') or public.has_role('admin') or public.has_role('viewer'));
create policy outputs_read on public.brief for select to authenticated
  using (public.has_role('planner') or public.has_role('procurement') or public.has_role('admin') or public.has_role('viewer'));
create policy outputs_read on public.decision for select to authenticated
  using (public.has_role('planner') or public.has_role('procurement') or public.has_role('admin') or public.has_role('viewer'));
create policy planner_insert on public.decision for insert to authenticated with check (public.has_role('planner') and by = auth.uid());
create policy admin_read on public.alert for select to authenticated using (public.has_role('admin'));
-- upload_hash, backfill_sales, zoho_token_cache: no policies => service role only.

-- ---------- RPCs ----------
create or replace function public.current_rules() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'params', params, 'created_at', created_at, 'reason', reason)
  from public.rule_version where is_current
$$;

create or replace function public.publish_rule_version(p_params jsonb, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_old jsonb;
begin
  if not public.has_role('planner') then raise exception 'Only the planner can change rules' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for every rule change (D12)'; end if;
  select params into v_old from public.rule_version where is_current;
  update public.rule_version set is_current = false where is_current;
  insert into public.rule_version (params, reason, created_by, is_current) values (p_params, p_reason, auth.uid(), true) returning id into v_id;
  insert into public.change_log (entity, entity_id, field, old, new, by, reason)
  values ('rule_version', v_id::text, 'params', v_old, p_params, auth.uid(), p_reason);
  return v_id;
end $$;

create or replace function public.set_mode(p_mode text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Only the owner (Deepa) can switch mode (D17)' using errcode = '42501'; end if;
  if p_mode not in ('shadow', 'live') then raise exception 'Unknown mode %', p_mode; end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  update public.app_mode set mode = p_mode, changed_by = auth.uid(), changed_at = now();
end $$;

create or replace function public.set_holdout(p_sku_ids text[], p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Only the owner (Deepa) can change the holdout list' using errcode = '42501'; end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  delete from public.holdout where sku_id <> all (p_sku_ids);
  insert into public.holdout (sku_id, added_by) select unnest(p_sku_ids), auth.uid() on conflict do nothing;
end $$;

-- Planner/admin edits of master data with a logged reason.
create or replace function public.set_change_reason(p_reason text) returns void
language sql as $$ select set_config('app.reason', coalesce(p_reason, ''), true) $$;

-- All-or-nothing commit of a validated upload (BUILD_PLAN §7, ARCHITECTURE §3.3).
create or replace function public.commit_upload(p_upload_id uuid) returns jsonb
language plpgsql security definer set search_path = public
set statement_timeout = '120s' as $$
declare
  u public.upload;
  v_last_asof timestamptz;
  v_latest_week text;
  v_run_week text;
  v_old_run uuid;
  v_new_run uuid;
  v_restated text[];
  v_locked text[];
  v_window int;
begin
  if not public.has_role('uploader') then raise exception 'Only an uploader can commit' using errcode = '42501'; end if;

  select * into u from public.upload where id = p_upload_id for update;
  if not found or u."by" <> auth.uid() then raise exception 'Upload not found'; end if;
  if u.status <> 'staged' then raise exception 'Upload is %, not staged', u.status; end if;
  if coalesce((u.validation_report ->> 'errors')::int, 1) > 0 then
    raise exception 'Upload has validation errors; nothing committed';
  end if;
  if coalesce((u.validation_report ->> 'unconfirmed')::int, 1) > 0 then
    raise exception 'Upload has items that need a Confirm; nothing committed';
  end if;

  -- Duplicate file (UP-01): the unique key rejects a hash committed before.
  insert into public.upload_hash (hash, upload_id) select unnest(u.hashes), u.id;

  v_window := coalesce((select (params ->> 'restatementWindowWks')::int from public.rule_version where is_current), 12);

  -- Masters first (unknown IDs in the same upload become known).
  insert into public.supplier (id, name)
  select r ->> 'id', r ->> 'name'
  from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'supplier'
  on conflict (id) do update set name = excluded.name;

  insert into public.distributor (id, name, region, status, start_week, end_week)
  select r ->> 'id', r ->> 'name', r ->> 'region', coalesce(r ->> 'status', 'active'), r ->> 'start_week', r ->> 'end_week'
  from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'distributor'
  on conflict (id) do update set name = excluded.name, region = excluded.region, status = excluded.status,
    start_week = excluded.start_week, end_week = excluded.end_week;

  insert into public.sku (id, name, category, status, first_sale_week, launch_estimate_wk, std_qty, moq, pack_size, uom,
                          lead_time_wks, shelf_life_wks, perishable, unit_cost_inr, supplier_id, zoho_item_id)
  select r ->> 'id', r ->> 'name', r ->> 'category', coalesce(r ->> 'status', 'active'), r ->> 'first_sale_week',
         (r ->> 'launch_estimate_wk')::numeric, (r ->> 'std_qty')::int, (r ->> 'moq')::int, (r ->> 'pack_size')::int, r ->> 'uom',
         (r ->> 'lead_time_wks')::numeric, (r ->> 'shelf_life_wks')::numeric, (r ->> 'perishable')::boolean,
         (r ->> 'unit_cost_inr')::numeric, r ->> 'supplier_id', r ->> 'zoho_item_id'
  from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'sku'
  on conflict (id) do update set name = excluded.name, category = excluded.category, status = excluded.status,
    first_sale_week = excluded.first_sale_week, launch_estimate_wk = excluded.launch_estimate_wk, std_qty = excluded.std_qty,
    moq = excluded.moq, pack_size = excluded.pack_size, uom = excluded.uom, lead_time_wks = excluded.lead_time_wks,
    shelf_life_wks = excluded.shelf_life_wks, perishable = excluded.perishable, unit_cost_inr = excluded.unit_cost_inr,
    supplier_id = excluded.supplier_id, zoho_item_id = excluded.zoho_item_id;

  insert into public.event (type, start_date, end_date, uplift_pct, preload_wks, reason, created_by)
  select 'festival', (r ->> 'start_date')::date, (r ->> 'end_date')::date, (r ->> 'uplift_pct')::numeric,
         coalesce((r ->> 'preload_wks')::int, 3), r ->> 'reason', auth.uid()
  from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'festival'
  on conflict do nothing;

  -- Sales: restatements allowed only inside the window (D14); logged.
  select max(iso_week) into v_latest_week from public.sales_fact;
  if v_latest_week is not null then
    select array_agg(distinct s.row ->> 'iso_week' order by s.row ->> 'iso_week') into v_locked
    from public.upload_staging s
    where s.upload_id = u.id and s.kind = 'sales'
      and public.iso_week_monday(s.row ->> 'iso_week') < public.iso_week_monday(v_latest_week) - (v_window - 1) * 7;
    if v_locked is not null then
      raise exception 'Restatement older than % weeks is locked: %', v_window, array_to_string(v_locked, ', ');
    end if;

    select array_agg(distinct s.row ->> 'iso_week' order by s.row ->> 'iso_week') into v_restated
    from public.upload_staging s
    where s.upload_id = u.id and s.kind = 'sales' and s.row ->> 'iso_week' <= v_latest_week;

    insert into public.change_log (entity, entity_id, field, old, new, by, reason)
    select 'sales_fact', f.sku_id || '|' || f.distributor_id || '|' || f.iso_week, 'shipped_units,returns_units,ordered_units',
           jsonb_build_array(f.shipped_units, f.returns_units, f.ordered_units),
           jsonb_build_array((s.row ->> 'shipped_units')::int, (s.row ->> 'returns_units')::int, (s.row ->> 'ordered_units')::int),
           auth.uid(), 'restatement in upload ' || u.id
    from public.upload_staging s
    join public.sales_fact f on f.sku_id = s.row ->> 'sku_id' and f.distributor_id = s.row ->> 'distributor_id' and f.iso_week = s.row ->> 'iso_week'
    where s.upload_id = u.id and s.kind = 'sales';
  end if;

  insert into public.sales_fact (sku_id, distributor_id, iso_week, shipped_units, returns_units, ordered_units, upload_id)
  select r ->> 'sku_id', r ->> 'distributor_id', r ->> 'iso_week', (r ->> 'shipped_units')::int,
         coalesce((r ->> 'returns_units')::int, 0), (r ->> 'ordered_units')::int, u.id
  from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'sales'
  on conflict (sku_id, distributor_id, iso_week) do update set shipped_units = excluded.shipped_units,
    returns_units = excluded.returns_units, ordered_units = excluded.ordered_units, upload_id = excluded.upload_id;

  -- Stock: older as-of rejected; equal = correction of the current week (C-023d).
  if exists (select 1 from public.upload_staging where upload_id = u.id and kind = 'stock') then
    select max(as_of_ts) into v_last_asof from public.stock_snapshot;
    if v_last_asof is not null and u.as_of_ts < v_last_asof then
      raise exception 'Stock as-of % is older than the last committed snapshot %', u.as_of_ts, v_last_asof;
    end if;

    insert into public.stock_snapshot (sku_id, as_of_ts, on_hand_units, upload_id)
    select r ->> 'sku_id', (r ->> 'as_of_ts')::timestamptz, (r ->> 'on_hand_units')::int, u.id
    from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'stock'
    on conflict (sku_id, as_of_ts) do update set on_hand_units = excluded.on_hand_units, upload_id = excluded.upload_id;

    -- The run is for the week after the snapshot's Sunday.
    v_run_week := public.iso_week_of(((u.as_of_ts at time zone 'Asia/Kolkata')::date + 1));
    -- A correction for the same week supersedes the current run (§4.2). The FK is deferred,
    -- so the old run can point at the new id before the new row exists.
    v_new_run := gen_random_uuid();
    update public.run set status = 'superseded', superseded_by = v_new_run
    where iso_week = v_run_week and superseded_by is null
    returning id into v_old_run;
    insert into public.run (id, iso_week, upload_id, rule_version_id, mode, spot_check_seed)
    select v_new_run, v_run_week, u.id, (select id from public.rule_version where is_current),
           (select mode from public.app_mode), (floor(random() * 2147483647))::bigint;
  end if;

  delete from public.upload_staging where upload_id = u.id;
  update public.upload set status = 'committed', committed_at = now() where id = u.id;

  return jsonb_build_object('upload_id', u.id, 'run_id', v_new_run, 'run_week', v_run_week,
                            'restated_weeks', coalesce(to_jsonb(v_restated), '[]'::jsonb), 'superseded_run', v_old_run);
end $$;

revoke all on function public.commit_upload(uuid) from public, anon;
grant execute on function public.commit_upload(uuid) to authenticated;
revoke all on function public.publish_rule_version(jsonb, text) from public, anon;
grant execute on function public.publish_rule_version(jsonb, text) to authenticated;
revoke all on function public.set_mode(text, text) from public, anon;
grant execute on function public.set_mode(text, text) to authenticated;
revoke all on function public.set_holdout(text[], text) from public, anon;
grant execute on function public.set_holdout(text[], text) to authenticated;

-- Storage: private bucket for raw upload files, readable/writable by the uploader who owns the upload folder.
insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false) on conflict do nothing;
create policy uploads_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and public.has_role('uploader'));
create policy uploads_read on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (owner = auth.uid() or public.has_role('admin')));
