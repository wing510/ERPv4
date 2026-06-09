# ERPv4.1 英文商業發票（Commercial Invoice）— 規格（MVP v1）

> **狀態**：**MVP 已實作**（2026-05-24）  
> **版本**：2026-06-06  
> **取代方向**：原 step9「台灣電子發票登記」為**錯向**，UI 已停用；改做本規格

---

## 0. 必填欄位（對照快遞／清關範本）

| 區塊 | 必填內容 | 系統對應 |
|------|----------|----------|
| Shipper 寄件人 | 公司名、完整地址、電話、統編 | **Settings 公司設定** → CI 賣方欄位 |
| Consignee 收件人 | 公司／姓名、完整地址、電話；大陸需證號 | **Customers** 英文欄位 + `consignee_id_no` |
| Invoice | 發票號、日期 | `inv_ci_no`、`inv_ci_date` |
| Waybill & Origin | 託運單號、原產地 | `inv_ci_waybill`、`inv_ci_origin` |
| Items | 英文品名（禁寫 Gift/Sample）、數量、單價、總價 | CI 明細表（可手改 description／unit_price） |
| Signature | 簽名、聲明 | `inv_ci_signature`、`inv_ci_declaration` |

**幣別：** USD / TWD / CNY 等（`inv_ci_currency`）。

---

## 1. 目的（一句話）

出貨寄往**其他國家**時，依 **POSTED 出貨單** 產生 **英文 Commercial Invoice**，可預覽、**手改金額／欄位**後 **列印／PDF**，賣方英文資料由**系統設定**維護。

---

## 2. 與「電子發票 step9」的差異

| | 原 step9（暫停） | 本規格 |
|---|------------------|--------|
| 用途 | 台灣電子發票號碼回填 | 出口對外 **Commercial Invoice** |
| 語言 | 中文＋台灣欄位 | **英文** |
| 產出 | 登記至 DB | **PDF／列印** |
| 典型欄位 | 統編、B2B/B2C、載具 | Seller / Buyer / Invoice No. / Description / Qty / Unit Price / Amount |

**既有 `einvoice_*` 表／API／Shipping 區塊：** 不刪除程式碼前，UI 應**隱藏或停用**；新功能獨立命名（建議 `commercial_invoice` / `ci_*`），避免與台灣發票混淆。

---

## 3. 已拍板決策

| 項目 | 決定 |
|------|------|
| 使用情境 | 出貨寄往**國外**（出口／跨境） |
| 觸發單據 | **POSTED** `shipment` |
| 明細來源 | 出貨明細 `shipment_item` + 品項主檔 |
| 金額來源 | 預設 **銷售單明細 `unit_price`**（依 `so_item_id`）；**可手改** |
| 賣方（英文） | **系統設定頁**（公司名、地址等） |
| 產出 | � browser 列印／PDF（比照現有 `downloadShipmentPdf` / `erpOpenPrintWindow_`） |

---

## 4. 名詞

| 中文 | 英文（單據上） |
|------|----------------|
| 商業發票 | **Commercial Invoice** |
| 出貨單 | Shipment / Delivery Ref. |
| 銷售單 | Sales Order Ref. |
| 賣方 | Seller / Exporter |
| 買方 | Buyer / Consignee |

---

## 5. 資料模型（建議）

### 5.1 `erp_company_profile`（系統設定 — 賣方英文，單筆或 key-value）

MVP 建議 **單筆主檔**（僅一間公司）：

| 欄位 | 說明 |
|------|------|
| profile_id | 固定 `DEFAULT` |
| company_name_en | 英文公司名 |
| address_en | 英文地址（可多行文字） |
| city_en, country_en, postal_code | 選用 |
| phone, email | |
| tax_id / registration_no | 選用（統編或外銷登記） |
| bank_info_en | 選用（Phase 2） |
| default_currency | 預設 USD / TWD 等 |
| default_incoterms | 例 FOB、CIF（可於每張發票覆寫） |
| remark | |
| updated_by, updated_at | |

**前端：** Shipping 列表顯示 CI 狀態＋跳轉；**Invoice 商業發票** 模組（SALES 區）為開立／編輯／PDF 主畫面；**Settings 公司設定** 維護賣方英文。

### 5.2 `commercial_invoice`（發票主檔 — 快照）

一張出貨單對一張 Commercial Invoice（可修訂後覆寫）：

| 欄位 | 說明 |
|------|------|
| ci_id | PK |
| shipment_id | FK → shipment（POSTED） |
| ci_no | Invoice No.（可手填；可自動編號規則 Phase 2） |
| ci_date | Invoice Date |
| status | DRAFT / ISSUED / VOID |
| currency | |
| incoterms | |
| seller_* | **開立當下快照**（來自 company_profile） |
| buyer_name_en | 買方英文（快照） |
| buyer_address_en | |
| buyer_country | |
| subtotal, tax_amount, total_amount | 可 0 稅或手改 |
| remark | Payment terms、Notes |
| issued_by, issued_at | |
| 稽核欄 | |

