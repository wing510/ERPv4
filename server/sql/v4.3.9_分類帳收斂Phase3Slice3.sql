-- ERP v4.3.9：Dealer 分類帳收斂 Phase3 slice3【僅 DEV】
-- 前置：v4.3.2 工具函式、v4.3.7 月結 Phase3
-- 建議順序：v4.3.7 → v4.3.8 → 本檔
-- 內容：建 dealer_cumulative_ledger、ledger-first 等級過帳、backfill、sync grant

-- ── 分類帳表（對齊 v4.2.14 草稿 v2.2 + MONTHLY_LEVEL_POST）────────────
create table if not exists dealer_cumulative_ledger (
  ledger_id uuid primary key default gen_random_uuid(),
  customer_id text not null,
  source_type text not null,
  source_id text not null,
  entry_type text not null default 'POST',
  adjustment_id text,
  period_ym text,
  amount numeric not null default 0,
  ar_id text,
  metadata jsonb default '{}'::jsonb,
  remark text,
  created_by text,
  created_at timestamptz not null default now(),
  constraint dealer_cumulative_ledger_entry_type_chk
    check (entry_type in ('POST', 'VOID', 'ADJUSTMENT')),
  constraint dealer_cumulative_ledger_period_ym_chk
    check (
      period_ym is null
      or (period_ym ~ '^\d{4}-(0[1-9]|1[0-2])$')
    )
);

alter table dealer_cumulative_ledger drop constraint if exists dealer_cumulative_ledger_source_type_chk;
alter table dealer_cumulative_ledger add constraint dealer_cumulative_ledger_source_type_chk
  check (source_type in (
    'GENERAL_SHIPMENT',
    'CONSIGNMENT_SETTLEMENT',
    'MONTHLY_REBATE',
    'MONTHLY_STAT',
    'MONTHLY_LEVEL_POST',
    'ADJUSTMENT'
  ));

create unique index if not exists idx_dcl_unique_post
  on dealer_cumulative_ledger (source_type, source_id)
  where entry_type = 'POST';

create unique index if not exists idx_dcl_unique_void
  on dealer_cumulative_ledger (source_type, source_id)
  where entry_type = 'VOID';

create unique index if not exists idx_dcl_unique_adjustment
  on dealer_cumulative_ledger (adjustment_id)
  where entry_type = 'ADJUSTMENT' and adjustment_id is not null;

create index if not exists idx_dcl_customer on dealer_cumulative_ledger (customer_id);
create index if not exists idx_dcl_period on dealer_cumulative_ledger (customer_id, period_ym);

comment on table dealer_cumulative_ledger is
  'Dealer 累積採購分類帳；POST/VOID 各一筆；customer 欄位為快取';

alter table dealer_cumulative_ledger enable row level security;
revoke all on table public.dealer_cumulative_ledger from anon, authenticated;

