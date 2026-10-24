-- Step 4 stress-test fixes (docs/STRESS_TEST_STEP4.md §1).

-- F2: re-uploading the SKU master no longer wipes values typed in Settings.
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
  -- Stress test F2: a column the file leaves empty keeps the value already in Settings (lead time, MOQ,
  -- shelf life, cost, Zoho item id…). Only the file's own values overwrite. Clearing a value is done in Settings.
  on conflict (id) do update set name = excluded.name, category = coalesce(excluded.category, sku.category), status = excluded.status,
    first_sale_week = coalesce(excluded.first_sale_week, sku.first_sale_week),
    launch_estimate_wk = coalesce(excluded.launch_estimate_wk, sku.launch_estimate_wk), std_qty = excluded.std_qty,
    moq = coalesce(excluded.moq, sku.moq), pack_size = coalesce(excluded.pack_size, sku.pack_size), uom = coalesce(excluded.uom, sku.uom),
    lead_time_wks = coalesce(excluded.lead_time_wks, sku.lead_time_wks), shelf_life_wks = coalesce(excluded.shelf_life_wks, sku.shelf_life_wks),
    perishable = excluded.perishable, unit_cost_inr = coalesce(excluded.unit_cost_inr, sku.unit_cost_inr),
    supplier_id = coalesce(excluded.supplier_id, sku.supplier_id), zoho_item_id = coalesce(excluded.zoho_item_id, sku.zoho_item_id);

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
revoke all on function public.commit_upload(uuid) from public, anon;
grant execute on function public.commit_upload(uuid) to authenticated;
