-- ERP v4.3.13：AR Phase4 slice4 — gap writeoff + 批次收款 RPC 原子化【僅 DEV】
-- 前置：v4.3.10 → v4.3.12
-- Node 規劃金額／分配；RPC 負責 payment + gap 調整 + AR 同步（單一 transaction）

-- ── gap writeoff 輔助 ─────────────────────────────────────────────
create or replace function public.erp_ar_new_adjust_id_()
returns text
language sql
as $$
  select 'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
         upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
$$;

create or replace function public.erp_ar_apply_gap_writeoff_for_payment_(
  p_payment_id text,
  p_ar_id text,
  p_amount_before numeric,
  p_amount_after numeric,
  p_reason text,
  p_adjust_id text,
  p_actor text,
  p_ts timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid text := erp_norm_id(p_payment_id);
  v_ar_id text := erp_norm_id(p_ar_id);
  v_adj_id text := erp_norm_id(p_adjust_id);
  v_before numeric := erp_round_money(coalesce(p_amount_before, 0));
  v_after numeric := erp_round_money(coalesce(p_amount_after, 0));
begin
  if v_pid = '' or v_ar_id = '' then raise exception 'payment_id and ar_id required'; end if;

  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = 'PAYMENT_GAP_WRITEOFF' and source_id = v_pid
  ) then
    select adjust_id into v_adj_id
    from ar_amount_adjustment_log
    where source_type = 'PAYMENT_GAP_WRITEOFF' and source_id = v_pid
    limit 1;
    return v_adj_id;
  end if;

  if v_adj_id = '' then v_adj_id := erp_ar_new_adjust_id_(); end if;

  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      v_adj_id, v_ar_id, v_before, v_after, trim(coalesce(p_reason, '')),
      trim(coalesce(p_actor, '')), coalesce(p_ts, now()),
      'PAYMENT_GAP_WRITEOFF', v_pid
    );
  exception when unique_violation then
    select adjust_id into v_adj_id
    from ar_amount_adjustment_log
    where source_type = 'PAYMENT_GAP_WRITEOFF' and source_id = v_pid
    limit 1;
  end;

  update ar_payment
  set system_remark = left('gap_writeoff|adjust_id=' || v_adj_id, 4000),
      updated_by = trim(coalesce(p_actor, '')),
      updated_at = coalesce(p_ts, now())
  where payment_id = v_pid;

  return v_adj_id;
end;
$$;

create or replace function public.erp_ar_restore_gap_writeoff_for_payment_(
  p_payment_id text,
  p_ar_id text,
  p_current_due numeric,
  p_actor text,
  p_ts timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid text := erp_norm_id(p_payment_id);
  v_ar_id text := erp_norm_id(p_ar_id);
  v_due numeric := erp_round_money(coalesce(p_current_due, 0));
  v_adj ar_amount_adjustment_log%rowtype;
  v_restored_due numeric;
  v_rev_id text;
begin
  select * into v_adj
  from ar_amount_adjustment_log
  where source_type = 'PAYMENT_GAP_WRITEOFF' and source_id = v_pid
  limit 1;

  if not found then
  begin
    select a.* into v_adj
    from ar_amount_adjustment_log a
    join ar_payment p on position('gap_writeoff|adjust_id=' || a.adjust_id in coalesce(p.system_remark, '')) > 0
    where p.payment_id = v_pid and a.ar_id = v_ar_id
    limit 1;
  exception when others then
    null;
  end;
  end if;

  if not found then
    return jsonb_build_object('due', v_due, 'restored', false);
  end if;

  v_restored_due := erp_round_money(coalesce(v_adj.amount_before, 0));
  if abs(v_due - v_restored_due) < 0.0000001 then
    return jsonb_build_object('due', v_due, 'restored', false);
  end if;

  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = 'PAYMENT_GAP_WRITEOFF_VOID' and source_id = v_pid
  ) then
    return jsonb_build_object('due', v_restored_due, 'restored', true);
  end if;

  v_rev_id := erp_ar_new_adjust_id_();
  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      v_rev_id, v_ar_id, v_due, v_restored_due,
      '作廢收款還原沖銷差額（' || coalesce(v_adj.reason, '') || '）',
      trim(coalesce(p_actor, '')), coalesce(p_ts, now()),
      'PAYMENT_GAP_WRITEOFF_VOID', v_pid
    );
  exception when unique_violation then
    null;
  end;

  return jsonb_build_object('due', v_restored_due, 'restored', true);
