## ERP 風險登記簿（Risk Register）

> 原則：新發現的相鄰風險只登記，不在本次 Phase 1 擴大修正。
>
> 更新日期：2026-07-14

### RR-2026-07-09-01：出貨過帳非單一 DB transaction（半成功風險）

- **狀態**：MITIGATED（NORMAL + RPC 已部署）；**PARTIALLY_MITIGATED**（RPC 未部署時 fallback Node+rollback）
- **範圍**：一般出貨過帳（`postShipmentBundle`）涉及多表寫入（shipment/shipment_item/inventory_movement/sales_order_item/ar_receivable 等）
- **風險**：任何中途錯誤都可能留下「已扣庫或已 POSTED，但 AR/後續處理未完成」的半成功狀態
- **2026-07-13 緩解 B**（`server/src/bundles/shipment.js`）：
  - 出貨前 **preflight** 庫存檢查（庫存不足時 **不寫入** shipment／shipment_item；整合測試 PARTIAL_FAILURE 由 **C → A**）
  - POST 中途失敗時 **compensating rollback**（回滾 movement／shipped_qty／SO 狀態／AR／pool／shipment 表頭與明細）
- **2026-07-13 緩解 ③**（`server/sql/v4.3.2_出貨過帳交易Phase1.sql` + Node RPC 優先）：
  - `erp_ship_post_phase1_tx`：NORMAL 出貨 **單一 DB transaction**（shipment／shipment_item 計價快照／庫存／SO／AR）
  - 計價仍由 Node `buildShipmentArPricing_` 權威計算後傳入（parity）
  - RPC 不存在時自動 **fallback** B 路徑
- **2026-07-13 緩解 ④**（`server/sql/v4.3.3_出貨過帳Dealer折抵原子.sql`）【DEV 先跑；正式庫暫不動】：
  - `erp_apply_dealer_credit_at_shipment` 併入 `erp_ship_post_phase1_tx` 同交易
  - Node：RPC 回傳 `dealer_credit_in_tx: true` 時不再跑折抵；v4.3.2 only 時 fallback Node 折抵
- **2026-07-13 緩解 ⑤**（`server/sql/v4.3.4_出貨作廢交易Phase1.sql`）【DEV 先跑；正式庫暫不動】：
  - `erp_ship_void_phase1_tx`：NORMAL 出貨 **VOID 單一 transaction**（還庫／SO／折抵還原／AR 作廢）
  - Node：RPC 優先；未部署時 fallback 既有 Node 作廢路徑
- **2026-07-13 緩解 ⑥**（`server/sql/v4.3.5_寄賣出貨交易Phase2.sql`）【DEV 先跑】：
  - `erp_ship_post_consignment_phase2_tx`：CONSIGNMENT POST 單一 transaction（含案件品項池）
  - `erp_ship_void_consignment_phase2_tx`：CONSIGNMENT VOID 單一 transaction（含移除品項池）
  - Node：RPC 優先；未部署時 fallback Node 多步
- **2026-07-14 緩解 ⑦**（`server/sql/v4.3.6_寄賣結算收回交易Phase2.sql`）【DEV 先跑】：
  - `erp_cc_post_settlement_phase2_tx`：寄賣結算 POST 單一 transaction（池子+結算+AR+Dealer 折抵）
  - `erp_cc_post_return_phase2_tx`：寄賣收回 POST 單一 transaction（池子+收回+庫存 IN）
  - 計價／促銷／收回分配仍由 Node 權威計算後傳入（parity）
  - Node：RPC 優先；未部署時 fallback Node 多步 + rollback
- **DEV 部署順序**：`v4.3.1` → … → `v4.3.12` → **`v4.3.13`**（Supabase SQL Editor Run）
- **2026-07-14 緩解 ⑧**（`server/sql/v4.3.7_月結帳本交易Phase3.sql`）【DEV；Phase 3 slice1】：
  - `erp_cc_post_level_phase3_tx` / `erp_cc_void_level_phase3_tx`：經銷等級過帳 POST/VOID 原子
  - `erp_cc_post_rebate_cf_phase3_tx` / `erp_cc_void_rebate_cf_phase3_tx`：月結回饋 **CARRY_FORWARD** POST/VOID 原子
  - 選用：v4.2.14 ledger 存在時同步寫入 `MONTHLY_LEVEL_POST` 分類帳
