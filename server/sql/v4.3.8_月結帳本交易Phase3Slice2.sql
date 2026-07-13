-- ERP v4.3.8：月結帳本 Phase3 slice2（回饋折讓 CREDIT_NOTE + 作廢本月月結 cascade）【僅 DEV】
-- 前置：v4.3.7_月結帳本交易Phase3.sql、v4.3.3 AR 調整冪等鍵、v4.3.4 erp_ar_sum_valid_payments_
-- 計價／折讓分配仍由 Node 權威計算後傳入（parity）

-- ── 內部：單筆 AR 折讓（冪等鍵 MONTHLY_REBATE_CN + rebate_id:ar_id）────────
create or replace function public.erp_cc_apply_rebate_cn_ar_cut_(
  p_rebate_id text,
  p_ar_id text,
  p_amount_before numeric,
  p_amount_after numeric,
  p_reason text,
  p_actor text,
  p_ts timestamptz
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reb_id text := erp_norm_id(p_rebate_id);
  v_ar_id text := erp_norm_id(p_ar_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_src_type text := 'MONTHLY_REBATE_CN';
  v_src_id text;
  v_before numeric;
  v_after numeric;
  v_received numeric;
  v_cut numeric;
  v_due numeric;
begin
  if v_reb_id = '' then raise exception 'ERR_REBATE_ID_REQUIRED'; end if;
  if v_ar_id = '' then raise exception 'ERR_AR_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  v_src_id := v_reb_id || ':' || v_ar_id;
  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = v_src_type and source_id = v_src_id
  ) then
    return erp_round_money(greatest(0, coalesce(p_amount_before, 0) - coalesce(p_amount_after, 0)));
  end if;

  v_before := erp_round_money(coalesce(p_amount_before, 0));
  v_after := erp_round_money(coalesce(p_amount_after, 0));
  v_cut := erp_round_money(greatest(0, v_before - v_after));
  if v_cut <= 0.000000001 then return 0; end if;

  select coalesce(amount_due, 0) into v_due
  from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id; end if;
  v_due := erp_round_money(v_due);
  if abs(v_due - v_before) > 0.02 then
    raise exception 'ERR_AR_DUE_MISMATCH: ar=% expected=% actual=%', v_ar_id, v_before, v_due;
  end if;

  v_received := erp_round_money(erp_ar_sum_valid_payments_(v_ar_id));
  if v_after + 0.000000001 < v_received then
    raise exception 'ERR_AR_DUE_LT_RECEIVED: due=% received=%', v_after, v_received;
  end if;

  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
      v_ar_id, v_before, v_after, trim(coalesce(p_reason, '')),
      v_actor, v_ts, v_src_type, v_src_id
    );
  exception when unique_violation then
    return v_cut;
  end;

  update ar_receivable
  set amount_due = v_after,
      status = case
        when v_after <= 0.000000001 then 'SETTLED'
        when v_received > 0.000000001 then 'PARTIAL'
        else status
      end,
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
        ' 經銷月結回饋折讓（應收 ' || v_before::text || ' → ' || v_after::text || '）'
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where ar_id = v_ar_id;

  return v_cut;
end;
$$;

revoke all on function public.erp_cc_apply_rebate_cn_ar_cut_(
  text, text, numeric, numeric, text, text, timestamptz
) from public;