end;
$$;

-- ── 登記收款（含可選 gap writeoff）────────────────────────────────
drop function if exists public.erp_ar_post_payment_phase4_tx(text, text, date, numeric, text, text, timestamptz, text);

create or replace function public.erp_ar_post_payment_phase4_tx(
  p_payment_id text,
  p_ar_id text,
  p_payment_date date,
  p_amount numeric,
  p_remark text default '',
  p_actor text default '',
  p_ts timestamptz default now(),
  p_ar_remark_append text default '',
  p_gap_writeoff_json jsonb default null
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
  v_target_due numeric;
  v_gap_before numeric;
  v_gap_after numeric;
  v_gap_reason text;
  v_gap_adj_id text;
  v_gap_append text := '';
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
      'ok', true, 'idempotent', true, 'payment_rpc', true,
      'ar_id', v_ar_id, 'payment_id', v_pid,
      'amount_received', erp_round_money(erp_ar_sum_valid_payments_(v_ar_id)),
      'amount_due', erp_round_money(coalesce(v_due, 0)),
      'status', erp_ar_calc_status_from_amounts_(v_due, erp_ar_sum_valid_payments_(v_ar_id)),
      'gap_writeoff', p_gap_writeoff_json is not null
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

  v_target_due := erp_round_money(coalesce(v_ar.amount_due, 0));

  if p_gap_writeoff_json is not null and p_gap_writeoff_json <> 'null'::jsonb then
    v_gap_before := erp_round_money(coalesce((p_gap_writeoff_json ->> 'amount_before')::numeric, v_target_due));
    v_gap_after := erp_round_money(coalesce((p_gap_writeoff_json ->> 'amount_after')::numeric, v_target_due));
    v_gap_reason := trim(coalesce(p_gap_writeoff_json ->> 'reason', ''));
    v_gap_adj_id := erp_norm_id(p_gap_writeoff_json ->> 'adjust_id');

    v_gap_adj_id := erp_ar_apply_gap_writeoff_for_payment_(
      v_pid, v_ar_id, v_gap_before, v_gap_after, v_gap_reason, v_gap_adj_id, v_actor, v_ts
    );
    v_target_due := v_gap_after;
    v_gap_append := '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
      ' 登記收款沖銷差額 ' || v_gap_before::text || ' → ' || v_gap_after::text ||
      '（' || v_pid || '）';
  end if;

  v_sync := erp_ar_sync_receivable_from_payments_(
    v_ar_id,
    v_target_due,
    v_actor,
    v_ts,
    left(trim(coalesce(p_ar_remark_append, '')) ||
      case when v_gap_append <> '' and coalesce(trim(p_ar_remark_append), '') <> '' then E'\n' else '' end ||
      v_gap_append, 4000)
  );

  return jsonb_build_object(
    'ok', true,
    'payment_rpc', true,
    'ar_id', v_ar_id,
    'payment_id', v_pid,
    'amount_received', v_sync ->> 'amount_received',
    'amount_due', v_sync ->> 'amount_due',
    'status', v_sync ->> 'status',
    'reopened', coalesce((v_sync ->> 'reopened')::boolean, false),
    'gap_writeoff', p_gap_writeoff_json is not null
  );
end;
$$;

-- ── 作廢收款（含 gap 還原）────────────────────────────────────────
drop function if exists public.erp_ar_void_payment_phase4_tx(text, text, text, timestamptz, text);

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
  v_restore jsonb;
  v_target_due numeric;
  v_gap_append text := '';
begin
  if v_pid = '' then raise exception 'payment_id required'; end if;

  select * into v_pay from ar_payment where payment_id = v_pid for update;
  if not found then raise exception 'Payment not found: %', v_pid; end if;

  v_ar_id := erp_norm_id(v_pay.ar_id);

  if upper(trim(coalesce(v_pay.status, 'POSTED'))) = 'VOID'
     or position('VOIDED|' in coalesce(v_pay.system_remark, '')) > 0 then
    select * into v_ar from ar_receivable where ar_id = v_ar_id;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'void_rpc', true, 'payment_status', 'VOID',
      'ar_id', v_ar_id, 'payment_id', v_pid,
      'voided_amount', erp_round_money(coalesce(v_pay.amount, 0)),
      'amount_received', erp_round_money(erp_ar_sum_valid_payments_(v_ar_id)),
      'status', coalesce(v_ar.status, 'OPEN'), 'reopened', false
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

  v_restore := erp_ar_restore_gap_writeoff_for_payment_(
    v_pid, v_ar_id, erp_round_money(coalesce(v_ar.amount_due, 0)), v_actor, v_ts
  );
  v_target_due := erp_round_money(coalesce((v_restore ->> 'due')::numeric, v_ar.amount_due));
  if coalesce((v_restore ->> 'restored')::boolean, false) then
    v_gap_append := '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
      ' 作廢收款還原沖銷差額（應收 ' || erp_round_money(v_ar.amount_due)::text ||
      ' → ' || v_target_due::text || '）';
  end if;

  v_sync := erp_ar_sync_receivable_from_payments_(
    v_ar_id,
    v_target_due,
    v_actor,
    v_ts,
    left(trim(coalesce(p_ar_remark_append, '')) ||
      case when v_gap_append <> '' and coalesce(trim(p_ar_remark_append), '') <> '' then E'\n' else '' end ||
      v_gap_append, 4000)
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
    'ok', true, 'void_rpc', true, 'payment_status', 'VOID',
    'ar_id', v_ar_id, 'payment_id', v_pid,
    'voided_amount', v_void_amount,
    'amount_received', v_sync ->> 'amount_received',
    'amount_due', v_sync ->> 'amount_due',
    'status', v_sync ->> 'status',
    'reopened', coalesce((v_sync ->> 'reopened')::boolean, false),
    'gap_restored', coalesce((v_restore ->> 'restored')::boolean, false)
  );
end;
$$;

-- ── 批次收款 POST ─────────────────────────────────────────────────
create or replace function public.erp_ar_post_payment_batch_phase4_tx(
  p_batch_id text,
  p_payment_date date,
  p_allocations_json jsonb,
  p_remark_prefix text default '',
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch text := erp_norm_id(p_batch_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_prefix text := trim(coalesce(p_remark_prefix, ''));
  v_item jsonb;
  v_pid text;
  v_ar_id text;
  v_amount numeric;
  v_remark text;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if v_batch = '' then raise exception 'batch_id required'; end if;
  if p_payment_date is null then raise exception 'payment_date required'; end if;
  if p_allocations_json is null or jsonb_typeof(p_allocations_json) <> 'array' then
    raise exception 'allocations_json must be array';
  end if;
  if jsonb_array_length(p_allocations_json) <= 0 then
    raise exception 'allocations_json empty';
  end if;

  for v_item in select value from jsonb_array_elements(p_allocations_json) loop
    v_pid := erp_norm_id(v_item ->> 'payment_id');
    v_ar_id := erp_norm_id(v_item ->> 'ar_id');
    v_amount := erp_round_money(coalesce((v_item ->> 'amount')::numeric, 0));
    v_remark := coalesce(nullif(trim(v_item ->> 'remark'), ''), v_prefix);

    if v_pid = '' or v_ar_id = '' then
      raise exception 'allocation missing payment_id or ar_id';
    end if;
    if v_amount <= 0.0000001 then
      raise exception 'allocation amount must be > 0: %', v_pid;
    end if;

    v_res := erp_ar_post_payment_phase4_tx(
      v_pid, v_ar_id, p_payment_date, v_amount, v_remark, v_actor, v_ts, '',
      null
    );

    update ar_payment
    set system_remark = left('batch_id=' || v_batch, 4000),
        updated_by = v_actor,
        updated_at = v_ts
    where payment_id = v_pid
      and position('batch_id=' in coalesce(system_remark, '')) = 0;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'ar_id', v_ar_id,
      'payment_id', v_pid,
      'amount', v_amount,
      'amount_received', v_res ->> 'amount_received',
      'status', v_res ->> 'status'
    ));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'batch_rpc', true,
    'batch_id', v_batch,
    'allocations', v_results
  );
