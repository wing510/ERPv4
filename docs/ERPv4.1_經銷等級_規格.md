# ERPv4.1 經銷等級 — 規格（MVP v1）

> **狀態**：規格定案（文件）；**尚未實作**  
> **版本**：2026-06-06 草案  
> **前提**：Supabase + Node API（v4.1）；出貨以 `shipment` POSTED 為準

---

## 1. 目的（一句話）

針對 **經銷商 + 單一產品**，在 **合約期間** 內依 **已過帳出貨量** 判斷是否達標、是否升級；升級後套用該等級的 **固定單價**；支援 **自動升級** 與 **人工確認／覆寫**。

---

## 2. 已拍板決策

| 項目 | 決定 |
|------|------|
| 累計依據 | **POSTED 出貨**（`shipment.status = POSTED`）；**CANCELLED 出貨不計入**（作廢後累計應扣回） |
| 品項範圍 | **單一 `product_id`**（一張合約只綁一個產品編號） |
| 單位 | 使用該品項主檔 `product.unit`；**直接加總 `ship_qty`**，不做箱／盒／小包換算 |
| 價格模式 | **A：每等級 × 每品項 = 固定 `unit_price`**（非折扣％） |
| 升級方式 | **自動 + 人工** 並存（依合約或經銷商設定 `upgrade_mode`） |
| SKU 用語 | 對外可稱 SKU；系統內即 **`product_id`** |

---

## 3. 名詞對照

| 口語 | ERP 欄位／表 |
|------|----------------|
| 經銷商 | `customer`（建議 `category = 經銷`） |
| 產品編號 | `product.product_id` |
| 出貨量 | `shipment_item.ship_qty`（關聯 POSTED `shipment`） |
| 合約期 | `dealer_contract.start_date`～`end_date` |
| 門檻量 | `dealer_contract.threshold_qty`（單位同該品項 `unit`） |
| 等級 | `dealer_tier` |
| 等級價 | `dealer_tier_price.unit_price` |

---

## 4. 業務規則

### 4.1 累計出貨量

**計入：**

- `shipment.customer_id` = 合約的經銷商
- `shipment_item.product_id` = 合約的產品
- `shipment.status` = `POSTED`
- `shipment.ship_date`（或 `posted_at`，實作時擇一寫死）落在 `[start_date, end_date]` 內

**不計入：**

- OPEN / CANCELLED 出貨
- 其他 `product_id`
- 合約期外出貨

**公式（概念）：**

```
累計 qty = SUM(shipment_item.ship_qty)
         WHERE 上述條件成立
```

### 4.2 升級判定

```
若 累計 qty >= threshold_qty → 達標
否則 → 未達標（維持 baseline_tier_id，除非人工覆寫）
```

### 4.3 升級模式（`upgrade_mode`）

| 值 | 行為 |
|----|------|
| `AUTO` | 達標即更新 `current_tier_id` = `target_tier_id`，寫 log |
| `MANUAL` | 達標僅標示「待升級」；管理者按 **確認升級** 後才改等級 |
| `AUTO_PENDING` | 達標後狀態 `PENDING_UPGRADE`；可設自動排程或仍須一人確認（實作時二選一，預設同 MANUAL） |

**人工覆寫（任何模式皆可）：**

- 未達標也可升級、或暫時降級
- 必填 **原因** + `updated_by`，寫入 `dealer_tier_log`

### 4.4 價格套用（模式 A）

- 查 `dealer_tier_price`：`tier_id` + `product_id` → `unit_price`
- **開銷售單**時：依經銷商 **目前生效等級** 帶入建議單價（是否鎖定不可改：MVP 建議 **可改但提示**，避免特殊案無法開單）
- 等級變更 **不 retroactive** 已開立之銷售單／出貨單價（歷史單據保持原價）

### 4.5 合約到期（MVP 暫定）

