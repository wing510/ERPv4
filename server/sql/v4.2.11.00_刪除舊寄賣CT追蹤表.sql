-- v4.2.11.00：刪除舊寄賣 CT 追蹤表（v4.2.1 舊流程）
-- 說明：
-- - v4.2.2 起已改用 consignment_case_*（案件版）取代
-- - 這批表僅為歷史/過渡保留；刪除不影響案件版
-- - 若表已不存在，本檔可重複執行（IF EXISTS）
--
-- 依賴順序：子表 → 父表

drop table if exists public.consignment_return_item cascade;
drop table if exists public.consignment_return cascade;

drop table if exists public.consignment_settlement_item cascade;
drop table if exists public.consignment_settlement cascade;

drop table if exists public.consignment_track_item cascade;
drop table if exists public.consignment_track cascade;