end;
$$;

-- ── 批次收款 VOID ─────────────────────────────────────────────────
create or replace function public.erp_ar_void_payment_batch_phase4_tx(
  p_batch_id text,
  p_void_reason text default '',
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch text := erp_norm_id(p_batch_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_pay record;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count int := 0;
  v_void_append text;
begin
  if v_batch = '' then raise exception 'batch_id required'; end if;

  for v_pay in
    select payment_id, ar_id, amount
    from ar_payment
    where position('batch_id=' || v_batch in coalesce(system_remark, '')) > 0
      and upper(trim(coalesce(status, 'POSTED'))) <> 'VOID'
      and position('VOIDED|' in coalesce(system_remark, '')) = 0
    order by ar_id, payment_id
    for update
  loop
    v_void_append := '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
      ' 作廢收款 ' || erp_round_money(v_pay.amount)::text ||
      '（' || erp_norm_id(v_pay.payment_id) || '）' ||
      case when v_reason <> '' then '：' || v_reason else '' end;

    v_res := erp_ar_void_payment_phase4_tx(
      erp_norm_id(v_pay.payment_id), v_reason, v_actor, v_ts, v_void_append
    );

    v_count := v_count + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'ar_id', v_res ->> 'ar_id',
      'payment_id', v_res ->> 'payment_id',
      'voided_amount', v_res ->> 'voided_amount',
      'amount_received', v_res ->> 'amount_received',
      'status', v_res ->> 'status',
      'reopened', v_res ->> 'reopened'
    ));
  end loop;

  if v_count <= 0 then
    raise exception 'Batch not found or already voided: %', v_batch;
  end if;

  return jsonb_build_object(
    'ok', true,
    'batch_void_rpc', true,
    'batch_id', v_batch,
    'voided_count', v_count,
    'allocations', v_results
  );
