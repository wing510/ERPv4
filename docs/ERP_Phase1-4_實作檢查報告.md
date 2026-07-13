# ERP 交易安全 Phase 1～4 實作檢查報告

> **用途**：供 GPT／人工做 Phase 1～4 交付物與風險覆蓋度檢查  
> **日期**：2026-07-14  
> **環境**：僅 **DEV Supabase** 已部署；**正式庫未動**  
> **唯一真相**：現行程式（`js/`、`server/src/`、`server/sql/`）＋整合測試結果  
> **參考路線圖**：`docs/ERP_交易安全_全景路線圖_討論書.md`（意圖骨架；細節以程式為準）

---

## 0. 執行摘要（給檢查者 30 秒版）

| Phase | 主題 | DEV SQL 版本 | 整合測試 | Gate 自評 |
|-------|------|-------------|----------|-----------|
| **1** | NORMAL 一般出貨 POST/VOID 原子化 + 促銷／折抵 parity | v4.3.1～v4.3.4 | `p1-integration.test.mjs`、`p1-shipment-promo.test.mjs` | GO FOR TESTING（DEV） |
| **2** | 寄賣出貨／結算／收回 POST/VOID 原子化 | v4.3.5～v4.3.6 | `p2-consignment-shipment.test.mjs`、`p2-consignment-settlement-return.test.mjs` | GO FOR TESTING（DEV） |
| **3** | 月結回饋／等級過帳 + ledger 收斂（3 slice） | v4.3.7～v4.3.9 | `p3-monthly-level-rebate.test.mjs`、`p3-monthly-cn-close.test.mjs`、`p3-ledger-convergence.test.mjs` | GO FOR TESTING（DEV） |
| **4** | AR 收款 status + RPC + 調整冪等鍵 + gap／批次（4 slice） | v4.3.10～v4.3.13 | `p4-ar-payment-*.test.mjs`、`p4-ar-adjustment-source.test.mjs` | GO FOR TESTING（DEV） |

**DEV 完整部署順序**（Supabase SQL Editor 依序 Run）：

```
v4.3.1 → v4.3.2 → v4.3.3 → v4.3.4 → v4.3.5 → v4.3.6
→ v4.3.7 → v4.3.8 → v4.3.9
→ v4.3.10 → v4.3.11 → v4.3.12 → v4.3.13
```

**Phase 5（正式 cutover）**：依專案決策 **暫不開跑**。

---

## 1. 架構原則（全 Phase 共用）

### 1.1 Parity 模式

- **Node**：商業計算權威（促銷價、折抵額度、月結折讓分配、gap 差額規劃等）
- **RPC**：單一 DB `transaction` 原子寫庫（庫存／單據／AR／調整 log／客戶餘額等）
- **Fallback**：RPC 函式未部署時，Node 多步寫入 + rollback（B 級緩解）；不可 silent 吞錯

### 1.2 冪等與 POST/VOID 對稱

- 財務調整：`ar_amount_adjustment_log.source_type` + `source_id`（partial unique index，v4.3.3 起）
- 收款：`ar_payment.status` = `POSTED` / `VOID`（v4.3.10 起）；作廢**保留原金額**供對帳
- VOID 須反向原 POST 的數量／金額／狀態，保留稽核歷史

### 1.3 Actor／權限

- UI 非安全邊界；`created_by` / `updated_by` 由 Node bundle 從 session 注入
- RPC 參數 `p_actor` 仍為顯式傳入（已知技術債；Phase 5 可加固）

---

## 2. Phase 1 — NORMAL 一般出貨交易安全

### 2.1 目標（路線圖）

僅 **NORMAL** 出貨過帳／作廢收成單一 transaction；含促銷計價、經銷折抵、出貨建 AR／作廢關 AR。

### 2.2 SQL 交付物

