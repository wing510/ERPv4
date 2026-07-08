const { getSupabase } = require("../supabase");

/** 寫入 timestamptz：台灣時間 +08:00（避免無時區字串被 PG 當 UTC，前端又 +8 變成 23:xx） */
function nowIso() {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    return (
      get("year") +
      "-" +
      get("month") +
      "-" +
      get("day") +
      "T" +
      get("hour") +
      ":" +
      get("minute") +
      ":" +
      get("second") +
      "+08:00"
    );
  } catch (_e) {
    return new Date().toISOString();
  }
}

/** 前端 nowIso16 等無時區字串 → 補 +08:00，避免 PG 當 UTC 儲存 */
function normalizeTaipeiTimestamp_(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return s;
  const sec = m[4] != null ? m[4] : "00";
  return m[1] + "T" + m[2] + ":" + m[3] + ":" + sec + "+08:00";
}

/** 前端傳入或缺省 → 寫入 timestamptz 用 */
function timestamptzFromClient_(v) {
  const n = normalizeTaipeiTimestamp_(v);
  return n || nowIso();
}

function buildTxId() {
  const ts = String(Date.now());
  const r = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return "TX-" + ts + "-" + r;
}

function buildId_(prefix) {
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return String(prefix || "ID") + "-" + Date.now() + "-" + rnd;
}

/** 較短單據 ID：PREFIX-YYMMDD-RRRR（例 CS-260619-K3P9） */
function buildShortDocId_(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return String(prefix || "ID") + "-" + ymd + "-" + rnd;
}

/** 促銷方案編號：CP-YYMMDD-RR（例 CP-260616-A3；與前端 ccNewPromoSchemeId_ 一致） */
function buildShortPromoSchemeId_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return "CP-" + ymd + "-" + rnd;
}

/** 經銷方案編號：CD-YYMMDD-RR（與前端 cdNewDealerSchemeId_ 一致） */
function buildShortDealerSchemeId_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return "CD-" + ymd + "-" + rnd;
}

/** 主檔短 ID：PREFIXYYMMDD-RR（例 C260616-A3、CC260616-A3；與前端 generateShortId 一致） */
function buildShortMasterId_(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(-2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return String(prefix || "ID") + ymd + "-" + rnd;
}

function appendSystemRemark_(prev, line) {
  const a = String(prev || "").trim();
  const b = String(line || "").trim();
  if (!b) return a;
  return a ? a + "\n" + b : b;
}

function parseJsonArray(raw, fieldName) {
  try {
    const arr = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(arr)) return { err: fieldName + " must be valid JSON array" };
    return { data: arr };
  } catch (_e) {
    return { err: fieldName + " must be valid JSON array" };
  }
}

function parseJsonObject(raw, fieldName) {
  try {
    const obj = JSON.parse(String(raw || "{}"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { err: fieldName + " invalid" };
    }
    return { data: obj };
  } catch (_e) {
    return { err: fieldName + " invalid" };
  }
}

const LOG_SKIP_FIELDS_ = new Set([
  "created_at", "created_by", "updated_at", "updated_by"
]);

function serializeLogPayload_(obj) {
  if (obj == null || obj === "") return "";
  if (typeof obj === "string") return obj;
  try {
    return JSON.stringify(obj);
  } catch (_e) {
    return "{}";
  }
}

function buildLogSnapshot_(row, fields) {
  const out = {};
  (fields || []).forEach((f) => {
    if (LOG_SKIP_FIELDS_.has(f)) return;
    if (row && row[f] !== undefined && row[f] !== null) {
      out[f] = String(row[f]);
    }
  });
  return out;
}

function buildLogDiff_(oldRow, patch, fields) {
  const oldOut = {};
  const newOut = {};
  (fields || []).forEach((f) => {
    if (LOG_SKIP_FIELDS_.has(f)) return;
    const o = oldRow && oldRow[f] != null ? String(oldRow[f]) : "";
    const n = patch && patch[f] !== undefined ? String(patch[f]) : o;
    if (o !== n) {
      oldOut[f] = o;
      newOut[f] = n;
    }
  });
  return { oldOut, newOut };
}

async function writeAuditLog_(table, refId, actionType, actor, newValue, oldValue) {
  try {
    const sb = getSupabase();
    await sb.from("logs").insert({
      log_id: buildId_("LOG"),
      table_name: table,
      reference_id: String(refId || ""),
      action_type: actionType,
      old_value: serializeLogPayload_(oldValue),
      new_value: serializeLogPayload_(newValue),
      created_by: actor,
      created_at: nowIso()
    });
  } catch (_e) {}
}

function parseYmd_(s) {
  const m = String(s || "").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!y || Number.isNaN(mo) || !d) return null;
  return { y, mo, d };
}

