# ERP 專案級商業不變條件與跨模組核心規則（完整版）

> 日期：2026-07-08  
> 文件定位：**可維護的完整版不變條件與跨模組核心規則**（商業細節與例外也放這裡）  
> 注意：本文件包含「當下定案」的細節條款（可能會隨商業規則調整而更新）。  
> 精簡治理不變請見：`.cursor/rules/11-erp-domain-invariants.mdc`

---

## 更新規則（很重要）

- 本文件是「目前已確認」的專案約束；**不是永久不變的真理**。
- 未來若正式商業規則改動（例如促銷 scope、寄賣 routing、月結口徑），**本文件必須同步更新**，否則 AI/團隊會忠實遵守過期規則造成反效果。

## 衝突處理

### 需求與本文件衝突
1. 不得自行選擇  
2. 不得自行改變既有規則  
3. 必須列出衝突  
4. 必須等待人工確認

### 程式現況與本文件不一致
不得默默以現況為正確答案。必須標記並輸出：

- DOCUMENTED_RULE
- CURRENT_BEHAVIOR
- DIFFERENCE
- RISK
- RECOMMENDATION

---

# 1. Global Source of Truth

每個核心商業資料必須有唯一 Source of Truth。禁止多個模組各自維護同一真相。

必須明確區分：

- Source of Truth
- Snapshot
- Cache
- Derived Value
- Audit Record

任何新增欄位若與既有資料重複，必須先定義其角色。

---

# 2. Sales Order Invariants

## 2.1 SO Item

每個 Sales Order Item 必須屬於指定 Sales Order。

禁止：

- 使用其他 SO 的 so_item_id
- client 任意指定不屬於該 SO 的 item
- shipment 更新錯誤 SO item

所有 Shipment POST 必須驗證：

`sales_order_item.so_id = shipment.so_id`

## 2.2 Product Consistency

Shipment Item 的 Product 必須與 SO Item 一致。

若使用 Lot：

`SO Item Product = Shipment Item Product = Lot Product`

任何不一致：必須 fail closed。

不得：

- 自動替換 product
- silent continue
- 使用 client product_id 覆蓋 DB truth

## 2.3 Over Shipment

任何情況：

`SUM(shipped_qty) <= order_qty`

同一 request 若相同 `so_item_id` 出現多列，必須先：

`GROUP BY so_item_id` → `SUM(requested_ship_qty)`

再與剩餘可出貨量比較。禁止逐列各自檢查後再累加。

## 2.4 Multi-Lot

同一 SO Item 允許拆分多個 Lot 出貨。例如：

- SO Item A qty = 10  
- Shipment: Lot L1 = 4、Lot L2 = 6

此情境為合法流程。任何 Pricing、Promotion、Shipment Item Mapping、VOID、Inventory Movement 必須支援。

不得假設：`1 SO Item = 1 Lot`

---

# 3. Shipment Invariants

## 3.1 Shipment Type

目前至少區分：

- NORMAL
- CONSIGNMENT

新 Shipment Transaction RPC：

- NORMAL -> 可導向新 RPC  
- CONSIGNMENT -> 在正式完成對應 RPC 前維持既有流程

禁止將所有 Shipment Type 無條件切入 NORMAL RPC。

## 3.2 Shipment POST Atomicity

NORMAL Shipment POST 為不可部分成功交易。以下操作必須位於同一 DB transaction：

- validate SO / SO items / Lots
- lock required rows
- create/update Shipment + Shipment Items
- create Inventory Movements / update Inventory
- update SO shipped_qty / SO status
- calculate Pricing / apply Promotion / snapshot
- create AR
- apply Dealer Credit（where applicable）
- append Dealer Cumulative Ledger（where applicable）
- write Audit data

任何一步失敗：全部 rollback。禁止 Node 多步呼叫模擬 transaction。

## 3.3 NORMAL Shipment AR

NORMAL Shipment 若依現行正式規則應產生 AR：

- POSTED Shipment 必須存在對應 AR
- VOID 時 AR missing 必須 fail closed（不得 silent continue）

