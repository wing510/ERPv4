# ERP v4.2.11 · 月結統計累積 — 定案條文（改程式對照）

> **日期**：2026-07-11　**狀態**：已定案、實作中  
> **詳述**：`ERPv4.2.11_月結統計_一般累積改月結過帳_討論定案說明書.md`

---

## 1. 累積寫入時點

| 管道 | 出貨／結算過帳 | 月結統計過帳 |
|------|---------------|-------------|
| 一般出貨 | 只建 AR | ✅ 計入累積（依 stat_source） |
| 寄賣結算 | 只建 AR | ✅ 計入累積（依 stat_source，維持現行） |

- 方案 `stat_source`：CONSIGNMENT／GENERAL／ALL 決定該月哪幾類請款計入。
- 同月多筆：**月結過帳一次加總**（例：寄賣 17,900 + 一般 44,800 = 62,700），只觸發一次升級判定。

## 2. 等級生效

- 當月出貨、結算、計價：用**目前等級**。
- 月結過帳達標：寫入**次月待生效**等級（pending 機制不變）。
- **一般、寄賣皆隔月才用新等級。**

## 3. 月結統計 POST／VOID

**過帳**

1. 快照當月請款淨額（寄賣／一般／合計）。
2. `resolveMonthlyStatCumulativeAdds_` 算 `cumulative_add_consignment`、`cumulative_add_general`。
3. **單次** `applyCustomerCumulativeAmountAdd_(billingNet: total)`。
4. 寫入 `commercial_dealer_monthly_stat`（含 before／after）。

**作廢**

- 扣回 `cumulative_add_consignment + cumulative_add_general`（與過帳對稱）。
- 若 pending 來自該筆快照，一併清除。
- 作廢後該月回到未過帳預覽，可重過帳。

## 4. 出貨／結算作廢

- **一般出貨作廢**：不扣累積（出貨已不再寫累積）。
- **寄賣結算作廢**：維持現行護欄（該月已有月結統計／回饋須先作廢）。

## 5. 列表顯示

| 狀態 | 寄賣／一般請款 | 累積 |
|------|---------------|------|
| 未過帳 | 灰字預覽 | 截至所選月 + 預覽 |
| 已過帳 | 正式值 | 快照 after |
| 已作廢 | 灰字預覽 | 扣回後 |

## 6. 不在本版

- 月結回饋仍為第二步，不併入一鍵過帳。
- 月結回饋過帳**不另加**累積。
- 畫面欄位本階段不大改；API 與文案須符合上表。

## 7. 實作對照

| 區塊 | 檔案 |
|------|------|
| 後端主邏輯 | `server/src/bundles/commercial-dealer.js` |
| 出貨累積 skip | `processCumulativeOnGeneralShipment_`（同檔） |
| 月結列表 UI | `js/dealer-rebate.js` |
| 方案客戶預覽 | `js/commercial-dealer-customer.js` |
| 說明文案 | `js/help.js` |
