-- ERP v4.2.14 遷移步驟 0【草稿 v2.2】：Dealer 累積分類帳
-- ⚠ 草稿 v2.2：尚未在 Supabase 正式執行
-- v2.2：VOID 僅信 ledger；月結回饋由 rebate 明細拆項計算；started_at 改 date 解析

-- ── 分類帳表 ─────────────────────────────────────────────────
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
  constraint dealer_cumulative_ledger_source_type_chk
    check (source_type in (
      'GENERAL_SHIPMENT',
      'CONSIGNMENT_SETTLEMENT',
      'MONTHLY_REBATE',
      'MONTHLY_STAT',
      'ADJUSTMENT'
    )),
  constraint dealer_cumulative_ledger_period_ym_chk
    check (
      period_ym is null
      or (
        period_ym ~ '^\d{4}-(0[1-9]|1[0-2])$'
      )
    )
);

-- POST／VOID：每來源各一筆；ADJUSTMENT 可多筆
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
  'Dealer 累積採購分類帳 v2；POST/VOID 各一筆；ADJUSTMENT 可多筆';

alter table dealer_cumulative_ledger enable row level security;
revoke all on table public.dealer_cumulative_ledger from anon, authenticated;

-- 防止重複作廢出貨庫存異動
create unique index if not exists idx_inv_mv_shipment_cancel
  on inventory_movement (ref_id)
  where upper(trim(ref_type)) = 'SHIPMENT_CANCEL';

-- ── 內部 helper（不 grant execute）──────────────────────────────
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

-- ── 方案資格（對齊 commercial-dealer.js）────────────────────────
create or replace function public.erp_scheme_stat_source_allows_(
  p_stat_source text,
  p_channel text
)
returns boolean
language sql
immutable
as $$
  select case upper(trim(coalesce(p_stat_source, 'CONSIGNMENT')))
    when 'ALL' then true
    else upper(trim(coalesce(p_stat_source, 'CONSIGNMENT'))) = upper(trim(coalesce(p_channel, 'CONSIGNMENT')))
  end;
$$;

create or replace function public.erp_scheme_overlaps_date_(
  p_date_from date,
  p_date_to date,
  p_ymd date
)
returns boolean
language sql
immutable
as $$
  select p_date_from is not null
    and p_date_to is not null
    and p_ymd is not null
    and p_ymd >= p_date_from
    and p_ymd <= p_date_to;
$$;

create or replace function public.erp_parse_date_ymd_(p_text text)
returns date
language plpgsql
immutable
as $$
declare
  v_raw text := left(trim(coalesce(p_text, '')), 10);
  v_d date;
begin
  if v_raw = '' then
    return null;
  end if;
  if v_raw !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'ERR_INVALID_DATE: %', p_text;
  end if;
  begin
    v_d := v_raw::date;
  exception when others then
    raise exception 'ERR_INVALID_DATE: %', p_text;
  end;
  return v_d;
end;
$$;

revoke all on function public.erp_parse_date_ymd_(text) from public;