- **2026-07-14 緩解 ⑧b**（`server/sql/v4.3.8_月結帳本交易Phase3Slice2.sql`）【DEV；Phase 3 slice2】：
  - `erp_cc_post_rebate_cn_phase3_tx` / `erp_cc_void_rebate_cn_phase3_tx`：月結回饋 **CREDIT_NOTE（折讓）** POST/VOID 原子（rebate + AR 折讓）
  - `erp_cc_void_monthly_close_phase3_tx`：**作廢本月月結** cascade（回饋→等級→統計，單一 transaction）
  - 折讓分配仍由 Node `planRebateCreditNote_` 預覽後傳入 RPC（parity）
  - 整合測試：`p3-monthly-level-rebate.test.mjs`、`p3-monthly-cn-close.test.mjs` 全綠
- **2026-07-14 緩解 ⑧c**（`server/sql/v4.3.9_分類帳收斂Phase3Slice3.sql`）【DEV；Phase 3 slice3】：
  - 建表 `dealer_cumulative_ledger`；等級過帳改 **ledger-first** + `erp_dealer_ledger_sync_customer_`
  - `erp_dealer_ledger_backfill_level_posts_`：既有等級過帳補寫分類帳
  - Node：有分類帳列時 `syncCustomerCumulativeFromSources_` 優先 RPC sync
  - 整合測試：`p3-ledger-convergence.test.mjs` 全綠
- **2026-07-14 緩解 ⑨**（`server/sql/v4.3.10_AR收款狀態Phase4.sql`）【DEV；Phase 4 slice1】：
  - `ar_payment.status`：`POSTED` / `VOID`（作廢不再把 amount 歸零）
  - `void_reason` / `voided_by` / `voided_at` 正式欄位
  - `erp_ar_sum_valid_payments_` 改以 status 為準（保留 `VOIDED|` legacy 過渡）
  - Node：`registerArPaymentBundle` / `voidArPaymentBundle` / `sumArPayments_` 已對齊
  - 整合測試：`p4-ar-payment-status.test.mjs`
- **2026-07-14 緩解 ⑨b**（`server/sql/v4.3.11_AR收款交易Phase4Slice2.sql`）【DEV；Phase 4 slice2】：
  - `erp_ar_post_payment_phase4_tx` / `erp_ar_void_payment_phase4_tx`：收款 POST/VOID 單一 transaction
  - `erp_ar_sync_receivable_from_payments_`：已收合計 + AR 狀態同步（含結清／重開）
  - Node：`registerArPaymentBundle` / `voidArPaymentBundle` RPC 優先（無 gap writeoff 時）
  - 整合測試：`p4-ar-payment-rpc.test.mjs`
- **2026-07-14 緩解 ⑨c**（`server/sql/v4.3.12_AR調整來源鍵Phase4Slice3.sql`）【DEV；Phase 4 slice3】：
  - Node 全部 `ar_amount_adjustment_log` 寫入帶 `source_type`/`source_id`（`insertArAdjustmentLog_` 冪等）
  - 涵蓋：手動調整、gap writeoff、強制結案、作廢出貨／結算、經銷折抵、月結折讓
  - SQL backfill 既有調整列；`erp_ship_void_phase1_tx` AR 歸零改 `SHIPMENT_VOID`
  - 整合測試：`p4-ar-adjustment-source.test.mjs`
- **2026-07-14 緩解 ⑨d**（`server/sql/v4.3.13_AR收款進階Phase4Slice4.sql`）【DEV；Phase 4 slice4】：
  - `erp_ar_post_payment_phase4_tx` 擴充：gap writeoff 原子寫入（`PAYMENT_GAP_WRITEOFF`）
  - `erp_ar_void_payment_phase4_tx` 擴充：gap 還原（`PAYMENT_GAP_WRITEOFF_VOID`）
  - `erp_ar_post_payment_batch_phase4_tx` / `erp_ar_void_payment_batch_phase4_tx`：批次收款／作廢
  - Node：登記／作廢／批次皆 RPC 優先（legacy fallback 保留）
  - 整合測試：`p4-ar-payment-gap-batch.test.mjs`
- **殘留風險**：一般出貨 `GENERAL_SHIPMENT` ledger 未接入 v4.3.2；Phase 5 cutover Gate 尚未開跑
