-- Stock snapshots for the engine as one JSON document per SKU batch (review finding 1: a plain select
-- of 27 weeks × all SKUs passes PostgREST's 1,000-row page and silently drops rows). Service role only.
create or replace function public.engine_stock(p_sku_ids text[], p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(sku_id, rows), '{}'::jsonb)
  from (
    select sku_id, jsonb_agg(jsonb_build_array(as_of_ts, on_hand_units) order by as_of_ts) as rows
    from public.stock_snapshot
    where sku_id = any (p_sku_ids) and as_of_ts >= p_from and as_of_ts <= p_to
    group by sku_id
  ) t
$$;
revoke all on function public.engine_stock(text[], timestamptz, timestamptz) from public, anon, authenticated;