function isLotExpired_(expiryDateStr) {
  const raw = String(expiryDateStr || "").trim();
  if (!raw) return false;
  const ymd = parseYmd_(raw);
  const now = new Date();
  if (ymd) {
    const expiryEnd = new Date(ymd.y, ymd.mo, ymd.d, 23, 59, 59, 999);
    return now.getTime() > expiryEnd.getTime();
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() > d.getTime();
}

function desiredInventoryStatusForLot_(lot, availableQty) {
  const qtyNum = Number(availableQty || 0);
  if (isLotExpired_(lot && lot.expiry_date)) return "VOID";
  if (qtyNum <= 1e-9) return "CLOSED";
  return "ACTIVE";
}

async function sumMovementsForLot_(lotId) {
  const id = String(lotId || "").trim();
  if (!id) return null;
  const sb = getSupabase();
  const { data: movs } = await sb.from("inventory_movement").select("qty").eq("lot_id", id);
  if (!movs || !movs.length) return null;
  let sum = 0;
  movs.forEach((r) => {
    const q = Number(r.qty || 0);
    if (!Number.isNaN(q)) sum += q;
  });
  return sum;
}

async function getLotAvailableQty_(lotId) {
  const id = String(lotId || "").trim();
  if (!id) return 0;
  const sb = getSupabase();
  const { data: bal } = await sb
    .from("lot_balance")
    .select("available_qty")
    .eq("lot_id", id)
    .maybeSingle();
  if (bal && bal.available_qty != null) return Number(bal.available_qty || 0);

  const sum = await sumMovementsForLot_(id);
  return sum == null ? 0 : sum;
}

async function applyLotBalanceDelta_(lotId, qtyDelta, movementId, actor) {
  const id = String(lotId || "").trim();
  if (!id) return;
  const d = Number(qtyDelta || 0);
  if (Number.isNaN(d)) return;
  const sb = getSupabase();
  const who = String(actor || "").trim();
  const mvId = String(movementId || "").trim();
  const now = nowIso();
  const { data: row } = await sb.from("lot_balance").select("*").eq("lot_id", id).maybeSingle();
  if (row) {
    await sb
      .from("lot_balance")
      .update({
        available_qty: Number(row.available_qty || 0) + d,
        movement_count: Number(row.movement_count || 0) + 1,
        last_movement_id: mvId || row.last_movement_id || null,
        updated_at: now,
        updated_by: who || row.updated_by || null
      })
      .eq("lot_id", id);
  } else {
    const sum = await sumMovementsForLot_(id);
    const qty = sum != null ? sum : d;
    await sb.from("lot_balance").insert({
      lot_id: id,
      available_qty: qty,
      movement_count: 1,
      last_movement_id: mvId || null,
      updated_at: now,
      updated_by: who || null
    });
  }
}

async function calcPurchaseOrderStatusByItems_(poId) {
  const id = String(poId || "").trim().toUpperCase();
  if (!id) return "OPEN";
  const sb = getSupabase();
  const { data: items } = await sb.from("purchase_order_item").select("*").eq("po_id", id);
  const rows = items || [];
  if (!rows.length) return "OPEN";

  let anyReceived = false;
  let allReceived = true;
  rows.forEach((row) => {
    const ordered = Number(row.order_qty || 0);
    const received = Number(row.received_qty || 0);
    if (received > 0) anyReceived = true;
    if (!(received + 1e-9 >= ordered)) allReceived = false;
  });
  if (allReceived) return "CLOSED";
  if (anyReceived) return "PARTIAL";
  return "OPEN";
}

async function calcImportDocumentStatusByItems_(docId) {
  const id = String(docId || "").trim().toUpperCase();
  if (!id) return "OPEN";
  const sb = getSupabase();

  const { data: items } = await sb.from("import_item").select("declared_qty").eq("import_doc_id", id);
  let declared = 0;
  (items || []).forEach((r) => {
    declared += Number(r.declared_qty || 0);
  });

  const { data: receipts } = await sb
    .from("import_receipt")
    .select("import_receipt_id, status")
    .eq("import_doc_id", id);
  const activeIds = new Set();
  (receipts || []).forEach((r) => {
    const st = String(r.status || "").trim().toUpperCase();
    if (st !== "CANCELLED") activeIds.add(String(r.import_receipt_id || "").trim());
  });

  let received = 0;
  if (activeIds.size > 0) {
    const { data: recItems } = await sb
      .from("import_receipt_item")
      .select("import_receipt_id, received_qty");
    (recItems || []).forEach((r) => {
      const rid = String(r.import_receipt_id || "").trim();
      if (!activeIds.has(rid)) return;
      received += Number(r.received_qty || 0);
    });
  }

  if (received <= 1e-9) return "OPEN";
  if (declared > 1e-9 && received + 1e-9 < declared) return "PARTIAL";
  return "CLOSED";
}

async function insertLot_(row) {
  const sb = getSupabase();
  return sb.from("lot").insert(row);
}

async function insertMovement_(row) {
  const sb = getSupabase();
  return sb.from("inventory_movement").insert(row);
}

async function findInMovement_(lotId, refType, refId) {
  const sb = getSupabase();
  const { data } = await sb
    .from("inventory_movement")
    .select("*")
    .eq("lot_id", lotId)
    .eq("movement_type", "IN")
    .eq("ref_type", refType)
    .eq("ref_id", refId)
    .limit(1);
  return (data && data[0]) || null;
}

async function hasCancelMovement_(refType, refId) {
  const sb = getSupabase();
  const { data } = await sb
    .from("inventory_movement")
    .select("movement_id")
    .eq("ref_type", refType)
    .eq("ref_id", refId)
    .limit(1);
  return !!(data && data.length);
}

module.exports = {
  nowIso,
  normalizeTaipeiTimestamp_,
  timestamptzFromClient_,
  buildTxId,
  buildId_,
  buildShortDocId_,
  buildShortPromoSchemeId_,
  buildShortDealerSchemeId_,
  buildShortMasterId_,
  appendSystemRemark_,
  parseJsonArray,
  parseJsonObject,
  serializeLogPayload_,
  buildLogSnapshot_,
  buildLogDiff_,
  writeAuditLog_,
  getLotAvailableQty_,
  sumMovementsForLot_,
  isLotExpired_,
  desiredInventoryStatusForLot_,
  applyLotBalanceDelta_,
  calcPurchaseOrderStatusByItems_,
  calcImportDocumentStatusByItems_,
  insertLot_,
  insertMovement_,
  findInMovement_,
  hasCancelMovement_
};
