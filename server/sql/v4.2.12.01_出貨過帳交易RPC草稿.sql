-- ERP v4.2.12 遷移步驟 1【草稿 v2.3】：出貨過帳單一交易 RPC
-- ⚠ 草稿 v2.3：尚未在 Supabase 正式執行
-- v2.3：Dealer Credit 冪等改 source_type/source_id UNIQUE；customer／AR 缺失 fail-closed

-- ── AR 調整來源鍵（財務冪等；勿再用 reason 字串）────────────────
alter table ar_amount_adjustment_log
  add column if not exists source_type text,
  add column if not exists source_id text;

comment on column ar_amount_adjustment_log.source_type is
  '調整來源類型；出貨折抵＝SHIPMENT_CREDIT、作廢沖銷＝SHIPMENT_CREDIT_VOID（財務冪等鍵）';
comment on column ar_amount_adjustment_log.source_id is
  '調整來源鍵；出貨折抵／沖銷皆＝shipment_id';

create unique index if not exists idx_ar_adj_source_unique
  on ar_amount_adjustment_log (source_type, source_id)
  where source_type is not null and source_id is not null;

-- ── SO 狀態（volatile；同 transaction 剛更新 shipped_qty）────────
create or replace function public.erp_calc_so_status(p_so_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int := 0;
  v_all_shipped int := 0;
  v_any_shipped int := 0;
  r record;
begin
  for r in
    select order_qty, shipped_qty from sales_order_item where so_id = erp_norm_id(p_so_id)
  loop
    v_total := v_total + 1;
    if coalesce(r.shipped_qty, 0) + 1e-9 >= coalesce(r.order_qty, 0) and coalesce(r.order_qty, 0) > 0 then
      v_all_shipped := v_all_shipped + 1;
    end if;
    if coalesce(r.shipped_qty, 0) > 1e-9 then
      v_any_shipped := v_any_shipped + 1;
    end if;
  end loop;
  if v_total = 0 then return 'OPEN'; end if;
  if v_all_shipped = v_total then return 'SHIPPED'; end if;
  if v_any_shipped > 0 then return 'PARTIAL'; end if;
  return 'OPEN';
end;
$$;

-- ── Dealer Credit（同交易；冪等鍵＝SHIPMENT_CREDIT + shipment_id）──
create or replace function public.erp_apply_dealer_credit_at_shipment(
  p_ar_id text,
  p_shipment_id text,
  p_customer_id text,
  p_ship_date date,
  p_actor text,
  p_ts timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ar_id text := erp_norm_id(p_ar_id);
  v_sid text := erp_norm_id(p_shipment_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reason text;
  v_src_type text := 'SHIPMENT_CREDIT';
  v_ship_ym text;
  v_balance numeric := 0;
  v_due numeric := 0;
  v_received numeric := 0;
  v_total_posted numeric := 0;
  v_consumed numeric := 0;
  v_eligible numeric := 0;
  v_eligible_remaining numeric := 0;
  v_cut numeric := 0;
  v_new_due numeric := 0;
  r record;
  v_amt numeric;
  v_used numeric;
  v_remaining numeric;
begin
  if v_ar_id = '' then raise exception 'ERR_AR_ID_REQUIRED'; end if;
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if p_ship_date is null then raise exception 'ERR_SHIP_DATE_REQUIRED'; end if;

  v_ship_ym := to_char(p_ship_date, 'YYYY-MM');
  v_reason := '經銷回饋折抵（出貨 ' || v_sid || '）';

  -- 冪等：UNIQUE(source_type, source_id)；不得用 reason 字串當財務鍵
  if exists (
    select 1
    from ar_amount_adjustment_log
    where source_type = v_src_type
      and source_id = v_sid
  ) then
    return;
  end if;

  select coalesce(dealer_rebate_credit_balance, 0) into v_balance
  from customer
  where customer_id = v_cust
  for update;
  if not found then
    raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust;
  end if;

  v_balance := erp_round_money(v_balance);
  if v_balance <= 0.000000001 then
    return;
  end if;

  select coalesce(amount_due, 0), coalesce(amount_received, 0) into v_due, v_received
  from ar_receivable
  where ar_id = v_ar_id
  for update;
  if not found then
    raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id;
  end if;

  v_due := erp_round_money(v_due);
  if v_due <= 0.000000001 then
    return;
  end if;

  v_received := erp_round_money(v_received);
  if v_due + 0.000000001 < v_received then
    raise exception 'ERR_AR_DUE_LT_RECEIVED: due=% received=%', v_due, v_received;
  end if;

  select coalesce(sum(rebate_amount), 0) into v_total_posted
  from commercial_dealer_rebate
  where customer_id = v_cust
    and status = 'POSTED'
    and settle_mode = 'CARRY_FORWARD';

  v_total_posted := erp_round_money(v_total_posted);
  v_consumed := erp_round_money(greatest(0, v_total_posted - v_balance));
  v_eligible_remaining := 0;

  for r in
    select period_ym, coalesce(rebate_amount, 0) as rebate_amount
    from commercial_dealer_rebate
    where customer_id = v_cust
      and status = 'POSTED'
      and settle_mode = 'CARRY_FORWARD'
    order by period_ym asc
  loop
    v_amt := erp_round_money(coalesce(r.rebate_amount, 0));
    v_used := erp_round_money(least(v_amt, v_consumed));
    v_consumed := erp_round_money(greatest(0, v_consumed - v_used));
    v_remaining := erp_round_money(v_amt - v_used);
    if trim(coalesce(r.period_ym, '')) < v_ship_ym then
      v_eligible_remaining := erp_round_money(v_eligible_remaining + v_remaining);
    end if;
  end loop;

  v_eligible := erp_round_money(least(v_balance, v_eligible_remaining));
  if v_eligible <= 0.000000001 then
    return;
  end if;

  v_cut := erp_round_money(least(v_eligible, v_due));
  if v_cut <= 0.000000001 then
    return;
  end if;
  v_new_due := erp_round_money(v_due - v_cut);
  if v_new_due + 0.000000001 < v_received then
    raise exception 'ERR_AR_DUE_LT_RECEIVED: due=% received=%', v_new_due, v_received;
  end if;

  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
      v_ar_id,
      v_due,
      v_new_due,
      v_reason,
      v_actor,
      v_ts,
      v_src_type,
      v_sid
    );
  exception when unique_violation then
    -- 並發重入：UNIQUE 擋下第二筆；本交易視為已套用
    return;
  end;

  update ar_receivable
  set amount_due = v_new_due,
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
        ' 經銷回饋折抵（應收 ' || v_due::text || ' → ' || v_new_due::text || '）：' || v_reason
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where ar_id = v_ar_id;

  update customer
  set dealer_rebate_credit_balance = erp_round_money(v_balance - v_cut),
      updated_by = v_actor,
      updated_at = v_ts
  where customer_id = v_cust;
end;
$$;

comment on function public.erp_apply_dealer_credit_at_shipment is
  'v4.2.12 草稿 v2.3：出貨折抵；冪等鍵 SHIPMENT_CREDIT+shipment_id；customer/AR 缺失 exception';

-- ── 出貨過帳（原子）────────────────────────────────────────────
create or replace function public.erp_ship_post_tx(
  p_shipment_id text,
  p_so_id text,
  p_ship_date date,
  p_shipper_id text,
  p_recipient_id text,
  p_recipient_name text,
  p_recipient_name_en text,
  p_recipient_address text,
  p_recipient_phone text,
  p_transaction_id text,
  p_parent_ref_type text,
  p_parent_ref_id text,
  p_remark text,
  p_consignment_case_id text,
  p_items_json jsonb,
  p_pricing_snapshot jsonb default null,
  p_expected_so_updated_at timestamptz default null,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid text := erp_norm_id(p_shipment_id);
  v_so_id text := erp_norm_id(p_so_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_tx text := trim(coalesce(p_transaction_id, ''));
  v_parent_type text := upper(trim(coalesce(p_parent_ref_type, 'SO')));
  v_parent_id text := erp_norm_id(p_parent_ref_id);
  v_case_id text := erp_norm_id(p_consignment_case_id);
  v_so record;
  v_cust text;
  v_so_type text;
  v_existed record;
  v_recip record;
  v_item jsonb;
  v_i int;
  v_lot_id text;
  v_qty numeric;
  v_so_item_id text;
  v_so_item record;
  v_product_id text;
  v_lot record;
  v_shi_id text;
  v_mv_id text;
  v_avail numeric;
  v_demand numeric;
  v_delta jsonb := '{}'::jsonb;
  v_next_shipped numeric;
  v_remain numeric;
  v_pricing jsonb;
  v_ar_id text;
  v_amount_system numeric;
  v_currency text;
  v_cum_add numeric := 0;
  v_line jsonb;
  v_plid text;
  v_line_key text;
  v_lot_keys text[];
  v_key text;
  v_lot_demand jsonb := '{}'::jsonb;
  v_demand numeric;
  v_items_for_pricing jsonb := '[]'::jsonb;
  v_line_key text;
  v_agg_qty numeric;
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_so_id = '' then raise exception 'ERR_SO_ID_REQUIRED'; end if;
  if p_ship_date is null then raise exception 'ERR_SHIP_DATE_REQUIRED'; end if;
  if trim(coalesce(p_shipper_id, '')) = '' then raise exception 'ERR_SHIPPER_REQUIRED'; end if;
  if erp_norm_id(p_recipient_id) = '' then raise exception 'ERR_RECIPIENT_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if v_tx = '' then raise exception 'ERR_TRANSACTION_ID_REQUIRED'; end if;
  if trim(coalesce(p_recipient_name, '')) = '' and trim(coalesce(p_recipient_name_en, '')) = '' then
    raise exception 'ERR_RECIPIENT_NAME_REQUIRED';
  end if;

  -- 冪等：已 POSTED 且 transaction_id 相同 → 回傳成功
  select * into v_existed from shipment where shipment_id = v_sid;
  if found and upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' then
    if trim(coalesce(v_existed.transaction_id, '')) <> v_tx then
      raise exception 'ERR_SHIPMENT_ID_CONFLICT: % already POSTED with different transaction_id', v_sid;
    end if;
    return jsonb_build_object(
      'ok', true, 'message', 'POSTED', 'idempotent', true,
      'shipment_id', v_sid,
      'ar_id', 'AR-' || v_sid
    );
  end if;
  if found then
    raise exception 'ERR_SHIPMENT_EXISTS_NOT_POSTED';
  end if;

  if v_parent_type not in ('SO', 'SHIPMENT') then
    raise exception 'ERR_PARENT_REF_TYPE';
  end if;
  if v_parent_type = 'SO' then v_parent_id := v_so_id;
  elsif v_parent_id = '' then raise exception 'ERR_PARENT_REF_ID_REQUIRED'; end if;

  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' or jsonb_array_length(p_items_json) < 1 then
    raise exception 'ERR_ITEMS_REQUIRED';
  end if;

  -- lock SO + 樂觀鎖
  select * into v_so from sales_order where so_id = v_so_id for update;
  if not found then raise exception 'ERR_SO_NOT_FOUND: %', v_so_id; end if;

  if p_expected_so_updated_at is not null
     and v_so.updated_at is distinct from p_expected_so_updated_at then
    raise exception 'ERR_SO_STALE: Sales order changed. Please reload and retry';
  end if;

  v_cust := erp_norm_id(v_so.customer_id);
  v_so_type := upper(trim(coalesce(v_so.so_type, 'NORMAL')));

  -- 收件人驗證
  select * into v_recip
  from customer_recipient
  where recipient_id = erp_norm_id(p_recipient_id);

  if not found then raise exception 'ERR_RECIPIENT_NOT_FOUND'; end if;
  if upper(trim(coalesce(v_recip.status, ''))) = 'VOID' then
    raise exception 'ERR_RECIPIENT_VOID';
  end if;
  if erp_norm_id(v_recip.customer_id) <> v_cust then
    raise exception 'ERR_RECIPIENT_CUSTOMER_MISMATCH';
  end if;

  -- ① 驗證所有明細 + 彙總 lot 需求
  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_so_item_id := erp_norm_id(v_item ->> 'so_item_id');
    v_lot_id := erp_norm_id(v_item ->> 'lot_id');
    v_qty := erp_round_qty((v_item ->> 'ship_qty')::numeric);

    if v_so_item_id = '' then raise exception 'ERR_SO_ITEM_REQUIRED items[%]', v_i; end if;
    if v_lot_id = '' then raise exception 'ERR_LOT_REQUIRED items[%]', v_i; end if;
    if v_qty <= 0 then raise exception 'ERR_SHIP_QTY_INVALID items[%]', v_i; end if;

    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    if not found then raise exception 'ERR_SO_ITEM_NOT_IN_SO: %', v_so_item_id; end if;

    select * into v_lot from lot where lot_id = v_lot_id;
    if not found then raise exception 'ERR_LOT_NOT_FOUND: %', v_lot_id; end if;

    if erp_norm_id(v_so_item.product_id) <> erp_norm_id(v_lot.product_id) then
      raise exception 'ERR_PRODUCT_LOT_MISMATCH: % / %', v_so_item_id, v_lot_id;
    end if;

    v_delta := v_delta || jsonb_build_object(
      v_so_item_id, coalesce((v_delta ->> v_so_item_id)::numeric, 0) + v_qty
    );
    v_lot_demand := v_lot_demand || jsonb_build_object(
      v_lot_id, coalesce((v_lot_demand ->> v_lot_id)::numeric, 0) + v_qty
    );
  end loop;

  select array_agg(key order by key) into v_lot_keys from jsonb_each_text(v_lot_demand);
  if v_lot_keys is not null then
    foreach v_key in array v_lot_keys loop
      v_demand := (v_lot_demand ->> v_key)::numeric;
      select * into v_lot from lot where lot_id = v_key for update;
      if not found then raise exception 'ERR_LOT_NOT_FOUND: %', v_key; end if;
      v_avail := erp_lot_available_qty(v_key);
      if v_avail + 1e-9 < v_demand then
        raise exception 'ERR_INSUFFICIENT_LOT: % need % have %', v_key, v_demand, v_avail;
      end if;
    end loop;
  end if;

  -- so_item 聚合後防超量（同 so_item 多列）
  for v_so_item_id, v_agg_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    if not found then
      raise exception 'ERR_SO_ITEM_NOT_IN_SO: %', v_so_item_id;
    end if;
    v_remain := erp_round_qty(coalesce(v_so_item.order_qty, 0) - coalesce(v_so_item.shipped_qty, 0));
    if v_agg_qty - v_remain > 1e-9 then
      raise exception 'ERR_OVER_SHIP_AGG: so_item % remain % request %', v_so_item_id, v_remain, v_agg_qty;
    end if;
  end loop;

  -- 預先指派 line_key = shipment_item_id，供計價與快照 1:1 對應
  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_shi_id := 'SHI-' || v_sid || '-' || lpad((v_i + 1)::text, 3, '0');
    v_items_for_pricing := v_items_for_pricing || jsonb_build_array(
      v_item || jsonb_build_object('line_key', v_shi_id, 'shipment_item_id', v_shi_id)
    );
  end loop;

  -- ② DB 計價（權威）+ 可選 snapshot diff
  if v_so_type = 'NORMAL' then
    v_pricing := erp_calc_shipment_pricing(v_so_id, v_cust, p_ship_date, v_items_for_pricing);
    perform erp_assert_pricing_snapshot_diff_(v_pricing, p_pricing_snapshot, 0.01);
    v_amount_system := erp_round_money((v_pricing ->> 'amount_system')::numeric);
    v_currency := upper(trim(v_pricing ->> 'currency'));
  else
    v_pricing := null;
    v_amount_system := 0;
    v_currency := upper(trim(coalesce(v_so.currency, '')));
  end if;

  insert into shipment (
    shipment_id, so_id, customer_id, shipper_id, transaction_id,
    parent_ref_type, parent_ref_id, ship_date, status, remark,
    recipient_id, recipient_name, recipient_name_en, recipient_address, recipient_phone,
    consignment_case_id, created_by, created_at, updated_by, updated_at
  ) values (
    v_sid, v_so_id, v_cust, trim(p_shipper_id), v_tx,
    v_parent_type, v_parent_id, p_ship_date, 'POSTED', coalesce(p_remark, ''),
    erp_norm_id(p_recipient_id),
    trim(coalesce(p_recipient_name, '')),
    trim(coalesce(p_recipient_name_en, '')),
    trim(coalesce(p_recipient_address, '')),
    trim(coalesce(p_recipient_phone, '')),
    nullif(v_case_id, ''),
    v_actor, p_ts, '', null
  );

  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_lot_id := erp_norm_id(v_item ->> 'lot_id');
    v_qty := erp_round_qty((v_item ->> 'ship_qty')::numeric);
    v_so_item_id := erp_norm_id(v_item ->> 'so_item_id');

    select * into v_so_item from sales_order_item where so_item_id = v_so_item_id;
    select * into v_lot from lot where lot_id = v_lot_id;

    v_product_id := erp_norm_id(v_so_item.product_id);
    v_shi_id := coalesce(
      nullif(trim(v_item ->> 'shipment_item_id'), ''),
      nullif(trim(v_item ->> 'line_key'), ''),
      'SHI-' || v_sid || '-' || lpad((v_i + 1)::text, 3, '0')
    );
    v_mv_id := erp_new_movement_id();

    insert into shipment_item (
      shipment_item_id, shipment_id, so_id, so_item_id, lot_id, product_id,
      transaction_id, parent_ref_type, parent_ref_id, ship_qty, unit, remark,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_shi_id, v_sid, v_so_id, v_so_item_id, v_lot_id, v_product_id,
      v_tx, 'SHIPMENT', v_sid, v_qty, trim(coalesce(v_so_item.unit, v_lot.unit, '')),
      coalesce(v_item ->> 'remark', ''),
      v_actor, p_ts, '', null
    );

    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'SHIP_OUT', v_lot_id, v_product_id,
      upper(trim(coalesce(v_lot.warehouse_id, 'MAIN'))),
      v_tx, 'SHIPMENT', v_sid, -abs(v_qty),
      trim(coalesce(v_so_item.unit, v_lot.unit, '')),
      'SHIPMENT', v_sid, '', coalesce(v_item ->> 'remark', ''),
      v_actor, p_ts, 'Ship OUT: ' || v_sid
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) - v_qty,
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = p_ts, updated_by = v_actor
    where lot_id = v_lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      select v_lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_lot_id), 0),
        coalesce((select count(*) from inventory_movement m where m.lot_id = v_lot_id), 0),
        v_mv_id, p_ts, v_actor;
    end if;
  end loop;

  for v_so_item_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item where so_item_id = v_so_item_id for update;
    v_next_shipped := coalesce(v_so_item.shipped_qty, 0) + v_qty;
    update sales_order_item
    set shipped_qty = v_next_shipped, updated_by = v_actor, updated_at = p_ts
    where so_item_id = v_so_item_id;
  end loop;

  update sales_order
  set status = erp_calc_so_status(v_so_id), updated_by = v_actor, updated_at = p_ts
  where so_id = v_so_id;

  v_ar_id := null;

  if v_so_type = 'NORMAL' then
    v_ar_id := 'AR-' || v_sid;
    insert into ar_receivable (
      ar_id, source_type, source_id, customer_id, so_id, shipment_id,
      transaction_id, ar_date, currency,
      amount_system, amount_due, amount_received, status,
      remark, created_by, created_at, system_remark, dealer_cumulative_added
    ) values (
      v_ar_id, 'SHIPMENT', v_sid, v_cust, v_so_id, v_sid,
      v_tx, p_ship_date, v_currency,
      v_amount_system, v_amount_system, 0, 'OPEN',
      '', v_actor, p_ts, coalesce(v_pricing ->> 'system_remark', ''), 0
    );

    -- 促銷計價快照（line_key = shipment_item_id 1:1）
    for v_i in 0 .. jsonb_array_length(coalesce(v_pricing -> 'lines', '[]'::jsonb)) - 1 loop
      v_line := (v_pricing -> 'lines') -> v_i;
      v_line_key := coalesce(nullif(trim(v_line ->> 'line_key'), ''), nullif(trim(v_line ->> 'shipment_item_id'), ''));
      if v_line_key is null or v_line_key = '' then
        raise exception 'ERR_PRICING_LINE_KEY_MISSING at lines[%]', v_i;
      end if;
      v_plid := 'SPL-' || v_line_key;
      insert into shipment_pricing_line (
        pricing_line_id, shipment_id, shipment_item_id, so_item_id, product_id,
        ship_qty, billable_qty, free_qty, base_unit_price, settle_unit_price, line_amount,
        promo_scheme_id, promo_scheme_name, promo_type, promo_price_basis,
        promo_discount_pct, promo_buy_qty, promo_scheme_free_qty, calc_scope
      )
      values (
        v_plid, v_sid, v_line_key,
        erp_norm_id(v_line ->> 'so_item_id'), erp_norm_id(v_line ->> 'product_id'),
        (v_line ->> 'ship_qty')::numeric, (v_line ->> 'billable_qty')::numeric,
        (v_line ->> 'free_qty')::numeric, (v_line ->> 'base_unit_price')::numeric,
        (v_line ->> 'settle_unit_price')::numeric, (v_line ->> 'amount')::numeric,
        coalesce(v_line ->> 'promo_scheme_id', ''), coalesce(v_line ->> 'promo_scheme_name', ''),
        coalesce(v_line ->> 'promo_type', ''), coalesce(v_line ->> 'promo_price_basis', ''),
        (v_line ->> 'promo_discount_pct')::numeric,
        (v_line ->> 'promo_buy_qty')::numeric, (v_line ->> 'promo_scheme_free_qty')::numeric,
        coalesce(v_line ->> 'calc_scope', 'PER_SHIPMENT')
      );
    end loop;

    perform erp_apply_dealer_credit_at_shipment(v_ar_id, v_sid, v_cust, p_ship_date, v_actor, p_ts);

    v_cum_add := erp_dealer_ledger_post_general_shipment(
      v_cust, v_sid, v_ar_id, p_ship_date, v_amount_system, v_actor, p_ts
    );

  elsif v_so_type = 'CONSIGNMENT' then
    if v_case_id = '' then raise exception 'ERR_CONSIGNMENT_CASE_REQUIRED'; end if;
    raise exception 'ERR_NOT_IMPLEMENTED: consignment pool in ship_post_tx v2';
  else
    raise exception 'ERR_UNKNOWN_SO_TYPE: %', v_so_type;
  end if;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'shipment_id', v_sid, 'so_id', v_so_id, 'so_type', v_so_type,
    'ar_id', v_ar_id, 'amount_system', v_amount_system,
    'dealer_cumulative_added', v_cum_add
  );
end;
$$;

comment on function public.erp_ship_post_tx is
  'v4.2.12 草稿 v2.3：出貨過帳原子交易；Dealer Credit 用 source 冪等鍵';

revoke all on function public.erp_calc_so_status(text) from public;
revoke all on function public.erp_apply_dealer_credit_at_shipment(text, text, text, date, text, timestamptz) from public;
revoke all on function public.erp_ship_post_tx(
  text, text, date, text, text, text, text, text, text, text,
  text, text, text, text, jsonb, jsonb, timestamptz, text, timestamptz
) from public;

grant execute on function public.erp_calc_so_status(text) to service_role;
grant execute on function public.erp_apply_dealer_credit_at_shipment(
  text, text, text, date, text, timestamptz
) to service_role;
grant execute on function public.erp_ship_post_tx(
  text, text, date, text, text, text, text, text, text, text,
  text, text, text, text, jsonb, jsonb, timestamptz, text, timestamptz
) to service_role;
