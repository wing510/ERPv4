/**
 * v4.2：Supabase 遷移過渡 — API 回 source:"stub" 時提示使用者
 */
(function () {
  /** 已在 Supabase + Node API 實作讀取的表 */
  var MIGRATED_TABLES = {
    product: 1,
    supplier: 1,
    customer: 1,
    customer_recipient: 1,
    warehouse: 1,
    user: 1,
    purchase_order: 1,
    purchase_order_item: 1,
    import_document: 1,
    import_item: 1,
    import_receipt: 1,
    import_receipt_item: 1,
    goods_receipt: 1,
    goods_receipt_item: 1,
    lot: 1,
    inventory_movement: 1,
    lot_balance: 1,
    logs: 1,
    sales_order: 1,
    sales_order_item: 1,
    shipment: 1,
    shipment_item: 1,
    process_order: 1,
    process_order_input: 1,
    process_order_output: 1,
    lot_relation: 1,
    einvoice_line: 1,
    erp_company_profile: 1,
    commercial_invoice: 1,
    commercial_invoice_line: 1,
    commercial_invoice_blank: 1,
    commercial_invoice_blank_line: 1,
    consignment_case: 1,
    consignment_case_pool_item: 1,
    consignment_case_settlement: 1,
    consignment_case_settlement_item: 1,
    consignment_case_return: 1,
    consignment_case_return_item: 1,
    consignment_promo_scheme: 1,
    consignment_promo_scheme_line: 1,
    commercial_dealer_scheme: 1,
    commercial_dealer_scheme_tier: 1,
    commercial_dealer_rebate: 1,
    commercial_dealer_monthly_stat: 1,
    ar_receivable: 1,
    ar_payment: 1,
    ar_amount_adjustment_log: 1
  };

  /** 模組 → 依賴的主表（用於進入模組時提示） */
  var MODULE_TABLES = {
    dashboard: ["product", "lot", "lot_balance", "purchase_order", "import_document", "shipment", "sales_order", "ar_receivable", "consignment_case"],
    products: ["product"],
    suppliers: ["supplier"],
    customers: ["customer", "customer_recipient"],
    warehouses: ["warehouse"],
    users: ["user"],
    purchase: ["purchase_order", "purchase_order_item", "supplier", "product"],
    import: ["import_document", "import_item", "import_receipt", "import_receipt_item", "supplier", "product"],
    receive: ["goods_receipt", "goods_receipt_item", "purchase_order", "import_document", "lot", "product"],
    lots: ["lot", "lot_balance", "inventory_movement", "product"],
    movements: ["inventory_movement", "lot", "product"],
    warehouse_stock: ["lot", "inventory_movement", "warehouse", "product"],
    outsource: ["process_order", "process_order_input", "process_order_output", "lot", "product", "supplier"],
    sales: ["sales_order", "sales_order_item", "customer", "product"],
    consignment: ["consignment_case", "consignment_case_pool_item", "consignment_case_settlement", "consignment_case_settlement_item", "consignment_case_return", "consignment_case_return_item", "shipment", "shipment_item", "sales_order", "sales_order_item", "customer", "product", "warehouse", "lot", "ar_receivable", "inventory_movement"],
    commercial_promo: ["consignment_promo_scheme", "consignment_promo_scheme_line", "customer", "product", "consignment_case"],
    commercial_dealer: ["commercial_dealer_scheme", "commercial_dealer_scheme_tier", "customer"],
    commercial_dealer_customer: ["customer", "commercial_dealer_scheme"],
    dealer_rebate: ["commercial_dealer_monthly_stat", "commercial_dealer_rebate", "customer", "consignment_case_settlement", "ar_receivable"],
    ar: ["ar_receivable", "ar_payment", "ar_amount_adjustment_log", "customer", "sales_order", "shipment", "consignment_case_settlement", "erp_company_profile"],
    shipping: ["shipment", "shipment_item", "sales_order", "sales_order_item", "lot", "customer", "customer_recipient", "product", "commercial_invoice", "commercial_invoice_line", "einvoice_line", "erp_company_profile", "consignment_case"],
    invoice: ["shipment", "commercial_invoice", "commercial_invoice_line", "einvoice_line", "customer", "product", "sales_order_item", "erp_company_profile"],
    invoice_blank: ["commercial_invoice_blank", "commercial_invoice_blank_line", "erp_company_profile"],
    trace: ["lot", "inventory_movement", "lot_relation", "shipment", "import_document"],
    logs: ["logs"],
    company_settings: ["erp_company_profile"]
  };

  var TABLE_ZH = {
    product: "產品",
    supplier: "供應商",
    customer: "客戶",
    customer_recipient: "客戶收件人",
    warehouse: "倉庫",
    user: "使用者",
    purchase_order: "採購單",
    purchase_order_item: "採購明細",
    import_document: "進口報單",
    import_item: "報單明細",
    import_receipt: "報單收貨",
    import_receipt_item: "報單收貨明細",
    goods_receipt: "採購收貨",
    goods_receipt_item: "採購收貨明細",
    lot: "批號",
    inventory_movement: "庫存異動",
    lot_balance: "庫存快照",
    process_order: "委外加工單",
    process_order_input: "委外投料",
    process_order_output: "委外產出",
    lot_relation: "批號關聯",
    sales_order: "銷售單",
    sales_order_item: "銷售明細",
    shipment: "出貨單",
    shipment_item: "出貨明細",
    einvoice_line: "發票明細",
    erp_company_profile: "公司英文資料",
    commercial_invoice: "商業發票",
    commercial_invoice_line: "商業發票明細",
    commercial_invoice_blank: "空白商業發票",
    commercial_invoice_blank_line: "空白商業發票明細",
    consignment_case: "寄賣案件",
    consignment_case_pool_item: "寄賣案件品項池",
    consignment_case_settlement: "寄賣案件結算",
    consignment_case_settlement_item: "寄賣案件結算明細",
    consignment_case_return: "寄賣案件收回",
    consignment_case_return_item: "寄賣案件收回明細",
    consignment_promo_scheme: "寄賣促銷方案",
    consignment_promo_scheme_line: "寄賣促銷方案明細",
    commercial_dealer_scheme: "經銷方案",
    commercial_dealer_scheme_tier: "經銷方案級距",
    commercial_dealer_rebate: "月結回饋紀錄",
    commercial_dealer_monthly_stat: "月結統計紀錄",
    ar_receivable: "應收帳款",
    ar_payment: "收款紀錄",
    ar_amount_adjustment_log: "應收調整紀錄",
    logs: "操作紀錄"
  };

  var sessionStubKeys = Object.create(null);
  var BANNER_ID = "erpMigrationStubBanner";

  function tableLabel(t) {
    var k = String(t || "").trim();
    return TABLE_ZH[k] || k;
  }

  function isSupabaseBackend_() {
    try {
      if (String(window.__ERP_BACKEND__ || "") === "supabase") return true;
      var cfg =
        typeof window.__ERP_CONFIG__ === "object" && window.__ERP_CONFIG__ !== null
          ? window.__ERP_CONFIG__
          : {};
      var base = String(cfg.API_BASE || "").trim();
      if (/127\.0\.0\.1:\d+|localhost:\d+/i.test(base)) return true;
      // v4.1 step8：非 GAS /exec 視為 Supabase Node API
      if (base && !/script\.google\.com/i.test(base)) return true;
    } catch (_e) {}
    return false;
  }

  function noteApiResult(action, result) {
    if (!result || String(result.source || "") !== "stub") return;
    try {
      if (String(result.backend || "") === "supabase") window.__ERP_BACKEND__ = "supabase";
    } catch (_e0) {}
    var key = String(result.stub_table || result.stub_action || action || "").trim();
    if (key) sessionStubKeys[key] = Date.now();
  }

  function pendingTablesForModule(moduleKey) {
    var mod = String(moduleKey || "").trim();
    if (mod === "consignment_case" || mod === "consignment_settlement" || mod === "consignment_return") {
      mod = "consignment";
    }
    if (mod === "consignmentPromo" || mod === "commercialPromo") {
      mod = "commercial_promo";
    } else if (mod === "commercialDealer") {
      mod = "commercial_dealer";
    } else if (mod === "commercialDealerCustomer") {
      mod = "commercial_dealer_customer";
    } else if (mod === "dealerRebate") {
      mod = "dealer_rebate";
    }
    var tables = MODULE_TABLES[mod] || [];
    var out = [];
    tables.forEach(function (t) {
      if (!MIGRATED_TABLES[t]) out.push(t);
    });
    return out;
  }

  function removeBanner_() {
    try {
      var el = document.getElementById(BANNER_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (_e) {}
  }

  function applyModuleBanner(moduleKey) {
    removeBanner_();
    if (!isSupabaseBackend_()) return;

    var pending = pendingTablesForModule(moduleKey);
    if (!pending.length) return;

    var content = document.getElementById("content");
    if (!content) return;

    var labels = pending.map(tableLabel);
    var uniq = [];
    labels.forEach(function (x) {
      if (uniq.indexOf(x) === -1) uniq.push(x);
    });

    var el = document.createElement("div");
    el.id = BANNER_ID;
    el.className = "erp-migration-stub-banner";
    el.setAttribute("role", "status");
    el.innerHTML =
      "<strong>此模組尚未遷移（v4.2 Supabase）</strong>" +
      "<span>目前列表可能為空，不代表正式環境無資料。待遷移：" +
      uniq.join("、") +
      "。</span>";

    content.insertBefore(el, content.firstChild);
  }

  window.erpMigrationStub_ = {
    noteApiResult: noteApiResult,
    applyModuleBanner: applyModuleBanner,
    isSupabaseBackend: isSupabaseBackend_,
    markTableMigrated: function (table) {
      var t = String(table || "").trim();
      if (t) MIGRATED_TABLES[t] = 1;
    },
    pendingTablesForModule: pendingTablesForModule
  };
})();
