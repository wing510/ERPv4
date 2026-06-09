const { getSupabase } = require("./supabase");
const { ok, fail, envName } = require("./response");
const { masterCrudHandlers } = require("./crud-master");
const { docCrudHandlers } = require("./crud-doc");
const { inventoryCrudHandlers } = require("./crud-inventory");
const { postTransferBundle } = require("./bundles/transfer");
const { postShipmentBundle, cancelShipmentBundle } = require("./bundles/shipment");
const { registerEinvoiceBundle, listEinvoiceLineByShipment } = require("./bundles/einvoice");
const {
  getCompanyProfile,
  updateCompanyProfile,
  listCommercialInvoiceByShipment,
  listCommercialInvoiceBlankByCi,
  listCommercialInvoiceByCi,
  saveCommercialInvoiceBundle,
  saveStandaloneCommercialInvoiceBundle,
  voidCommercialInvoiceBundle
} = require("./bundles/commercial-invoice");
const { resetSalesOrderItemsCmd, cancelSalesOrderBundle } = require("./bundles/sales-order");
const {
  createProcessOrderCmd,
  updateProcessOrderHeaderCmd,
  updateProcessOrderInputRemark,
  updateProcessOrderOutputRemark,
  issueProcessOrderBundle,
  receiveProcessOutputBundle,
  retractProcessIssueBundle,
  voidProcessOutputBundle,
  cancelProcessOrderBundle
} = require("./bundles/process-order");
const { cancelPurchaseOrderBundle } = require("./bundles/purchase");
const { postGoodsReceiptBundle, cancelGoodsReceiptBundle } = require("./bundles/goods-receipt");
const { postImportReceiptBundle, cancelImportReceiptBundle } = require("./bundles/import-receipt");
const {
  saveImportDocument,
  resetImportItemsCmd,
  cancelImportDocumentBundle
} = require("./bundles/import-document");
const { traceLotBundle, traceTransactionBundle } = require("./bundles/trace");
const {
  allowedGoogleAudiences_,
  verifyGoogleIdToken_,
  getActiveUserByEmail_
} = require("./google-auth");
const {
  createSession,
  readSessionValid,
  touchSession,
  deleteSession,
  formatExpIso
} = require("./session");
const {
  sha256Hex,
  getSuperAdminUserId_,
  isSuperAdminUserId_,
  verifySuperAdminPassword_
} = require("./auth-config");

/** 可見管理員：erp_user，Users + 公司設定，密碼可於 Users 重設 */
const DB_ADMIN_ID = "admin";

/** Sheet 按鈕 key → Postgres 表名 */
const PG_TABLE_BY_SHEET_KEY = {
  user: "erp_user"
};

function supabaseProjectRef_() {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const refMatch = supabaseUrl.match(/^https?:\/\/([^.]+)\.supabase\.co/i);
  return refMatch ? refMatch[1] : "";
}

function pgTableForSheetKey_(key) {
  const k = String(key || "").trim();
  return PG_TABLE_BY_SHEET_KEY[k] || k;
}

let ERP_TABLE_OID_MAP_CACHE_ = null;
let ERP_TABLE_OID_MAP_AT_ = 0;
const ERP_TABLE_OID_MAP_TTL_MS_ = 60 * 60 * 1000;

async function loadSupabaseTableOidMap_() {
  const now = Date.now();
  if (ERP_TABLE_OID_MAP_CACHE_ && now - ERP_TABLE_OID_MAP_AT_ < ERP_TABLE_OID_MAP_TTL_MS_) {
    return ERP_TABLE_OID_MAP_CACHE_;
  }
  const sb = getSupabase();
  try {
    const { data, error } = await sb.rpc("erp_pg_table_oid_map");
    if (!error && data && typeof data === "object") {
      ERP_TABLE_OID_MAP_CACHE_ = data;
      ERP_TABLE_OID_MAP_AT_ = now;
      return data;
    }
  } catch (_e) {
    /* RPC 未建：見 server/sql/v4.1.08_Supabase表編輯RPC.sql */
  }
  return ERP_TABLE_OID_MAP_CACHE_ || null;
}

