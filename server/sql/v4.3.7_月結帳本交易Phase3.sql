-- ERP v4.3.7：月結帳本 Phase3（經銷等級過帳 + 回饋次月折抵）單一 DB transaction【僅 DEV】
-- 前置：v4.2.12 經銷等級過帳表、v4.2.5 月結回饋表、v4.2.9 月結統計表、v4.3.2 工具函式（erp_norm_id / erp_round_money）
-- 選用：v4.2.14 Dealer 累積分類帳（有 ledger 時 RPC 會同步寫入分類帳）
-- 計價／級距／請款淨額仍由 Node 權威計算後傳入（parity）

-- ── 擴充分類帳來源類型（若 ledger 已存在）────────────────────────
do $$
begin
  if to_regclass('public.dealer_cumulative_ledger') is not null then
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
  end if;
end $$;

-- ── 內部：ledger 寫入（表不存在則略過）──────────────────────────
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
  perform erp_dealer_ledger_sync_customer_(p_customer_id, p_actor, p_ts);
end;
$$;

revoke all on function public.erp_cc_try_ledger_append_(
  text, text, text, text, numeric, text, jsonb, text, text, timestamptz
) from public;

-- ── 經銷等級過帳 POST（原子：level_post + 客戶累積）────────────────
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
begin
  if v_lpid = '' then raise exception 'ERR_LEVEL_POST_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_ym = '' then raise exception 'ERR_PERIOD_YM_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_existed from commercial_dealer_level_post where level_post_id = v_lpid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' and erp_norm_id(v_existed.customer_id) = v_cust then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'level_post_id', v_lpid, 'level_rpc', true
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

  v_cur := erp_round_money(coalesce(v_customer.dealer_cumulative_amount, 0));
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
    p_cumulative_before, p_cumulative_after,
    coalesce(p_pending_tier_label, ''),
    p_pending_price_rate,
    coalesce(p_pending_from_ym, ''),
    'POSTED', coalesce(p_remark, ''),
    v_actor, v_ts, '', null, '', ''
  );

  update customer
  set dealer_cumulative_amount = erp_round_money(coalesce(p_cumulative_after, v_cur + v_add_total)),
      dealer_cumulative_pending_tier_label = case
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

  if v_add_total > 0.000000001 then
    perform erp_cc_try_ledger_append_(
      v_cust, 'MONTHLY_LEVEL_POST', v_lpid, 'POST', v_add_total, v_ym,
      jsonb_build_object(
        'stat_id', erp_norm_id(p_stat_id),
        'cumulative_add_consignment', erp_round_money(coalesce(p_cumulative_add_consignment, 0)),
        'cumulative_add_general', erp_round_money(coalesce(p_cumulative_add_general, 0))
      ),
      '經銷等級過帳累積', v_actor, v_ts
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'level_post_id', v_lpid,
    'cumulative_add_total', v_add_total,
    'level_rpc', true
  );
end;
$$;

-- ── 經銷等級過帳 VOID（原子）────────────────────────────────────
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
begin
  if v_lpid = '' then raise exception 'ERR_LEVEL_POST_ID_REQUIRED'; end if;
  if v_reason = '' then raise exception 'ERR_VOID_REASON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_row from commercial_dealer_level_post where level_post_id = v_lpid for update;
  if not found then raise exception 'Level post not found: %', v_lpid; end if;

  if upper(trim(coalesce(v_row.status, ''))) = 'VOID' then
    return jsonb_build_object(
      'ok', true, 'message', 'ALREADY_VOID', 'idempotent', true,
      'level_post_id', v_lpid, 'level_rpc', true
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

    v_after := erp_round_money(greatest(0, coalesce(v_customer.dealer_cumulative_amount, 0) - v_removed));
    v_snap_pending := trim(coalesce(v_row.cumulative_pending_tier_label, ''));
    v_cust_pending := trim(coalesce(v_customer.dealer_cumulative_pending_tier_label, ''));

    update customer
    set dealer_cumulative_amount = v_after,
        dealer_cumulative_pending_tier_label = case
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

    perform erp_cc_try_ledger_append_(
      erp_norm_id(v_row.customer_id), 'MONTHLY_LEVEL_POST', v_lpid, 'VOID', -v_removed,
      trim(coalesce(v_row.period_ym, '')),
      jsonb_build_object('void_reason', v_reason),
      '作廢經銷等級過帳', v_actor, v_ts
    );
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
    'level_rpc', true
  );