| 項目 | MVP 預設 |
|------|----------|
| 到期後等級 | **維持最後等級**（不自動降級） |
| 到期後累計 | 僅顯示「合約已結束」；不累計至新合約 |
| 新合約 | 另建一筆 `dealer_contract` |

> 若日後要「到期降回 baseline」，加規則即可，不影響表結構。

---

## 5. 資料模型（建議表）

### 5.1 `dealer_tier`（等級主檔）

| 欄位 | 型別 | 說明 |
|------|------|------|
| tier_id | text PK | 例：`T1`、`T2`、`T3` |
| tier_name | text | 顯示名稱（例：一般、銀級、金級） |
| sort_order | int | 排序（低→高） |
| status | text | ACTIVE / INACTIVE |
| remark | text | |
| created_by, created_at, updated_by, updated_at | | 稽核 |

### 5.2 `dealer_tier_price`（等級固定價）

| 欄位 | 型別 | 說明 |
|------|------|------|
| tier_price_id | text PK | |
| tier_id | text FK | → dealer_tier |
| product_id | text FK | → product |
| unit_price | numeric | **固定單價**（未稅或含稅：全系統擇一，與 sales_order 一致） |
| currency | text | 預設 TWD |
| effective_from | date | 選用；空白=立即 |
| effective_to | date | 選用 |
| status | text | ACTIVE / INACTIVE |
| remark | text | |
| 稽核欄 | | |

**唯一性：** `(tier_id, product_id)` 在 ACTIVE 期間不重複。

### 5.3 `dealer_contract`（經銷合約）

| 欄位 | 型別 | 說明 |
|------|------|------|
| contract_id | text PK | |
| customer_id | text FK | 經銷商 |
| product_id | text FK | **單一品項** |
| start_date | date | 合約起 |
| end_date | date | 合約迄 |
| threshold_qty | numeric | 達標門檻（單位 = product.unit） |
| baseline_tier_id | text FK | 未達標／起點等級 |
| target_tier_id | text FK | 達標後等級 |
| current_tier_id | text FK | **目前生效**等級 |
| upgrade_mode | text | AUTO / MANUAL / AUTO_PENDING |
| contract_status | text | DRAFT / ACTIVE / EXPIRED / CANCELLED |
| upgrade_status | text | NONE / PENDING / UPGRADED（輔助 UI） |
| upgraded_at | timestamptz | 實際升級時間 |
| upgraded_by | text | 自動可填 SYSTEM |
| remark | text | |
| 稽核欄 | | |

**範例：** 簽約 3 個月、`threshold_qty = 500`、`target_tier_id = T3`。

### 5.4 `dealer_tier_log`（等級異動紀錄）

| 欄位 | 型別 | 說明 |
|------|------|------|
| log_id | text PK | |
| contract_id | text | |
| customer_id | text | |
| product_id | text | |
| action_type | text | AUTO_UPGRADE / MANUAL_UPGRADE / MANUAL_OVERRIDE / DOWNGRADE / RECalc |
| from_tier_id | text | |
| to_tier_id | text | |
| accumulated_qty | numeric | 當下累計量（快照） |
| reason | text | 人工必填 |
| created_by, created_at | | |

### 5.5 累計（MVP 可不另建表）

以 SQL / API **即時聚合** `shipment` + `shipment_item`；若效能不足再加 `dealer_contract_snapshot`（每日批次）。

---

## 6. API 與 Bundle（實作階段參考）

| action（草案） | 用途 |
|----------------|------|
| `list_dealer_tier` | 等級主檔 |
| `list_dealer_tier_price` | 價格表 |
| `list_dealer_contract` | 合約列表 |
| `create_dealer_contract` / `update_dealer_contract` | 維護合約 |
| `dealer_contract_progress_bundle` | 回傳：累計 qty、門檻、百分比、是否達標、建議等級、目前單價 |
| `confirm_dealer_upgrade_bundle` | 人工確認升級 |
| `override_dealer_tier_bundle` | 人工覆寫等級 |
| `recalc_dealer_tier_bundle` | 重算（出貨作廢後、或批次修正） |