async function resolveSupabaseTableOid_(pgTable) {
  const name = String(pgTable || "").trim();
  if (!name) return null;

  const map = await loadSupabaseTableOidMap_();
  if (map && map[name] != null) {
    const n = Number(map[name]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb.rpc("erp_pg_table_oid", { p_table: name });
    if (!error && data != null && data !== "") {
      const n = Number(data);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (_e) {}

  return null;
}

/** Supabase 已有資料表的 list_{name} */
const SUPABASE_LIST_TABLES = {
  product: "product",
  supplier: "supplier",
  customer: "customer",
  customer_recipient: "customer_recipient",
  warehouse: "warehouse",
  user: "erp_user",
  purchase_order: "purchase_order",
  purchase_order_item: "purchase_order_item",
  import_document: "import_document",
  import_item: "import_item",
  import_receipt: "import_receipt",
  import_receipt_item: "import_receipt_item",
  goods_receipt: "goods_receipt",
  goods_receipt_item: "goods_receipt_item",
  lot: "lot",
  inventory_movement: "inventory_movement",
  lot_balance: "lot_balance",
  logs: "logs",
  sales_order: "sales_order",
  sales_order_item: "sales_order_item",
  shipment: "shipment",
  shipment_item: "shipment_item",
  process_order: "process_order",
  process_order_input: "process_order_input",
  process_order_output: "process_order_output",
  lot_relation: "lot_relation",
  einvoice_line: "einvoice_line",
  commercial_invoice: "commercial_invoice",
  commercial_invoice_line: "commercial_invoice_line",
  commercial_invoice_blank: "commercial_invoice_blank",
  commercial_invoice_blank_line: "commercial_invoice_blank_line",
  erp_company_profile: "erp_company_profile",
  company_profile: "erp_company_profile"
};

function stripUserSecret_(row) {
  if (!row || typeof row !== "object") return row;
  const o = Object.assign({}, row);
  delete o.password_hash;
  return o;
}

async function getUserByIdForLogin_(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const sb = getSupabase();
  const { data, error } = await sb.from("erp_user").select("*").eq("user_id", id).maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data || null;
}

function canSetUserPassword_(session, targetUserId) {
  const actorId = String(session?.user_id || "").trim();
  const actorRole = String(session?.role || "").trim().toUpperCase();
  const target = String(targetUserId || "").trim();
  if (!actorId || !target) return false;
  if (isSuperAdminUserId_(target)) return false;
  if (isSuperAdminUserId_(actorId)) return true;
  if (actorRole === "CEO" || actorRole === "GA" || actorRole === "ADMIN") return true;
  return actorId.toLowerCase() === target.toLowerCase();
}

function requireSession(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return { err: fail("session_token required", "ERR_SESSION_REQUIRED") };
  const o = readSessionValid(tok);
  if (!o) return { err: fail("Permission denied", "ERR_PERMISSION_DENIED") };
  return { session: o, token: tok };
}

function supabaseReady() {
  return (
    String(process.env.SUPABASE_URL || "").trim() &&
    String(process.env.SUPABASE_SECRET_KEY || "").trim()
  );
}

async function login(p) {
  const userIdRaw = String(p.user_id || "").trim();
  const pw = String(p.password != null ? p.password : "");
  if (!userIdRaw) return fail("user_id required");
  if (pw === undefined) return fail("password required");
  if (String(pw) === "__SESSION__") return fail("USE_SESSION_RESUME");

  if (isSuperAdminUserId_(userIdRaw)) {
    if (!getSuperAdminUserId_()) return fail("PASSWORD_LOGIN_DISABLED");
    if (!verifySuperAdminPassword_(pw)) return fail("BAD_PASSWORD");
    const superId = getSuperAdminUserId_();
    const sess = createSession(superId, "Super Admin", "ADMIN", p.remember_me, "*");
    return ok({
      user_id: superId,
      user_name: "Super Admin",
      role: "ADMIN",
      allowed_modules: "*",
      status: "ACTIVE",
      remember: !!sess.record.remember,
      session_token: sess.token,
      session_expires_at: formatExpIso(sess.exp)
    });
  }

  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  let u;
  try {
    u = await getUserByIdForLogin_(userIdRaw);
  } catch (err) {
    return fail(err.message || String(err));
  }
  if (!u) return fail("NOT_FOUND");
  if (String(u.status || "").trim().toUpperCase() !== "ACTIVE") return fail("INACTIVE");

  const hash = String(u.password_hash || "").trim().toLowerCase();
  if (!hash) return fail("PASSWORD_LOGIN_DISABLED");
  if (sha256Hex(pw).toLowerCase() !== hash) return fail("BAD_PASSWORD");

  const userId = String(u.user_id || "").trim();
  const userName = String(u.user_name || userId).trim();
  const role = String(u.role || "").trim();
  const modules = String(u.allowed_modules || "").trim();
  const sess = createSession(userId, userName, role, p.remember_me, modules);
  return ok({
    user_id: userId,
    user_name: userName,
    role,
    allowed_modules: modules,
    status: "ACTIVE",
    remember: !!sess.record.remember,
    session_token: sess.token,
    session_expires_at: formatExpIso(sess.exp)
  });
}

async function setUserPassword(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const targetId = String(p.user_id || "").trim();
  const newPw = String(p.new_password != null ? p.new_password : "");
  const confirm = String(p.confirm_password != null ? p.confirm_password : "");
  if (!targetId) return fail("user_id required");
  if (!newPw) return fail("new_password required");
  if (newPw !== confirm) return fail("PASSWORD_MISMATCH");
  if (!canSetUserPassword_(gate.session, targetId)) {
    return fail("Permission denied", "ERR_PERMISSION_DENIED");
  }
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  let u;
  try {
    u = await getUserByIdForLogin_(targetId);
  } catch (err) {
    return fail(err.message || String(err));
  }
  if (!u) return fail("NOT_FOUND");

  const actor = String(gate.session.user_id || "").trim();
  const hash = sha256Hex(newPw);
  const sb = getSupabase();
  const { error } = await sb
    .from("erp_user")
    .update({
      password_hash: hash,
      updated_by: actor,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", targetId);
  if (error) return fail(error.message || String(error));
  return ok({ message: "Password updated", source: "supabase" });
}

async function googleLogin(p) {
  const idToken = String(p.id_token || "").trim();
  if (!idToken) return fail("BAD_ID_TOKEN");
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  const info = await verifyGoogleIdToken_(idToken);
  if (!info) return fail("BAD_ID_TOKEN");

  const aud = String(info.aud || "").trim();
  const allowed = allowedGoogleAudiences_();
  if (!aud || !allowed.size || !allowed.has(aud)) return fail("BAD_AUD");

  const emailVerified = String(info.email_verified || "")
    .trim()
    .toLowerCase();
  if (emailVerified !== "true") return fail("BAD_ID_TOKEN");

  const email = String(info.email || "")
    .trim()
    .toLowerCase();
  if (!email) return fail("BAD_ID_TOKEN");

  let u;
  try {
    u = await getActiveUserByEmail_(email);
  } catch (err) {
    return fail(err.message || String(err));
  }
  if (!u) return fail("NOT_ALLOWED");

  const userId = String(u.user_id || "").trim();
  const userName = String(u.user_name || userId).trim();
  const role = String(u.role || "").trim();
  const modules = String(u.allowed_modules || "").trim();
  const sess = createSession(userId, userName, role, p.remember_me, modules);
  return ok({
    user_id: userId,
    user_name: userName,
    role,
    allowed_modules: modules,
    status: "ACTIVE",
    remember: !!sess.record.remember,
    session_token: sess.token,
    session_expires_at: formatExpIso(sess.exp)
  });
}

async function sessionResume(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("session_token required", "ERR_SESSION_REQUIRED");
  const o = readSessionValid(tok);
  if (!o) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const o2 = touchSession(tok);
  if (!o2) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  return ok({
    user_id: String(o2.user_id || "").trim(),
    user_name: String(o2.user_name || ""),
    role: String(o2.role || ""),
    allowed_modules: String(o2.allowed_modules || ""),
    status: "ACTIVE",
    remember: !!o2.remember,
    session_token: tok,
    session_expires_at: formatExpIso(o2.exp)
  });
}

async function sessionLogout(p) {
  deleteSession(String(p.session_token || "").trim());
  return ok({ message: "logged out" });
}

const LIST_ORDER_COL = {
  customer_recipient: "recipient_id",
  goods_receipt: "gr_id",
  goods_receipt_item: "gr_item_id",
  import_document: "import_doc_id",
  import_item: "import_item_id",
  import_receipt: "import_receipt_id",
  import_receipt_item: "import_receipt_item_id",
  purchase_order: "po_id",
  purchase_order_item: "po_item_id",
  sales_order: "so_id",
  sales_order_item: "so_item_id",
  shipment: "shipment_id",
  shipment_item: "shipment_item_id",
  process_order: "process_order_id",
  process_order_input: "process_input_id",
  process_order_output: "process_output_id",
  lot_relation: "relation_id",
  user: "user_id",
  logs: "created_at",
  commercial_invoice: "ci_id",
  commercial_invoice_line: "ci_line_id",
  commercial_invoice_blank: "ci_id",
  commercial_invoice_blank_line: "ci_line_id",
  einvoice_line: "einvoice_line_id"
};

async function listFromSupabaseTable(table, orderCol) {
  const sb = getSupabase();
  let q = sb.from(table).select("*");
  if (orderCol) q = q.order(orderCol, { ascending: true });
  const { data, error } = await q;
  if (error) return fail(error.message || String(error));
  const rows = data || [];
  if (table === "erp_user") {
    return ok({ data: rows.map(stripUserSecret_), source: "supabase" });
  }
  return ok({ data: rows, source: "supabase" });
}

async function listGenericSheet(sheetKey, p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;

  const table = SUPABASE_LIST_TABLES[sheetKey];
  if (!table) {
    return fail("Unknown list table: " + sheetKey, "ERR_TABLE_NOT_MIGRATED");
  }

  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }
  const orderCol =
    LIST_ORDER_COL[sheetKey] ||
    (sheetKey === "logs" ? "created_at" : sheetKey + "_id");
  return listFromSupabaseTable(table, orderCol);

}

async function listInventoryMovementAvailableByLot(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  const sb = getSupabase();
  const map = {};
  let balanceSource = "movements";

  const { data: balRows, error: balErr } = await sb.from("lot_balance").select("lot_id, available_qty");
  if (balErr) return fail(balErr.message || String(balErr));

  if (balRows && balRows.length > 0) {
    balanceSource = "lot_balance";
    balRows.forEach((r) => {
      const id = String(r.lot_id || "").trim();
      if (id) map[id] = Number(r.available_qty || 0);
    });
  } else {
    const { data: movRows, error: movErr } = await sb
      .from("inventory_movement")
      .select("lot_id, qty");
    if (movErr) return fail(movErr.message || String(movErr));
    (movRows || []).forEach((r) => {
      const id = String(r.lot_id || "").trim();
      if (!id) return;
      const q = Number(r.qty || 0);
      if (Number.isNaN(q)) return;
      map[id] = (map[id] || 0) + q;
    });
  }

  const { data: lots, error: lotErr } = await sb
    .from("lot")
    .select("lot_id, inventory_status");
  if (lotErr) return fail(lotErr.message || String(lotErr));

  const missing = [];
  (lots || []).forEach((lot) => {
    const id = String(lot.lot_id || "").trim();
    if (!id) return;
    const inv = String(lot.inventory_status || "ACTIVE").trim().toUpperCase();
    if (inv === "VOID") return;
    if (!Object.prototype.hasOwnProperty.call(map, id)) missing.push(id);
  });

  return ok({
    data: map,
    missing_movement_count: missing.length,
    missing_lot_ids: missing.slice(0, 100),
    balance_source: balanceSource,
    source: "supabase"
  });
}

async function listLotsMissingMovement(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const pack = await listInventoryMovementAvailableByLot(p);
  if (!pack.success) return pack;
  const limit = Number(p.limit || 0);
  const ids = Array.isArray(pack.missing_lot_ids) ? pack.missing_lot_ids : [];
  const cap = limit > 0 ? ids.slice(0, limit) : ids;
  return ok({ data: cap, count: cap.length });
}

async function listInventoryMovementRecent(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  const days = Number(p.days);
  const dayCap = Number.isNaN(days) ? 90 : Math.max(1, days);
  const cutoff = new Date(Date.now() - dayCap * 86400000).toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from("inventory_movement")
    .select("*")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error) return fail(error.message || String(error));
  return ok({ data: data || [] });
}

async function listLogsRecent(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) {
    return ok({ data: [] });
  }

  const days = Number(p.days);
  const dayCap = Number.isNaN(days) ? 90 : Math.max(1, days);
  const limit = Number(p.limit || 2000);
  const cap = Number.isNaN(limit) ? 2000 : Math.min(Math.max(limit, 50), 5000);
  const cutoff = new Date(Date.now() - dayCap * 86400000).toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from("logs")
    .select("*")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(cap);

  if (error) return fail(error.message || String(error));
  return ok({ data: data || [] });
}

async function envInfo(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  return ok({
    spreadsheet_id: "",
    backend: "supabase",
    supabase_url: supabaseUrl,
    supabase_project_ref: supabaseProjectRef_()
  });
}

async function supabaseTableEditorUrl(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  const tableKey = String(p.table_key || p.table || "").trim();
  if (!tableKey) return fail("table_key required");

  const projectRef = supabaseProjectRef_();
  if (!projectRef) return fail("Invalid SUPABASE_URL (cannot parse project ref)");

  const pgTable = pgTableForSheetKey_(tableKey);
  const tableId = await resolveSupabaseTableOid_(pgTable);

  if (!tableId) {
    return fail(
      "找不到表 " +
        pgTable +
        " 的 Table Editor ID。請在 Supabase SQL Editor 執行 server/sql/v4.1.08_Supabase表編輯RPC.sql 後重試。",
      "ERR_SUPABASE_TABLE_ID"
    );
  }

  const url =
    "https://supabase.com/dashboard/project/" +
    encodeURIComponent(projectRef) +
    "/editor/" +
    encodeURIComponent(String(tableId)) +
    "?schema=public";

  return ok({
    url,
    table_key: tableKey,
    pg_table: pgTable,
    table_id: tableId,
    project_ref: projectRef,
    direct: true,
    source: "supabase"
  });
}

async function listTableRecent(p, table, defaultDays) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) {
    return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  }

  const days = Number(p.days);
  const dayCap = Number.isNaN(days) ? defaultDays : Math.max(1, days);
  const cutoff = new Date(Date.now() - dayCap * 86400000).toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from(table)
    .select("*")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error) return fail(error.message || String(error));
  let rows = data || [];
  if (!rows.length) {
    const { data: tail, error: tailErr } = await sb
      .from(table)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (tailErr) return fail(tailErr.message || String(tailErr));
    rows = tail || [];
  }
  return ok({ data: rows, source: "supabase" });
}

