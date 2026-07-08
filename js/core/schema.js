/*********************************
 * ERP Schema Contract v3
 * 設計依據：《公司營運流程總整理》、食品追溯追蹤系統管理辦法、ERP v1.1 設計整理文件
 * 核心：PO 不產生庫存；收貨產生 Lot；inventory_movements 為唯一庫存來源；銷售不直接扣庫，出貨才扣庫
 *********************************/

const SCHEMA = {

  /*********************************
   * Master Data
   *********************************/

  product: [
    "product_id",
    "product_name",
    "product_name_en",
    "hs_code",
    // RM / WIP / FG
    "type",
    "spec",
    "unit",
    "suggested_retail_price",
    // 多單位換算 JSON：{"base_unit":"KG","map":{"BOX":0.01,...}}（1 產生單位 = map[U] 基準單位）
    "uom_config",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  customer_recipient: [
    "recipient_id",
    "customer_id",
    "recipient_name",
    "recipient_name_en",
    "address",
    "phone",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  // 供應商（食品追溯辦法：名稱、登錄字號、地址、聯絡人、聯絡電話）
  supplier: [
    "supplier_id",
    "supplier_name",
    "contact_person",
    "phone",
    "email",
    "address",
    "country",
    // 供應商類型（可多選）：RM/PK/WIP/FG/PROC/LOG/OTHER...（逗號分隔）
    "supplier_type",
    // 可用流程（可多選）：PO/IMPORT/OUTSOURCE...（逗號分隔）
    "supplier_flow",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  // 客戶（食品追溯辦法：買受者名稱、地址、聯絡人、食品業者登錄字號等）
  customer: [
    "customer_id",
    "customer_name",
    "customer_type",
    "category",
    "contact_person",
    "phone",
    "email",
    "address",
    "country",
    "tax_id",
    "invoice_title",
    "invoice_email",
    "invoice_type_default",
    "invoice_name_en",
    "invoice_address_en",
    "consignee_id_no",
    "consignee_usci",
    "consignment_allocation_policy",
    "dealer_scheme_id",
    "dealer_rebate_scheme_id",
    "dealer_cumulative_scheme_id",
    "dealer_rebate_settle_mode",
    "dealer_rebate_excluded",
    "dealer_rebate_credit_balance",
    "dealer_cumulative_amount",
    "dealer_cumulative_tier_label",
    "dealer_cumulative_price_rate",
    "dealer_cumulative_pending_tier_label",
    "dealer_cumulative_pending_price_rate",
    "dealer_cumulative_started_at",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  // 倉庫（分倉/定位的主檔）
  warehouse: [
    "warehouse_id",
    "warehouse_name",
    // AMBIENT / CHILLED / FROZEN
    "category",
    "address",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  /*********************************
   * Purchase (STEP 1)
   *********************************/

  purchase_order: [
    "po_id",
    "supplier_id",
    "order_date",
    "expected_arrival_date",
    // OPEN / PARTIAL / CLOSED
    "status",
    "document_link",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  purchase_order_item: [
    "po_item_id",
    "po_id",
    "product_id",
    "order_qty",
    "received_qty",
    "unit",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Import Document
   *********************************/

  import_document: [
    "import_doc_id",
    "import_no",
    "declaration_no",
    "supplier_id",
    "import_date",
    "release_date",
    "inspection_no",   // 查驗案號（輸入查驗申請書號碼）
    "document_link",   // 文件連結
    "incoterm",
    "mbl_no",
    "hbl_no",
    "exporter_name",
    "importer_name",
    "port_of_entry",
    "currency",
    "customs_value",
    "tax_amount",
    "vat_amount",
    "freight_amount",
    "insurance_amount",
    "other_fee_amount",
    "broker",
    "status",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "remark",
    "system_remark"
  ],

  import_item: [
    "import_item_id",
    "import_doc_id",
    "product_id",
    "item_no",
    "description",
    "hs_code",
    "declared_qty",
    "declared_unit",
    "declared_price",
    "declared_amount",
    "origin_country",
    "invoice_no",
    "net_weight",
    "gross_weight",
    "package_qty",
    "package_unit",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Import Receipt（進口收貨入庫）
   * 海外 Supplier → 報關 → Import Receipt（含報單資料） → Lot
   *********************************/

  import_receipt: [
    "import_receipt_id",
    "import_doc_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "receipt_date",
    "warehouse",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  import_receipt_item: [
    "import_receipt_item_id",
    "import_receipt_id",
    "import_item_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "received_qty",
    "unit",
    "lot_id",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Inventory Lots (STEP 2 & 3)
   * 類型 RM/WIP/FG；狀態 PENDING/APPROVED/REJECTED；追溯辦法：批號、有效日期、製造日期、收貨日期
   *********************************/

  lot: [
    "lot_id",
    "product_id",
    "warehouse_id",
    // 來源：PO / IMPORT / REPACK / PROCESS 等
    "source_type",
    "source_id",
    // 初始入庫數量（庫存帳本以 inventory_movement 為準）
    "qty",
    "unit",
    // RM / WIP / FG
    "type",
    // PENDING / APPROVED / REJECTED
    "status",
    // ACTIVE / CLOSED / VOID（是否可再被使用）
    "inventory_status",
    "received_date",
    "manufacture_date",
    "expiry_date",
    "factory_lot",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    // 系統追溯字串（由各模組自動寫入），與使用者備註 remark 分離；欄位放最後便於 sheet header 對齊
    "system_remark"
  ],

  /*********************************
   * Inventory Movements（庫存帳本，唯一扣庫核心）
   *********************************/

  inventory_movement: [
    "movement_id",
    // IN / OUT / ADJUST / PROCESS_IN / PROCESS_OUT / SHIP_OUT
    "movement_type",
    "lot_id",
    "product_id",
    "warehouse_id",
    // cross-module traceability
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    // qty 建議：IN 為正數、OUT 為負數（避免方向欄位分裂）
    "qty",
    "unit",
    // ref_type / ref_id 用來追溯來源單據（PO / IMPORT / PROCESS / SHIPMENT...）
    "ref_type",
    "ref_id",
    // 手動異動：領用/交付對象（例如 公關/員工/KOL/經銷）
    "issued_to",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    // 系統追溯字串（由各模組自動寫入），與使用者備註 remark 分離
    "system_remark"
  ],

  // 庫存快照（查詢加速；真相仍為 inventory_movement）
  lot_balance: [
    "lot_id",
    "available_qty",
    "movement_count",
    "last_movement_id",
    "updated_at",
    "updated_by"
  ],

  /*********************************
   * Goods Receipt（採購收貨）
   * PO → 收貨（可分批）→ 每次收貨產生 Lot（PENDING）→ movements(IN)
   *********************************/

  goods_receipt: [
    "gr_id",
    "po_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "receipt_date",
    "warehouse",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  goods_receipt_item: [
    "gr_item_id",
    "gr_id",
    "po_id",
    "po_item_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "received_qty",
    "unit",
    "lot_id",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Process / Outsource（委外加工）
   * - 投料：inventory_movement(PROCESS_OUT)
   * - 回收：inventory_movement(PROCESS_IN)
   * - 追溯：lot_relation
   *********************************/

  process_order: [
    "process_order_id",
    // PROCESS / PACKING / REPACK / REWORK / SPLIT / MERGE（依 ERP v1.1 設計）
    "process_type",
    // RM / WIP / FG（來源類別）
    "source_type",
    // 加工廠（供應商）
    "supplier_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "planned_date",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  process_order_input: [
    "process_input_id",
    "process_order_id",
    "lot_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "issue_qty",
    "unit",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  process_order_output: [
    "process_output_id",
    "process_order_id",
    "lot_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "receive_qty",
    "unit",
    // 回收當下換算後的損耗（基準單位）
    "loss_base_qty_after",
    "loss_base_unit",
    // PENDING / APPROVED / REJECTED（沿用 lot.status）
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  lot_relation: [
    "relation_id",
    // INPUT / OUTPUT / REPACK / REWORK / SPLIT / MERGE
    "relation_type",
    "from_lot_id",
    "to_lot_id",
    "qty",
    "unit",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "ref_type",
    "ref_id",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Sales Orders（銷售單，不直接扣庫）
   *********************************/

  sales_order: [
    "so_id",
    "customer_id",
    "salesperson_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    // NORMAL / SAMPLE / GIFT / CONSIGNMENT / RESHIP / OTHER
    "so_type",
    // 當 so_type=RESHIP 時，必填原單參考（SO / SHIPMENT）
    "reship_ref_type",
    "reship_ref_id",
    "order_date",
    "currency",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  sales_order_item: [
    "so_item_id",
    "so_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "order_qty",
    "shipped_qty",
    "unit",
    "unit_price",
    "amount",
    "billable_qty",
    "free_qty",
    "promo_scheme_id",
    "promo_scheme_name",
    "promo_type",
    "promo_price_basis",
    "base_unit_price",
    "pricing_snapshot_id",
    "pricing_version",
    "promo_buy_qty",
    "promo_scheme_free_qty",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  /*********************************
   * Shipment（出貨）
   * - Shipment 才扣庫：inventory_movement(SHIP_OUT)
   *********************************/

  shipment: [
    "shipment_id",
    "so_id",
    "customer_id",
    "shipper_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "ship_date",
    "recipient_id",
    "recipient_name",
    "recipient_name_en",
    "recipient_address",
    "recipient_phone",
    "consignment_case_id",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark",
    "einvoice_status",
    "einvoice_type",
    "einvoice_no",
    "einvoice_date",
    "einvoice_tax_id",
    "einvoice_buyer_name",
    "einvoice_buyer_email",
    "einvoice_amount",
    "einvoice_tax_amount",
    "einvoice_random_code",
    "einvoice_carrier_type",
    "einvoice_carrier_id",
    "einvoice_donate_code",
    "einvoice_remark",
    "einvoice_issued_by",
    "einvoice_issued_at",
    "einvoice_platform",
    "einvoice_platform_ref"
  ],

  einvoice_line: [
    "einvoice_line_id",
    "shipment_id",
    "einvoice_no",
    "line_no",
    "shipment_item_id",
    "so_item_id",
    "product_id",
    "description",
    "qty",
    "unit",
    "unit_price",
    "amount",
    "tax_type",
    "tax_rate",
    "tax_amount",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  shipment_item: [
    "shipment_item_id",
    "shipment_id",
    "so_id",
    "so_item_id",
    "lot_id",
    "product_id",
    "transaction_id",
    "parent_ref_type",
    "parent_ref_id",
    "ship_qty",
    "unit",
    "so_pricing_snapshot_id",
    "so_pricing_version",
    "shipment_pricing_unit_price",
    "shipment_pricing_billable_qty",
    "shipment_pricing_free_qty",
    "shipment_pricing_amount",
    "applied_promo_scheme_id",
    "applied_promo_type",
    "applied_promo_scope",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  erp_company_profile: [
    "profile_id",
    "company_name_zh",
    "company_name_en",
    "address_zh",
    "address_en",
    "city_zh",
    "city_en",
    "country_zh",
    "country_en",
    "postal_code",
    "phone",
    "email",
    "tax_id",
    "default_currency",
    "default_country_of_origin",
    "default_incoterms",
    "declaration_text",
    "remark",
    "ar_overdue_days_normal",
    "ar_overdue_days_consignment",
    "ar_reminder_days_before_overdue",
    "updated_by",
    "updated_at"
  ],

  consignment_case: [
    "case_id",
    "customer_id",
    "status",
    "allocation_policy",
    "open_date",
    "close_date",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_case_pool_item: [
    "pool_item_id",
    "case_id",
    "shipment_id",
    "shipment_item_id",
    "so_id",
    "so_item_id",
    "product_id",
    "lot_id",
    "factory_lot",
    "warehouse_id",
    "ship_qty",
    "settled_qty",
    "returned_qty",
    "unit",
    "unit_price",
    "ship_date",
    "transaction_id",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_case_settlement: [
    "settlement_id",
    "case_id",
    "customer_id",
    "transaction_id",
    "settlement_date",
    "amount_system",
    "ar_id",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_case_settlement_item: [
    "settlement_item_id",
    "settlement_id",
    "pool_item_id",
    "shipment_item_id",
    "so_item_id",
    "product_id",
    "settle_qty",
    "billable_qty",
    "free_qty",
    "unit",
    "list_unit_price",
    "settle_unit_price",
    "unit_price",
    "amount",
    "promo_scheme_id",
    "promo_type",
    "promo_scheme_name",
    "promo_discount_pct",
    "promo_buy_qty",
    "promo_scheme_free_qty",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_promo_scheme: [
    "scheme_id",
    "scheme_name",
    "status",
    "date_from",
    "date_to",
    "scope_type",
    "channel",
    "price_basis",
    "case_id",
    "customer_id",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_promo_scheme_line: [
    "line_id",
    "scheme_id",
    "product_id",
    "promo_type",
    "promo_unit_price",
    "discount_pct",
    "buy_qty",
    "free_qty",
    "sort_order",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  commercial_dealer_scheme: [
    "scheme_id",
    "scheme_name",
    "status",
    "date_from",
    "date_to",
    "scheme_type",
    "stat_source",
    "mutex_group",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  commercial_dealer_scheme_tier: [
    "tier_id",
    "scheme_id",
    "line_no",
    "amount_from",
    "amount_to",
    "rebate_pct",
    "tier_label",
    "price_rate",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  commercial_dealer_rebate: [
    "rebate_id",
    "customer_id",
    "period_ym",
    "scheme_id",
    "scheme_name_snapshot",
    "billing_net",
    "rebate_pct",
    "rebate_amount",
    "tier_snapshot_json",
    "settle_mode",
    "status",
    "ar_id",
    "credit_applied",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_case_return: [
    "return_id",
    "case_id",
    "customer_id",
    "transaction_id",
    "return_reason",
    "return_date",
    "return_warehouse_id",
    "filter_unit_price",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  consignment_case_return_item: [
    "return_item_id",
    "return_id",
    "factory_lot",
    "product_id",
    "return_qty",
    "pool_item_id",
    "shipment_item_id",
    "so_item_id",
    "lot_id",
    "recognized_unit_price",
    "unit",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  ar_receivable: [
    "ar_id",
    "source_type",
    "source_id",
    "customer_id",
    "so_id",
    "shipment_id",
    "settlement_id",
    "transaction_id",
    "ar_date",
    "currency",
    "amount_system",
    "amount_due",
    "amount_received",
    "status",
    "close_mode",
    "close_reason",
    "closed_by",
    "closed_at",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  ar_payment: [
    "payment_id",
    "ar_id",
    "payment_date",
    "amount",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "system_remark"
  ],

  ar_amount_adjustment_log: [
    "adjust_id",
    "ar_id",
    "amount_before",
    "amount_after",
    "reason",
    "adjusted_by",
    "adjusted_at"
  ],

  commercial_invoice: [
    "ci_id",
    "shipment_id",
    "so_id",
    "ci_no",
    "ci_date",
    "status",
    "currency",
    "incoterms",
    "waybill_no",
    "country_of_origin",
    "seller_company_name_en",
    "seller_address_en",
    "seller_phone",
    "seller_email",
    "seller_tax_id",
    "buyer_name_en",
    "buyer_address_en",
    "buyer_phone",
    "buyer_country",
    "buyer_id_no",
    "buyer_usci",
    "subtotal",
    "total_amount",
    "payment_terms",
    "remark",
    "signature_name",
    "signature_date",
    "declaration_text",
    "issued_by",
    "issued_at",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  commercial_invoice_line: [
    "ci_line_id",
    "ci_id",
    "line_no",
    "shipment_item_id",
    "so_item_id",
    "product_id",
    "description_en",
    "hs_code",
    "qty",
    "unit",
    "unit_price",
    "amount",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  commercial_invoice_blank: [
    "ci_id",
    "ci_no",
    "ci_date",
    "status",
    "currency",
    "incoterms",
    "waybill_no",
    "country_of_origin",
    "seller_company_name_en",
    "seller_address_en",
    "seller_phone",
    "seller_email",
    "seller_tax_id",
    "buyer_name_en",
    "buyer_address_en",
    "buyer_phone",
    "buyer_country",
    "buyer_id_no",
    "buyer_usci",
    "subtotal",
    "total_amount",
    "payment_terms",
    "remark",
    "signature_name",
    "signature_date",
    "declaration_text",
    "issued_by",
    "issued_at",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  commercial_invoice_blank_line: [
    "ci_line_id",
    "ci_id",
    "line_no",
    "product_id",
    "description_en",
    "hs_code",
    "qty",
    "unit",
    "unit_price",
    "amount",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ],

  /*********************************
   * Users（使用者）
   * - 目前先做本機選擇（localStorage），供 created_by 使用
   *********************************/

  user: [
    "user_id",
    "user_name",
    // Google 登入：對應名單用（建議存小寫 email）
    "email",
    // 可用模組（逗號分隔；空白=全開；* = 全開）
    "allowed_modules",
    "role",
    "status",
    "remark",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at"
  ]
};

/*********************************
 * Enumerations & Defaults
 *********************************/

const ENUMS = {
  product: {
    type: ["RM", "WIP", "FG"]
  },
  purchase_order: {
    status: ["OPEN", "PARTIAL", "CLOSED"]
  },
  import_document: {
    status: ["OPEN", "CLOSED", "CANCELLED"]
  },
  import_receipt: {
    status: ["OPEN", "POSTED", "CANCELLED"]
  },
  goods_receipt: {
    status: ["OPEN", "POSTED", "CANCELLED"]
  },
  process_order: {
    process_type: ["PROCESS", "PACKING", "REPACK", "REWORK", "SPLIT", "MERGE"],
    source_type: ["RM", "WIP", "FG"],
    status: ["OPEN", "POSTED", "CANCELLED"]
  },
  sales_order: {
    status: ["OPEN", "PARTIAL", "SHIPPED", "CANCELLED"]
  },
  shipment: {
    status: ["OPEN", "POSTED", "CANCELLED"],
    einvoice_status: ["NONE", "PENDING", "ISSUED", "VOID", "ALLOWANCE"],
    einvoice_type: ["B2B", "B2C"]
  },
  commercial_invoice: {
    status: ["DRAFT", "ISSUED", "VOID"]
  },
  commercial_invoice_blank: {
    status: ["DRAFT", "ISSUED", "VOID"]
  },
  consignment_case: {
    status: ["OPEN", "CLOSED"],
    allocation_policy: ["FIFO", "HIGH_PRICE_FIRST", "PRICE_IF_GIVEN"]
  },
  consignment_case_return: {
    return_reason: ["UNSOLD", "CASE_CLOSE", "DAMAGED", "EXPIRED", "WRONG_GOODS", "OTHER"],
    status: ["POSTED"]
  },
  consignment_promo_scheme: {
    status: ["DRAFT", "ACTIVE", "ENDED"],
    scope_type: ["CASE", "CUSTOMER", "GLOBAL"]
  },
  consignment_promo_scheme_line: {
    promo_type: ["FIXED_PRICE", "DISCOUNT_PCT", "BUY_N_GET_M"]
  },
  commercial_dealer_scheme: {
    status: ["DRAFT", "ACTIVE", "ENDED"],
    scheme_type: ["MONTHLY_REBATE", "CUMULATIVE_AMOUNT"],
    stat_source: ["CONSIGNMENT", "GENERAL", "ALL"]
  },
  commercial_dealer_rebate: {
    settle_mode: ["CREDIT_NOTE", "CARRY_FORWARD"],
    status: ["POSTED", "VOID"]
  },
  ar_receivable: {
    source_type: ["SHIPMENT", "CONSIGNMENT_SETTLEMENT", "CONSIGNMENT_CASE_SETTLEMENT"],
    status: ["OPEN", "PARTIAL", "SETTLED"],
    close_mode: ["", "NORMAL", "FORCE"]
  },
  customer: {
    invoice_type_default: ["B2B", "B2C"],
    customer_type: ["PERSON", "COMPANY"],
    consignment_allocation_policy: ["FIFO", "HIGH_PRICE_FIRST", "PRICE_IF_GIVEN"],
    dealer_rebate_settle_mode: ["CREDIT_NOTE", "CARRY_FORWARD"]
  },
  user: {
    // 角色代碼（新：兩字母縮寫；舊代碼保留相容歷史資料）
    role: ["CEO", "FN", "GA", "OP", "QA", "SL", "WH", "AS", "ADMIN", "FINANCE", "GENERAL_AFFAIRS", "SALES", "WAREHOUSE"],
    status: ["ACTIVE", "INACTIVE"]
  },
  lot_relation: {
    relation_type: ["INPUT", "OUTPUT", "REPACK", "REWORK", "SPLIT", "MERGE"]
  },
  inventory_movement: {
    movement_type: ["IN", "OUT", "ADJUST", "PROCESS_IN", "PROCESS_OUT", "SHIP_OUT"]
  },
  lot: {
    status: ["PENDING", "APPROVED", "REJECTED"],
    inventory_status: ["ACTIVE", "CLOSED", "VOID"]
  }
};

// Lot 預設狀態：PENDING
const LOT_DEFAULT_STATUS = "PENDING";

/*********************************
 * Schema Validation
 *********************************/

function validateSchema(type, obj) {

  const fields = SCHEMA[type];

  if (!fields) {
    throw new Error("Unknown schema type: " + type);
  }

  // 檢查欄位是否在定義內
  for (let key of Object.keys(obj)) {
    if (!fields.includes(key)) {
      throw new Error(
        `Schema violation in ${type}: unexpected field "${key}"`
      );
    }
  }

  // 檢查枚舉值（例如 product.type / purchase_order.status / lot.status）
  const enums = ENUMS[type];
  if (enums) {
    for (let [field, allowed] of Object.entries(enums)) {
      if (obj[field] != null && !allowed.includes(obj[field])) {
        throw new Error(
          `Schema violation in ${type}: invalid value for "${field}" (got "${obj[field]}", allowed: ${allowed.join(
            ", "
          )})`
        );
      }
    }
  }

  return true;
}