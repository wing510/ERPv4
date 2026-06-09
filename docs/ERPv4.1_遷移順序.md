# ERPv4.1 Supabase 遷移順序

> **step8 後（現行）**  
> - 已遷移的 `list_*` → `{ success: true, data: [...], source: "supabase" }`  
> - 未遷移的 `list_*` → `{ success: false, error_code: "ERR_TABLE_NOT_MIGRATED" }`（**不再**回 `source:"stub"` 假空陣列）  
> - 前端黃色橫幅：由 `js/core/migration-stub.js` 的 `MIGRATED_TABLES` + 模組依賴表判斷（與後端 `SUPABASE_LIST_TABLES` 應同步）

**每完成一步：** 建表 → 實作 `list_*` / 寫入 bundle → `handlers.js` 的 `SUPABASE_LIST_TABLES` 加 key → `migration-stub.js` 的 `MIGRATED_TABLES` 加表名。

> 詳細 API 說明：`docs/ERPv4.1_Supabase_API_起步.md`

## 目前已遷移

| 表 | 讀取 | 寫入 CRUD |
|----|:----:|:---------:|
| product | ✅ | ✅ |
| supplier | ✅ | ✅ |
| customer | ✅ | ✅ |
| warehouse | ✅ | ✅ |
| user（表 `erp_user`） | ✅ | ✅ |
| lot | ✅ | — |
| inventory_movement | ✅ | — |
| lot_balance | ✅ | — |
| logs | ✅ | — |
| purchase_order | ✅ | ✅ |
| purchase_order_item | ✅ | ✅（明細可刪；表頭作廢走 bundle） |
| import_document | ✅ | ✅（save_import_document bundle） |
| import_item | ✅ | ✅ |
| import_receipt | ✅ | ✅（post/cancel bundle） |
| import_receipt_item | ✅ | ✅ |
| goods_receipt | ✅ | ✅（post/cancel bundle） |
| goods_receipt_item | ✅ | ✅ |
| sales_order | ✅（程式已接；需跑 SQL） | ✅ |
| sales_order_item | ✅ | ✅ |
| shipment | ✅ | —（走 bundle） |
| shipment_item | ✅ | —（走 bundle） |
| process_order | ✅（程式已接；需跑 SQL） | —（走 cmd/bundle） |
| process_order_input | ✅ | —（走 bundle） |
| process_order_output | ✅ | —（走 bundle） |
| lot_relation | ✅ | —（走 bundle） |

---

## 步驟 1｜主檔補齊

**目標模組**：Suppliers、Customers、Warehouses、Users

| 建 Supabase 表 | 後端 `list_*` |
|----------------|---------------|
| supplier | list_supplier |
| customer | list_customer |
| warehouse | list_warehouse |
| user | list_user（→ `erp_user`） |

**寫入**：`create_*` / `update_*` / `delete_*`（主檔軟刪）

**驗收**：四個主檔模組無黃色橫幅；可新增一筆產品供應商。

---

## 步驟 2｜採購鏈 ✅（程式已接；需跑 SQL）

**目標模組**：Purchase Orders

| 表 | 後端 `list_*` |
|----|---------------|
| purchase_order | list_purchase_order |
| purchase_order_item | list_purchase_order_item |

**寫入**：`create_*` / `update_*`；明細 `delete_purchase_order_item`；作廢 `cancel_purchase_order_bundle`

**SQL**：`server/sql/v4.1.02_採購單.sql`

**驗收**：採購單頁無黃色橫幅；可建 PO + 明細 + 作廢。

---

## 步驟 3｜進口報單 + 收貨入庫（進貨）✅（程式已接；需跑 SQL）

**目標模組**：Import、Receive（Goods Receipt）

| 表 | 後端 `list_*` |
|----|---------------|
| import_document, import_item | list_import_* |
| import_receipt, import_receipt_item | list_import_receipt* |
| goods_receipt, goods_receipt_item | list_goods_receipt* |

**寫入（核心）**：

- `save_import_document` / `reset_import_items_cmd` / `cancel_import_document_bundle`
- `post_import_receipt_bundle` / `cancel_import_receipt_bundle`
- `post_goods_receipt_bundle` / `cancel_goods_receipt_bundle`（產 lot + IN movement）

**SQL**：`server/sql/v4.1.03_進口報單與收貨.sql`

**驗收**：Import / Receive 頁無黃色橫幅；對 PO 收貨後 `lot`、`inventory_movement` 有列；Lots 頁可用量非 `--`。

---

## 步驟 4｜庫存寫入與快照 ✅（程式已接）

**目標**：Movements 手動異動、轉倉、admin 重建快照