async function listSalesOrderRecent(p) {
  return listTableRecent(p, "sales_order", 365);
}

async function listShipmentRecent(p) {
  return listTableRecent(p, "shipment", 180);
}

async function listSalesOrderItemBySo(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const soId = String(p.so_id || "").trim().toUpperCase();
  if (!soId) return fail("so_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("sales_order_item").select("*").eq("so_id", soId);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listShipmentBySo(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const soId = String(p.so_id || "").trim().toUpperCase();
  if (!soId) return fail("so_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("shipment").select("*").eq("so_id", soId);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listShipmentItemByShipment(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const sid = String(p.shipment_id || "").trim().toUpperCase();
  if (!sid) return fail("shipment_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("shipment_item").select("*").eq("shipment_id", sid);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listShipmentItemByShipments(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  let ids = [];
  try {
    ids = JSON.parse(String(p.shipment_ids_json || "[]"));
  } catch (_e) {
    return fail("shipment_ids_json must be valid JSON array");
  }
  if (!Array.isArray(ids) || !ids.length) return ok({ data: [] });

  const idSet = new Set(
    ids.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)
  );
  const sb = getSupabase();
  const { data, error } = await sb.from("shipment_item").select("*");
  if (error) return fail(error.message || String(error));
  const out = (data || []).filter((r) => idSet.has(String(r.shipment_id || "").trim().toUpperCase()));
  return ok({ data: out, source: "supabase" });
}

async function listShipmentItemByLot(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const lotId = String(p.lot_id || "").trim().toUpperCase();
  if (!lotId) return fail("lot_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("shipment_item").select("*").eq("lot_id", lotId);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], shipment_items: data || [], source: "supabase" });
}

async function listProcessOrderInputByOrder(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const id = String(p.process_order_id || "").trim().toUpperCase();
  if (!id) return fail("process_order_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("process_order_input").select("*").eq("process_order_id", id);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listProcessOrderOutputByOrder(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const id = String(p.process_order_id || "").trim().toUpperCase();
  if (!id) return fail("process_order_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("process_order_output").select("*").eq("process_order_id", id);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listLotRelationByRef(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const rt = String(p.ref_type || "").trim().toUpperCase();
  const rid = String(p.ref_id || "").trim().toUpperCase();
  if (!rt || !rid) return fail("ref_type/ref_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("lot_relation").select("*").eq("ref_type", rt).eq("ref_id", rid);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listLotRelationByLot(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  const lotId = String(p.lot_id || "").trim().toUpperCase();
  const dir = String(p.direction || "").trim().toUpperCase();
  if (!lotId) return fail("lot_id required");
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");

  const sb = getSupabase();
  const { data, error } = await sb.from("lot_relation").select("*");
  if (error) return fail(error.message || String(error));

  const out = (data || []).filter((r) => {
    const fromId = String(r.from_lot_id || "").trim().toUpperCase();
    const toId = String(r.to_lot_id || "").trim().toUpperCase();
    const isUp = toId === lotId;
    const isDown = fromId === lotId;
    if (dir === "UP") return isUp;
    if (dir === "DOWN") return isDown;
    return isUp || isDown;
  });
  return ok({ data: out, source: "supabase" });
}

async function listEinvoiceLineByShipmentRoute(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  return listEinvoiceLineByShipment(p);
}

async function listCommercialInvoiceByShipmentRoute(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  return listCommercialInvoiceByShipment(p);
}

async function listCommercialInvoiceByCiRoute(p) {
  const gate = requireSession(p);
  if (gate.err) return gate.err;
  if (!supabaseReady()) return fail("SUPABASE_URL and SUPABASE_SECRET_KEY required in .env");
  return listCommercialInvoiceBlankByCi(p);
}

const EXACT_LIST_ROUTES = {
  list_inventory_movement_available_by_lot: listInventoryMovementAvailableByLot,
  list_lots_missing_movement: listLotsMissingMovement,
  list_inventory_movement_recent: listInventoryMovementRecent,
  list_logs_recent: listLogsRecent,
  list_sales_order_recent: listSalesOrderRecent,
  list_shipment_recent: listShipmentRecent,
  list_sales_order_item_by_so: listSalesOrderItemBySo,
  list_shipment_by_so: listShipmentBySo,
  list_shipment_item_by_shipment: listShipmentItemByShipment,
  list_shipment_item_by_shipments: listShipmentItemByShipments,
  list_shipment_item_by_lot: listShipmentItemByLot,
  list_process_order_input_by_order: listProcessOrderInputByOrder,
  list_process_order_output_by_order: listProcessOrderOutputByOrder,
  list_lot_relation_by_ref: listLotRelationByRef,
  list_lot_relation_by_lot: listLotRelationByLot,
  list_einvoice_line_by_shipment: listEinvoiceLineByShipmentRoute,
  list_commercial_invoice_by_shipment: listCommercialInvoiceByShipmentRoute,
  list_commercial_invoice_by_ci: listCommercialInvoiceByCiRoute,
  list_commercial_invoice_blank_by_ci: listCommercialInvoiceByCiRoute
};

async function handleListAction(action, p) {
  if (EXACT_LIST_ROUTES[action]) return EXACT_LIST_ROUTES[action](p);
  const sheetKey = action.slice("list_".length);
  return listGenericSheet(sheetKey, p);
}

const ROUTES = Object.assign(
  {
    login,
    google_login: googleLogin,
    set_user_password: setUserPassword,
    session_resume: sessionResume,
    session_logout: sessionLogout,
    env_info: envInfo,
    supabase_table_editor_url: supabaseTableEditorUrl,
    cancel_purchase_order_bundle: cancelPurchaseOrderBundle,
    post_goods_receipt_bundle: postGoodsReceiptBundle,
    cancel_goods_receipt_bundle: cancelGoodsReceiptBundle,
    post_import_receipt_bundle: postImportReceiptBundle,
    cancel_import_receipt_bundle: cancelImportReceiptBundle,
    save_import_document: saveImportDocument,
    reset_import_items_cmd: resetImportItemsCmd,
    cancel_import_document_bundle: cancelImportDocumentBundle,
    post_transfer_bundle: postTransferBundle,
    post_shipment_bundle: postShipmentBundle,
    cancel_shipment_bundle: cancelShipmentBundle,
    register_einvoice_bundle: registerEinvoiceBundle,
    get_company_profile: getCompanyProfile,
    update_company_profile: updateCompanyProfile,
    save_commercial_invoice_bundle: saveCommercialInvoiceBundle,
    save_standalone_commercial_invoice_bundle: saveStandaloneCommercialInvoiceBundle,
    void_commercial_invoice_bundle: voidCommercialInvoiceBundle,
    reset_sales_order_items_cmd: resetSalesOrderItemsCmd,
    cancel_sales_order_bundle: cancelSalesOrderBundle,
    create_shipment: () => fail("Direct create_shipment is not allowed. Use post_shipment_bundle instead"),
    update_shipment: () => fail("Direct update_shipment is not allowed. Use cancel_shipment_bundle or other commands instead"),
    delete_shipment: () => fail("Deletion is not allowed. Use cancel shipment flow instead"),
    create_shipment_item: () => fail("Direct create_shipment_item is not allowed. Use post_shipment_bundle instead"),
    update_shipment_item: () => fail("Direct update_shipment_item is not allowed"),
    delete_shipment_item: () => fail("Direct delete_shipment_item is not allowed"),
    create_process_order_cmd: createProcessOrderCmd,
    update_process_order_header_cmd: updateProcessOrderHeaderCmd,
    update_process_order_input_remark: updateProcessOrderInputRemark,
    update_process_order_output_remark: updateProcessOrderOutputRemark,
    issue_process_order_bundle: issueProcessOrderBundle,
    receive_process_output_bundle: receiveProcessOutputBundle,
    retract_process_issue_bundle: retractProcessIssueBundle,
    void_process_output_bundle: voidProcessOutputBundle,
    cancel_process_order_bundle: cancelProcessOrderBundle,
    trace_lot_bundle: traceLotBundle,
    trace_transaction_bundle: traceTransactionBundle,
    create_process_order: () => fail("Direct create_process_order is not allowed. Use create_process_order_cmd instead"),
    update_process_order: () => fail("Direct update_process_order is not allowed. Use update_process_order_header_cmd or bundles instead"),
    delete_process_order: () => fail("Deletion is not allowed. Use cancel process order flow instead"),
    create_process_order_input: () => fail("Direct create_process_order_input is not allowed. Use issue_process_order_bundle instead"),
    update_process_order_input: () => fail("Direct update_process_order_input is not allowed. Use update_process_order_input_remark instead"),
    delete_process_order_input: () => fail("Deletion is not allowed. Use retract/void flow instead"),
    create_process_order_output: () => fail("Direct create_process_order_output is not allowed. Use receive_process_output_bundle instead"),
    update_process_order_output: () => fail("Direct update_process_order_output is not allowed. Use update_process_order_output_remark instead"),
    delete_process_order_output: () => fail("Deletion is not allowed. Use void output flow instead")
  },
  masterCrudHandlers(),
  docCrudHandlers(),
  inventoryCrudHandlers()
);

async function dispatch(action, params) {
  const a = String(action || "").trim();
  const p = params || {};

  if (!a) return fail("Unknown or missing action", "ERR_UNKNOWN_ACTION");

  if (ROUTES[a]) {
    const needsSession =
      a !== "login" &&
      a !== "google_login" &&
      !a.startsWith("list_") &&
      (a.startsWith("create_") ||
        a.startsWith("update_") ||
        a.startsWith("delete_") ||
        a.endsWith("_bundle") ||
        a.endsWith("_cmd") ||
        a === "save_import_document" ||
        a === "get_company_profile" ||
        a === "set_user_password" ||
        a === "env_info" ||
        a === "supabase_table_editor_url");
    if (needsSession) {
      const gate = requireSession(p);
      if (gate.err) return gate.err;
    }
    return ROUTES[a](p);
  }
  if (a.startsWith("list_")) return handleListAction(a, p);

  return fail("Unknown or missing action", "ERR_UNKNOWN_ACTION");
}

module.exports = { dispatch };
