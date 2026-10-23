-- Milestone 2: what the run worker needs to feed the engine and store its output.

alter table public.recommendation add column if not exists spot_check boolean not null default false;
-- Spot-checks are a marker on auto items (C-028b); the triage value stays 'auto'.

-- One compact JSON document per SKU (ARCHITECTURE §3.3): avoids PostgREST's 1,000-row pages.
-- Selects only; all cleaning stays in the pure engine. Service role only.
create or replace function public.engine_inputs(p_sku_ids text[], p_from_week text, p_to_week text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(sku_id, rows), '{}'::jsonb)
  from (
    select sku_id, jsonb_agg(jsonb_build_array(distributor_id, iso_week, shipped_units, returns_units) order by iso_week, distributor_id) as rows
    from public.sales_fact
    where sku_id = any (p_sku_ids) and iso_week >= p_from_week and iso_week <= p_to_week
    group by sku_id
  ) t
$$;
revoke all on function public.engine_inputs(text[], text, text) from public, anon, authenticated;

-- Row lease so the cron safety net and the commit trigger never run the same step twice (ARCHITECTURE §4).
create or replace function public.claim_run(p_run_id uuid, p_seconds int default 240) returns boolean
language sql security definer set search_path = public as $$
  with c as (
    update public.run set locked_until = now() + make_interval(secs => p_seconds), step_attempts = step_attempts + 1
    where id = p_run_id and superseded_by is null and status not in ('done', 'blocked', 'superseded', 'ready')
      and (locked_until is null or locked_until < now())
    returning 1
  )
  select exists (select 1 from c)
$$;
revoke all on function public.claim_run(uuid, int) from public, anon, authenticated;

create or replace function public.release_run(p_run_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.run set locked_until = null where id = p_run_id
$$;
revoke all on function public.release_run(uuid) from public, anon, authenticated;

alter table public.run add column if not exists notes text[] not null default '{}';