-- ── 內部：append（不 sync）────────────────────────────────────────
create or replace function public.erp_dealer_ledger_append_(
  p_customer_id text,
  p_source_type text,
  p_source_id text,
  p_entry_type text,
  p_amount numeric,
  p_period_ym text,
  p_ar_id text,
  p_metadata jsonb,
  p_remark text,
  p_actor text,
  p_ts timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_cust text := erp_norm_id(p_customer_id);
  v_stype text := upper(trim(coalesce(p_source_type, '')));
  v_sid text := erp_norm_id(p_source_id);
  v_etype text := upper(trim(coalesce(p_entry_type, 'POST')));
  v_amt numeric := erp_round_money(p_amount);
begin
  if v_cust = '' then raise exception 'ERR_CUSTOMER_REQUIRED'; end if;
  if v_stype = '' then raise exception 'ERR_SOURCE_TYPE_REQUIRED'; end if;
  if v_sid = '' then raise exception 'ERR_SOURCE_ID_REQUIRED'; end if;
  if v_amt = 0 then return null; end if;

  insert into dealer_cumulative_ledger (
    ledger_id, customer_id, source_type, source_id, entry_type,
    period_ym, amount, ar_id, metadata, remark, created_by, created_at
  ) values (
    v_id, v_cust, v_stype, v_sid, v_etype,
    nullif(trim(coalesce(p_period_ym, '')), ''),
    v_amt,
    nullif(erp_norm_id(p_ar_id), ''),
    coalesce(p_metadata, '{}'::jsonb),
    left(trim(coalesce(p_remark, '')), 500),
    trim(coalesce(p_actor, '')),
    coalesce(p_ts, now())
  );

  return v_id;
end;
$$;

revoke all on function public.erp_dealer_ledger_append_(
  text, text, text, text, numeric, text, text, jsonb, text, text, timestamptz
) from public;

-- ── 同步 customer 快取（ledger 為準）──────────────────────────────
create or replace function public.erp_dealer_ledger_sync_customer_(
  p_customer_id text,
  p_actor text,
  p_ts timestamptz default now()
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_total numeric := 0;
begin
  if v_cust = '' then raise exception 'ERR_CUSTOMER_REQUIRED'; end if;
  if not exists (select 1 from customer where customer_id = v_cust) then
    raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust;
  end if;

  select coalesce(sum(amount), 0) into v_total
  from dealer_cumulative_ledger
  where customer_id = v_cust;

  v_total := erp_round_money(v_total);

  update customer
  set dealer_cumulative_amount = v_total,
      updated_by = trim(coalesce(p_actor, '')),
      updated_at = coalesce(p_ts, now())
  where customer_id = v_cust;

  return v_total;
end;
$$;

revoke all on function public.erp_dealer_ledger_sync_customer_(text, text, timestamptz) from public;
grant execute on function public.erp_dealer_ledger_sync_customer_(text, text, timestamptz) to service_role;

-- ── 內部：ledger 寫入（append only；sync 由 caller 負責）────────────
create or replace function public.erp_cc_try_ledger_append_(
  p_customer_id text,
  p_source_type text,
  p_source_id text,
  p_entry_type text,
  p_amount numeric,
  p_period_ym text,
  p_metadata jsonb,
  p_remark text,
  p_actor text,
  p_ts timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regclass('public.dealer_cumulative_ledger') is null then
    return;
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'erp_dealer_ledger_append_'
  ) then
    return;
  end if;
  perform erp_dealer_ledger_append_(
    p_customer_id, p_source_type, p_source_id, p_entry_type, p_amount,
    p_period_ym, null, coalesce(p_metadata, '{}'::jsonb), p_remark, p_actor, p_ts
  );
end;
$$;

-- ── backfill：既有 POSTED 等級過帳 → ledger POST/VOID ───────────────
create or replace function public.erp_dealer_ledger_backfill_level_posts_(
  p_customer_id text default '',
  p_actor text default 'ledger-backfill'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust_filter text := erp_norm_id(p_customer_id);
  v_actor text := trim(coalesce(p_actor, 'ledger-backfill'));
  v_ts timestamptz := now();
  r record;
  v_amt numeric;
  v_posted int := 0;
  v_voided int := 0;
  v_customers text[] := '{}';
begin
  if to_regclass('public.dealer_cumulative_ledger') is null then
    return jsonb_build_object('ok', false, 'reason', 'ledger_table_missing');
  end if;

  for r in
    select *
    from commercial_dealer_level_post
    where upper(trim(coalesce(status, ''))) = 'POSTED'
      and (v_cust_filter = '' or customer_id = v_cust_filter)
    order by period_ym asc, created_at asc
  loop
    v_amt := erp_round_money(
      coalesce(r.cumulative_add_consignment, 0) + coalesce(r.cumulative_add_general, 0)
    );
    if v_amt <= 0.000000001 then continue; end if;
    if exists (
      select 1 from dealer_cumulative_ledger
      where customer_id = r.customer_id
        and source_type = 'MONTHLY_LEVEL_POST'
        and source_id = r.level_post_id
        and entry_type = 'POST'
    ) then
      continue;
    end if;
    perform erp_dealer_ledger_append_(
      r.customer_id, 'MONTHLY_LEVEL_POST', r.level_post_id, 'POST', v_amt,
      trim(coalesce(r.period_ym, '')),
      null,
      jsonb_build_object('backfill', true, 'stat_id', coalesce(r.stat_id, '')),
      'backfill 等級過帳', v_actor, v_ts
    );
    v_posted := v_posted + 1;
    if not (r.customer_id = any(v_customers)) then
      v_customers := array_append(v_customers, r.customer_id);
    end if;
  end loop;

  for r in
    select lp.*
    from commercial_dealer_level_post lp
    where upper(trim(coalesce(lp.status, ''))) = 'VOID'
      and (v_cust_filter = '' or lp.customer_id = v_cust_filter)
    order by lp.updated_at asc nulls last, lp.created_at asc
  loop
    v_amt := erp_round_money(
      coalesce(r.cumulative_add_consignment, 0) + coalesce(r.cumulative_add_general, 0)
    );
    if v_amt <= 0.000000001 then continue; end if;
    if not exists (
      select 1 from dealer_cumulative_ledger
      where customer_id = r.customer_id
        and source_type = 'MONTHLY_LEVEL_POST'
        and source_id = r.level_post_id
        and entry_type = 'POST'
    ) then
      continue;
    end if;
    if exists (
      select 1 from dealer_cumulative_ledger
      where customer_id = r.customer_id
        and source_type = 'MONTHLY_LEVEL_POST'
        and source_id = r.level_post_id
        and entry_type = 'VOID'
    ) then
      continue;
    end if;
    perform erp_dealer_ledger_append_(
      r.customer_id, 'MONTHLY_LEVEL_POST', r.level_post_id, 'VOID', -v_amt,
      trim(coalesce(r.period_ym, '')),
      null,
      jsonb_build_object('backfill', true, 'void_reason', coalesce(r.void_reason, '')),
      'backfill 作廢等級過帳', v_actor, v_ts
    );
    v_voided := v_voided + 1;
    if not (r.customer_id = any(v_customers)) then
      v_customers := array_append(v_customers, r.customer_id);
    end if;
  end loop;

  if array_length(v_customers, 1) is not null then
    foreach v_cust_filter in array v_customers
    loop
      perform erp_dealer_ledger_sync_customer_(v_cust_filter, v_actor, v_ts);
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'posted', v_posted,
    'voided', v_voided,
    'customers_synced', coalesce(array_length(v_customers, 1), 0)
  );
end;
$$;

comment on function public.erp_dealer_ledger_backfill_level_posts_ is
  'v4.3.9：將既有等級過帳補寫入分類帳並 sync 客戶快取';

revoke all on function public.erp_dealer_ledger_backfill_level_posts_(text, text) from public;
grant execute on function public.erp_dealer_ledger_backfill_level_posts_(text, text) to service_role;

-- ── 等級過帳 POST（ledger-first 當分類帳存在）──────────────────────
create or replace function public.erp_cc_post_level_phase3_tx(
  p_level_post_id text,
  p_stat_id text,
  p_customer_id text,
  p_period_ym text,
  p_cumulative_scheme_id text,
  p_billing_net_consignment numeric,
  p_billing_net_general numeric,
  p_billing_net_total numeric,
  p_cumulative_add_consignment numeric,
  p_cumulative_add_general numeric,
  p_cumulative_before numeric,
  p_cumulative_after numeric,
  p_pending_tier_label text,
  p_pending_price_rate numeric,
  p_pending_from_ym text,
  p_expected_cumulative_before numeric,
  p_remark text,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lpid text := erp_norm_id(p_level_post_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_ym text := trim(coalesce(p_period_ym, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_add_total numeric;
  v_cur numeric;
  v_existed record;
  v_customer record;
  v_use_ledger boolean;
begin
  if v_lpid = '' then raise exception 'ERR_LEVEL_POST_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_ym = '' then raise exception 'ERR_PERIOD_YM_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  v_use_ledger := to_regclass('public.dealer_cumulative_ledger') is not null;

  select * into v_existed from commercial_dealer_level_post where level_post_id = v_lpid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' and erp_norm_id(v_existed.customer_id) = v_cust then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'level_post_id', v_lpid, 'level_rpc', true, 'ledger_mode', v_use_ledger
      );
    end if;
    raise exception 'Level post already exists: %', v_lpid;
  end if;

  if exists (
    select 1 from commercial_dealer_level_post
    where customer_id = v_cust and period_ym = v_ym and upper(trim(coalesce(status, ''))) <> 'VOID'
  ) then
    raise exception 'ERR_LEVEL_POST_DUPLICATE_PERIOD';
  end if;

  v_add_total := erp_round_money(
    coalesce(p_cumulative_add_consignment, 0) + coalesce(p_cumulative_add_general, 0)
  );

  select * into v_customer from customer where customer_id = v_cust for update;
  if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;

  if v_use_ledger then
    select coalesce(sum(amount), 0) into v_cur
    from dealer_cumulative_ledger where customer_id = v_cust;
    v_cur := erp_round_money(v_cur);
  else
    v_cur := erp_round_money(coalesce(v_customer.dealer_cumulative_amount, 0));
  end if;

  if abs(v_cur - erp_round_money(coalesce(p_expected_cumulative_before, p_cumulative_before, v_cur))) > 0.02 then
    raise exception 'ERR_CUMULATIVE_CONFLICT: expected=% actual=%', p_expected_cumulative_before, v_cur;
  end if;

  insert into commercial_dealer_level_post (
    level_post_id, stat_id, customer_id, period_ym, cumulative_scheme_id,
    billing_net_consignment, billing_net_general, billing_net_total,
    cumulative_add_consignment, cumulative_add_general,
    cumulative_before, cumulative_after,
    cumulative_pending_tier_label, cumulative_pending_price_rate, cumulative_pending_from_ym,
    status, remark, created_by, created_at, updated_by, updated_at, void_reason, system_remark
  ) values (
    v_lpid, erp_norm_id(p_stat_id), v_cust, v_ym, erp_norm_id(p_cumulative_scheme_id),
    erp_round_money(coalesce(p_billing_net_consignment, 0)),
    erp_round_money(coalesce(p_billing_net_general, 0)),
    erp_round_money(coalesce(p_billing_net_total, 0)),
    erp_round_money(coalesce(p_cumulative_add_consignment, 0)),
    erp_round_money(coalesce(p_cumulative_add_general, 0)),
    coalesce(p_cumulative_before, v_cur),
    coalesce(p_cumulative_after, erp_round_money(v_cur + v_add_total)),
    coalesce(p_pending_tier_label, ''),
    p_pending_price_rate,
    coalesce(p_pending_from_ym, ''),
    'POSTED', coalesce(p_remark, ''),
    v_actor, v_ts, '', null, '', ''
  );

  if v_use_ledger and v_add_total > 0.000000001 then
    perform erp_dealer_ledger_append_(
      v_cust, 'MONTHLY_LEVEL_POST', v_lpid, 'POST', v_add_total, v_ym,
      null,
      jsonb_build_object(
        'stat_id', erp_norm_id(p_stat_id),
        'cumulative_add_consignment', erp_round_money(coalesce(p_cumulative_add_consignment, 0)),
        'cumulative_add_general', erp_round_money(coalesce(p_cumulative_add_general, 0))
      ),
      '經銷等級過帳累積', v_actor, v_ts
    );
    perform erp_dealer_ledger_sync_customer_(v_cust, v_actor, v_ts);
  elsif not v_use_ledger then
    update customer
    set dealer_cumulative_amount = erp_round_money(coalesce(p_cumulative_after, v_cur + v_add_total)),
        updated_by = v_actor,
        updated_at = v_ts
    where customer_id = v_cust;
  end if;

  update customer
  set dealer_cumulative_pending_tier_label = case
        when coalesce(trim(p_pending_tier_label), '') <> '' then trim(p_pending_tier_label)
        else dealer_cumulative_pending_tier_label
      end,
      dealer_cumulative_pending_price_rate = case
        when coalesce(trim(p_pending_tier_label), '') <> '' then p_pending_price_rate
        else dealer_cumulative_pending_price_rate
      end,
      dealer_cumulative_pending_from_ym = case
        when coalesce(trim(p_pending_tier_label), '') <> '' then coalesce(p_pending_from_ym, v_ym)
        else dealer_cumulative_pending_from_ym
      end,
      updated_by = v_actor,
      updated_at = v_ts
  where customer_id = v_cust;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'level_post_id', v_lpid,
    'cumulative_add_total', v_add_total,
    'level_rpc', true,
    'ledger_mode', v_use_ledger
  );
end;
$$;

-- ── 等級過帳 VOID（ledger-first）──────────────────────────────────
create or replace function public.erp_cc_void_level_phase3_tx(
  p_level_post_id text,
  p_void_reason text,
  p_actor text,
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lpid text := erp_norm_id(p_level_post_id);
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_row record;
  v_customer record;
  v_removed numeric;
  v_after numeric;
  v_snap_pending text;
  v_cust_pending text;
  v_use_ledger boolean;
begin
  if v_lpid = '' then raise exception 'ERR_LEVEL_POST_ID_REQUIRED'; end if;
  if v_reason = '' then raise exception 'ERR_VOID_REASON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  v_use_ledger := to_regclass('public.dealer_cumulative_ledger') is not null;

  select * into v_row from commercial_dealer_level_post where level_post_id = v_lpid for update;
  if not found then raise exception 'Level post not found: %', v_lpid; end if;

  if upper(trim(coalesce(v_row.status, ''))) = 'VOID' then
    return jsonb_build_object(
      'ok', true, 'message', 'ALREADY_VOID', 'idempotent', true,
      'level_post_id', v_lpid, 'level_rpc', true, 'ledger_mode', v_use_ledger
    );
  end if;
  if upper(trim(coalesce(v_row.status, ''))) <> 'POSTED' then
    raise exception 'Level post cannot be voided: %', v_lpid;
  end if;

  v_removed := erp_round_money(
    coalesce(v_row.cumulative_add_consignment, 0) + coalesce(v_row.cumulative_add_general, 0)
  );

  if v_removed > 0.000000001 then
    select * into v_customer from customer where customer_id = v_row.customer_id for update;
    if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_row.customer_id; end if;

    v_snap_pending := trim(coalesce(v_row.cumulative_pending_tier_label, ''));
    v_cust_pending := trim(coalesce(v_customer.dealer_cumulative_pending_tier_label, ''));

    if v_use_ledger then
      perform erp_dealer_ledger_append_(
        erp_norm_id(v_row.customer_id), 'MONTHLY_LEVEL_POST', v_lpid, 'VOID', -v_removed,
        trim(coalesce(v_row.period_ym, '')),
        null,
        jsonb_build_object('void_reason', v_reason),
        '作廢經銷等級過帳', v_actor, v_ts
      );
      perform erp_dealer_ledger_sync_customer_(erp_norm_id(v_row.customer_id), v_actor, v_ts);
    else
      v_after := erp_round_money(greatest(0, coalesce(v_customer.dealer_cumulative_amount, 0) - v_removed));
      update customer
      set dealer_cumulative_amount = v_after,
          updated_by = v_actor,
          updated_at = v_ts
      where customer_id = v_row.customer_id;
    end if;

    update customer
    set dealer_cumulative_pending_tier_label = case
          when v_snap_pending <> '' and v_snap_pending = v_cust_pending then '' else dealer_cumulative_pending_tier_label
        end,
        dealer_cumulative_pending_price_rate = case
          when v_snap_pending <> '' and v_snap_pending = v_cust_pending then null else dealer_cumulative_pending_price_rate
        end,
        dealer_cumulative_pending_from_ym = case
          when v_snap_pending <> '' and v_snap_pending = v_cust_pending then '' else dealer_cumulative_pending_from_ym
        end,
        updated_by = v_actor,
        updated_at = v_ts
    where customer_id = v_row.customer_id;
  end if;

  update commercial_dealer_level_post
  set status = 'VOID',
      void_reason = v_reason,
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[作廢 ' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_reason
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where level_post_id = v_lpid;

  return jsonb_build_object(
    'ok', true, 'message', 'VOIDED',
    'level_post_id', v_lpid,
    'cumulative_removed', v_removed,
    'level_rpc', true,
    'ledger_mode', v_use_ledger
  );
end;
$$;

comment on function public.erp_cc_post_level_phase3_tx is
  'v4.3.9：等級過帳 POST；分類帳存在時 ledger-first + sync';
comment on function public.erp_cc_void_level_phase3_tx is
  'v4.3.9：等級過帳 VOID；分類帳存在時 ledger-first + sync';