## 3.4 Shipment Idempotency

相同 Shipment POST request 重送不得：

- 重複扣庫存
- 重複增加 shipped_qty
- 重複建立 AR
- 重複套 Dealer Credit
- 重複增加 cumulative
- 重複建立 movement

必須使用正式 idempotency strategy（優先順序）：

- transaction_id
- shipment_id
- source_type + source_id
- UNIQUE constraint
- request hash when necessary

## 3.5 Shipment Item Identity

Pricing 與 Shipment Item 對應不得只用 `so_item_id` 當唯一 line key（同一 so_item_id 可拆多 Lot）。

必須使用可唯一識別實際 Shipment line 的 key，例如：

- shipment_item_id
- stable line_key
- item_seq + shipment_id

---

# 4. Inventory and Lot Invariants

## 4.1 Inventory Source

所有庫存異動必須可追溯正式來源。每筆 movement 必須能回答：

- source_type
- source_id
- movement_type
- quantity
- lot_id
- actor
- created_at

## 4.2 Lot Availability

出貨不得使可用庫存低於允許範圍。

同一 request 若同一 `lot_id` 出現多列，必須先：

`GROUP BY lot_id` → `SUM(required_qty)` 再驗證總需求。

不得逐列檢查舊 available_qty。

## 4.3 Lot Lock Order

涉及多 Lot 必須使用固定順序 lock（例如 `ORDER BY lot_id`）。POST 與 VOID 應使用一致 lock order，降低 deadlock 風險。

## 4.4 Shipment VOID Inventory

Shipment VOID 必須依原 Shipment Items 與原始 movement 關係反向。

不得：

- 依目前 UI 輸入重新決定 qty
- 猜測原 qty
- 重新選 Lot
- 使用目前庫存狀態重建原交易

作廢 movement 應使用明確類型（例如 SHIP_VOID），不得混用一般人工 ADJUST。

---

# 5. Pricing Invariants

## 5.1 DB Pricing Authority

對已切入新 Shipment RPC 的流程：DB Pricing Engine 為權威計價來源。

Node pricing snapshot 只能作為：

- preview
- comparison
- mismatch detection

不得作為最終 amount_system 權威來源。

## 5.2 Pricing Snapshot

Shipment POST 後必須保存原始 Pricing Snapshot，至少可追溯：

- product / shipment item / quantity
- base price / pricing basis
- promotion / free qty / billed qty
- net amount / currency
- pricing date / rule source

VOID 必須使用原 POST 結果反向，禁止重新計價。

## 5.3 Same Product Multiple Lines

同一商品可出現在多個 SO lines，不得假設 same product = same SO price。

若不同 SO lines 有不同價格，Pricing Engine 必須依正式規則處理，不得任意取第一列套全部。

---

# 6. Promotion Invariants

## 6.1 Promotion Scope

促銷必須明確定義 scope（例如 PER_SHIPMENT / PER_ORDER / PER_SETTLEMENT / PER_MONTH），不得由程式實作暗中決定。

## 6.2 General Shipment Buy-N-Get-M

目前一般出貨買 N 送 M：以本批 Shipment 為計算範圍，不跨不同 Shipment 自動累積（除非未來商業規則明確修改）。

## 6.3 Promotion Snapshot

POST 時套用的 Promotion 必須 snapshot；VOID 不得重新查目前 ACTIVE promotion 後重算。

## 6.4 Promotion Overlap

多促銷重疊必須依明確 priority 規則；不得暗用 `created_at` 當隱含商業優先序（除非正式規則如此定義）。

---

# 7. Dealer Pricing Invariants

## 7.1 Dealer Pricing

若使用累積制經銷價，必須考慮 scheme type、ACTIVE、effective period、stat_source、started_at、tier、pending tier 與 effective month。

不得默默 fallback 到錯誤價格。

## 7.2 Missing Scheme

必須區分：

- A. Customer 合法沒有 Dealer Scheme -> 可依正式 fallback 規則  
- B. Customer 指定 scheme_id，但 scheme 不存在 -> data integrity error -> fail closed