end;
$$;

-- ── 月結回饋 POST（CARRY_FORWARD；原子：rebate + 折抵餘額）────────
create or replace function public.erp_cc_post_rebate_cf_phase3_tx(
  p_rebate_json jsonb,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reb_id text;
  v_cust text;
  v_ym text;
  v_mode text;
  v_amt numeric;
  v_balance numeric;
  v_new_bal numeric;
  v_existed record;
begin
  if p_rebate_json is null then raise exception 'ERR_REBATE_JSON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  v_reb_id := erp_norm_id(p_rebate_json ->> 'rebate_id');
  v_cust := erp_norm_id(p_rebate_json ->> 'customer_id');
  v_ym := trim(coalesce(p_rebate_json ->> 'period_ym', ''));
  v_mode := upper(trim(coalesce(p_rebate_json ->> 'settle_mode', '')));
  v_amt := erp_round_money(coalesce((p_rebate_json ->> 'rebate_amount')::numeric, 0));

  if v_reb_id = '' then raise exception 'ERR_REBATE_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_ym = '' then raise exception 'ERR_PERIOD_YM_REQUIRED'; end if;
  if v_mode <> 'CARRY_FORWARD' then
    raise exception 'ERR_SETTLE_MODE_NOT_CF: %', v_mode;
  end if;

  select * into v_existed from commercial_dealer_rebate where rebate_id = v_reb_id;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'rebate_id', v_reb_id, 'rebate_rpc', true
      );
    end if;
    raise exception 'Rebate already exists: %', v_reb_id;
  end if;

  if exists (
    select 1 from commercial_dealer_rebate
    where customer_id = v_cust and period_ym = v_ym and upper(trim(coalesce(status, ''))) <> 'VOID'
  ) then
    raise exception 'ERR_REBATE_DUPLICATE_PERIOD';
  end if;

  insert into commercial_dealer_rebate (
    rebate_id, customer_id, period_ym, scheme_id, scheme_name_snapshot,
    billing_net, billing_net_consignment, billing_net_general,
    gross_settlement, gross_shipment,
    rebate_pct, rebate_amount, tier_snapshot_json,
    settle_mode, status, ar_id, credit_applied,
    remark, created_by, created_at, updated_by, updated_at, system_remark
  ) values (
    v_reb_id, v_cust, v_ym,
    erp_norm_id(p_rebate_json ->> 'scheme_id'),
    coalesce(p_rebate_json ->> 'scheme_name_snapshot', ''),
    erp_round_money(coalesce((p_rebate_json ->> 'billing_net')::numeric, 0)),
    erp_round_money(coalesce((p_rebate_json ->> 'billing_net_consignment')::numeric, 0)),
    erp_round_money(coalesce((p_rebate_json ->> 'billing_net_general')::numeric, 0)),
    erp_round_money(coalesce((p_rebate_json ->> 'gross_settlement')::numeric, 0)),
    erp_round_money(coalesce((p_rebate_json ->> 'gross_shipment')::numeric, 0)),
    coalesce((p_rebate_json ->> 'rebate_pct')::numeric, 0),
    v_amt,
    coalesce(p_rebate_json ->> 'tier_snapshot_json', ''),
    'CARRY_FORWARD', 'POSTED', '', 0,
    coalesce(p_rebate_json ->> 'remark', ''),
    v_actor, v_ts, '', null, ''
  );

  if v_amt > 0.000000001 then
    select coalesce(dealer_rebate_credit_balance, 0) into v_balance
    from customer where customer_id = v_cust for update;
    if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;

    v_new_bal := erp_round_money(v_balance + v_amt);
    update customer
    set dealer_rebate_credit_balance = v_new_bal,
        updated_by = v_actor,
        updated_at = v_ts
    where customer_id = v_cust;

    update commercial_dealer_rebate
    set credit_applied = v_amt,
        updated_by = v_actor,
        updated_at = v_ts
    where rebate_id = v_reb_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'rebate_id', v_reb_id,
    'rebate_amount', v_amt,
    'credit_applied', v_amt,
    'rebate_rpc', true
  );
