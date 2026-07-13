-- ERP v4.3.10：AR Phase4 slice1 — 收款正式 status（不再只靠 system_remark VOIDED|）【僅 DEV】
-- 前置：v4.2.1 應收表、v4.3.4 erp_ar_sum_valid_payments_

alter table ar_payment
  add column if not exists status text not null default 'POSTED',
  add column if not exists void_reason text default '',
  add column if not exists voided_by text default '',
  add column if not exists voided_at timestamptz;

alter table ar_payment drop constraint if exists ar_payment_status_chk;
alter table ar_payment add constraint ar_payment_status_chk
  check (upper(trim(coalesce(status, ''))) in ('POSTED', 'VOID'));

comment on column ar_payment.status is 'POSTED=有效收款；VOID=已作廢（金額欄保留原值供對帳）';
comment on column ar_payment.void_reason is '作廢原因';
comment on column ar_payment.voided_by is '作廢人';
comment on column ar_payment.voided_at is '作廢時間';

create index if not exists idx_ap_status on ar_payment (status);

-- 既有作廢收款：標記 VOID
update ar_payment
set status = 'VOID'
where upper(trim(coalesce(status, 'POSTED'))) <> 'VOID'
  and (
    position('VOIDED|' in coalesce(system_remark, '')) > 0
    or (
      coalesce(amount, 0) <= 0.0000001
      and coalesce(remark, '') like '[已作廢]%'
    )
  );

-- 還原曾被歸零的作廢金額（從舊 system_remark 解析）
update ar_payment
set amount = erp_round_money(
  (regexp_match(coalesce(system_remark, ''), 'VOIDED\|amount=([0-9.]+)'))[1]::numeric
)
where upper(trim(coalesce(status, ''))) = 'VOID'
  and coalesce(amount, 0) <= 0.0000001
  and coalesce(system_remark, '') ~ 'VOIDED\|amount=[0-9.]+';

-- 解析 voided_at / voided_by（舊 remark 備援）
update ar_payment
set voided_at = coalesce(
      voided_at,
      (regexp_match(coalesce(system_remark, ''), 'VOIDED\|(?:[^|]*\|)*at=([^|]+)'))[1]::timestamptz
    ),
    voided_by = coalesce(
      nullif(trim(voided_by), ''),
      nullif(trim((regexp_match(coalesce(system_remark, ''), 'VOIDED\|(?:[^|]*\|)*by=([^|]+)'))[1]), '')
    )
where upper(trim(coalesce(status, ''))) = 'VOID';

-- 有效收款合計（status 為準；保留 legacy VOIDED| 過渡）
create or replace function public.erp_ar_sum_valid_payments_(p_ar_id text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(
    case
      when upper(trim(coalesce(status, 'POSTED'))) = 'VOID' then 0
      when position('VOIDED|' in coalesce(system_remark, '')) > 0 then 0
      when coalesce(amount, 0) <= 0.000000001 then 0
      else amount
    end
  ), 0)::numeric
  from ar_payment
  where ar_id = erp_norm_id(p_ar_id);
$$;

revoke all on function public.erp_ar_sum_valid_payments_(text) from public;
grant execute on function public.erp_ar_sum_valid_payments_(text) to service_role;

comment on function public.erp_ar_sum_valid_payments_ is
  'v4.3.10 Phase4：有效收款合計；以 ar_payment.status=POSTED 為準';