**觸發重算時機：**

- `post_shipment_bundle` 成功後（該 customer + product）
- `cancel_shipment_bundle` 成功後
- 合約儲存／人工覆寫後

---

## 7. 前端 MVP 畫面

### 7.1 模組：`Dealer` 或 `Customers` 子頁「經銷合約」

**合約列表：**

- 經銷商、品項、合約期、門檻、累計 `420/500 BOX`、目前等級、升級狀態

**合約編輯／詳情：**

- 維護合約欄位
- 進度條 + 距離達標差額
- 目前適用 **unit_price**（來自 `dealer_tier_price`）
- 按鈕：**確認升級**（MANUAL）、**人工改等級**

### 7.2 銷售開單（Sales）整合（第二優先）

- 選經銷商 + 品項時，若存在 ACTIVE 合約且該品項有等級價 → **預填 unit_price**
- 提示：「依經銷等級 T2：2000」

### 7.3 提醒（Phase 2）

- Dashboard 或 Dealer 列表 badge：待升級、快達標（≥90%）、合約 7 日內到期

---

## 8. 與現有 ERP 關係

```
customer (經銷)
    └── dealer_contract ──→ dealer_tier (current / target / baseline)
              │                    └── dealer_tier_price → product
              │
              └── 累計 ← shipment (POSTED) ← shipment_item
                              │
                              └── sales_order（開單可帶等級價）
```

**依賴已遷移表：** `customer`、`product`、`shipment`、`shipment_item`、`sales_order`、`sales_order_item`

**建議遷移步驟編號：** step10（接在 step9 電子發票之後）

---

## 9. MVP 範圍 vs 不做

### MVP 要做

- [ ] 四張表（tier、tier_price、contract、log）
- [ ] 合約 CRUD + 累計查詢 API
- [ ] AUTO / MANUAL 升級 + log
- [ ] 一個管理 UI（合約 + 進度 + 確認升級）
- [ ] 出貨過帳／作廢後觸發重算

### MVP 不做（後續）

- 多品項加權合約（一約多 SKU）
- 箱盒換算、uom_config 換算
- 折扣％模式
- 經銷商自助 Portal
- Email / LINE 推播
- 合約到期自動降級

---

## 10. 驗收案例（範例）

**前提：** 產品 P260605-C8，unit=BOX；T2 價 2000、T3 價 1800；合約 2026/03/01～05/31，門檻 500，baseline=T2，target=T3，upgrade_mode=AUTO。

| 步驟 | 動作 | 預期 |
|------|------|------|
| 1 | 期內 POSTED 出貨 300 BOX | 累計 300/500，current=T2，單價 2000 |
| 2 | 再 POSTED 200 BOX | 累計 500/500，**自動** current=T3，單價 1800，log 一筆 |
| 3 | 作廢其中 50 BOX | 累計 450/500；是否降級：**MVP 維持 T3**（僅標示未達標；降級規則 Phase 2） |
| 4 | 同合約改 MANUAL，重新達 500 | 狀態 PENDING，按確認後才 T3 |

---

## 11. 待確認（實作前可再細化）

1. 累計日期用 `ship_date` 還是出貨過帳時間 `updated_at`？
2. `unit_price` 未稅或含稅 — 與現有銷售單一致（需對照 `sales_order_item` 慣例）。
3. 作廢出貨後累計低於門檻，是否 **自動降級**？（MVP 建議：**否**，僅提示 + 人工處理）
4. 一經銷商同一品項是否允許 **重疊合約**？（MVP 建議：**否**）

---

## 12. 修訂紀錄

| 日期 | 說明 |
|------|------|
| 2026-06-06 | 初版：單品項、POSTED 出貨累計、固定等級價、自動+人工升級 |