| 檔案 | 內容 |
|------|------|
| `v4.3.1_銷售與出貨計價快照.sql` | 出貨明細計價快照欄位 |
| `v4.3.2_出貨過帳交易Phase1.sql` | `erp_ship_post_phase1_tx`：POST 原子（shipment／庫存／SO／AR） |
| `v4.3.3_出貨過帳Dealer折抵原子.sql` | `erp_apply_dealer_credit_at_shipment` 併入 POST；`SHIPMENT_CREDIT` 冪等鍵 |
| `v4.3.4_出貨作廢交易Phase1.sql` | `erp_ship_void_phase1_tx`：VOID 原子；`SHIPMENT_CREDIT_VOID`；`erp_ar_sum_valid_payments_` |

### 2.3 Node 整合

- `server/src/bundles/shipment.js`：`tryPostShipmentPhase1TxRpc_` / `tryCancelShipmentPhase1TxRpc_` RPC 優先
- POST 前 **preflight** 庫存；失敗 **compensating rollback**（RPC 未部署時）
- 計價：`buildShipmentArPricing_` → `p_pricing_lines` 傳入 RPC

### 2.4 整合測試

| 測試檔 | 驗證重點 |
|--------|----------|
| `tests/p1-integration.test.mjs` | SO 重置 → 出貨 POST → VOID；庫存／AR／狀態對稱；partial failure 不半套 |
| `tests/p1-shipment-promo.test.mjs` | 促銷計價 parity |

### 2.5 已知殘留（檢查重點）

- **`GENERAL_SHIPMENT` ledger**（`dealer_cumulative_ledger`）**未**接入 v4.3.2 出貨 RPC；累積仍以月結等級過帳為主
- CONSIGNMENT 出貨 intentionally 不在 Phase 1（見 Phase 2）

---

## 3. Phase 2 — 寄賣交易對稱

### 3.1 目標

寄賣出貨進 pool、結算過帳、未售收回；POST/VOID 不留下半套 pool／AR。

### 3.2 SQL 交付物

| 檔案 | 主要 RPC |
|------|----------|
| `v4.3.5_寄賣出貨交易Phase2.sql` | `erp_ship_post_consignment_phase2_tx`、`erp_ship_void_consignment_phase2_tx` |
| `v4.3.6_寄賣結算收回交易Phase2.sql` | `erp_cc_post_settlement_phase2_tx`、`erp_cc_post_return_phase2_tx`；`SETTLEMENT_CREDIT` 冪等鍵 |

### 3.3 Node 整合

- `shipment.js`：CONSIGNMENT 類型走 Phase2 RPC
- `consignment-case.js`：結算／收回 POST 走 Phase2 RPC；作廢結算／收回沿用 v4.2.2.03 既有 VOID RPC

### 3.4 整合測試

| 測試檔 | 驗證重點 |
|--------|----------|
| `tests/p2-consignment-shipment.test.mjs` | 寄賣出貨 POST/VOID、`post_pass` / `void_pass` |
| `tests/p2-consignment-settlement-return.test.mjs` | 結算 POST、收回 POST（含 pool／AR） |

### 3.5 使用者驗證（對話紀錄）

寄賣手動路徑（出貨→結算→收回→作廢）曾由使用者確認正常。

---

## 4. Phase 3 — 月結／經銷帳本收斂（3 slice）

### 4.1 Slice 1 — 等級過帳 + CARRY_FORWARD 回饋

**SQL**：`v4.3.7_月結帳本交易Phase3.sql`

| RPC | 用途 |
|-----|------|
| `erp_cc_post_level_phase3_tx` / `erp_cc_void_level_phase3_tx` | 經銷等級過帳 POST/VOID |
| `erp_cc_post_rebate_cf_phase3_tx` / `erp_cc_void_rebate_cf_phase3_tx` | 月結回饋 CARRY_FORWARD POST/VOID |

**測試**：`tests/p3-monthly-level-rebate.test.mjs` — PASS