不得把 B 當 A。

---

# 8. Dealer Cumulative Invariants

## 8.1 Source of Truth

`dealer_cumulative_ledger` 為 Source of Truth。`customer.dealer_cumulative_amount`、`ar_receivable.dealer_cumulative_added` 只能是 cache/snapshot/derived。

## 8.2 One Commercial Amount Once

同一商業金額只能計入 cumulative 一次，禁止 GENERAL_SHIPMENT 已累積後，MONTHLY_REBATE 對同一 GENERAL component 再累積一次。

## 8.3 General Shipment Cumulative Eligibility

一般出貨是否累積必須依正式規則判斷（scheme type、ACTIVE、stat_source includes GENERAL、started_at、date_from/date_to），不得只因客戶有 scheme 就全部累積。

## 8.4/8.5 Ledger POST/VOID

POST/VOID 必須使用正式 source identity；VOID 必須 lock 原 POST 並反向相同金額（負數），不得 caller 猜測反向金額或用 AR 現值推測。

## 8.6 Immutable Ledger

原 POST ledger 不得刪除；VOID 用 reversal entry 保留完整歷史。

---

# 9. Monthly Rebate Invariants

- 月結 cumulative 必須拆來源 component，且以 DB 明細計算為準；caller amount 只可做 mismatch validation。
- 已鎖定月結期間，普通 Shipment VOID 不得破壞已結算結果（需 block 或正式 reopen/adjustment 流程）。

---

# 10. Accounts Receivable Invariants

- Shipment POST 必要的 AR 建立必須同 transaction。
- Payment registration 必須同 transaction（validate/lock/insert/recalc/status/audit）。
- Batch payment 若規則要求 atomic，不得出現部分成功。
- 同一 AR 同時收款必須 lock，避免 lost update。
- 必須維護 amount_due/amount_received/outstanding/status 的一致性，避免 over receive 或錯誤結案。

---

# 11. AR Write-off Invariants

- 差額沖銷與反向必須是正式資料（不得只靠 system_remark）。
- VOID/reversal 必須由正式原始紀錄取得金額，不得解析 remark 猜測。

---

# 12. Dealer Credit Invariants

- Shipment POST 套用 Dealer Credit 必須與 Shipment/AR 同 transaction。
- Credit 必須有正式 source identity（`SHIPMENT_CREDIT`/`SHIPMENT_CREDIT_VOID` + shipment_id）與 UNIQUE 防重。
- 禁止只改 credit balance 而無 reversal history；必須可追溯使用與還原。

---

# 13. Shipment VOID Invariants

- 所有可前置完成的 blocker validation 必須優先於 mutation（至少：shipment/SO/items/lots/AR/payment/月結鎖/寄賣依賴/ledger/credit readiness）。
- AR 已有有效付款：普通 VOID 必須拒絕。
- NORMAL 理應有 AR 但 missing：fail closed。
- 重複 VOID 不得重複還庫存、重複 reverse ledger、重複 restore credit、重複 void AR。

---

# 14. Consignment Invariants

- 新 Consignment RPC 完成前，CONSIGNMENT 不得誤導向 NORMAL RPC。
- 寄賣 settlement 若涉及 pool/AR/credit/cumulative/rebate，必須分析 single transaction。
- 正式 transaction RPC 缺失不得 silent fallback legacy（除非人工核准過渡方案）。

---

# 15. Permission / UI / Migration Invariants（摘要）

- 所有 mutation 必須 server-side 驗證；actor 不可信任 client。
- 除非明確核准，不得改 UI/API contract/error/report meaning。
- 新增 UNIQUE/FK/CHECK/NOT NULL 前必須檢查既有資料；不可破壞式驚喜刪歷史。

---

# 16. Unknown Business Rule（禁止猜）

遇到程式有兩套不同邏輯、文件與程式不同、Node 與 SQL 不同等，必須輸出 `UNKNOWN_BUSINESS_RULE` 與 A/B 現況、影響模組與需要決策，不得自行選擇較合理版本。