-- ── 月結回饋 POST（CREDIT_NOTE；原子：rebate + AR 折讓）────────────────
create or replace function public.erp_cc_post_rebate_cn_phase3_tx(
  p_rebate_json jsonb,
  p_ar_cuts jsonb,
  p_period_ym text,
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
  v_ym text := trim(coalesce(p_period_ym, ''));
  v_reb_id text;
  v_cust text;
  v_mode text;
  v_amt numeric;
  v_reason text;
  v_existed record;
  v_cut jsonb;
  v_primary_ar text := '';
  v_applied numeric := 0;
  v_one numeric;
  v_ar_id text;
begin
  if p_rebate_json is null then raise exception 'ERR_REBATE_JSON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if v_ym = '' then raise exception 'ERR_PERIOD_YM_REQUIRED'; end if;

  v_reb_id := erp_norm_id(p_rebate_json ->> 'rebate_id');
  v_cust := erp_norm_id(p_rebate_json ->> 'customer_id');
  v_mode := upper(trim(coalesce(p_rebate_json ->> 'settle_mode', '')));
  v_amt := erp_round_money(coalesce((p_rebate_json ->> 'rebate_amount')::numeric, 0));
  v_reason := '經銷月結回饋折讓（' || v_ym || '）';

  if v_reb_id = '' then raise exception 'ERR_REBATE_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_mode <> 'CREDIT_NOTE' then raise exception 'ERR_SETTLE_MODE_NOT_CN: %', v_mode; end if;

  select * into v_existed from commercial_dealer_rebate where rebate_id = v_reb_id;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'rebate_id', v_reb_id, 'rebate_rpc', true,
        'ar_id', coalesce(v_existed.ar_id, ''),
        'credit_applied', coalesce(v_existed.credit_applied, 0)
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
    'CREDIT_NOTE', 'POSTED', '', 0,
    coalesce(p_rebate_json ->> 'remark', ''),
    v_actor, v_ts, '', null, ''
  );

  if v_amt > 0.000000001 and p_ar_cuts is not null and jsonb_typeof(p_ar_cuts) = 'array' then
    for v_cut in select * from jsonb_array_elements(p_ar_cuts)
    loop
      v_ar_id := erp_norm_id(v_cut ->> 'ar_id');
      if v_ar_id = '' then continue; end if;
      v_one := erp_cc_apply_rebate_cn_ar_cut_(
        v_reb_id,
        v_ar_id,
        coalesce((v_cut ->> 'amount_before')::numeric, 0),
        coalesce((v_cut ->> 'amount_after')::numeric, 0),
        v_reason,
        v_actor,
        v_ts
      );
      if v_one > 0.000000001 and v_primary_ar = '' then v_primary_ar := v_ar_id; end if;
      v_applied := erp_round_money(v_applied + v_one);
    end loop;
  end if;

  if v_amt > 0.000000001 and abs(v_applied - v_amt) > 0.02 then
    raise exception 'ERR_CN_APPLIED_MISMATCH: expected=% applied=%', v_amt, v_applied;
  end if;

  update commercial_dealer_rebate
  set ar_id = v_primary_ar,
      credit_applied = v_applied,
      updated_by = v_actor,
      updated_at = v_ts
  where rebate_id = v_reb_id;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'rebate_id', v_reb_id,
    'rebate_amount', v_amt,
    'ar_id', v_primary_ar,
    'credit_applied', v_applied,
    'rebate_rpc', true
  );
end;
$$;

-- ── 月結回饋 VOID（CREDIT_NOTE；原子還原主應收折讓）────────────────────
create or replace function public.erp_cc_void_rebate_cn_phase3_tx(
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
  v_ar_id text;
  v_period text;
  v_snapshot numeric;
  v_discount_reason text;
  v_void_reason_ar text;
  v_net_cut numeric := 0;
  v_restore numeric;
  v_due numeric;
  v_received numeric;
  v_new_due numeric;
  r record;
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
  if upper(trim(coalesce(v_reb.settle_mode, ''))) <> 'CREDIT_NOTE' then
    raise exception 'ERR_VOID_CN_ONLY: settle_mode=%', v_reb.settle_mode;
  end if;

  v_ar_id := erp_norm_id(v_reb.ar_id);
  v_period := trim(coalesce(v_reb.period_ym, ''));
  v_snapshot := erp_round_money(coalesce(v_reb.credit_applied, v_reb.rebate_amount, 0));
  v_discount_reason := '經銷月結回饋折讓（' || v_period || '）';
  v_void_reason_ar := '作廢經銷月結回饋（' || v_period || '）';

  if v_ar_id <> '' and v_snapshot > 0.000000001 then
    for r in
      select amount_before, amount_after, reason
      from ar_amount_adjustment_log
      where ar_id = v_ar_id and reason in (v_discount_reason, v_void_reason_ar)
    loop
      v_net_cut := erp_round_money(v_net_cut + greatest(0, coalesce(r.amount_before, 0) - coalesce(r.amount_after, 0)));
    end loop;
    v_restore := erp_round_money(least(v_snapshot, v_net_cut));
    if v_restore > 0.000000001 then
      select coalesce(amount_due, 0) into v_due
      from ar_receivable where ar_id = v_ar_id for update;
      if not found then raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id; end if;
      v_due := erp_round_money(v_due);
      v_received := erp_round_money(erp_ar_sum_valid_payments_(v_ar_id));
      v_new_due := erp_round_money(v_due + v_restore);
      insert into ar_amount_adjustment_log (
        adjust_id, ar_id, amount_before, amount_after, reason, adjusted_by, adjusted_at
      ) values (
        'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
        v_ar_id, v_due, v_new_due, v_void_reason_ar, v_actor, v_ts
      );
      update ar_receivable
      set amount_due = v_new_due,
          status = case
            when v_new_due <= 0.000000001 then 'SETTLED'
            when v_received > 0.000000001 then 'PARTIAL'
            else 'OPEN'
          end,
          updated_by = v_actor,
          updated_at = v_ts
      where ar_id = v_ar_id;
    end if;
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
    'credit_restored', coalesce(v_restore, 0),
    'rebate_rpc', true
  );
end;
$$;