### 4.2 Slice 2 — CREDIT_NOTE 折讓 + 作廢本月月結 cascade

**SQL**：`v4.3.8_月結帳本交易Phase3Slice2.sql`

| RPC | 用途 |
|-----|------|
| `erp_cc_post_rebate_cn_phase3_tx` / `erp_cc_void_rebate_cn_phase3_tx` | 折讓 POST/VOID（`MONTHLY_REBATE_CN` 冪等鍵） |
| `erp_cc_void_monthly_close_phase3_tx` | 作廢本月月結 cascade |

**Node**：`planRebateCreditNote_` 預覽 → RPC 原子寫入（parity）

**測試**：`tests/p3-monthly-cn-close.test.mjs` — `cn_pass` / `close_pass` / `rebate_rpc` / `close_rpc` 全 true

### 4.3 Slice 3 — 分類帳 ledger-first

**SQL**：`v4.3.9_分類帳收斂Phase3Slice3.sql`

- 建表 `dealer_cumulative_ledger`
- 等級過帳改 **ledger-first** + `erp_dealer_ledger_sync_customer_`
- `erp_dealer_ledger_backfill_level_posts_` 補寫既有等級過帳
- 修正 `erp_cc_try_ledger_append_` 避免 append 時錯誤 sync（雙寫衝突）

**Node**：`syncCustomerCumulativeFromSources_` 有分類帳列時優先 RPC sync

**測試**：`tests/p3-ledger-convergence.test.mjs` — PASS（累積 800→0 對帳）

### 4.4 Phase 3 重要 bug 修復

`applyCustomerCumulativeAmountAdd_` 的 `dryRun: true` 原本仍會寫入客戶累積 → 已改為 dryRun 只預覽不寫庫（否則 RPC `ERR_CUMULATIVE_CONFLICT`）。

---

## 5. Phase 4 — AR Phase（4 slice）

### 5.1 Slice 1 — 收款正式 status

**SQL**：`v4.3.10_AR收款狀態Phase4.sql`

- `ar_payment.status`：`POSTED` / `VOID`
- `void_reason` / `voided_by` / `voided_at`
- 既有作廢資料 backfill；還原曾被歸零的作廢金額
- `erp_ar_sum_valid_payments_` 以 status 為準（保留 `VOIDED|` legacy 過渡）

**Node / 前端**：`server/src/bundles/ar.js`、`js/ar.js`、`js/core/schema.js`

**測試**：`tests/p4-ar-payment-status.test.mjs`

```json
{ "post_pass": true, "void_pass": true, "amount_preserved": 300 }
```

### 5.2 Slice 2 — 收款 POST/VOID RPC

**SQL**：`v4.3.11_AR收款交易Phase4Slice2.sql`

| RPC | 用途 |
|-----|------|
| `erp_ar_post_payment_phase4_tx` | 登記收款 + AR 已收／狀態同步 |
| `erp_ar_void_payment_phase4_tx` | 作廢收款 + AR 同步（含重開備註） |
| `erp_ar_sync_receivable_from_payments_` | 共用同步 helper |

**測試**：`tests/p4-ar-payment-rpc.test.mjs`

```json
{ "post_pass": true, "void_pass": true, "payment_rpc": true, "void_rpc": true }
```

### 5.3 Slice 3 — 調整 log 全面 source_type/source_id

**SQL**：`v4.3.12_AR調整來源鍵Phase4Slice3.sql`

- Node `insertArAdjustmentLog_` 冪等寫入
- 涵蓋路徑：手動調整、gap writeoff、強制結案、作廢出貨／結算、經銷折抵、月結折讓
- 既有列 backfill；`erp_ship_void_phase1_tx` AR 歸零改 `SHIPMENT_VOID` 冪等鍵

**主要 source_type 字典**：

