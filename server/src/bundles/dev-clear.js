const { getSupabase } = require("../supabase");
const { ok, fail, envName } = require("../response");
const { writeAuditLog_ } = require("./shared");

/**
 * 一鍵刪除例外（固定保留，不刪）：
 * - 主檔：產品、供應商、客戶（含收件人）、倉庫、使用者
 * - 公司設定、空白 CI、促銷方案、經銷方案（含級距明細）
 */
const DEV_CLEAR_EXCEPTION_LABELS_ = [
  "產品",
  "供應商",
  "客戶",
  "倉庫",
  "使用者",
  "公司設定",
  "空白 CI",
  "促銷方案",
  "經銷方案"
];

/** 主檔表（不在清除清單內，僅作文檔／API 回傳） */
const DEV_CLEAR_MASTER_TABLES_ = [
  "product",
  "supplier",
  "customer",
  "customer_recipient",
  "warehouse",
  "erp_user",
  "erp_company_profile"
];

/** 非主檔但固定保留的表 */
const DEV_CLEAR_PRESERVED_TABLES_ = [
  "commercial_invoice_blank",
  "commercial_invoice_blank_line",
  "consignment_promo_scheme",
  "consignment_promo_scheme_line",
  "commercial_dealer_scheme",
  "commercial_dealer_scheme_tier"
];

const DEV_CLEAR_PRESERVED_SET_ = new Set(DEV_CLEAR_PRESERVED_TABLES_);

/** 刪除順序：子表 → 父表（例外模組表已排除） */
const DEV_CLEAR_TABLES_ = [
  // Dealer 月結統計（非主檔、可重建）
  { table: "commercial_dealer_monthly_stat", pk: "stat_id" },
  { table: "consignment_case_return_item", pk: "return_item_id" },
  { table: "consignment_case_return", pk: "return_id" },
  { table: "consignment_case_settlement_item", pk: "settlement_item_id" },
  { table: "consignment_case_settlement", pk: "settlement_id" },
  { table: "commercial_dealer_rebate", pk: "rebate_id" },
  { table: "consignment_case_pool_item", pk: "pool_item_id" },
  { table: "consignment_case", pk: "case_id" },
  { table: "consignment_return_item", pk: "return_item_id" },
  { table: "consignment_return", pk: "return_id" },
  { table: "consignment_settlement_item", pk: "settlement_item_id" },
  { table: "consignment_settlement", pk: "settlement_id" },
  { table: "consignment_track_item", pk: "track_item_id" },
  { table: "consignment_track", pk: "track_id" },
  { table: "ar_payment", pk: "payment_id" },
  { table: "ar_amount_adjustment_log", pk: "adjust_id" },
  { table: "ar_receivable", pk: "ar_id" },
  { table: "einvoice_line", pk: "einvoice_line_id" },
  { table: "commercial_invoice_line", pk: "ci_line_id" },
  { table: "commercial_invoice", pk: "ci_id" },
  { table: "shipment_item", pk: "shipment_item_id" },
  { table: "shipment", pk: "shipment_id" },
  { table: "sales_order_item", pk: "so_item_id" },
  { table: "sales_order", pk: "so_id" },
  { table: "lot_relation", pk: "relation_id" },
  { table: "process_order_output", pk: "process_output_id" },
  { table: "process_order_input", pk: "process_input_id" },
  { table: "process_order", pk: "process_order_id" },
  { table: "inventory_movement", pk: "movement_id" },
  { table: "lot_balance", pk: "lot_id" },
  { table: "lot", pk: "lot_id" },
  { table: "goods_receipt_item", pk: "gr_item_id" },
  { table: "goods_receipt", pk: "gr_id" },
  { table: "import_receipt_item", pk: "import_receipt_item_id" },
  { table: "import_receipt", pk: "import_receipt_id" },
  { table: "import_item", pk: "import_item_id" },
  { table: "import_document", pk: "import_doc_id" },
  { table: "purchase_order_item", pk: "po_item_id" },
  { table: "purchase_order", pk: "po_id" },
  { table: "logs", pk: "log_id" }
];

const DEV_CLEAR_SENTINEL_ = "__ERP_DEV_CLEAR_NOMATCH__";

function shouldPreserveDevClearTable_(table) {
  return DEV_CLEAR_PRESERVED_SET_.has(table);
}

function assertDevClearAllowed_(p) {
  const env = String(envName() || "DEV").trim().toUpperCase();
  if (env === "PROD") {
    return fail("dev_clear_non_master is disabled in PROD", "ERR_DEV_CLEAR_PROD");
  }

  const role = String(p._session?.role || "").trim().toUpperCase();
  if (role !== "ADMIN") {
    return fail("Permission denied: ADMIN only", "ERR_PERMISSION_DENIED");
  }

  const wantTok = String(process.env.ERP_DEV_GUARD_TOKEN || "").trim();
  if (wantTok) {
    const gotTok = String(p.dev_token || "").trim();
    if (gotTok !== wantTok) {
      return fail("Invalid dev_token", "ERR_DEV_GUARD");
    }
  }

  return null;
}

async function deleteAllRowsInTable_(sb, table, pk) {
  const { error, count } = await sb
    .from(table)
    .delete({ count: "exact" })
    .neq(pk, DEV_CLEAR_SENTINEL_);
  if (error) {
    const msg = String(error.message || error);
    if (/relation .* does not exist/i.test(msg) || /schema cache/i.test(msg)) {
      return { skipped: true, reason: msg };
    }
    return { error: msg };
  }
  return { deleted: typeof count === "number" ? count : null };
}

async function devClearNonMasterBundle(p) {
  const gate = assertDevClearAllowed_(p);
  if (gate) return gate;

  const actor = String(p.updated_by || p.created_by || p._session?.user_id || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const cleared = [];
  const skipped = [];
  const preserved = DEV_CLEAR_PRESERVED_TABLES_.slice();
  const exceptions = DEV_CLEAR_EXCEPTION_LABELS_.slice();

  for (let i = 0; i < DEV_CLEAR_TABLES_.length; i++) {
    const spec = DEV_CLEAR_TABLES_[i];
    if (shouldPreserveDevClearTable_(spec.table)) {
      continue;
    }
    const res = await deleteAllRowsInTable_(sb, spec.table, spec.pk);
    if (res.error) {
      return fail(
        "dev_clear failed at " + spec.table + ": " + res.error,
        "ERR_DEV_CLEAR"
      );
    }
    if (res.skipped) {
      skipped.push(spec.table);
      continue;
    }
    cleared.push(spec.table + (res.deleted != null ? "(" + res.deleted + ")" : ""));
  }

  await writeAuditLog_(
    "dev_clear",
    "NON_MASTER",
    "DEV_CLEAR_NON_MASTER",
    actor,
    JSON.stringify({
      cleared,
      skipped,
      preserved,
      exceptions,
      master_tables: DEV_CLEAR_MASTER_TABLES_,
      env: envName()
    })
  );

  return ok({
    message: "CLEARED",
    cleared,
    skipped,
    preserved,
    exceptions,
    source: "supabase"
  });
}

module.exports = {
  devClearNonMasterBundle,
  DEV_CLEAR_TABLES_,
  DEV_CLEAR_EXCEPTION_LABELS_,
  DEV_CLEAR_MASTER_TABLES_,
  DEV_CLEAR_PRESERVED_TABLES_,
  shouldPreserveDevClearTable_
};