| 項目 | 說明 |
|------|------|
| 已有讀取 | list_inventory_movement*、available_by_lot |
| 補寫入 | `create_inventory_movement`、`post_transfer_bundle` |
| 快照 | `admin_rebuild_lot_balance` / `dev_rebuild_lot_balance` |
| Lot QA | `update_lot` |

**SQL（可選）**：`server/sql/v4.1.04_庫存快照.sql`（lot_balance 表）

**驗收**：手動 OUT 後可用量變化；轉倉產生新 Lot；重建快照筆數 > 0。

---

## 步驟 5｜銷售 + 出貨 ✅（程式已接；需跑 SQL）

**目標模組**：Sales、Shipping

| 表 / action | 後端 `list_*` |
|-------------|---------------|
| sales_order, sales_order_item | list_sales_order*、**list_sales_order_recent** |
| shipment, shipment_item | list_shipment*、**list_shipment_recent** |

**寫入（核心）**：

- `create_*` / `update_*`（銷售單主檔與明細）
- `reset_sales_order_items_cmd` / `cancel_sales_order_bundle`
- `post_shipment_bundle` / `cancel_shipment_bundle`

**SQL**：`server/sql/v4.1.05_銷售與出貨.sql`

**驗收**：Sales / Shipping 頁無黃色橫幅；出貨過帳扣庫；Logs 有 `BUNDLE_POST_SHIPMENT`。

---

## 步驟 6｜委外加工 ✅（程式已接；需跑 SQL）

**目標模組**：Outsource

| 表 | 後端 `list_*` |
|----|---------------|
| process_order, process_order_input, process_order_output | list_process_* |
| lot_relation | list_lot_relation* |

**寫入**：

- `create_process_order_cmd` / `update_process_order_header_cmd`
- `issue_process_order_bundle` / `receive_process_output_bundle`
- `retract_process_issue_bundle` / `void_process_output_bundle` / `cancel_process_order_bundle`

**SQL**：`server/sql/v4.1.06_委外加工.sql`

**驗收**：委外頁無黃色橫幅；送加工扣庫、回收產 Lot；Logs 有 `BUNDLE_ISSUE_PROCESS_ORDER`。

---

## 步驟 7｜追溯 + 倉庫庫存視圖 ✅（程式已接）

**目標模組**：Trace、Warehouse Stock

| 項目 | 說明 |
|------|------|
| trace_transaction_bundle | 依 `transaction_id` 彙總 13 張交易表 |
| trace_lot_bundle | BFS `lot_relation` + 篩 `shipment_item` + `avail_by_lot_id` |
| 倉庫庫存 | 沿用 `list_inventory_movement_available_by_lot` + lot 篩選（步驟 1、4 已完成） |

**後端**：`server/src/bundles/trace.js` → `handlers.js` 已接線

**驗收**：Trace 頁查 Lot / TX 有資料；Warehouse Stock 無黃色橫幅。

---

## 步驟 8｜正式切換 + 關閉 stub fallback ✅（程式已接；PROD 部署需你完成）

| 項目 | 狀態 |
|------|------|
| 關閉 stub fallback | ✅ `listGenericSheet` 未遷移表 → `ERR_TABLE_NOT_MIGRATED` |
| Google 登入 | ✅ `google_login`（Node + `erp_user.email`） |
| `API_BASE_DEV` | ✅ 指向本機 `http://127.0.0.1:1314/exec` |
| `API_BASE_PROD` | ⏳ 部署 Node 到雲端後更新（見 `docs/ERPv4.1_部署SOP.md`） |
| GAS 唯讀/停用 | ⏳ 手動（Apps Script 後台） |
| Supabase 按鈕 | ✅ `supabase_table_editor_url` + `v4.1.08_Supabase表編輯RPC.sql` |
| 部署文件 | ✅ `docs/ERPv4.1_部署SOP.md`、`server/.env.example` |

### 尚未 port（切 PROD 前請知悉）

| 模組 | 說明 |
|------|------|
| Split / Merge | `post_split_bundle` / `post_merge_bundle` 仍待 Node 實作 |

**驗收**：GitHub Pages PROD 無黃色橫幅；`ERPv4.1_smoke-test.ps1 -ExpectedVersion 4.1` 全綠。

---

## 開發備註

- 本機 Supabase API：`http://127.0.0.1:1314/exec`
- 遷移完成某表後：
  - `server/src/handlers.js` → `SUPABASE_LIST_TABLES` 加 key（`user` 對應表 `erp_user`）
  - `js/core/migration-stub.js` → `MIGRATED_TABLES` 加表名（模組黃色橫幅用）
- 未在 `SUPABASE_LIST_TABLES` 的 `list_*` 會回 **ERR_TABLE_NOT_MIGRATED**，前端 `callAPI` 會 throw，列表可能空白並有錯誤 Toast
