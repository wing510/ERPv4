# ERP 部署 SOP（v4.1 Supabase + Node）

> 前端：GitHub Pages（或本機 Live Server）  
> 後端：`server/` Node API + Supabase PostgreSQL  
> v3.3 GAS 版 SOP 已移除；v4.1 以本檔為準。

---

## A. 什麼時候要跑這份 SOP？

- 第一次把 **PROD** 從 GAS 切到 Node API
- 要交 **公司 Windows 主機** 給同事安裝（先跑 `ERPv4.1_PROD-pack.ps1` 打包）
- Node API 或 Supabase 設定有變
- 前端有改 JS/HTML（記得更新 `index.html` 的 `?v=`）

---

## B. 本機開發（已完成步驟 1～7 後）

### 1) Supabase

依序在 SQL Editor 執行（若該步尚未跑過）：

- **正式庫一次建置**：`server/sql/v4.1.00_正式庫一次建置.sql`（全新 PROD 建議用此檔一次 Run）
- 或逐步：`v4.1.01_主檔.sql` … `v4.1.06_委外加工.sql`、`v4.1.08_Supabase表編輯RPC.sql`、`v4.1.10_商業發票.sql` … `v4.1.17_HS稅則號.sql`
- 建表後：**`v4.1.18_取消資料API公開.sql`**（移除 Table Editor 地球圖示）

### 2) Node API

```powershell
cd d:\Desktop\ERP\server
copy .env.example .env
# 編輯 .env：SUPABASE_URL、SUPABASE_SECRET_KEY、ERP_SUPER_ADMIN_*、GOOGLE_CLIENT_ID_*
npm install
npm run dev
```

成功：`ERP Supabase API http://127.0.0.1:1314/exec`

### 3) 前端

- `js/core/config.js` → `API_BASE_DEV` 已指向 `http://127.0.0.1:1314/exec`
- 開 `http://127.0.0.1:5501/index.html` → **Ctrl+F5**
- 登入：admin 密碼 或 Google（`erp_user.email` 須在 Supabase 且 ACTIVE）

---

## C. 正式上線（PROD 切換）

### 0) 打包交付 zip（交公司同事安裝前）

在開發機執行：

```powershell
cd D:\Desktop\ERP\docs
.\ERPv4.1_PROD-pack.ps1
```

**成功判斷：** 專案根目錄產生 `ERP-v4.1-PROD-deploy_YYYYMMDD-HHMM.zip`（約 3～4 MB）。

| zip 內容 | 說明 |
|----------|------|
| `server\` | Node API（不含 `node_modules`、`.env`） |
| `web\` | `index.html` + `js` + `modules` + `assets` |
| `本安裝說明.txt` | 快速安裝 |
| `server\.env.example` | 複製為 `.env` 後填空 |
| `設成Windows服務-說明.txt` | NSSM 設常駐服務（文字版） |

- 說明範本來源：`docs/deploy-templates/`（改範本後重跑打包腳本即可）。
- 機密設定僅用 `server\.env.example`（複製為 `.env` 後編輯）；zip 內**不含**獨立的「機密設定」文字檔。
- 指定輸出路徑：`.\ERPv4.1_PROD-pack.ps1 -OutZip "D:\交付\xxx.zip"`

### 1) 公司 Windows 主機安裝（建議內網）

**架構：** 瀏覽器 → IIS 靜態 `web\` → 公司主機 Node API → Supabase 雲端 `ERP_DB_PROD正式`。

1. 解壓 zip 至例如 `D:\ERP\`
2. `copy D:\ERP\server\.env.example D:\ERP\server\.env`，編輯填入機密（`ERP_ENV_NAME=PROD`）
3. 安裝 [Node.js 18 LTS+](https://nodejs.org)，PowerShell：

```powershell
cd D:\ERP\server
npm install
npm start
```

成功：`http://127.0.0.1:1314/health` → `{"ok":true,"erp_version":"4.1","env":"PROD"}`

4. `web\` 複製到 IIS 網站根目錄；`web\js\core\config.js` → `API_BASE_PROD` 改為公司 API 網址（例 `http://erp:1314/exec`）
5. 設成 Windows 服務（開機自動啟動）：見 zip 內 `設成Windows服務-說明.txt`（工具 NSSM）
6. Google OAuth **已授權的 JavaScript 來源** 加入 IIS 正式網址

### 2) 或：部署 Node API 到雲端（Railway / Render 等）

| 項目 | 說明 |
|------|------|
| Root | `server/` |
| Start | `npm start` |
| 環境變數 | `ERP_ENV_NAME=PROD` + Supabase + Google（見 `.env` 範本） |
| 健康檢查 | `GET /health` → `{ ok: true, erp_version: "4.1" }` |

取得公開 URL，例如：`https://erp-api.example.com/exec`

### 3) 更新前端 PROD 端點

`js/core/config.js`：

```javascript
API_BASE_PROD: "https://erp-api.example.com/exec", // prev: GAS ...
```

推送 GitHub Pages 後，用 `?env=PROD` 開站驗證一次。

### 4) Google 登入（正式站）

- Google Cloud Console → OAuth 用戶端 → **已授權的 JavaScript 來源** 加入 GitHub Pages 網域
- `server/.env` 的 `GOOGLE_CLIENT_ID_PROD` 與 `config.js` 的 `GOOGLE_CLIENT_ID_PROD` 一致
- Supabase `erp_user` 表：使用者 `email` 必須存在且 `status=ACTIVE`

### 5) GAS 舊後端

- **建議**：Apps Script 改為唯讀或停用 Web App 寫入（Sheets 留備份）
- 前端 `API_BASE_PROD` 指向 Node 後，不再寫入 Sheets

---

## D. 冒煙測試

```powershell
cd d:\Desktop\ERP\docs
.\ERPv4.1_smoke-test.ps1 `
  -SiteUrl "https://你的-github-pages" `
  -ApiBase "https://erp-api.example.com/exec" `
  -ExpectedVersion "4.1" `
  -ActorId "admin" `
  -SessionToken "（登入後從 DevTools / session 取得）"
```

**通過標準**：無 `[FAIL]`；各模組無黃色「尚未遷移」橫幅。

Node API 也可用：

```powershell
Invoke-RestMethod "https://erp-api.example.com/health"
```

---

## E. v4.1 step8 程式變更摘要

| 項目 | 狀態 |
|------|------|
| `list_*` 未遷移表 | 回 **明確錯誤**（不再 `source: stub` + 空陣列） |
| `google_login` | Node API 已實作（tokeninfo + `erp_user.email`） |
| `API_BASE_DEV` | 本機 Node `1314` |
| `migration-stub` | 非 GAS URL 視為 Supabase 後端 |

---

## F. 尚未遷移（切 PROD 前請知悉）

| 模組 | 說明 |
|------|------|
| Split / Merge | `post_split_bundle` / `post_merge_bundle` 仍在 GAS；PROD 全切 Node 後此二模組需後續補 port |

---

## G. 使用者端

上線後請使用者 **Ctrl+F5**；API 重啟後需重新登入。
