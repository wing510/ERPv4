# ERPv4.1 Supabase API 起步

Node API 對齊前端 `callAPI({ action: "..." })` 格式；資料在 **Supabase PostgreSQL**。

> 完整遷移進度：`docs/ERPv4.1_遷移順序.md`  
> 部署與冒煙測試：`docs/ERPv4.1_部署SOP.md`

---

## 1. 安裝

```powershell
cd D:\Desktop\ERP\server
copy .env.example .env
# 編輯 .env：SUPABASE_URL、SUPABASE_SECRET_KEY、ERP_ADMIN_PASSWORD_SHA256_HEX、GOOGLE_CLIENT_ID_*
npm install
```

## 2. 啟動

```powershell
npm run dev
```

**成功判斷：** 終端機顯示 `ERP Supabase API http://127.0.0.1:1314/exec`、`env=DEV`。

## 3. 前端連本機 API

本機 DEV 預設已指向 Node（`js/core/config.js` → `API_BASE_DEV` = `http://127.0.0.1:1314/exec`）。

1. Live Server 開 `http://127.0.0.1:5501/index.html`
2. **Ctrl+F5**
3. admin 密碼登入或 Google 登入（`erp_user.email` 須在 Supabase 且 ACTIVE）

API 重啟後 session 會失效，需重新登入。

---

## 4. `list_*` 行為（step8 後）

| 情況 | API 回應 |
|------|----------|
| **已遷移表** | `{ success: true, data: [...], source: "supabase" }` |
| **未遷移表** | `{ success: false, error_code: "ERR_TABLE_NOT_MIGRATED", errors: ["Unknown list table: …"] }` |

**不再**回 `{ source: "stub", data: [] }` 假空陣列。

前端 `js/core/migration-stub.js` 的 `MIGRATED_TABLES` 仍用於模組**黃色橫幅**（依模組依賴表判斷）；與後端 `SUPABASE_LIST_TABLES` 應保持一致。

---

## 5. 已實作 action（摘要）

### 登入 / 環境

| action | 說明 |
|--------|------|
| `login` | admin 密碼（`.env` 內 SHA256 HEX） |
| `google_login` | Google id_token + `erp_user.email` |
| `session_resume` / `session_logout` | Session 續期 / 登出 |
| `env_info` | 回 `backend: "supabase"`、`supabase_project_ref` |
| `supabase_table_editor_url` | Supabase 按鈕直達 Table Editor |

### 讀取 `list_*`

主檔、採購、進口、收貨、批號、異動、銷售、出貨、委外、logs 等——見 `server/src/handlers.js` 的 `SUPABASE_LIST_TABLES`。

另有多個**專用 list**（如 `list_inventory_movement_recent`、`list_lot_relation_by_lot` 等）。

### 寫入

| 類型 | 範例 |
|------|------|
| 主檔 CRUD | `create_*` / `update_*` / `delete_*`（product、supplier、customer、warehouse、user） |
| 採購 / 進口 | `cancel_purchase_order_bundle`、`save_import_document`、… |
| 收貨 | `post_goods_receipt_bundle`、`post_import_receipt_bundle`、cancel 系列 |
| 出貨 / 銷售 | `post_shipment_bundle`、`cancel_shipment_bundle`、`cancel_sales_order_bundle` |
| 轉倉 | `post_transfer_bundle` |
| 委外 | `create_process_order_cmd`、`issue_process_order_bundle`、`receive_process_output_bundle`、… |
| 追溯 | `trace_lot_bundle`、`trace_transaction_bundle` |

交易表**禁止**通用 `create_*` / `update_*` 側門；未允許的 action 回 `Unknown or missing action` 或明確 fail。

### 尚未 port（切 PROD 前請知悉）

| 模組 | 說明 |
|------|------|
| Split / Merge | `post_split_bundle` / `post_merge_bundle` 仍待 Node 實作 |

---

## 6. Supabase SQL（依序執行）

在 Supabase SQL Editor 執行（若該步尚未跑過）：

- `server/sql/v4.1.00_正式庫一次建置.sql`（全新庫一次建表）
- 或逐步：`v4.1.01_主檔.sql` … `v4.1.17_HS稅則號.sql`（見 `server/sql/`）
- `v4.1.18_取消資料API公開.sql`（建表後執行）

---

## 7. 注意

- Session 存在**記憶體**（重啟 API 要重新登入）；上線前可改存 Supabase `sessions` 表。
- **Secret key 僅放 `server/.env`**，勿放前端。
- 使用者表名為 **`erp_user`**（API 仍用 `list_user` / 模組 key `user`）。
- 健康檢查：`GET http://127.0.0.1:1314/health` → `{ ok: true, erp_version: "4.1" }`。
- 直接開 `/exec` 看到 `Unknown or missing action` 屬正常（須帶 `action` 參數）。
