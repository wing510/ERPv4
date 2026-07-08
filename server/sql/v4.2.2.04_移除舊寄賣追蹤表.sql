-- ERP v4.2.2 遷移步驟 4（可選）：移除 v4.2.1 寄賣追蹤表
-- ⚠ 僅在確認無舊 CT 資料、且 v4.2.2 案件流程已上線後執行
-- ⚠ 不影響 ar_receivable / ar_payment（v4.2.1 應收仍保留）
-- DEV 可先跑 dev_clear 清空資料，再執行本檔 DROP

-- 依賴順序：子表 → 父表
drop table if exists public.consignment_return_item cascade;
drop table if exists public.consignment_return cascade;
drop table if exists public.consignment_settlement_item cascade;
drop table if exists public.consignment_settlement cascade;
drop table if exists public.consignment_track_item cascade;
drop table if exists public.consignment_track cascade;