-- ── 作廢本月月結 cascade（回饋→等級→統計；單一 transaction）────────────
create or replace function public.erp_cc_void_monthly_close_phase3_tx(
  p_customer_id text,
  p_period_ym text,
  p_void_reason text,
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
  v_ym text := trim(coalesce(p_period_ym, ''));
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_steps jsonb := '[]'::jsonb;
  v_reb record;
  v_level record;
  v_stat record;
  v_res jsonb;
  v_removed numeric;
  v_customer record;
  v_before numeric;
  v_after numeric;
  v_snap_pending text;
  v_cust_pending text;
begin
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_ym = '' then raise exception 'ERR_PERIOD_YM_REQUIRED'; end if;
  if v_reason = '' then raise exception 'ERR_VOID_REASON_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_reb
  from commercial_dealer_rebate
  where customer_id = v_cust and period_ym = v_ym and upper(trim(coalesce(status, ''))) = 'POSTED'
  for update;
  if found then
    if upper(trim(coalesce(v_reb.settle_mode, ''))) = 'CARRY_FORWARD' then
      v_res := erp_cc_void_rebate_cf_phase3_tx(v_reb.rebate_id, v_reason, v_actor, v_ts);
    elsif upper(trim(coalesce(v_reb.settle_mode, ''))) = 'CREDIT_NOTE' then
      v_res := erp_cc_void_rebate_cn_phase3_tx(v_reb.rebate_id, v_reason, v_actor, v_ts);
    else
      raise exception 'ERR_REBATE_SETTLE_MODE: %', v_reb.settle_mode;
    end if;
    v_steps := v_steps || jsonb_build_array(jsonb_build_object('step', 'rebate', 'rebate_id', v_reb.rebate_id));
  end if;

  select * into v_level
  from commercial_dealer_level_post
  where customer_id = v_cust and period_ym = v_ym and upper(trim(coalesce(status, ''))) = 'POSTED'
  for update;
  if found then
    v_res := erp_cc_void_level_phase3_tx(v_level.level_post_id, v_reason, v_actor, v_ts);
    v_steps := v_steps || jsonb_build_array(jsonb_build_object(
      'step', 'level', 'level_post_id', v_level.level_post_id
    ));
  end if;

  select * into v_stat
  from commercial_dealer_monthly_stat
  where customer_id = v_cust and period_ym = v_ym and upper(trim(coalesce(status, ''))) = 'POSTED'
  for update;
  if not found then
    if jsonb_array_length(v_steps) = 0 then
      raise exception 'ERR_MONTHLY_STAT_NOT_FOUND';
    end if;
    raise exception 'ERR_MONTHLY_STAT_ALREADY_VOID';
  end if;

  v_removed := erp_round_money(
    coalesce(v_stat.cumulative_add_consignment, 0) + coalesce(v_stat.cumulative_add_general, 0)
  );
  if v_removed > 0.000000001
     or v_stat.cumulative_before is not null
     or v_stat.cumulative_after is not null then
    select * into v_customer from customer where customer_id = v_cust for update;
    if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;
    if v_removed > 0.000000001 then
      v_before := erp_round_money(coalesce(v_customer.dealer_cumulative_amount, 0));
      v_after := erp_round_money(greatest(0, v_before - v_removed));
      v_snap_pending := trim(coalesce(v_stat.cumulative_pending_tier_label, ''));
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
      where customer_id = v_cust;
    end if;
    v_steps := v_steps || jsonb_build_array(jsonb_build_object(
      'step', 'legacy_level_in_stat', 'cumulative_removed', v_removed
    ));
  end if;

  update commercial_dealer_monthly_stat
  set status = 'VOID',
      void_reason = v_reason,
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor || ' 作廢本月月結：' || v_reason
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where stat_id = v_stat.stat_id;

  v_steps := v_steps || jsonb_build_array(jsonb_build_object('step', 'stat', 'stat_id', v_stat.stat_id));

  return jsonb_build_object(
    'ok', true,
    'message', 'VOIDED',
    'customer_id', v_cust,
    'period_ym', v_ym,
    'stat_id', v_stat.stat_id,
    'steps', v_steps,
    'close_rpc', true
  );
end;
$$;

comment on function public.erp_cc_post_rebate_cn_phase3_tx is 'v4.3.8 Phase3：月結回饋 CREDIT_NOTE POST 原子';
comment on function public.erp_cc_void_rebate_cn_phase3_tx is 'v4.3.8 Phase3：月結回饋 CREDIT_NOTE VOID 原子';
comment on function public.erp_cc_void_monthly_close_phase3_tx is 'v4.3.8 Phase3：作廢本月月結 cascade（回饋→等級→統計）';

revoke all on function public.erp_cc_post_rebate_cn_phase3_tx(jsonb, jsonb, text, text, timestamptz) from public;
grant execute on function public.erp_cc_post_rebate_cn_phase3_tx(jsonb, jsonb, text, text, timestamptz) to service_role;

revoke all on function public.erp_cc_void_rebate_cn_phase3_tx(text, text, text, timestamptz) from public;
grant execute on function public.erp_cc_void_rebate_cn_phase3_tx(text, text, text, timestamptz) to service_role;

revoke all on function public.erp_cc_void_monthly_close_phase3_tx(text, text, text, text, timestamptz) from public;
grant execute on function public.erp_cc_void_monthly_close_phase3_tx(text, text, text, text, timestamptz) to service_role;
