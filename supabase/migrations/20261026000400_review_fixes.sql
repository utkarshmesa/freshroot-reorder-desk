-- Fixes from the Milestone 1 code review.

-- 1. People: no direct writes. Admin changes go through RPCs that never touch is_owner and
--    refuse changes to the caller's own roles (keeps approver ≠ issuer, D19). is_owner is set
--    only by the service role (IT runbook), never through the API.
drop policy if exists admin_write on public.app_user;

create or replace function public.admin_set_user(p_user_id uuid, p_name text, p_roles text[], p_backup_for text, p_backup_from date, p_backup_to date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old text[];
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change people' using errcode = '42501'; end if;
  select roles into v_old from public.app_user where user_id = p_user_id;
  if not found then raise exception 'No such person'; end if;
  if p_user_id = auth.uid() and v_old is distinct from p_roles then
    raise exception 'You can''t change your own roles; ask another admin' using errcode = '42501';
  end if;
  update public.app_user
  set name = p_name, roles = p_roles, backup_for = p_backup_for, backup_from = p_backup_from, backup_to = p_backup_to
  where user_id = p_user_id;
end $$;

create or replace function public.admin_add_user(p_user_id uuid, p_email text, p_name text, p_roles text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can add people' using errcode = '42501'; end if;
  if p_user_id = auth.uid() then raise exception 'You can''t add yourself' using errcode = '42501'; end if;
  insert into public.app_user (user_id, email, name, roles, is_owner) values (p_user_id, p_email, p_name, p_roles, false);
end $$;

revoke all on function public.admin_set_user(uuid, text, text[], text, date, date) from public, anon;
grant execute on function public.admin_set_user(uuid, text, text[], text, date, date) to authenticated;
revoke all on function public.admin_add_user(uuid, text, text, text[]) from public, anon;
grant execute on function public.admin_add_user(uuid, text, text, text[]) to authenticated;

-- 9. Role-checked reads, no PUBLIC execute on definer functions, validated rule shape, Zoho host allowlist.
create or replace function public.current_rules() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Not a member' using errcode = '42501'; end if;
  return (select jsonb_build_object('id', id, 'params', params, 'created_at', created_at, 'reason', reason)
          from public.rule_version where is_current);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.current_rules()', 'public.has_role(text)', 'public.is_owner()', 'public.is_member()', 'public.current_actor()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- Same keys and JSON types as the reference document, recursively (values may differ).
create or replace function public.jsonb_same_shape(a jsonb, b jsonb) returns boolean
language plpgsql immutable as $$
declare k text;
begin
  if jsonb_typeof(a) is distinct from jsonb_typeof(b) then return false; end if;
  if jsonb_typeof(a) <> 'object' then return true; end if;
  if (select array_agg(x order by x) from jsonb_object_keys(a) x) is distinct from (select array_agg(x order by x) from jsonb_object_keys(b) x) then
    return false;
  end if;
  for k in select jsonb_object_keys(a) loop
    if not public.jsonb_same_shape(a -> k, b -> k) then return false; end if;
  end loop;
  return true;
end $$;

create or replace function public.publish_rule_version(p_params jsonb, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_old jsonb;
begin
  if not public.has_role('planner') then raise exception 'Only the planner can change rules' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for every rule change (D12)'; end if;
  select params into v_old from public.rule_version where is_current;
  if v_old is not null and not public.jsonb_same_shape(p_params, v_old) then
    raise exception 'Rule parameters must have the same fields and types as the current version';
  end if;
  update public.rule_version set is_current = false where is_current;
  insert into public.rule_version (params, reason, created_by, is_current) values (p_params, p_reason, auth.uid(), true) returning id into v_id;
  insert into public.change_log (entity, entity_id, field, old, new, by, reason)
  values ('rule_version', v_id::text, 'params', v_old, p_params, auth.uid(), p_reason);
  return v_id;
end $$;

alter table public.app_setting
  add constraint zoho_accounts_domain_allowed check (zoho_accounts_domain ~ '^https://accounts\.zoho\.(in|com|eu|com\.au|jp|com\.cn|sa|ca)$'),
  add constraint zoho_api_domain_allowed check (zoho_api_domain ~ '^https://www\.zohoapis\.(in|com|eu|com\.au|jp|com\.cn|sa|ca)$');

-- 3 + 4. Runs: a same-week re-run keeps the week's mode and rule version (C-023c, D12), and a sales
--        restatement that feeds the current run supersedes it (ARCHITECTURE §4.2).
create or replace function public.supersede_or_start_run(p_week text, p_upload uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old public.run;
  v_new uuid := gen_random_uuid();
begin
  select * into v_old from public.run where iso_week = p_week and superseded_by is null for update;
  if found then
    update public.run set status = 'superseded', superseded_by = v_new where id = v_old.id;
  end if;
  insert into public.run (id, iso_week, upload_id, rule_version_id, mode, spot_check_seed)
  values (v_new, p_week, p_upload,
          coalesce(v_old.rule_version_id, (select id from public.rule_version where is_current)),
          coalesce(v_old.mode, (select mode from public.app_mode)),
          coalesce(v_old.spot_check_seed, (floor(random() * 2147483647))::bigint));
  return jsonb_build_object('run_id', v_new, 'superseded_run', v_old.id);
end $$;
revoke all on function public.supersede_or_start_run(text, uuid) from public, anon, authenticated;

create or replace function public.commit_upload(p_upload_id uuid) returns jsonb
language plpgsql security definer set search_path = public
set statement_timeout = '120s' as $$
declare
  u public.upload;
  v_last_asof timestamptz;
  v_latest_week text;
  v_run_week text;
  v_run jsonb;
  v_current_run_week text;
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

  insert into public.upload_hash (hash, upload_id) select unnest(u.hashes), u.id;

  v_window := coalesce((select (params ->> 'restatementWindowWks')::int from public.rule_version where is_current), 12);

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
         (r ->> 'unit_cost_inr')::numeric, nullif(r ->> 'supplier_id', ''), r ->> 'zoho_item_id'
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

  if exists (select 1 from public.upload_staging where upload_id = u.id and kind = 'stock') then
    select max(as_of_ts) into v_last_asof from public.stock_snapshot;
    if v_last_asof is not null and u.as_of_ts < v_last_asof then
      raise exception 'Stock as-of % is older than the last committed snapshot %', u.as_of_ts, v_last_asof;
    end if;

    insert into public.stock_snapshot (sku_id, as_of_ts, on_hand_units, upload_id)
    select r ->> 'sku_id', (r ->> 'as_of_ts')::timestamptz, (r ->> 'on_hand_units')::int, u.id
    from public.upload_staging s, lateral (select s.row as r) x where s.upload_id = u.id and s.kind = 'stock'
    on conflict (sku_id, as_of_ts) do update set on_hand_units = excluded.on_hand_units, upload_id = excluded.upload_id;

    v_run_week := public.iso_week_of(((u.as_of_ts at time zone 'Asia/Kolkata')::date + 1));
    v_run := public.supersede_or_start_run(v_run_week, u.id);
  elsif v_restated is not null then
    -- Sales corrections for weeks before the current run's week feed that run: redo it.
    select iso_week into v_current_run_week from public.run where superseded_by is null order by iso_week desc limit 1;
    if v_current_run_week is not null and exists (select 1 from unnest(v_restated) w where w < v_current_run_week) then
      v_run_week := v_current_run_week;
      v_run := public.supersede_or_start_run(v_run_week, u.id);
    end if;
  end if;

  delete from public.upload_staging where upload_id = u.id;
  update public.upload set status = 'committed', committed_at = now() where id = u.id;

  return jsonb_build_object('upload_id', u.id, 'run_id', v_run ->> 'run_id', 'run_week', v_run_week,
                            'restated_weeks', coalesce(to_jsonb(v_restated), '[]'::jsonb), 'superseded_run', v_run ->> 'superseded_run');
end $$;

-- upload_context also returns the current run's week so the report can say a correction re-runs it.
create or replace function public.upload_context(p_hashes text[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_latest text;
begin
  if not (public.has_role('uploader') or public.has_role('admin')) then
    raise exception 'Only an uploader can prepare uploads' using errcode = '42501';
  end if;
  select max(iso_week) into v_latest from public.sales_fact;
  return jsonb_build_object(
    'latest_committed_week', v_latest,
    'current_run_week', (select max(iso_week) from public.run where superseded_by is null),
    'last_as_of', (select to_jsonb(max(as_of_ts)) from public.stock_snapshot),
    'previous_week_net_units', (select sum(shipped_units - returns_units) from public.sales_fact where iso_week = v_latest),
    'committed_hashes', coalesce((select jsonb_agg(hash) from public.upload_hash where hash = any (p_hashes)), '[]'::jsonb),
    'sku_ids', coalesce((select jsonb_agg(id) from public.sku), '[]'::jsonb),
    'active_sku_ids', coalesce((select jsonb_agg(id) from public.sku where status = 'active'), '[]'::jsonb),
    'distributor_ids', coalesce((select jsonb_agg(id) from public.distributor), '[]'::jsonb),
    'supplier_ids', coalesce((select jsonb_agg(id) from public.supplier), '[]'::jsonb),
    'rules', (select params from public.rule_version where is_current)
  );
end $$;