end;
$$;

comment on function public.erp_ar_post_payment_phase4_tx is
  'v4.3.13 Phase4 slice4：登記收款原子 transaction（可含 gap writeoff）';
comment on function public.erp_ar_void_payment_phase4_tx is
  'v4.3.13 Phase4 slice4：作廢收款原子 transaction（含 gap 還原）';
comment on function public.erp_ar_post_payment_batch_phase4_tx is
  'v4.3.13 Phase4 slice4：批次收款原子 transaction';
comment on function public.erp_ar_void_payment_batch_phase4_tx is
  'v4.3.13 Phase4 slice4：批次作廢收款原子 transaction';

revoke all on function public.erp_ar_new_adjust_id_() from public;
revoke all on function public.erp_ar_apply_gap_writeoff_for_payment_(text, text, numeric, numeric, text, text, text, timestamptz) from public;
revoke all on function public.erp_ar_restore_gap_writeoff_for_payment_(text, text, numeric, text, timestamptz) from public;
revoke all on function public.erp_ar_post_payment_phase4_tx(text, text, date, numeric, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.erp_ar_void_payment_phase4_tx(text, text, text, timestamptz, text) from public;
revoke all on function public.erp_ar_post_payment_batch_phase4_tx(text, date, jsonb, text, text, timestamptz) from public;
revoke all on function public.erp_ar_void_payment_batch_phase4_tx(text, text, text, timestamptz) from public;

grant execute on function public.erp_ar_new_adjust_id_() to service_role;
grant execute on function public.erp_ar_apply_gap_writeoff_for_payment_(text, text, numeric, numeric, text, text, text, timestamptz) to service_role;
grant execute on function public.erp_ar_restore_gap_writeoff_for_payment_(text, text, numeric, text, timestamptz) to service_role;
grant execute on function public.erp_ar_post_payment_phase4_tx(text, text, date, numeric, text, text, timestamptz, text, jsonb) to service_role;
grant execute on function public.erp_ar_void_payment_phase4_tx(text, text, text, timestamptz, text) to service_role;
grant execute on function public.erp_ar_post_payment_batch_phase4_tx(text, date, jsonb, text, text, timestamptz) to service_role;
grant execute on function public.erp_ar_void_payment_batch_phase4_tx(text, text, text, timestamptz) to service_role;
