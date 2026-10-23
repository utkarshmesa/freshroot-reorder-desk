-- Freshroots Reorder Desk: core schema (BUILD_PLAN §6, ARCHITECTURE §3).
-- RLS is enabled on every table in 20261026000200_rls.sql.

-- ---------- helpers ----------
create or replace function public.is_iso_week(label text) returns boolean
language sql immutable as $$
  select case
    when label is null or label !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' then false
    else to_char(to_date(substr(label, 1, 4) || '-' || substr(label, 7, 2) || '-1', 'IYYY-IW-ID'), 'IYYY-"W"IW') = label
  end
$$;

create or replace function public.iso_week_monday(label text) returns date
language sql immutable as $$
  select to_date(substr(label, 1, 4) || '-' || substr(label, 7, 2) || '-1', 'IYYY-IW-ID')
$$;

create or replace function public.iso_week_of(d date) returns text
language sql immutable as $$ select to_char(d, 'IYYY-"W"IW') $$;

-- ---------- people ----------
create table public.app_user (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  roles text[] not null default '{}'
    check (roles <@ array['uploader', 'planner', 'procurement', 'admin', 'viewer']::text[]),
  is_owner boolean not null default false,
  backup_for text,
  backup_from date,
  backup_to date
);

-- ---------- master data ----------
create table public.supplier (
  id text primary key,
  name text not null,
  zoho_vendor_id text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.sku (
  id text primary key,
  name text not null,
  category text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  first_sale_week text check (first_sale_week is null or public.is_iso_week(first_sale_week)),
  launch_estimate_wk numeric check (launch_estimate_wk is null or launch_estimate_wk >= 0),
  std_qty integer not null check (std_qty > 0),
  moq integer check (moq is null or moq > 0),
  pack_size integer check (pack_size is null or pack_size > 0),
  uom text,
  lead_time_wks numeric check (lead_time_wks is null or lead_time_wks >= 0),
  shelf_life_wks numeric check (shelf_life_wks is null or shelf_life_wks > 0),
  perishable boolean not null default false,
  unit_cost_inr numeric check (unit_cost_inr is null or unit_cost_inr >= 0),
  supplier_id text references public.supplier (id),
  zoho_item_id text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.distributor (
  id text primary key,
  name text not null,
  region text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  start_week text check (start_week is null or public.is_iso_week(start_week)),
  end_week text check (end_week is null or public.is_iso_week(end_week))
);

create table public.event (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('festival', 'hold')),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  sku_ids text[] not null default '{}',
  distributor_ids text[] not null default '{}',
  uplift_pct numeric check (uplift_pct is null or uplift_pct >= 0),
  preload_wks integer not null default 3 check (preload_wks >= 0),
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index event_festival_unique on public.event (start_date, end_date) where type = 'festival';

create table public.rule_version (
  id bigint generated always as identity primary key,
  params jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  is_current boolean not null default false
);
create unique index rule_version_one_current on public.rule_version (is_current) where is_current;

create table public.change_log (
  id bigint generated always as identity primary key,
  entity text not null,
  entity_id text not null,
  field text not null,
  old jsonb,
  new jsonb,
  by uuid,
  by_label text,
  at timestamptz not null default now(),
  reason text
);
create index change_log_entity on public.change_log (entity, entity_id, at desc);

create table public.holdout (
  sku_id text primary key references public.sku (id),
  added_by uuid,
  added_at timestamptz not null default now()
);

create table public.app_mode (
  id boolean primary key default true check (id),
  mode text not null default 'shadow' check (mode in ('shadow', 'live')),
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table public.app_setting (
  id boolean primary key default true check (id),
  zoho_accounts_domain text not null default 'https://accounts.zoho.in',
  zoho_api_domain text not null default 'https://www.zohoapis.in',
  alert_recipients jsonb not null default '{}'::jsonb
);

create table public.reason_code (
  code text primary key,
  label text not null,
  active boolean not null default true,
  sort integer not null default 0
);

create table public.zoho_token_cache (
  id boolean primary key default true check (id),
  access_token text not null,
  expires_at timestamptz not null
);

-- ---------- uploads and facts ----------
create table public.upload (
  id uuid primary key default gen_random_uuid(),
  files text[] not null default '{}',
  hashes text[] not null default '{}',
  kinds text[] not null default '{}',
  as_of_ts timestamptz,
  weeks text[] not null default '{}',
  status text not null default 'staged' check (status in ('staged', 'rejected', 'committed')),
  validation_report jsonb not null default '{}'::jsonb,
  case_data boolean not null default false,
  by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

-- A file hash can be committed only once (UP-01, enforced in the database too).
create table public.upload_hash (
  hash text primary key,
  upload_id uuid not null references public.upload (id)
);

create table public.upload_staging (
  id bigint generated always as identity primary key,
  upload_id uuid not null references public.upload (id) on delete cascade,
  kind text not null check (kind in ('sales', 'stock', 'sku', 'distributor', 'supplier', 'festival')),
  row jsonb not null
);
create index upload_staging_upload on public.upload_staging (upload_id, kind);

create table public.sales_fact (
  sku_id text not null references public.sku (id),
  distributor_id text not null references public.distributor (id),
  iso_week text not null check (public.is_iso_week(iso_week)),
  shipped_units integer not null check (shipped_units >= 0),
  returns_units integer not null default 0 check (returns_units >= 0),
  ordered_units integer check (ordered_units is null or ordered_units >= 0),
  upload_id uuid not null references public.upload (id),
  primary key (sku_id, distributor_id, iso_week)
);
create index sales_fact_week on public.sales_fact (iso_week);

create table public.stock_snapshot (
  sku_id text not null references public.sku (id),
  as_of_ts timestamptz not null,
  on_hand_units integer not null check (on_hand_units >= 0),
  upload_id uuid not null references public.upload (id),
  primary key (sku_id, as_of_ts)
);

-- 3-year history for the replay; loaded by scripts/replay with COPY (C-023g).
create table public.backfill_sales (
  sku_id text not null,
  distributor_id text not null,
  iso_week text not null check (public.is_iso_week(iso_week)),
  shipped_units integer not null,
  returns_units integer not null default 0,
  ordered_units integer,
  primary key (sku_id, distributor_id, iso_week)
);

-- ---------- runs, recommendations, decisions, drafts ----------
create table public.run (
  id uuid primary key default gen_random_uuid(),
  iso_week text not null check (public.is_iso_week(iso_week)),
  upload_id uuid references public.upload (id),
  rule_version_id bigint references public.rule_version (id),
  mode text not null default 'shadow' check (mode in ('shadow', 'live')),
  zoho_read jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'zoho_read', 'mapping', 'readback', 'engine', 'triage', 'ready', 'llm', 'done', 'blocked', 'superseded')),
  locked_until timestamptz,
  step_attempts integer not null default 0,
  error jsonb,
  spot_check_seed bigint,
  superseded_by uuid references public.run (id) deferrable initially deferred,
  created_at timestamptz not null default now(),
  ready_at timestamptz
);
create unique index run_one_current_per_week on public.run (iso_week) where superseded_by is null;

create table public.recommendation (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.run (id) on delete cascade,
  sku_id text not null references public.sku (id),
  action text not null check (action in ('reorder', 'pause', 'none', 'blocked')),
  qty integer not null default 0 check (qty >= 0),
  cover numeric,
  cover_after numeric,
  flags text[] not null default '{}',
  top_distributors jsonb,
  reason_text text,
  reason_source text check (reason_source in ('llm', 'template')),
  triage text not null
    check (triage in ('auto', 'queue', 'spotcheck', 'deadline_auto', 'rolled', 'none', 'info_no_open_po')),
  line_state text
    check (line_state in ('auto', 'queued', 'approved', 'changed', 'rejected', 'deadline_auto', 'rolled', 'sent', 'blocked_pending', 'held_changed')),
  inputs jsonb not null default '{}'::jsonb,
  assumed text[] not null default '{}',
  holdout boolean not null default false,
  days_to_stockout numeric,
  unique (run_id, sku_id)
);

create table public.decision (
  id bigint generated always as identity primary key,
  recommendation_id bigint not null references public.recommendation (id) on delete cascade,
  status text not null check (status in ('approved', 'changed', 'rejected', 'reapproved')),
  final_qty integer check (final_qty is null or final_qty >= 0),
  reason_code text references public.reason_code (code),
  note text,
  by uuid not null default auth.uid(),
  at timestamptz not null default now()
);

create table public.draft_po (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.run (id),
  supplier_id text not null references public.supplier (id),
  iso_week text not null check (public.is_iso_week(iso_week)),
  mode text not null check (mode in ('shadow', 'live')),
  reference text not null,
  zoho_po_id text,
  status text not null
    check (status in ('creating', 'created', 'issued', 'edited', 'deleted', 'skipped_pending', 'shadow')),
  requested_lines jsonb not null default '[]'::jsonb,
  issued_lines jsonb,
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  last_read_at timestamptz
);
-- Shadow rows never block live rows (C-015/ADR-0005).
create unique index draft_po_reference_live on public.draft_po (reference) where mode = 'live';
create unique index draft_po_supplier_week_live on public.draft_po (supplier_id, iso_week) where mode = 'live';

create table public.brief (
  run_id uuid primary key references public.run (id) on delete cascade,
  text text not null,
  checked boolean not null default false,
  source text not null check (source in ('llm', 'template'))
);

create table public.alert (
  id bigint generated always as identity primary key,
  kind text not null,
  dedupe_key text not null unique,
  run_id uuid references public.run (id),
  "to" text[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
