# ERP v4.2.4 寄賣模組效能改善備忘

> **版本**：v4.2.4（寄賣模組 · 效能）  
> 建立：2026-06-16  
> 狀態：**P0／P1 已實作**（2026-06-16）  
> 觸發：使用者反映寄賣相關頁面（Case／Settlement／Return／Promo 下拉）載入偏慢。

---

## 現象

- 進入 **Case 案件**、**Settlement 結算**、**Return 收回**、**Promo 促銷** 時，常需等待數秒（案件數多時更明顯）。
- 選定寄賣案後載入池子／歷史，相對可接受；**慢的主要在「案件列表／下拉」第一次出現前**。

---

## 根因（已確認）

### 1. 後端 `list_consignment_case_enriched` — N+1 查詢（主因）

**檔案：** `server/src/bundles/consignment-case.js` → `listConsignmentCaseEnriched_`

流程：

1. 查 `consignment_case`（最多 500 筆）
2. 批次查 `customer` 取 `customer_name`（已優化，OK）
3. **對每一案**在 `for` 迴圈內串行：
   - `consignment_case_pool_item`（該案池子）
   - `sumCaseSettledAmountAndPromo_`（結算表 + 結算明細）
   - `sumCaseReceivedAmount_`（結算 → `ar_receivable` 收款）

粗估：**每案約 4～6 次** DB 往返 × 案件數（串行）→ 20 案約百次、50 案約數百次。

下拉顯示「已收／預估應收(%)」依賴此 API，故**任一頁載入寄賣案下拉都會觸發**。

### 2. 前端重複呼叫 enriched API（次因）

| 頁面 | 載入時 API 行為 |
|------|-----------------|
| **Case** | `ccListCases_` enriched（列表） |
| **Settlement** | 先 `OPEN` enriched → 若有選案再 `ALL` enriched（`ccSettlementLoadCase_`） |
| **Return** | 下拉 `OPEN` enriched → 選案後 `ALL` enriched（`ccReturnLoadCase_`） |
| **Promo** | 進頁 `ALL` enriched（寄賣案下拉） |

同一 session 內可能**短時間算兩遍**整包 enriched（OPEN + ALL）。

### 3. 主檔預載（輕微）

各頁 `consignmentXxxInit` → `ccLoadMasterData_()`：`getAll(customer)`、`getAll(product)`、`getAll(warehouse)`。主檔大時略慢，通常不如 enriched 嚴重。

---

## 改善方向（建議優先順序）

### P0 — 後端 enriched 改批次彙總（效益最大）

- **目標：** 固定次數查詢（與案件數解耦），勿 `for` 每案查 pool / settlement / AR。
- **作法示意：**
  - 一次 `IN (case_ids)` 撈全部 `consignment_case_pool_item`，記憶體依 `case_id` 彙總。
  - 一次撈 POSTED 結算 + 結算明細，依 `case_id` 彙總 `settledAmount` / `listAmount` / `promoAllowance`。
  - 一次撈相關 `ar_receivable`，依 `case_id` 彙總 `total_received_amount`。
- **檔案：** `server/src/bundles/consignment-case.js`（`listConsignmentCaseEnriched_` 及相關 sum 函式）。
- **注意：** 回傳欄位與現行前端一致，避免破壞下拉格式 `案件ID｜客戶名稱｜開案日｜已收/預估應收(%)`。

### P1 — 前端少打重複 enriched

- **Settlement／Return：** 選案後載入摘要時，勿再 `ccListCases_({ status: "ALL" })`；改為：
  - 沿用下拉已載入的 case 列，或
  - 新增／使用**單案查詢** API（僅一筆 enriched 或僅 case 主檔 + 必要欄位）。
- **檔案：** `js/consignment-settlement.js`（`ccSettlementLoadCase_`）、`js/consignment-return.js`（`ccReturnLoadCase_`）。
- **可選：** session 內 enriched 列表短快取（`ccListCases_` 包一層，TTL 或同頁不重打）。

### P1 — 下拉輕量列表（可與 P0 二選一或並行）

- 下拉僅需：案件 ID、客戶名稱、開案日、簡要未售／進度。
- 完整「已收／預估應收(%)」改在**選案後**案件摘要區載入。
- 需新 API 或 enriched 的 `lite=1` 參數。

### P2 — 長期：SQL view 或 RPC

- 例如 `v_consignment_case_enriched`，或 `erp_list_consignment_case_enriched` RPC，供列表／下拉專用。
- 利於正式庫索引與維護。

### P3 — 其他（非載入慢主因）

- `js/consignment-shared.js` 體積大，可日後拆分（維護性，非首要效能）。
- Promo 列表、池子單案查詢目前尚可，優先處理 enriched。

---

## 成功判斷（改善後）

- 案件約 **50 筆**時，進 Settlement／Return，下拉出現 **&lt; 2 秒**（本機 DEV，視網路略有差異）。
- 後端 `list_consignment_case_enriched` 的 DB round-trip **不隨案件數線性暴增**（例如固定 &lt; 10 次查詢）。
- 選案後載入池子，行為與金額與改善前一致（回歸：開案、出貨掛池、結算、收回、下拉文案）。

---

## 相關檔案速查

| 類型 | 路徑 |
|------|------|
| 後端 enriched | `server/src/bundles/consignment-case.js` |
| 前端 API 封裝 | `js/consignment-shared.js` → `ccListCases_` |
| Case 列表 | `js/consignment-case.js` → `ccReloadCaseList_` |
| Settlement | `js/consignment-settlement.js` → `ccSettlementReload_`、`ccSettlementLoadCase_` |
| Return | `js/consignment-return.js` → `ccReturnLoadCase_`、`ccPopulateCaseDropdown_` |
| Promo | `js/consignment-promo.js` → `consignmentPromoInit` |
| 出貨下拉 | `js/shipping.js` → `shipRefreshConsignmentCaseDropdown_` |

---

## 備註

- 收回頁已加「數量 ≤ 未售」前端驗證；與效能無關。
- 改倉說明、help 已對齊現況；與效能無關。
- 實作前建議用 DEV 量測：案件 10／50／100 筆，記錄 `list_consignment_case_enriched` 耗時與查詢次數，作為對照基準。

---

## 相關文件

- `docs/ERPv4.2.1_寄賣與財務收款_討論定案說明書.md`  
- `docs/ERPv4.2.2_寄賣案件_討論定案說明書.md`  
- `docs/ERPv4.2.3_寄賣促銷方案_討論定案說明書.md`