| source_type | source_id 範例 | 場景 |
|-------------|----------------|------|
| `SHIPMENT_CREDIT` | shipment_id | 出貨經銷折抵 |
| `SHIPMENT_CREDIT_VOID` | shipment_id | 作廢出貨還原折抵 |
| `SHIPMENT_VOID` | shipment_id | 作廢出貨 AR 歸零 |
| `SETTLEMENT_CREDIT` | settlement_id | 結算經銷折抵 |
| `MONTHLY_REBATE_CN` | rebate_id:ar_id | 月結折讓 |
| `PAYMENT_GAP_WRITEOFF` | payment_id | 登記收款沖銷差額 |
| `PAYMENT_GAP_WRITEOFF_VOID` | payment_id | 作廢收款還原差額 |
| `AR_FORCE_CLOSE` | ar_id | 強制結案沖銷 |
| `MANUAL_ADJUST` | adjust_id | 手動調整應收 |

**測試**：`tests/p4-ar-adjustment-source.test.mjs`

```json
{ "source_pass": true, "idempotent_pass": true }
```

### 5.4 Slice 4 — gap writeoff + 批次收款 RPC

**SQL**：`v4.3.13_AR收款進階Phase4Slice4.sql`

- 擴充 `erp_ar_post_payment_phase4_tx`：可選 `p_gap_writeoff_json` 原子寫入 gap 調整
- 擴充 `erp_ar_void_payment_phase4_tx`：自動 `PAYMENT_GAP_WRITEOFF_VOID` 還原
- 新增 `erp_ar_post_payment_batch_phase4_tx` / `erp_ar_void_payment_batch_phase4_tx`

**Node**：登記／作廢／批次皆 RPC 優先（legacy fallback 保留）

**測試**：`tests/p4-ar-payment-gap-batch.test.mjs`

```json
{
  "gap_post_pass": true,
  "gap_void_pass": true,
  "batch_post_pass": true,
  "batch_void_pass": true
}
```

---

## 6. 測試矩陣總表（建議 GPT 逐項勾選）

| # | 測試檔 | Phase | 指令 | 預期 |
|---|--------|-------|------|------|
| 1 | `p1-integration.test.mjs` | 1 | `node tests/p1-integration.test.mjs` | exit 0 |
| 2 | `p1-shipment-promo.test.mjs` | 1 | `node tests/p1-shipment-promo.test.mjs` | exit 0 |
| 3 | `p2-consignment-shipment.test.mjs` | 2 | `node tests/p2-consignment-shipment.test.mjs` | `post_pass`/`void_pass` true |
| 4 | `p2-consignment-settlement-return.test.mjs` | 2 | `node tests/p2-consignment-settlement-return.test.mjs` | exit 0 |
| 5 | `p3-monthly-level-rebate.test.mjs` | 3 | `node tests/p3-monthly-level-rebate.test.mjs` | exit 0 |
| 6 | `p3-monthly-cn-close.test.mjs` | 3 | `node tests/p3-monthly-cn-close.test.mjs` | exit 0 |
| 7 | `p3-ledger-convergence.test.mjs` | 3 | `node tests/p3-ledger-convergence.test.mjs` | exit 0 |
| 8 | `p4-ar-payment-status.test.mjs` | 4s1 | `node tests/p4-ar-payment-status.test.mjs` | exit 0 |
| 9 | `p4-ar-payment-rpc.test.mjs` | 4s2 | `node tests/p4-ar-payment-rpc.test.mjs` | `payment_rpc`/`void_rpc` true |
| 10 | `p4-ar-adjustment-source.test.mjs` | 4s3 | `node tests/p4-ar-adjustment-source.test.mjs` | exit 0 |
| 11 | `p4-ar-payment-gap-batch.test.mjs` | 4s4 | `node tests/p4-ar-payment-gap-batch.test.mjs` | 四項 pass true |

**執行前**：`cd d:\Desktop\ERP`；確認 `server/.env` 指向 **DEV**；`ERP_ENV_NAME` 不可為 PROD。

