-- Validation reports and staging rows are written only by the server after it validates the files,
-- so an uploader can't forge a clean report through the API. The uploader keeps: read own uploads,
-- and commit_upload() (which re-checks the report and every database-level rule).
drop policy if exists uploader_insert on public.upload;
drop policy if exists uploader_update_own on public.upload;
drop policy if exists staging_rw on public.upload_staging;

-- Everything the validator needs from the database, in one call (role-checked).
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
revoke all on function public.upload_context(text[]) from public, anon;
grant execute on function public.upload_context(text[]) to authenticated;
