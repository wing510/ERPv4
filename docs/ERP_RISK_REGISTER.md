## ERP 風險登記簿（Risk Register）

> 原則：新發現的相鄰風險只登記，不在本次 Phase 1 擴大修正。
>
> 更新日期：2026-07-09

### RR-2026-07-09-01：出貨過帳非單一 DB transaction（半成功風險）

- **狀態**：OPEN
- **範圍**：一般出貨過帳（`postShipmentBundle`）涉及多表寫入（shipment/shipment_item/inventory_movement/sales_order_item/ar_receivable 等）
- **風險**：任何中途錯誤都可能留下「已扣庫或已 POSTED，但 AR/後續處理未完成」的半成功狀態
- **本次處置**：不在 Phase 1 擴大範圍重構；僅確保 Phase 1 的計價與 AR.amount_system 依快照落帳，不再重算
- **後續建議**：以 RPC/transaction 將出貨過帳收斂為單一原子交易（需另開 Gate）