end;
$$;

-- ── 月結回饋 VOID（CARRY_FORWARD；原子）──────────────────────────
create or replace function public.erp_cc_void_rebate_cf_phase3_tx(
  p_rebate_id text,
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
  v_reb_id text := erp_norm_id(p_rebate_id);
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reb record;
  v_amt numeric;
  v_balance numeric;
begin
  if v_reb_id = '' then raise exception 'ERR_REBATE_ID_REQUIRED'; end if;
  if v_reason = '' then raise exception 'ERR_VOID_REASON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_reb from commercial_dealer_rebate where rebate_id = v_reb_id for update;
  if not found then raise exception 'Rebate not found: %', v_reb_id; end if;

  if upper(trim(coalesce(v_reb.status, ''))) = 'VOID' then
    return jsonb_build_object(
      'ok', true, 'message', 'ALREADY_VOID', 'idempotent', true,
      'rebate_id', v_reb_id, 'rebate_rpc', true
    );
  end if;
  if upper(trim(coalesce(v_reb.status, ''))) <> 'POSTED' then
    raise exception 'Rebate cannot be voided: %', v_reb_id;
  end if;
  if upper(trim(coalesce(v_reb.settle_mode, ''))) <> 'CARRY_FORWARD' then
    raise exception 'ERR_VOID_CF_ONLY: settle_mode=%', v_reb.settle_mode;
  end if;

  v_amt := erp_round_money(coalesce(v_reb.rebate_amount, v_reb.credit_applied, 0));

  if v_amt > 0.000000001 then
    select coalesce(dealer_rebate_credit_balance, 0) into v_balance
    from customer where customer_id = v_reb.customer_id for update;
    if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_reb.customer_id; end if;
    if v_balance + 0.000000001 < v_amt then
      raise exception 'ERR_CREDIT_BALANCE_INSUFFICIENT: balance=% need=%', v_balance, v_amt;
    end if;
    update customer
    set dealer_rebate_credit_balance = erp_round_money(v_balance - v_amt),
        updated_by = v_actor,
        updated_at = v_ts
    where customer_id = v_reb.customer_id;
  end if;

  update commercial_dealer_rebate
  set status = 'VOID',
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[作廢 ' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_reason
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where rebate_id = v_reb_id;

  return jsonb_build_object(
    'ok', true, 'message', 'VOIDED',
    'rebate_id', v_reb_id,
    'rebate_rpc', true
  );
end;
$$;

comment on function public.erp_cc_post_level_phase3_tx is 'v4.3.7 Phase3：經銷等級過帳 POST 原子（level_post + 客戶累積）';
comment on function public.erp_cc_void_level_phase3_tx is 'v4.3.7 Phase3：經銷等級過帳 VOID 原子';
comment on function public.erp_cc_post_rebate_cf_phase3_tx is 'v4.3.7 Phase3：月結回饋 CARRY_FORWARD POST 原子';
comment on function public.erp_cc_void_rebate_cf_phase3_tx is 'v4.3.7 Phase3：月結回饋 CARRY_FORWARD VOID 原子';

revoke all on function public.erp_cc_post_level_phase3_tx(
  text, text, text, text, text, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, text, numeric, text, numeric, text, text, timestamptz
) from public;
grant execute on function public.erp_cc_post_level_phase3_tx(
  text, text, text, text, text, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, text, numeric, text, numeric, text, text, timestamptz
) to service_role;

revoke all on function public.erp_cc_void_level_phase3_tx(text, text, text, timestamptz) from public;
grant execute on function public.erp_cc_void_level_phase3_tx(text, text, text, timestamptz) to service_role;

revoke all on function public.erp_cc_post_rebate_cf_phase3_tx(jsonb, text, timestamptz) from public;
grant execute on function public.erp_cc_post_rebate_cf_phase3_tx(jsonb, text, timestamptz) to service_role;

revoke all on function public.erp_cc_void_rebate_cf_phase3_tx(text, text, text, timestamptz) from public;
grant execute on function public.erp_cc_void_rebate_cf_phase3_tx(text, text, text, timestamptz) to service_role;