### 5.3 `commercial_invoice_line`（明細 — 快照）

| 欄位 | 說明 |
|------|------|
| ci_line_id | PK |
| ci_id | |
| line_no | |
| shipment_item_id, so_item_id, product_id | 追溯 |
| description_en | 英文品名（預設 product 英文或主檔名＋spec） |
| qty, unit | 來自出貨；unit 可手改顯示 |
| unit_price, amount | **預設 SO 單價×qty；可手改** |
| remark | |

### 5.4 客戶主檔延伸（建議）

在 `customer` 增加（或沿用並語意分離）：

| 欄位 | 用途 |
|------|------|
| invoice_name_en | 買方英文抬頭 |
| invoice_address_en | 英文地址 |
| country | 已有；Commercial Invoice 必帶 |

（原 step9 的 `tax_id`、`invoice_title` 等**台灣用**欄位保留亦可，與 CI 分開顯示。）

### 5.5 產品主檔延伸（選用 MVP）

| 欄位 | 用途 |
|------|------|
| product_name_en | 英文品名 |
| hs_code | 報關用（Phase 2） |

若無英文品名，MVP 可 fallback `product_name` + `spec`。

---

## 6. 流程

```
POSTED 出貨單 Load（Shipping）
    ↓
側欄 → **Invoice 商業發票**（或出貨列表按 CI 跳轉）
    ↓
選 POSTED 出貨 → 自動帶入賣方（設定頁）、買方（customer 英文）、明細＋SO 單價
    ↓
使用者可手改：ci_no、date、單價、amount、description、incoterms…
    ↓
「儲存／開立」→ 寫入 commercial_invoice + line（快照）
    ↓
「下載 PDF／列印」→ 英文版型
```

**未 POSTED：** 不顯示 CI 區塊（與原發票邏輯相同）。

---

## 7. PDF 版型（MVP 欄位）

**Header**

- Title: **COMMERCIAL INVOICE**
- Invoice No. / Date
- Seller（英文公司、地址、電話、email）
- Buyer / Ship To（英文）

**References（選用）**

- Shipment No.
- Sales Order No.
- Incoterms

**Line table**

| No. | Description | Qty | Unit | Unit Price | Amount |

**Footer**

- Subtotal / Total（Currency）
- Payment Terms / Remarks（文字欄）

**不做 MVP：** Logo 上傳、多頁裝櫃明細、Packing List 合併。

---

## 8. API（草案）

| action | 用途 |
|--------|------|
| `get_company_profile` / `update_company_profile` | 系統設定 |
| `list_commercial_invoice_by_shipment` | 查是否已開 |
| `save_commercial_invoice` | 儲存主檔＋明細（含手改） |
| `void_commercial_invoice` | 作廢（選用） |

Bundle 或 CRUD 皆可；明細用 `lines_json` 與 shipment bundle 一致。

---

## 9. 前端

| 位置 | 內容 |
|------|------|
| **系統設定**（新） | 賣方英文資料維護 |
| **Shipping** | POSTED 載入後：CI 表單 + 明細表 + **儲存** + **下載 Commercial Invoice PDF** |
| **Customers** | 買方英文欄位（invoice_name_en、invoice_address_en） |

按鈕位置：可沿用「出貨明細下方／與出貨按鈕同列」，文案改 **Commercial Invoice**。

---

## 10. 權限（建議）

| 動作 | 角色 |
|------|------|
| 改公司英文設定 | ADMIN（或 CEO） |
| 開立／手改 CI | 與出貨／銷售相同（SL、OP、ADMIN…） |
| 列印 PDF | 同上 |

---

## 11. MVP 範圍

### 要做

- [ ] company_profile 表 + 設定頁
- [ ] customer 英文欄位（或確認用既有欄位）
- [ ] commercial_invoice + line 表
- [ ] Shipping：CI 編輯 + 儲存 + 英文 PDF
- [ ] **隱藏**原台灣電子發票登記 UI

### 不做（Phase 2）

- 自動發票編號規則、多幣別匯率
- Packing List、報關 HS Code 必填
- Email 寄 PDF
- 加值中心／台灣電子發票

---

## 12. 驗收案例

1. 系統設定填好 Seller 英文地址 → 儲存成功。  
2. 客戶「北京王樹杰」填 invoice_name_en / address_en。  
3. Load POSTED 出貨單 → CI 明細自動 10 BOX、單價 2000。  
4. 手改某一列 unit_price → 儲存 → 再開仍為手改值。  
5. 下載 PDF → 全英文版型、Seller/Buyer/明細正確。

---

## 13. 與其他規格

| 文件 | 狀態 |
|------|------|
| `ERPv4.1_經銷等級_規格.md` | **暫緩** |
| step9 `v4.1.09_台灣電子發票.sql` | **不擴充**；新功能用新 SQL step |

---

## 14. 修訂紀錄

| 日期 | 說明 |
|------|------|
| 2026-06-06 | 初版：出口英文 CI、SO 單價可手改、賣方系統設定 |