**SQL 部署輔助**：`node tests/_deploy-sql-dev.mjs server/sql/<檔名>.sql`

---

## 7. 風險登記簿對照（`docs/ERP_RISK_REGISTER.md`）

| 風險 ID | 狀態 | 說明 |
|---------|------|------|
| RR-2026-07-09-01 出貨半成功 | **MITIGATED**（DEV RPC 路徑） | NORMAL + 寄賣 + 月結 + AR 已分段緩解 |
| ⑨ AR 收款體系 | **MITIGATED**（DEV Phase 4 全 slice） | status + RPC + 調整冪等鍵 + gap／批次 |
| GENERAL_SHIPMENT ledger | **OPEN** | 未接入 v4.3.2 出貨 RPC |
| Phase 5 cutover | **NOT STARTED** | 正式庫 migration／並行壓測／hash 未做 |

---

## 8. 給 GPT 的檢查清單（建議審查角度）

### 8.1 治理不變（Domain Invariants）

- [ ] 核心寫庫是否仍在單一 DB transaction（或等價 RPC）內完成？
- [ ] 是否存在 silent fallback 導致半套資料？（應僅 RPC-missing 時走明確 legacy + rollback）
- [ ] POST/VOID 是否對稱（金額／數量／狀態／折抵／調整 log）？
- [ ] 冪等鍵是否用 `source_type/source_id`，而非不穩定 reason 字串？
- [ ] `p_actor` 是否仍信任 client？（已知債；UI 非邊界但 RPC 參數仍可偽造—Phase 5）

### 8.2 Parity

- [ ] Node 計算與 RPC 寫入是否分離清楚？
- [ ] 促銷／折抵／月結折讓／gap 差額是否仍由 Node 規劃後傳入？
- [ ] RPC 未部署時 fallback 行為是否與舊版一致？

### 8.3 測試覆蓋缺口（誠實標示）

| 項目 | 現況 |
|------|------|
| 並行壓測／死鎖回歸 | **未做**（Phase 5） |
| 正式庫 migration dry-run | **未做** |
| 全面 request hash | **未做** |
| 一般出貨 GENERAL_SHIPMENT ledger | **未接入** RPC |
| 批次收款含 gap writeoff | **不支援**（單筆收款路徑支援） |
| `p_actor` 從 DB session 注入 | **未做** |

### 8.4 相容性

- [ ] API response contract 是否維持（新增 `payment_rpc`/`void_rpc`/`batch_rpc` 等旗標為 additive）？
- [ ] Legacy `VOIDED|` system_remark 是否仍相容判斷？

---

## 9. 檔案索引（主要變更面）

```
server/sql/v4.3.1 ～ v4.3.13     # 13 支 DEV migration
server/src/bundles/shipment.js   # Phase 1/2 出貨 RPC
server/src/bundles/consignment-case.js
server/src/bundles/commercial-dealer.js  # Phase 3 月結 RPC
server/src/bundles/ar.js         # Phase 4 AR RPC
tests/p1-*.test.mjs
tests/p2-*.test.mjs
tests/p3-*.test.mjs
tests/p4-*.test.mjs
docs/ERP_RISK_REGISTER.md
```

---

## 10. 結論（實作狀態）

- **Phase 1～4 在 DEV 環境已完成實作與整合測試**；路線圖 Phase 4 四個 slice 均已交付。
- **不構成 GO FOR PRODUCTION**：正式庫未部署、Phase 5 Gate 未跑、並行／cutover 測試缺失。
- **建議 GPT 回覆格式**：逐 Phase 標註 `PASS` / `GAP` / `BLOCKER`，並對照 §8.3 測試缺口是否可接受為 Phase 5 前置。

---

*本報告由實作對話產出；若程式與本檔矛盾，以 `server/sql/`、`server/src/` 現行程式為準。*