create or replace function public.erp_dealer_general_cumulative_eligible_(
  p_customer_id text,
  p_ship_date date
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_customer record;
  v_scheme record;
  v_started date;
begin
  if v_cust = '' or p_ship_date is null then
    return false;
  end if;

  select * into v_customer from customer where customer_id = v_cust;
  if not found then
    return false;
  end if;

  if coalesce(trim(v_customer.dealer_cumulative_scheme_id), '') = '' then
    return false;
  end if;

  v_started := erp_parse_date_ymd_(v_customer.dealer_cumulative_started_at);
  if v_started is not null and p_ship_date < v_started then
    return false;
  end if;

  select * into v_scheme
  from commercial_dealer_scheme
  where scheme_id = erp_norm_id(v_customer.dealer_cumulative_scheme_id);

  if not found then
    return false;
  end if;
  if upper(trim(coalesce(v_scheme.scheme_type, ''))) <> 'CUMULATIVE_AMOUNT' then
    return false;
  end if;
  if upper(trim(coalesce(v_scheme.status, ''))) <> 'ACTIVE' then
    return false;
  end if;
  if not erp_scheme_stat_source_allows_(v_scheme.stat_source, 'GENERAL') then
    return false;
  end if;
  if not erp_scheme_overlaps_date_(v_scheme.date_from, v_scheme.date_to, p_ship_date) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.erp_scheme_stat_source_allows_(text, text) from public;
revoke all on function public.erp_scheme_overlaps_date_(date, date, date) from public;
revoke all on function public.erp_dealer_general_cumulative_eligible_(text, date) from public;

-- ── 同步 customer 快取 ────────────────────────────────────────
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
  v_exists boolean;
begin
  if v_cust = '' then raise exception 'ERR_CUSTOMER_REQUIRED'; end if;

  select exists(select 1 from customer where customer_id = v_cust) into v_exists;
  if not v_exists then
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

-- ── 月結回饋累積入帳金額（對齊 resolveBillingNetForCumulativeOnRebate_）──
create or replace function public.erp_dealer_rebate_ledger_amount_(p_rebate_id text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reb_id text := erp_norm_id(p_rebate_id);
  v_reb record;
  v_stat_source text;
begin
  if v_reb_id = '' then
    raise exception 'ERR_REBATE_ID_REQUIRED';
  end if;

  select
    r.rebate_id,
    coalesce(r.billing_net_general, 0) as billing_net_general,
    coalesce(r.billing_net_consignment, 0) as billing_net_consignment,
    coalesce(r.billing_net, 0) as billing_net,
    s.stat_source
  into v_reb
  from commercial_dealer_rebate r
  left join customer c on c.customer_id = r.customer_id
  left join commercial_dealer_scheme s
    on s.scheme_id = erp_norm_id(c.dealer_cumulative_scheme_id)
  where r.rebate_id = v_reb_id;

  if not found then
    raise exception 'ERR_REBATE_NOT_FOUND: %', v_reb_id;
  end if;

  v_stat_source := upper(trim(coalesce(v_reb.stat_source, 'CONSIGNMENT')));

  if v_stat_source = 'GENERAL' then
    return 0;
  elsif v_stat_source = 'ALL' then
    return erp_round_money(v_reb.billing_net_consignment);
  else
    return erp_round_money(v_reb.billing_net);
  end if;
end;
$$;

-- ── 作廢前：確認 ledger VOID 狀態（僅信 ledger，不看 AR 欄位）────
create or replace function public.erp_dealer_ledger_assert_void_general_ready_(
  p_customer_id text,
  p_shipment_id text
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_ship text := erp_norm_id(p_shipment_id);
  v_has_post boolean;
  v_has_void boolean;
begin
  if v_cust = '' or v_ship = '' then
    return;
  end if;

  select exists(
    select 1 from dealer_cumulative_ledger
    where customer_id = v_cust
      and source_type = 'GENERAL_SHIPMENT'
      and source_id = v_ship
      and entry_type = 'POST'
  ) into v_has_post;

  if not v_has_post then
    return;
  end if;

  select exists(
    select 1 from dealer_cumulative_ledger
    where customer_id = v_cust
      and source_type = 'GENERAL_SHIPMENT'
      and source_id = v_ship
      and entry_type = 'VOID'
  ) into v_has_void;

  if v_has_void then
    return;
  end if;
end;
$$;

revoke all on function public.erp_dealer_rebate_ledger_amount_(text) from public;
revoke all on function public.erp_dealer_ledger_assert_void_general_ready_(text, text) from public;

-- ── 一般出貨 POST（須在 transaction 內呼叫）────────────────────
create or replace function public.erp_dealer_ledger_post_general_shipment(
  p_customer_id text,
  p_shipment_id text,
  p_ar_id text,
  p_ship_date date,
  p_billing_net numeric,
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
  v_ship text := erp_norm_id(p_shipment_id);
  v_ar text := erp_norm_id(p_ar_id);
  v_net numeric := erp_round_money(p_billing_net);
  v_ym text;
  v_customer record;
begin
  if v_cust = '' or v_ship = '' or v_net <= 0 then
    return 0;
  end if;

  select * into v_customer from customer where customer_id = v_cust for update;
  if not found then
    raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust;
  end if;

  if not erp_dealer_general_cumulative_eligible_(v_cust, p_ship_date) then
    return 0;
  end if;

  v_ym := to_char(p_ship_date, 'YYYY-MM');

  perform erp_dealer_ledger_append_(
    v_cust, 'GENERAL_SHIPMENT', v_ship, 'POST', v_net, v_ym,
    v_ar, jsonb_build_object('ship_date', p_ship_date::text),
    '一般出貨過帳', p_actor, p_ts
  );

  perform erp_dealer_ledger_sync_customer_(v_cust, p_actor, p_ts);

  if v_ar <> '' then
    update ar_receivable
    set dealer_cumulative_added = v_net,
        updated_by = trim(coalesce(p_actor, '')),
        updated_at = coalesce(p_ts, now())
    where ar_id = v_ar;
  end if;

  return v_net;
end;
$$;

-- ── 一般出貨 VOID：鎖原 POST，自動 -POST.amount（僅信 ledger）────────
create or replace function public.erp_dealer_ledger_void_general_shipment(
  p_customer_id text,
  p_shipment_id text,
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
  v_ship text := erp_norm_id(p_shipment_id);
  v_post record;
  v_void_exists boolean;
begin
  if v_cust = '' or v_ship = '' then
    return 0;
  end if;

  select * into v_post
  from dealer_cumulative_ledger
  where customer_id = v_cust
    and source_type = 'GENERAL_SHIPMENT'
    and source_id = v_ship
    and entry_type = 'POST'
  for update;

  if not found then
    return 0;
  end if;

  select exists(
    select 1 from dealer_cumulative_ledger
    where customer_id = v_cust
      and source_type = 'GENERAL_SHIPMENT'
      and source_id = v_ship
      and entry_type = 'VOID'
  ) into v_void_exists;

  if v_void_exists then
    return 0;
  end if;

  perform erp_dealer_ledger_append_(
    v_cust, 'GENERAL_SHIPMENT', v_ship, 'VOID', -erp_round_money(v_post.amount),
    v_post.period_ym, v_post.ar_id,
    jsonb_build_object('reverses_ledger_id', v_post.ledger_id::text),
    '作廢出貨反向沖銷', p_actor, p_ts
  );

  perform erp_dealer_ledger_sync_customer_(v_cust, p_actor, p_ts);
  return erp_round_money(v_post.amount);
end;
$$;

-- ── 月結回饋 POST：由 rebate 明細拆項計算（不依 caller 總額）────────
create or replace function public.erp_dealer_ledger_post_monthly_rebate(
  p_customer_id text,
  p_rebate_id text,
  p_period_ym text,
  p_cumulative_amount numeric default null,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_reb text := erp_norm_id(p_rebate_id);
  v_ym text := trim(coalesce(p_period_ym, ''));
  v_amt numeric;
  v_general numeric;
  v_consignment numeric;
  v_reb_row record;
begin
  if v_cust = '' or v_reb = '' then
    return jsonb_build_object('skipped', true, 'reason', 'missing_ids');
  end if;

  select
    coalesce(billing_net_general, 0) as billing_net_general,
    coalesce(billing_net_consignment, 0) as billing_net_consignment
  into v_reb_row
  from commercial_dealer_rebate
  where rebate_id = v_reb and customer_id = v_cust;

  if not found then
    raise exception 'ERR_REBATE_NOT_FOUND: %', v_reb;
  end if;

  v_general := erp_round_money(v_reb_row.billing_net_general);
  v_consignment := erp_round_money(v_reb_row.billing_net_consignment);
  v_amt := erp_dealer_rebate_ledger_amount_(v_reb);

  if p_cumulative_amount is not null
     and abs(erp_round_money(p_cumulative_amount) - v_amt) > 0.01 then
    raise exception 'ERR_REBATE_CUMULATIVE_MISMATCH: db=% caller=%', v_amt, p_cumulative_amount;
  end if;

  if v_amt <= 0 then
    return jsonb_build_object(
      'skipped', true,
      'reason', 'zero_cumulative',
      'billing_net_general', v_general,
      'billing_net_consignment', v_consignment,
      'ledger_amount', 0
    );
  end if;

  if v_ym = '' then
    raise exception 'ERR_PERIOD_YM_REQUIRED';
  end if;

  perform erp_dealer_ledger_append_(
    v_cust, 'MONTHLY_REBATE', v_reb, 'POST', v_amt, v_ym,
    null,
    jsonb_build_object(
      'period_ym', v_ym,
      'billing_net_general', v_general,
      'billing_net_consignment', v_consignment,
      'ledger_amount', v_amt
    ),
    '月結回饋累積', p_actor, p_ts
  );

  perform erp_dealer_ledger_sync_customer_(v_cust, p_actor, p_ts);

  return jsonb_build_object(
    'cumulative_added', v_amt,
    'billing_net_general', v_general,
    'billing_net_consignment', v_consignment,
    'ledger_amount', v_amt
  );
end;
$$;

comment on function public.erp_dealer_ledger_post_general_shipment is
  'v4.2.14 草稿 v2.2：一般出貨 POST；ledger 為準；AR 欄位為快照';
comment on function public.erp_dealer_ledger_void_general_shipment is
  'v4.2.14 草稿 v2.2：VOID 僅信 ledger POST；不依 AR 欄位';
comment on function public.erp_dealer_ledger_post_monthly_rebate is
  'v4.2.14 草稿 v2.2：月結回饋由 rebate 拆項計算；GENERAL 已在出貨 ledger';

revoke all on function public.erp_dealer_ledger_sync_customer_(text, text, timestamptz) from public;
revoke all on function public.erp_dealer_ledger_post_general_shipment(text, text, text, date, numeric, text, timestamptz) from public;
revoke all on function public.erp_dealer_ledger_void_general_shipment(text, text, text, timestamptz) from public;
revoke all on function public.erp_dealer_ledger_post_monthly_rebate(text, text, text, numeric, text, timestamptz) from public;

grant execute on function public.erp_dealer_rebate_ledger_amount_(text) to service_role;
grant execute on function public.erp_dealer_ledger_assert_void_general_ready_(text, text) to service_role;
grant execute on function public.erp_dealer_ledger_post_general_shipment(text, text, text, date, numeric, text, timestamptz) to service_role;
grant execute on function public.erp_dealer_ledger_void_general_shipment(text, text, text, timestamptz) to service_role;
grant execute on function public.erp_dealer_ledger_post_monthly_rebate(text, text, text, numeric, text, timestamptz) to service_role;
