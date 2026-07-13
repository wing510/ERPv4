-- ERP v4.3.11：AR Phase4 slice2 — 收款 POST/VOID 單一 DB transaction【僅 DEV】
-- 前置：v4.3.10_AR收款狀態Phase4.sql
-- 計算仍由 Node 權威（金額、日期、備註）；RPC 負責原子寫入 payment + ar_receivable 同步
-- 沖銷差額（gap writeoff）仍走 Node 多步（Phase4 slice4）

create or replace function public.erp_ar_calc_status_from_amounts_(p_due numeric, p_received numeric)
returns text
language plpgsql
immutable
as $$
declare
  v_due numeric := erp_round_money(coalesce(p_due, 0));
  v_rec numeric := erp_round_money(coalesce(p_received, 0));
begin
  if v_rec <= 0.0000001 then
    return 'OPEN';
  end if;
  if v_rec + 0.0000001 >= v_due then
    return 'SETTLED';
  end if;
  return 'PARTIAL';
end;
$$;

create or replace function public.erp_ar_sync_receivable_from_payments_(
  p_ar_id text,
  p_amount_due numeric,
  p_actor text,
  p_ts timestamptz,
  p_remark_append text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ar_id text := erp_norm_id(p_ar_id);
  v_ar ar_receivable%rowtype;
  v_due numeric;
  v_rec numeric;
  v_status text;
  v_was_settled boolean;
  v_reopened boolean := false;
begin
  select * into v_ar from ar_receivable where ar_id = v_ar_id for update;
  if not found then
    raise exception 'AR not found: %', v_ar_id;
  end if;

  v_due := erp_round_money(coalesce(p_amount_due, v_ar.amount_due, 0));
  v_rec := erp_round_money(erp_ar_sum_valid_payments_(v_ar_id));
  v_was_settled := upper(trim(coalesce(v_ar.status, ''))) = 'SETTLED';
  v_status := erp_ar_calc_status_from_amounts_(v_due, v_rec);
  v_reopened := v_was_settled and v_status <> 'SETTLED';

  update ar_receivable
  set amount_due = v_due,
      amount_received = v_rec,
      status = v_status,
      close_mode = case when v_status = 'SETTLED' then 'NORMAL' else '' end,
      close_reason = case when v_status = 'SETTLED' then '' else '' end,
      closed_by = case when v_status = 'SETTLED' then coalesce(nullif(trim(p_actor), ''), closed_by) else '' end,
      closed_at = case when v_status = 'SETTLED' then coalesce(p_ts, now()) else null end,
      updated_by = coalesce(nullif(trim(p_actor), ''), updated_by),
      updated_at = coalesce(p_ts, now()),
      system_remark = left(
        trim(coalesce(system_remark, '')) ||
        case
          when coalesce(trim(p_remark_append), '') <> '' and coalesce(system_remark, '') <> '' then E'\n'
          else ''
        end ||
        coalesce(trim(p_remark_append), ''),
        4000
      )
  where ar_id = v_ar_id;

  return jsonb_build_object(
    'amount_due', v_due,
    'amount_received', v_rec,
    'status', v_status,
    'reopened', v_reopened
  );
end;
$$;

create or replace function public.erp_ar_post_payment_phase4_tx(
  p_payment_id text,
  p_ar_id text,
  p_payment_date date,
  p_amount numeric,
  p_remark text default '',
  p_actor text default '',
  p_ts timestamptz default now(),
  p_ar_remark_append text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid text := erp_norm_id(p_payment_id);
  v_ar_id text := erp_norm_id(p_ar_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_amount numeric := erp_round_money(coalesce(p_amount, 0));
  v_ar ar_receivable%rowtype;
  v_pay ar_payment%rowtype;
  v_sync jsonb;
  v_due numeric;
begin
  if v_pid = '' then raise exception 'payment_id required'; end if;
  if v_ar_id = '' then raise exception 'ar_id required'; end if;
  if v_amount <= 0.0000001 then raise exception 'amount must be > 0'; end if;
  if p_payment_date is null then raise exception 'payment_date required'; end if;

  select * into v_pay from ar_payment where payment_id = v_pid;
  if found then
    if upper(trim(coalesce(v_pay.status, 'POSTED'))) = 'VOID'
       or position('VOIDED|' in coalesce(v_pay.system_remark, '')) > 0 then
      raise exception 'Payment was voided: %', v_pid;
    end if;
    if erp_norm_id(v_pay.ar_id) <> v_ar_id then
      raise exception 'Payment belongs to different AR';
    end if;
    select amount_due into v_due from ar_receivable where ar_id = v_ar_id;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'payment_rpc', true,
      'ar_id', v_ar_id,
      'payment_id', v_pid,
      'amount_received', erp_round_money(erp_ar_sum_valid_payments_(v_ar_id)),
      'amount_due', erp_round_money(coalesce(v_due, 0)),
      'status', erp_ar_calc_status_from_amounts_(v_due, erp_ar_sum_valid_payments_(v_ar_id))
    );
  end if;

  select * into v_ar from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'AR not found: %', v_ar_id; end if;
  if upper(trim(coalesce(v_ar.status, ''))) = 'SETTLED' then
    raise exception 'AR already SETTLED';
  end if;

  insert into ar_payment (
    payment_id, ar_id, payment_date, amount, status, remark,
    created_by, created_at, updated_by, updated_at, system_remark
  ) values (
    v_pid, v_ar_id, p_payment_date, v_amount, 'POSTED', coalesce(p_remark, ''),
    v_actor, v_ts, '', null, ''
  );

  v_sync := erp_ar_sync_receivable_from_payments_(
    v_ar_id,
    v_ar.amount_due,
    v_actor,
    v_ts,
    coalesce(p_ar_remark_append, '')
  );

  return jsonb_build_object(
    'ok', true,
    'payment_rpc', true,
    'ar_id', v_ar_id,
    'payment_id', v_pid,
    'amount_received', v_sync ->> 'amount_received',
    'amount_due', v_sync ->> 'amount_due',
    'status', v_sync ->> 'status',
    'reopened', coalesce((v_sync ->> 'reopened')::boolean, false)
  );
end;
$$;

create or replace function public.erp_ar_void_payment_phase4_tx(
  p_payment_id text,
  p_void_reason text default '',
  p_actor text default '',
  p_ts timestamptz default now(),
  p_ar_remark_append text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid text := erp_norm_id(p_payment_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_pay ar_payment%rowtype;
  v_ar ar_receivable%rowtype;
  v_ar_id text;
  v_void_amount numeric;
  v_original_remark text;
  v_orig_enc text;
  v_void_remark text;
  v_pay_sm text;
  v_sync jsonb;
begin
  if v_pid = '' then raise exception 'payment_id required'; end if;

  select * into v_pay from ar_payment where payment_id = v_pid for update;
  if not found then raise exception 'Payment not found: %', v_pid; end if;

  v_ar_id := erp_norm_id(v_pay.ar_id);

  if upper(trim(coalesce(v_pay.status, 'POSTED'))) = 'VOID'
     or position('VOIDED|' in coalesce(v_pay.system_remark, '')) > 0 then
    select * into v_ar from ar_receivable where ar_id = v_ar_id;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'void_rpc', true,
      'payment_status', 'VOID',
      'ar_id', v_ar_id,
      'payment_id', v_pid,
      'voided_amount', erp_round_money(coalesce(v_pay.amount, 0)),
      'amount_received', erp_round_money(erp_ar_sum_valid_payments_(v_ar_id)),
      'status', coalesce(v_ar.status, 'OPEN'),
      'reopened', false
    );
  end if;

  select * into v_ar from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'AR not found: %', v_ar_id; end if;

  v_void_amount := erp_round_money(coalesce(v_pay.amount, 0));
  v_original_remark := trim(coalesce(v_pay.remark, ''));
  v_orig_enc := replace(replace(replace(v_original_remark, '%', '%25'), '|', '%7C'), E'\n', '%0A');
  v_void_remark := '[已作廢] ' ||
    to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD HH24:MI') ||
    case when v_actor <> '' then '· ' || v_actor else '' end;

  v_pay_sm := trim(coalesce(v_pay.system_remark, '')) ||
    case when coalesce(v_pay.system_remark, '') <> '' then E'\n' else '' end ||
    'VOIDED|amount=' || v_void_amount::text ||
    '|at=' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') ||
    '|by=' || v_actor ||
    case when v_reason <> '' then '|reason=' || v_reason else '' end ||
    '|orig_remark=' || v_orig_enc;

  update ar_payment
  set status = 'VOID',
      void_reason = v_reason,
      voided_by = v_actor,
      voided_at = v_ts,
      remark = v_void_remark,
      updated_by = v_actor,
      updated_at = v_ts,
      system_remark = left(v_pay_sm, 4000)
  where payment_id = v_pid;

  v_sync := erp_ar_sync_receivable_from_payments_(
    v_ar_id,
    v_ar.amount_due,
    v_actor,
    v_ts,
    coalesce(p_ar_remark_append, '')
  );

  if coalesce((v_sync ->> 'reopened')::boolean, false) then
    update ar_receivable
    set system_remark = left(
      trim(coalesce(system_remark, '')) ||
      case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
      '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
      ' 作廢收款後重開 AR（已收 ' || (v_sync ->> 'amount_received') ||
      '，應收 ' || (v_sync ->> 'amount_due') || '）',
      4000
    )
    where ar_id = v_ar_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'void_rpc', true,
    'payment_status', 'VOID',
    'ar_id', v_ar_id,
    'payment_id', v_pid,
    'voided_amount', v_void_amount,
    'amount_received', v_sync ->> 'amount_received',
    'amount_due', v_sync ->> 'amount_due',
    'status', v_sync ->> 'status',
    'reopened', coalesce((v_sync ->> 'reopened')::boolean, false)
  );
end;
$$;

comment on function public.erp_ar_post_payment_phase4_tx is
  'v4.3.11 Phase4 slice2：登記收款原子 transaction（payment POSTED + AR 已收同步）';
comment on function public.erp_ar_void_payment_phase4_tx is
  'v4.3.11 Phase4 slice2：作廢收款原子 transaction（payment VOID + AR 已收同步）';

revoke all on function public.erp_ar_calc_status_from_amounts_(numeric, numeric) from public;
revoke all on function public.erp_ar_sync_receivable_from_payments_(text, numeric, text, timestamptz, text) from public;
revoke all on function public.erp_ar_post_payment_phase4_tx(text, text, date, numeric, text, text, timestamptz, text) from public;
revoke all on function public.erp_ar_void_payment_phase4_tx(text, text, text, timestamptz, text) from public;

grant execute on function public.erp_ar_calc_status_from_amounts_(numeric, numeric) to service_role;
grant execute on function public.erp_ar_sync_receivable_from_payments_(text, numeric, text, timestamptz, text) to service_role;
grant execute on function public.erp_ar_post_payment_phase4_tx(text, text, date, numeric, text, text, timestamptz, text) to service_role;
grant execute on function public.erp_ar_void_payment_phase4_tx(text, text, text, timestamptz, text) to service_role;
