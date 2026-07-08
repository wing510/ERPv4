-- ERP v4.2.12 遷移步驟 0【草稿 v2.3】：出貨計價（DB 為準）
-- ⚠ 草稿 v2.3：尚未在 Supabase 正式執行
-- v2.3：累積制經銷價＝牌價×等級%；scheme_id 有值但找不到 → fail-closed

-- ── 工具 ─────────────────────────────────────────────────────
create or replace function public.erp_norm_id(p_text text)
returns text
language sql
immutable
as $$
  select upper(trim(coalesce(p_text, '')));
$$;

create or replace function public.erp_round_money(p_amount numeric)
returns numeric
language sql
immutable
as $$
  select round(coalesce(p_amount, 0)::numeric, 2);
$$;

create or replace function public.erp_round_qty(p_qty numeric)
returns numeric
language sql
immutable
as $$
  select round(coalesce(p_qty, 0)::numeric, 6);
$$;

-- ── 工具：YYYY-MM-DD 解析（供 started_at）──────────────────────
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

-- ── 累積制經銷價（GENERAL）：回傳牌價折數％（0 表示不啟用）────────
create or replace function public.erp_resolve_cumulative_dealer_price_rate_(
  p_customer_id text,
  p_ship_date date,
  p_channel text default 'GENERAL'
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_ch text := upper(trim(coalesce(p_channel, 'GENERAL')));
  v_ym text;
  v_customer record;
  v_scheme record;
  v_started date;
  v_rate numeric;
  v_pending_label text;
  v_pending_rate numeric;
  v_pending_from text;
begin
  if v_cust = '' or p_ship_date is null then
    return 0;
  end if;
  v_ym := to_char(p_ship_date, 'YYYY-MM');

  select * into v_customer
  from customer
  where customer_id = v_cust;
  if not found then
    return 0;
  end if;

  if coalesce(trim(v_customer.dealer_cumulative_scheme_id), '') = '' then
    return 0;
  end if;

  v_started := erp_parse_date_ymd_(v_customer.dealer_cumulative_started_at);
  if v_started is not null and p_ship_date < v_started then
    return 0;
  end if;

  select * into v_scheme
  from commercial_dealer_scheme
  where scheme_id = erp_norm_id(v_customer.dealer_cumulative_scheme_id);
  if not found then
    raise exception 'ERR_DEALER_SCHEME_NOT_FOUND: %',
      erp_norm_id(v_customer.dealer_cumulative_scheme_id);
  end if;

  if upper(trim(coalesce(v_scheme.scheme_type, ''))) <> 'CUMULATIVE_AMOUNT' then
    return 0;
  end if;
  if upper(trim(coalesce(v_scheme.status, ''))) <> 'ACTIVE' then
    return 0;
  end if;
  if not (p_ship_date between v_scheme.date_from and v_scheme.date_to) then
    return 0;
  end if;

  -- stat_source：CONSIGNMENT／GENERAL／ALL
  if upper(trim(coalesce(v_scheme.stat_source, 'CONSIGNMENT'))) <> 'ALL'
     and upper(trim(coalesce(v_scheme.stat_source, 'CONSIGNMENT'))) <> v_ch then
    return 0;
  end if;

  v_rate := nullif(trim(coalesce(v_customer.dealer_cumulative_price_rate::text, '')), '')::numeric;
  v_pending_label := trim(coalesce(v_customer.dealer_cumulative_pending_tier_label, ''));
  v_pending_rate := nullif(trim(coalesce(v_customer.dealer_cumulative_pending_price_rate::text, '')), '')::numeric;
  v_pending_from := trim(coalesce(v_customer.dealer_cumulative_pending_from_ym, ''));

  -- 對齊 Node：settleYm > pendingFromYm 才視為 pending 生效（嚴格大於）
  if v_pending_label <> '' and v_pending_rate is not null and v_pending_from <> '' then
    if v_ym > v_pending_from then
      v_rate := v_pending_rate;
    end if;
  end if;

  if not (v_rate > 0) then
    return 0;
  end if;
  return erp_round_money(v_rate);
end;
$$;

-- ── 出貨明細計價快照表（同一 transaction 寫入）────────────────
create table if not exists shipment_pricing_line (
  pricing_line_id text primary key,
  shipment_id text not null,
  shipment_item_id text not null,
  so_item_id text not null,
  product_id text not null,
  ship_qty numeric not null default 0,
  billable_qty numeric not null default 0,
  free_qty numeric not null default 0,
  base_unit_price numeric not null default 0,
  settle_unit_price numeric not null default 0,
  line_amount numeric not null default 0,
  promo_scheme_id text default '',
  promo_scheme_name text default '',
  promo_type text default '',
  promo_price_basis text default '',
  promo_discount_pct numeric,
  promo_buy_qty numeric,
  promo_scheme_free_qty numeric,
  calc_scope text not null default 'PER_SHIPMENT',
  created_at timestamptz not null default now()
);

create index if not exists idx_spl_shipment on shipment_pricing_line (shipment_id);
create index if not exists idx_spl_line_key on shipment_pricing_line (shipment_id, shipment_item_id);

alter table shipment_pricing_line enable row level security;
revoke all on table public.shipment_pricing_line from anon, authenticated;

-- ── 促銷：為單一產品選方案（GENERAL／ALL；ACTIVE；日期內）────────
create or replace function public.erp_promo_pick_for_product_(
  p_customer_id text,
  p_ship_date date,
  p_product_id text
)
returns table (
  scheme_id text,
  scheme_name text,
  promo_type text,
  price_basis text,
  promo_unit_price numeric,
  discount_pct numeric,
  buy_qty numeric,
  free_qty numeric,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.scheme_id,
    s.scheme_name,
    l.promo_type,
    coalesce(nullif(trim(s.price_basis), ''), 'DEALER') as price_basis,
    l.promo_unit_price,
    l.discount_pct,
    l.buy_qty,
    l.free_qty,
    s.created_at
  from consignment_promo_scheme s
  inner join consignment_promo_scheme_line l on l.scheme_id = s.scheme_id
  where erp_norm_id(l.product_id) = erp_norm_id(p_product_id)
    and upper(trim(coalesce(s.status, ''))) = 'ACTIVE'
    and p_ship_date between s.date_from and s.date_to
    and upper(trim(coalesce(s.channel, 'CONSIGNMENT'))) in ('GENERAL', 'ALL')
    and upper(trim(coalesce(s.scope_type, ''))) in ('CUSTOMER', 'GLOBAL')
    and (
      upper(trim(coalesce(s.scope_type, ''))) = 'GLOBAL'
      or erp_norm_id(s.customer_id) = erp_norm_id(p_customer_id)
    )
  order by
    case upper(trim(coalesce(s.scope_type, '')))
      when 'CUSTOMER' then 2
      when 'GLOBAL' then 1
      else 0
    end desc,
    s.created_at desc
  limit 1;
$$;

-- ── 結算單價（FIXED_PRICE／DISCOUNT_PCT；BUY_N_GET_M 在數量層處理）──
create or replace function public.erp_promo_settle_unit_price_(
  p_base_unit_price numeric,
  p_promo_type text,
  p_promo_unit_price numeric,
  p_discount_pct numeric
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_base numeric := erp_round_money(p_base_unit_price);
  v_type text := upper(trim(coalesce(p_promo_type, '')));
begin
  if v_type = 'FIXED_PRICE' and coalesce(p_promo_unit_price, 0) > 0 then
    return erp_round_money(p_promo_unit_price);
  end if;
  if v_type = 'DISCOUNT_PCT' and coalesce(p_discount_pct, 0) > 0 then
    return erp_round_money(v_base * (1 - p_discount_pct / 100.0));
  end if;
  return v_base;
end;
$$;

-- ── 底價：LIST＝牌價；DEALER＝累積制經銷價（牌價×等級%），否則 SO 單價 ──
create or replace function public.erp_resolve_shipment_base_unit_price_(
  p_customer_id text,
  p_ship_date date,
  p_so_unit_price numeric,
  p_list_price numeric,
  p_price_basis text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_basis text := upper(trim(coalesce(p_price_basis, 'DEALER')));
  v_list numeric := erp_round_money(coalesce(p_list_price, 0));
  v_so numeric := erp_round_money(coalesce(p_so_unit_price, 0));
  v_rate numeric := 0;
begin
  if v_basis = 'LIST' and v_list > 0 then
    return v_list;
  end if;
  if v_basis <> 'LIST' and v_list > 0 then
    v_rate := erp_resolve_cumulative_dealer_price_rate_(p_customer_id, p_ship_date, 'GENERAL');
    if v_rate > 0 then
      return erp_round_money(v_list * v_rate / 100.0);
    end if;
  end if;
  if v_so > 0 then
    return v_so;
  end if;
  if v_list > 0 then
    return v_list;
  end if;
  return 0;
end;
$$;

-- ── 買 N 送 M：本批出貨量（PER_SHIPMENT）────────────────────────
create or replace function public.erp_calc_buy_n_get_m_free_(
  p_ship_qty numeric,
  p_buy_qty numeric,
  p_free_qty numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_buy_qty, 0) > 0 and coalesce(p_free_qty, 0) > 0 then
      floor(erp_round_qty(p_ship_qty) / (p_buy_qty + p_free_qty) + 1e-9) * p_free_qty
    else 0
  end;
$$;

-- ── 將贈送量分配到單價較高的明細（key = line_key，非 so_item_id）────
create or replace function public.erp_allocate_free_qty_high_price_(
  p_rows jsonb,
  p_free_total numeric
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_free numeric := erp_round_qty(p_free_total);
  v_result jsonb := '{}'::jsonb;
  v_row jsonb;
  v_key text;
  v_qty numeric;
  v_alloc numeric;
  v_sorted jsonb;
  i int;
begin
  if v_free <= 0 or p_rows is null then
    return '{}'::jsonb;
  end if;

  select jsonb_agg(elem order by (elem ->> 'base_unit_price')::numeric desc nulls last)
  into v_sorted
  from jsonb_array_elements(p_rows) elem;

  if v_sorted is null then
    return '{}'::jsonb;
  end if;

  for i in 0 .. jsonb_array_length(v_sorted) - 1 loop
    v_row := v_sorted -> i;
    v_key := coalesce(nullif(trim(v_row ->> 'line_key'), ''), v_row ->> 'so_item_id');
    v_qty := erp_round_qty((v_row ->> 'ship_qty')::numeric);
    v_alloc := least(v_qty, v_free);
    v_result := v_result || jsonb_build_object(v_key, v_alloc);
    v_free := v_free - v_alloc;
    exit when v_free <= 0;
  end loop;

  return v_result;
end;
$$;

-- ── 主計價：DB 重算（權威）────────────────────────────────────
create or replace function public.erp_calc_shipment_pricing(
  p_so_id text,
  p_customer_id text,
  p_ship_date date,
  p_items_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_so_id text := erp_norm_id(p_so_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_so record;
  v_currency text;
  v_item jsonb;
  v_i int;
  v_so_item_id text;
  v_so_item record;
  v_lot_id text;
  v_lot record;
  v_ship_qty numeric;
  v_line_key text;
  v_product_id text;
  v_list_price numeric;
  v_prod_exists boolean;
  v_promo record;
  v_grouped jsonb := '{}'::jsonb;
  v_prod text;
  v_rows jsonb;
  v_sum_ship numeric;
  v_free_total numeric;
  v_free_map jsonb;
  v_row jsonb;
  v_base numeric;
  v_settle numeric;
  v_billable numeric;
  v_free numeric;
  v_amount numeric;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_remark text := 'General shipment commercial';
  v_promo_names text := '';
begin
  if v_so_id = '' then raise exception 'ERR_SO_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_REQUIRED'; end if;
  if p_ship_date is null then raise exception 'ERR_SHIP_DATE_REQUIRED'; end if;
  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' or jsonb_array_length(p_items_json) < 1 then
    raise exception 'ERR_ITEMS_REQUIRED';
  end if;

  select * into v_so from sales_order where so_id = v_so_id;
  if not found then
    raise exception 'ERR_SO_NOT_FOUND: %', v_so_id;
  end if;
  if erp_norm_id(v_so.customer_id) <> v_cust then
    raise exception 'ERR_CUSTOMER_SO_MISMATCH';
  end if;

  v_currency := upper(trim(coalesce(v_so.currency, '')));
  if v_currency = '' then
    raise exception 'ERR_SO_CURRENCY_MISSING';
  end if;

  -- 驗證每行 + 分組（product_id）；每行帶唯一 line_key
  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_line_key := coalesce(
      nullif(trim(v_item ->> 'line_key'), ''),
      nullif(trim(v_item ->> 'item_seq'), ''),
      nullif(trim(v_item ->> 'shipment_item_id'), ''),
      'LINE-' || lpad((v_i + 1)::text, 3, '0')
    );
    v_so_item_id := erp_norm_id(v_item ->> 'so_item_id');
    v_lot_id := erp_norm_id(v_item ->> 'lot_id');
    v_ship_qty := erp_round_qty((v_item ->> 'ship_qty')::numeric);

    if v_so_item_id = '' then raise exception 'ERR_SO_ITEM_REQUIRED at items[%]', v_i; end if;
    if v_lot_id = '' then raise exception 'ERR_LOT_REQUIRED at items[%]', v_i; end if;
    if v_ship_qty <= 0 then raise exception 'ERR_SHIP_QTY_INVALID at items[%]', v_i; end if;

    select * into v_so_item
    from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id;

    if not found then
      raise exception 'ERR_SO_ITEM_NOT_IN_SO: %', v_so_item_id;
    end if;

    select * into v_lot from lot where lot_id = v_lot_id;
    if not found then
      raise exception 'ERR_LOT_NOT_FOUND: %', v_lot_id;
    end if;

    v_product_id := erp_norm_id(v_so_item.product_id);
    if v_product_id = '' then
      raise exception 'ERR_SO_ITEM_PRODUCT_MISSING: %', v_so_item_id;
    end if;

    select exists(select 1 from product where product_id = v_product_id) into v_prod_exists;
    if not v_prod_exists then
      raise exception 'ERR_PRODUCT_NOT_FOUND: %', v_product_id;
    end if;

    if v_product_id <> erp_norm_id(v_lot.product_id) then
      raise exception 'ERR_PRODUCT_LOT_MISMATCH: so_item % lot %', v_so_item_id, v_lot_id;
    end if;

    select coalesce(p.suggested_retail_price, 0) into v_list_price
    from product p where product_id = v_product_id;

    v_row := jsonb_build_object(
      'line_key', v_line_key,
      'so_item_id', v_so_item_id,
      'product_id', v_product_id,
      'ship_qty', v_ship_qty,
      'so_unit_price', coalesce(v_so_item.unit_price, 0),
      'list_unit_price', v_list_price
    );

    if v_grouped ? v_product_id then
      v_grouped := jsonb_set(
        v_grouped,
        array[v_product_id],
        (v_grouped -> v_product_id) || jsonb_build_array(v_row),
        true
      );
    else
      v_grouped := jsonb_set(v_grouped, array[v_product_id], jsonb_build_array(v_row), true);
    end if;
  end loop;

  -- 依產品計促銷（PER_SHIPMENT）
  for v_prod, v_rows in select key, value from jsonb_each(v_grouped) loop
    v_sum_ship := 0;
    for v_i in 0 .. jsonb_array_length(v_rows) - 1 loop
      v_sum_ship := v_sum_ship + erp_round_qty((v_rows -> v_i ->> 'ship_qty')::numeric);
    end loop;

    select * into v_promo
    from erp_promo_pick_for_product_(v_cust, p_ship_date, v_prod)
    limit 1;

    select coalesce(p.suggested_retail_price, 0) into v_list_price
    from product p where product_id = v_prod;

    if coalesce(v_promo.scheme_id, '') <> '' then
      if upper(trim(coalesce(v_promo.promo_type, ''))) = 'BUY_N_GET_M' then
        v_free_total := erp_calc_buy_n_get_m_free_(v_sum_ship, v_promo.buy_qty, v_promo.free_qty);
        v_rows := (
          select jsonb_agg(
            elem || jsonb_build_object(
              'promo_scheme_id', v_promo.scheme_id,
              'promo_scheme_name', v_promo.scheme_name,
              'promo_type', v_promo.promo_type,
              'promo_price_basis', v_promo.price_basis,
              'base_unit_price', erp_resolve_shipment_base_unit_price_(
                v_cust,
                p_ship_date,
                (elem ->> 'so_unit_price')::numeric,
                (elem ->> 'list_unit_price')::numeric,
                v_promo.price_basis
              )
            )
          )
          from jsonb_array_elements(v_rows) elem
        );
        v_free_map := erp_allocate_free_qty_high_price_(v_rows, v_free_total);

        for v_i in 0 .. jsonb_array_length(v_rows) - 1 loop
          v_row := v_rows -> v_i;
          v_line_key := coalesce(nullif(trim(v_row ->> 'line_key'), ''), v_row ->> 'so_item_id');
          v_ship_qty := erp_round_qty((v_row ->> 'ship_qty')::numeric);
          v_base := erp_round_money((v_row ->> 'base_unit_price')::numeric);
          v_free := erp_round_qty(coalesce((v_free_map ->> v_line_key)::numeric, 0));
          v_billable := erp_round_qty(v_ship_qty - v_free);
          v_settle := erp_promo_settle_unit_price_(
            v_base, v_promo.promo_type, v_promo.promo_unit_price, v_promo.discount_pct
          );
          v_amount := erp_round_money(v_billable * v_settle);

          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'line_key', v_line_key,
            'so_item_id', v_row ->> 'so_item_id',
            'product_id', v_prod,
            'ship_qty', v_ship_qty,
            'billable_qty', v_billable,
            'free_qty', v_free,
            'base_unit_price', v_base,
            'settle_unit_price', v_settle,
            'unit_price', v_settle,
            'amount', v_amount,
            'promo_scheme_id', coalesce(v_promo.scheme_id, ''),
            'promo_scheme_name', coalesce(v_promo.scheme_name, ''),
            'promo_type', coalesce(v_promo.promo_type, ''),
            'promo_price_basis', coalesce(v_promo.price_basis, ''),
            'promo_discount_pct', v_promo.discount_pct,
            'promo_buy_qty', v_promo.buy_qty,
            'promo_scheme_free_qty', v_promo.free_qty,
            'calc_scope', 'PER_SHIPMENT'
          ));
          v_total := v_total + v_amount;
        end loop;
      else
        for v_i in 0 .. jsonb_array_length(v_rows) - 1 loop
          v_row := v_rows -> v_i;
          v_line_key := coalesce(nullif(trim(v_row ->> 'line_key'), ''), v_row ->> 'so_item_id');
          v_ship_qty := erp_round_qty((v_row ->> 'ship_qty')::numeric);
          v_base := erp_resolve_shipment_base_unit_price_(
            v_cust,
            p_ship_date,
            (v_row ->> 'so_unit_price')::numeric,
            (v_row ->> 'list_unit_price')::numeric,
            v_promo.price_basis
          );
          v_settle := erp_promo_settle_unit_price_(
            v_base, v_promo.promo_type, v_promo.promo_unit_price, v_promo.discount_pct
          );
          v_amount := erp_round_money(v_ship_qty * v_settle);

          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'line_key', v_line_key,
            'so_item_id', v_row ->> 'so_item_id',
            'product_id', v_prod,
            'ship_qty', v_ship_qty,
            'billable_qty', v_ship_qty,
            'free_qty', 0,
            'base_unit_price', v_base,
            'settle_unit_price', v_settle,
            'unit_price', v_settle,
            'amount', v_amount,
            'promo_scheme_id', coalesce(v_promo.scheme_id, ''),
            'promo_scheme_name', coalesce(v_promo.scheme_name, ''),
            'promo_type', coalesce(v_promo.promo_type, ''),
            'promo_price_basis', coalesce(v_promo.price_basis, ''),
            'promo_discount_pct', v_promo.discount_pct,
            'promo_buy_qty', v_promo.buy_qty,
            'promo_scheme_free_qty', v_promo.free_qty,
            'calc_scope', 'PER_SHIPMENT'
          ));
          v_total := v_total + v_amount;
        end loop;
      end if;

      if coalesce(v_promo.scheme_name, '') <> '' then
        v_promo_names := v_promo_names || case when v_promo_names <> '' then ', ' else '' end || v_promo.scheme_name;
      end if;
    else
      -- 無促銷：逐行 SO 單價
      for v_i in 0 .. jsonb_array_length(v_rows) - 1 loop
        v_row := v_rows -> v_i;
        v_line_key := coalesce(nullif(trim(v_row ->> 'line_key'), ''), v_row ->> 'so_item_id');
        v_ship_qty := erp_round_qty((v_row ->> 'ship_qty')::numeric);
        v_base := erp_round_money((v_row ->> 'so_unit_price')::numeric);
        v_amount := erp_round_money(v_ship_qty * v_base);

        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'line_key', v_line_key,
          'so_item_id', v_row ->> 'so_item_id',
          'product_id', v_prod,
          'ship_qty', v_ship_qty,
          'billable_qty', v_ship_qty,
          'free_qty', 0,
          'base_unit_price', v_base,
          'settle_unit_price', v_base,
          'unit_price', v_base,
          'amount', v_amount,
          'promo_scheme_id', '',
          'promo_scheme_name', '',
          'promo_type', '',
          'promo_price_basis', '',
          'calc_scope', 'PER_SHIPMENT'
        ));
        v_total := v_total + v_amount;
      end loop;
    end if;
  end loop;

  v_total := erp_round_money(v_total);
  if v_promo_names <> '' then
    v_remark := v_remark || ' | Promo: ' || v_promo_names;
  end if;

  return jsonb_build_object(
    'amount_system', v_total,
    'currency', v_currency,
    'system_remark', v_remark,
    'lines', v_lines,
    'calc_scope', 'PER_SHIPMENT',
    'pricing_source', 'DB_RECALC'
  );
end;
$$;

-- ── snapshot 僅對帳：不一致則 fail ────────────────────────────
create or replace function public.erp_assert_pricing_snapshot_diff_(
  p_db_pricing jsonb,
  p_snapshot jsonb,
  p_tolerance numeric default 0.01
)
returns void
language plpgsql
immutable
as $$
declare
  v_db numeric := erp_round_money((p_db_pricing ->> 'amount_system')::numeric);
  v_snap numeric;
  v_tol numeric := coalesce(p_tolerance, 0.01);
begin
  if p_snapshot is null or p_snapshot = 'null'::jsonb then
    return;
  end if;
  v_snap := erp_round_money((p_snapshot ->> 'amount_system')::numeric);
  if abs(v_db - v_snap) > v_tol then
    raise exception 'ERR_PRICING_SNAPSHOT_MISMATCH: db=% snapshot=%', v_db, v_snap;
  end if;
end;
$$;

comment on function public.erp_calc_shipment_pricing is
  'v4.2.12 草稿 v2.3：出貨計價 DB 權威；line_key 唯一；PER_SHIPMENT 促銷；累積制經銷價＝牌價×等級%';

revoke all on function public.erp_norm_id(text) from public;
revoke all on function public.erp_round_money(numeric) from public;
revoke all on function public.erp_round_qty(numeric) from public;
revoke all on function public.erp_parse_date_ymd_(text) from public;
revoke all on function public.erp_resolve_cumulative_dealer_price_rate_(text, date, text) from public;
revoke all on function public.erp_promo_pick_for_product_(text, date, text) from public;
revoke all on function public.erp_promo_settle_unit_price_(numeric, text, numeric, numeric) from public;
revoke all on function public.erp_resolve_shipment_base_unit_price_(text, date, numeric, numeric, text) from public;
revoke all on function public.erp_calc_buy_n_get_m_free_(numeric, numeric, numeric) from public;
revoke all on function public.erp_allocate_free_qty_high_price_(jsonb, numeric) from public;
revoke all on function public.erp_calc_shipment_pricing(text, text, date, jsonb) from public;
revoke all on function public.erp_assert_pricing_snapshot_diff_(jsonb, jsonb, numeric) from public;

grant execute on function public.erp_round_money(numeric) to service_role;
grant execute on function public.erp_resolve_shipment_base_unit_price_(text, date, numeric, numeric, text) to service_role;
grant execute on function public.erp_calc_shipment_pricing(text, text, date, jsonb) to service_role;
grant execute on function public.erp_assert_pricing_snapshot_diff_(jsonb, jsonb, numeric) to service_role;
