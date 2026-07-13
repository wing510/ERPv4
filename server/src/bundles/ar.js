const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { nowIso, buildId_, parseJsonArray, writeAuditLog_, appendSystemRemark_ } = require("./shared");

const { readSessionValid } = require("../session");

const PROFILE_ID = "DEFAULT";

function parseSessionModuleList_(session) {
  const mods = String(session?.allowed_modules || "").trim();
  if (!mods) return [];
  if (mods === "*" || mods.toLowerCase() === "all") return "*";
  return mods
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function sessionHasModule_(session, modKey) {
  const list = parseSessionModuleList_(session);
  if (list === "*") return true;
  const key = String(modKey || "").trim().toLowerCase();
  return list.includes(key);
}

function sessionHasFinanceModule_(session, modKey) {
  const list = parseSessionModuleList_(session);
  if (list === "*") return true;
  const key = String(modKey || "ar").trim().toLowerCase();
  if (key === "dealer_rebate") return list.includes("dealer_rebate") || list.includes("ar");
  return list.includes(key);
}

/** 財務寫入／AR 主功能：CEO、財務、總務、管理者，或 Users 勾選 ar */
function canManageAr_(session) {
  const r = String(session?.role || "").trim().toUpperCase();
  if (r === "CEO" || r === "FN" || r === "FINANCE" || r === "GA" || r === "ADMIN") return true;
  return sessionHasFinanceModule_(session, "ar");
}

/** 寄賣作業（結算產 AR 等）：有 consignment 模組，或具 AR 權限 */
function canOperateConsignmentAr_(session) {
  return sessionHasModule_(session, "consignment") || canManageAr_(session);
}

/** 讀取 AR 彙總／列表：具 AR 權限，或有寄賣模組（Dashboard 待辦） */
function canViewArData_(session) {
  return canManageAr_(session) || sessionHasModule_(session, "consignment");
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

const AR_ADJUST_DECREASE_ONLY_CODES_ = new Set(["DISCOUNT", "NEGOTIATE"]);

function inferAdjustReasonCode_(p) {
  const code = String(p.reason_code || "").trim().toUpperCase();
  if (code) return code;
  const reason = String(p.reason || "").trim();
  if (reason === "折讓") return "DISCOUNT";
  if (reason === "議價調整") return "NEGOTIATE";
  if (reason === "金額更正") return "AMOUNT_FIX";
  if (reason.indexOf("其他：") === 0 || reason.indexOf("其他:") === 0) return "OTHER";
  return "";
}

function validateAdjustDirection_(reasonCode, before, newDue) {
  const code = String(reasonCode || "").trim().toUpperCase();
  if (!AR_ADJUST_DECREASE_ONLY_CODES_.has(code)) return "";
  if (newDue + 1e-9 >= before) {
    return "折讓／議價調整僅可減少應收金額（新應收須小於 " + before + "）";
  }
  return "";
}

const AR_GAP_WRITEOFF_MAX_ = 100;
const AR_GAP_WRITEOFF_LABELS_ = {
  REMIT_FEE: "匯費扣除",
  HANDLING_FEE: "手續費損",
  ROUNDING: "尾數折讓"
};

function gapWriteoffLabel_(code) {
  return AR_GAP_WRITEOFF_LABELS_[String(code || "").trim().toUpperCase()] || "";
}

function planPaymentGapWriteoff_(ar, paymentAmount, gapWriteoffCode) {
  const code = String(gapWriteoffCode || "").trim().toUpperCase();
  const label = gapWriteoffLabel_(code);
  if (!label) return { err: "沖銷差額原因無效" };
  if (String(ar?.status || "").toUpperCase() === "SETTLED") {
    return { err: "AR 已結清，不可沖銷差額" };
  }

  const due = roundMoney_(ar.amount_due);
  const received = roundMoney_(ar.amount_received);
  const payAmt = roundMoney_(paymentAmount);
  const totalAfter = roundMoney_(received + payAmt);
  const gap = roundMoney_(due - totalAfter);

  if (gap <= 1e-9) return { err: "登記後無差額，不需沖銷" };
  if (gap > AR_GAP_WRITEOFF_MAX_ + 1e-9) {
    return { err: "差額 " + gap + " 超過 " + AR_GAP_WRITEOFF_MAX_ + "，請用例外處理" };
  }

  return { code: code, label: label, gap: gap, newDue: totalAfter, dueBefore: due };
}

function parsePaymentGapWriteoff_(pay) {
  const sm = String(pay?.system_remark || "");
  const m = sm.match(/gap_writeoff\|adjust_id=([^|]+)/);
  if (!m) return null;
  return { adjust_id: normArId_(m[1]) };
}

async function executePaymentGapWriteoff_(sb, opts) {
  const arId = normArId_(opts.arId);
  const plan = opts.plan;
  const actor = String(opts.actor || "").trim();
  const paymentId = normArId_(opts.paymentId);
  const iso = opts.ts || nowIso();
  const adjustId = buildId_("ARA");
  const adjReason = "登記收款沖銷差額：" + plan.label;

  const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
    adjust_id: adjustId,
    ar_id: arId,
    amount_before: plan.dueBefore,
    amount_after: plan.newDue,
    reason: adjReason,
    adjusted_by: actor,
    adjusted_at: iso
  });
  if (logErr) return { err: logErr.message || String(logErr) };

  const paySm = "gap_writeoff|adjust_id=" + adjustId;
  const { error: payErr } = await sb
    .from("ar_payment")
    .update({ system_remark: paySm, updated_by: actor, updated_at: iso })
    .eq("payment_id", paymentId);
  if (payErr) return { err: payErr.message || String(payErr) };

  const sysRemark = appendSystemRemark_(
    opts.ar?.system_remark || "",
    "[" + iso + "] " + actor + " 登記收款沖銷差額 " + plan.dueBefore + " → " + plan.newDue + "（" + plan.label + "，" + paymentId + "）"
  );

  return { adjustId: adjustId, newDue: plan.newDue, system_remark: sysRemark };
}

async function restoreGapWriteoffOnVoid_(sb, ar, arId, pay, actor, ts) {
  const gapWo = parsePaymentGapWriteoff_(pay);
  if (!gapWo || !gapWo.adjust_id) return { due: roundMoney_(ar.amount_due), restored: false };

  const { data: adj, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("*")
    .eq("adjust_id", gapWo.adjust_id)
    .maybeSingle();
  if (error) return { err: error.message || String(error) };
  if (!adj) return { due: roundMoney_(ar.amount_due), restored: false };

  const beforeDue = roundMoney_(ar.amount_due);
  const restoredDue = roundMoney_(adj.amount_before);
  if (Math.abs(beforeDue - restoredDue) < 1e-9) {
    return { due: beforeDue, restored: false };
  }

  const revId = buildId_("ARA");
  const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
    adjust_id: revId,
    ar_id: arId,
    amount_before: beforeDue,
    amount_after: restoredDue,
    reason: "作廢收款還原沖銷差額（" + String(adj.reason || "") + "）",
    adjusted_by: actor,
    adjusted_at: ts
  });
  if (logErr) return { err: logErr.message || String(logErr) };

  return { due: restoredDue, restored: true, revId: revId };
}

function calcArStatusFromAmounts_(amountDue, amountReceived, isSettled) {
  if (isSettled) return "SETTLED";
  const due = roundMoney_(amountDue);
  const rec = roundMoney_(amountReceived);
  if (rec <= 1e-9) return "OPEN";
  if (rec + 1e-9 >= due) return "PARTIAL";
  return "PARTIAL";
}

function parseYmd_(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysBetweenYmd_(startYmd, endDate) {
  const start = parseYmd_(startYmd);
  if (!start) return null;
  const end = endDate || new Date();
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((e.getTime() - s.getTime()) / 86400000);
}

async function loadCompanyArSettings_(sb) {
  const { data } = await sb
    .from("erp_company_profile")
    .select("ar_overdue_days_normal, ar_overdue_days_consignment, ar_reminder_days_before_overdue")
    .eq("profile_id", PROFILE_ID)
    .maybeSingle();
  return {
    normal: Number(data?.ar_overdue_days_normal ?? 14) || 14,
    consignment: Number(data?.ar_overdue_days_consignment ?? 30) || 30,
    reminder_before: Math.max(0, Math.floor(Number(data?.ar_reminder_days_before_overdue ?? 5) || 0))
  };
}

function overdueThresholdForAr_(arRow, settings) {
  const src = String(arRow?.source_type || "").trim().toUpperCase();
  if (src === "CONSIGNMENT_SETTLEMENT" || src === "CONSIGNMENT_CASE_SETTLEMENT") return settings.consignment;
  return settings.normal;
}

function calcOverdueDays_(arRow, settings) {
  if (String(arRow?.status || "").toUpperCase() === "SETTLED") return 0;
  const arDate = String(arRow?.ar_date || "").trim();
  if (!arDate) return 0;
  const threshold = overdueThresholdForAr_(arRow, settings);
  const elapsed = daysBetweenYmd_(arDate, new Date());
  if (elapsed == null) return 0;
  const overdue = elapsed - threshold;
  return overdue > 0 ? overdue : 0;
}

function calcDaysUntilOverdue_(arRow, settings) {
  if (String(arRow?.status || "").toUpperCase() === "SETTLED") return null;
  const arDate = String(arRow?.ar_date || "").trim();
  if (!arDate) return null;
  const threshold = overdueThresholdForAr_(arRow, settings);
  const elapsed = daysBetweenYmd_(arDate, new Date());
  if (elapsed == null) return null;
  const left = threshold - elapsed;
  return left >= 0 ? left : 0;
}

function enrichArOverdueFields_(row, settings) {
  const overdueDays = calcOverdueDays_(row, settings);
  const daysUntil = calcDaysUntilOverdue_(row, settings);
  const reminderBefore = Number(settings?.reminder_before || 0) || 0;
  const isReminder =
    overdueDays <= 0 &&
    reminderBefore > 0 &&
    daysUntil != null &&
    daysUntil <= reminderBefore;
  return Object.assign({}, row, {
    overdue_days: overdueDays,
    is_overdue: overdueDays > 0,
    days_until_overdue: daysUntil != null ? daysUntil : null,
    is_reminder: isReminder
  });
}

function normArId_(v) {
  return String(v || "").trim().toUpperCase();
}

async function enrichArConsignmentCaseFields_(sb, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const settlementIds = [];
  list.forEach((row) => {
    const t = normArId_(row.source_type);
    if (t !== "CONSIGNMENT_CASE_SETTLEMENT" && t !== "CONSIGNMENT_SETTLEMENT") return;
    const sid = normArId_(row.settlement_id || row.source_id);
    if (sid) settlementIds.push(sid);
  });
  const uniqStl = [...new Set(settlementIds)];
  if (!uniqStl.length) return list;

  const { data: stls, error } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, case_id")
    .in("settlement_id", uniqStl);
  if (error) return list;

  const stlToCase = {};
  const caseIds = [];
  (stls || []).forEach((s) => {
    const sid = normArId_(s.settlement_id);
    const cid = normArId_(s.case_id);
    if (!sid || !cid) return;
    stlToCase[sid] = cid;
    caseIds.push(cid);
  });

  const caseStatus = {};
  const uniqCase = [...new Set(caseIds)];
  if (uniqCase.length) {
    const { data: cases } = await sb.from("consignment_case").select("case_id, status").in("case_id", uniqCase);
    (cases || []).forEach((c) => {
      caseStatus[normArId_(c.case_id)] = String(c.status || "").trim().toUpperCase();
    });
  }

  return list.map((row) => {
    const t = normArId_(row.source_type);
    if (t !== "CONSIGNMENT_CASE_SETTLEMENT" && t !== "CONSIGNMENT_SETTLEMENT") return row;
    const sid = normArId_(row.settlement_id || row.source_id);
    const caseId = stlToCase[sid] || "";
    const caseSt = caseId ? caseStatus[caseId] || "" : "";
    return Object.assign({}, row, {
      consignment_case_id: caseId || null,
      consignment_case_status: caseSt || null
    });
  });
}

function isArPaymentVoided_(pay) {
  const sm = String(pay?.system_remark || "");
  if (sm.indexOf("VOIDED|") >= 0) return true;
  return roundMoney_(pay?.amount) <= 1e-9 && String(pay?.remark || "").indexOf("[已作廢]") === 0;
}

function parsePaymentBatchId_(sm) {
  const m = String(sm || "").match(/(?:^|\|)batch_id=([^|&\s]+)/);
  return m ? normArId_(m[1]) : "";
}

function parsePaymentRemarkMeta_(remark) {
  const raw = String(remark || "").trim();
  if (!raw) return { userRemark: "", last5: "", accountName: "" };
  const parts = raw.split(/\s*·\s*/).filter(Boolean);
  const kept = [];
  let last5 = "";
  let acct = "";
  parts.forEach(function (part) {
    const m5 = part.match(/^末五碼(.+)$/);
    const ma = part.match(/^帳戶(.+)$/);
    if (m5) last5 = String(m5[1] || "").trim();
    else if (ma) acct = String(ma[1] || "").trim();
    else if (part.indexOf("[已作廢]") !== 0) kept.push(part);
  });
  return { userRemark: kept.join(" · "), last5: last5, accountName: acct };
}

function paymentOrigRemarkForVoid_(pay) {
  const sm = String(pay?.system_remark || "");
  const m = sm.match(/(?:\||^)orig_remark=([^|]*)/);
  if (!m) return String(pay?.remark || "");
  try {
    return decodeURIComponent(m[1]);
  } catch (_e) {
    return m[1];
  }
}

function paymentRemarkSource_(pay) {
  if (isArPaymentVoided_(pay)) return paymentOrigRemarkForVoid_(pay);
  return String(pay?.remark || "");
}

async function loadArMapForPayments_(sb, pays) {
  const arIds = [];
  (pays || []).forEach(function (pay) {
    const id = normArId_(pay.ar_id);
    if (id && arIds.indexOf(id) < 0) arIds.push(id);
  });
  if (!arIds.length) return {};
  const { data, error } = await sb.from("ar_receivable").select("*").in("ar_id", arIds);
  if (error) throw new Error(error.message || String(error));
  const map = {};
  (data || []).forEach(function (row) {
    map[normArId_(row.ar_id)] = row;
  });
  return map;
}

function parsePaymentVoidMeta_(pay) {
  const sm = String(pay?.system_remark || "");
  const atM = sm.match(/VOIDED\|(?:[^|]*\|)*at=([^|]+)/);
  const byM = sm.match(/VOIDED\|(?:[^|]*\|)*by=([^|]+)/);
  return {
    at: atM ? String(atM[1] || "").trim() : "",
    by: byM ? String(byM[1] || "").trim() : ""
  };
}

function formatArVoidRemarkDisplay_(at, by) {
  const actor = String(by || "").trim();
  const dt = String(at || "").replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*/, "$1 $2");
  if (!dt && !actor) return "[已作廢]";
  if (!dt) return "[已作廢] · " + actor;
  return "[已作廢] " + dt + "· " + actor;
}

function buildBatchVoidRemark_(plist) {
  const voided = (plist || []).filter(function (p) {
    return isArPaymentVoided_(p);
  });
  if (!voided.length) return { void_at: "", void_by: "", void_remark: "" };
  voided.sort(function (a, b) {
    return parsePaymentVoidMeta_(b).at.localeCompare(parsePaymentVoidMeta_(a).at);
  });
  const latest = voided[0];
  const vm = parsePaymentVoidMeta_(latest);
  return {
    void_at: vm.at,
    void_by: vm.by,
    void_remark: formatArVoidRemarkDisplay_(vm.at, vm.by)
  };
}

function buildBatchSummaryFromPayments_(batchId, pays, arMap) {
  const plist = (pays || []).slice().sort(function (a, b) {
    const da = String(a.payment_date || "");
    const db = String(b.payment_date || "");
    if (da !== db) return da < db ? -1 : 1;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });
  if (!plist.length) return null;
  const first = plist[0];
  let totalOriginal = 0;
  let totalEffective = 0;
  let voidedCount = 0;
  let customerId = "";
  let currency = "USD";
  plist.forEach(function (p) {
    const ar = arMap[normArId_(p.ar_id)] || {};
    if (!customerId && ar.customer_id) customerId = normArId_(ar.customer_id);
    if (ar.currency) currency = String(ar.currency || "USD").trim().toUpperCase() || "USD";
    const voided = isArPaymentVoided_(p);
    const origAmt = voided ? arPaymentVoidOriginalAmount_(p) : roundMoney_(p.amount);
    totalOriginal += origAmt;
    if (voided) voidedCount += 1;
    else totalEffective += roundMoney_(p.amount);
  });
  const meta = parsePaymentRemarkMeta_(paymentRemarkSource_(first));
  const createdAt = plist.reduce(function (max, p) {
    const ts = String(p.created_at || "");
    return ts > max ? ts : max;
  }, String(first.created_at || ""));
  const allVoided = voidedCount > 0 && voidedCount === plist.length;
  const voidPack = allVoided ? buildBatchVoidRemark_(plist) : { void_at: "", void_by: "", void_remark: "" };
  return {
    batch_id: batchId,
    payment_date: String(first.payment_date || "").slice(0, 10),
    customer_id: customerId,
    currency: currency,
    total_amount: roundMoney_(totalEffective),
    total_original: roundMoney_(totalOriginal),
    allocation_count: plist.length,
    voided_count: voidedCount,
    all_voided: allVoided,
    void_at: voidPack.void_at,
    void_by: voidPack.void_by,
    void_remark: voidPack.void_remark,
    remark: meta.userRemark,
    last5: meta.last5,
    account_name: meta.accountName,
    created_by: String(first.created_by || ""),
    created_at: createdAt
  };
}

function buildBatchLineFromPayment_(pay, arMap) {
  const ar = arMap[normArId_(pay.ar_id)] || {};
  const voided = isArPaymentVoided_(pay);
  const origAmt = voided ? arPaymentVoidOriginalAmount_(pay) : roundMoney_(pay.amount);
  return {
    payment_id: String(pay.payment_id || ""),
    ar_id: normArId_(pay.ar_id),
    payment_date: String(pay.payment_date || "").slice(0, 10),
    amount: voided ? 0 : roundMoney_(pay.amount),
    original_amount: roundMoney_(origAmt),
    voided: voided,
    ar_date: String(ar.ar_date || "").slice(0, 10),
    ar_created_at: String(ar.created_at || ""),
    source_type: String(ar.source_type || ""),
    source_id: String(ar.source_id || ""),
    settlement_id: String(ar.settlement_id || ""),
    shipment_id: String(ar.shipment_id || ""),
    customer_id: normArId_(ar.customer_id),
    currency: String(ar.currency || "USD").trim() || "USD",
    ar_status: String(ar.status || ""),
    created_by: String(pay.created_by || ""),
    created_at: String(pay.created_at || "")
  };
}

function arPaymentVoidOriginalAmount_(pay) {
  const sm = String(pay?.system_remark || "");
  const m = sm.match(/VOIDED\|amount=([0-9.]+)/);
  if (m) return roundMoney_(m[1]);
  const rm = String(pay?.remark || "");
  const m2 = rm.match(/^\[已作廢\]\s*原\s*([0-9.]+)/);
  if (m2) return roundMoney_(m2[1]);
  return roundMoney_(pay?.amount);
}

async function sumArPayments_(sb, arId) {
  const { data, error } = await sb.from("ar_payment").select("amount").eq("ar_id", arId);
  if (error) throw new Error(error.message || String(error));
  let sum = 0;
  (data || []).forEach((row) => {
    sum += Number(row.amount || 0);
  });
  return roundMoney_(sum);
}

function buildArSyncPatch_(ar, amountDue, totalReceived, actor, ts) {
  const due = roundMoney_(amountDue);
  const rec = roundMoney_(totalReceived);
  const iso = ts || nowIso();
  const wasSettled = String(ar?.status || "").toUpperCase() === "SETTLED";

  let nextStatus = "OPEN";
  if (rec <= 1e-9) nextStatus = "OPEN";
  else if (rec + 1e-9 >= due) nextStatus = "SETTLED";
  else nextStatus = "PARTIAL";

  const patch = {
    amount_due: due,
    amount_received: rec,
    status: nextStatus,
    updated_by: actor,
    updated_at: iso
  };

  if (nextStatus === "SETTLED") {
    patch.close_mode = "NORMAL";
    patch.close_reason = "";
    patch.closed_by = actor;
    patch.closed_at = iso;
  } else {
    patch.close_mode = "";
    patch.close_reason = "";
    patch.closed_by = "";
    patch.closed_at = null;
  }

  return { patch, nextStatus, reopened: wasSettled && nextStatus !== "SETTLED" };
}

async function countArAdjustments_(sb, arId) {
  const { count, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("*", { count: "exact", head: true })
    .eq("ar_id", arId);
  if (error) throw new Error(error.message || String(error));
  return Number(count || 0);
}

async function loadSoItemsMap_(sb, soItemIds) {
  const map = {};
  const ids = [...new Set(soItemIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const { data } = await sb.from("sales_order_item").select("*").eq("so_item_id", id).maybeSingle();
    if (data) map[id] = data;
  }
  return map;
}

async function createArFromShipment_(ctx) {
  const { sb, shipmentId, soId, customerId, txId, shipDate, items, currency, actor, ts } = ctx;
  const arId = "AR-" + shipmentId;

  const { data: existed } = await sb.from("ar_receivable").select("ar_id").eq("ar_id", arId).maybeSingle();
  if (existed) return ok({ ar_id: arId, skipped: true });

  let amountSystem =
    ctx.amountSystem != null && ctx.amountSystem !== "" ? roundMoney_(ctx.amountSystem) : null;
  if (amountSystem == null) {
    const soItemIds = items.map((it) => String(it.so_item_id || "").trim().toUpperCase()).filter(Boolean);
    const soItemMap = await loadSoItemsMap_(sb, soItemIds);
    amountSystem = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const soItemId = String(it.so_item_id || "").trim().toUpperCase();
      const qty = Number(it.ship_qty || 0);
      const soItem = soItemMap[soItemId];
      const unitPrice = Number(soItem?.unit_price || 0);
      amountSystem += unitPrice * qty;
    }
    amountSystem = roundMoney_(amountSystem);
  }

  const systemRemark = String(ctx.systemRemark || ctx.system_remark || "").trim();

  const { error } = await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "SHIPMENT",
    source_id: shipmentId,
    customer_id: customerId,
    so_id: soId,
    shipment_id: shipmentId,
    settlement_id: "",
    transaction_id: txId,
    ar_date: shipDate,
    currency: String(currency || "USD").trim().toUpperCase() || "USD",
    amount_system: amountSystem,
    amount_due: amountSystem,
    amount_received: 0,
    status: "OPEN",
    close_mode: "",
    close_reason: "",
    closed_by: "",
    closed_at: null,
    remark: "",
    created_by: actor,
    created_at: ts || nowIso(),
    updated_by: "",
    updated_at: null,
    system_remark: systemRemark || "Shipment: " + String(shipmentId || "")
  });
  if (error) return fail(error.message || String(error));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_CREATE_AR_FROM_SHIPMENT",
    actor,
    JSON.stringify({ ar_id: arId, shipment_id: shipmentId, amount_system: amountSystem })
  );

  return ok({ ar_id: arId, amount_system: amountSystem });
}

async function createArFromCaseSettlement_(ctx) {
  const {
    sb,
    settlementId,
    caseId,
    customerId,
    txId,
    settlementDate,
    amountSystem,
    currency,
    soId,
    shipmentId,
    actor,
    ts
  } = ctx;
  const arId = "AR-STL-" + settlementId;

  const { data: existed } = await sb.from("ar_receivable").select("ar_id").eq("ar_id", arId).maybeSingle();
  if (existed) return ok({ ar_id: arId, skipped: true });

  const amt = roundMoney_(amountSystem);
  const { error } = await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "CONSIGNMENT_CASE_SETTLEMENT",
    source_id: settlementId,
    customer_id: customerId,
    so_id: String(soId || "").trim().toUpperCase(),
    shipment_id: String(shipmentId || "").trim().toUpperCase(),
    settlement_id: settlementId,
    transaction_id: txId,
    ar_date: settlementDate,
    currency: String(currency || "USD").trim().toUpperCase() || "USD",
    amount_system: amt,
    amount_due: amt,
    amount_received: 0,
    status: "OPEN",
    close_mode: "",
    close_reason: "",
    closed_by: "",
    closed_at: null,
    remark: "",
    created_by: actor,
    created_at: ts || nowIso(),
    updated_by: "",
    updated_at: null,
    system_remark: "Case: " + String(caseId || "")
  });
  if (error) return fail(error.message || String(error));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_CREATE_AR_FROM_CASE_SETTLEMENT",
    actor,
    JSON.stringify({ ar_id: arId, settlement_id: settlementId, case_id: caseId, amount_system: amt })
  );

  return ok({ ar_id: arId });
}

function requireListSession_(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const sess = readSessionValid(tok);
  if (!sess) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  if (!canViewArData_(sess)) return fail("Permission denied: AR operation", "ERR_PERMISSION_DENIED");
  return null;
}

async function listArReceivableEnriched_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const statusFilter = String(p.status || "").trim().toUpperCase();
  let q = sb.from("ar_receivable").select("*").order("ar_date", { ascending: false }).order("created_at", { ascending: false }).limit(Number(p.limit || 500));
  if (statusFilter && statusFilter !== "ALL") {
    q = q.eq("status", statusFilter);
  }
  const { data, error } = await q;
  if (error) return fail(error.message || String(error));

  const settings = await loadCompanyArSettings_(sb);
  let rows = (data || []).map((row) => enrichArOverdueFields_(row, settings));
  rows = await enrichArConsignmentCaseFields_(sb, rows);
  return ok({ data: rows, source: "supabase" });
}

async function listArPaymentByAr_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");
  const sb = getSupabase();
  const { data, error } = await sb
    .from("ar_payment")
    .select("*")
    .eq("ar_id", arId)
    .order("payment_date", { ascending: false });
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listArAdjustmentByAr_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");
  const sb = getSupabase();
  const { data, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("*")
    .eq("ar_id", arId)
    .order("adjusted_at", { ascending: false });
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function listArPaymentBatchBundle_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const customerFilter = normArId_(p.customer_id || "");
  const limit = Math.min(Math.max(Number(p.limit || 200) || 200, 1), 500);

  const { data: pays, error } = await sb
    .from("ar_payment")
    .select("payment_id, ar_id, payment_date, amount, remark, created_by, created_at, system_remark")
    .like("system_remark", "batch_id=%")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return fail(error.message || String(error));

  let arMap = {};
  try {
    arMap = await loadArMapForPayments_(sb, pays || []);
  } catch (err) {
    return fail(err.message || String(err));
  }

  const groups = {};
  (pays || []).forEach(function (pay) {
    const batchId = parsePaymentBatchId_(pay.system_remark);
    if (!batchId) return;
    if (!groups[batchId]) groups[batchId] = [];
    groups[batchId].push(pay);
  });

  let rows = Object.keys(groups)
    .map(function (batchId) {
      return buildBatchSummaryFromPayments_(batchId, groups[batchId], arMap);
    })
    .filter(Boolean);

  if (customerFilter) {
    rows = rows.filter(function (row) {
      return normArId_(row.customer_id) === customerFilter;
    });
  }

  rows.sort(function (a, b) {
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });

  return ok({ data: rows.slice(0, limit), source: "supabase" });
}

async function getArPaymentBatchBundle_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const batchId = normArId_(p.batch_id || "");
  if (!batchId) return fail("batch_id required");

  const sb = getSupabase();
  const { data: pays, error } = await sb
    .from("ar_payment")
    .select("payment_id, ar_id, payment_date, amount, remark, created_by, created_at, system_remark")
    .like("system_remark", "%batch_id=" + batchId + "%")
    .order("payment_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return fail(error.message || String(error));

  const matched = (pays || []).filter(function (pay) {
    return parsePaymentBatchId_(pay.system_remark) === batchId;
  });
  if (!matched.length) return fail("Batch not found: " + batchId);

  let arMap = {};
  try {
    arMap = await loadArMapForPayments_(sb, matched);
  } catch (err) {
    return fail(err.message || String(err));
  }

  const summary = buildBatchSummaryFromPayments_(batchId, matched, arMap);
  const lines = matched
    .slice()
    .sort(function (a, b) {
      const arA = arMap[normArId_(a.ar_id)] || {};
      const arB = arMap[normArId_(b.ar_id)] || {};
      const da = String(arA.ar_date || a.payment_date || "");
      const db = String(arB.ar_date || b.payment_date || "");
      if (da !== db) return da < db ? -1 : 1;
      return arBatchSortCreatedMs_(arA) - arBatchSortCreatedMs_(arB);
    })
    .map(function (pay) {
      return buildBatchLineFromPayment_(pay, arMap);
    });

  return ok({ data: Object.assign({}, summary, { lines: lines }), source: "supabase" });
}

async function listArDashboardSummary_(p) {
  const gate = requireListSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const settings = await loadCompanyArSettings_(sb);

  const { data: arRows, error: arErr } = await sb
    .from("ar_receivable")
    .select("*")
    .neq("status", "SETTLED");
  if (arErr) return fail(arErr.message || String(arErr));

  let overdueCount = 0;
  let reminderCount = 0;
  let openArCount = 0;
  (arRows || []).forEach((row) => {
    openArCount += 1;
    const enriched = enrichArOverdueFields_(row, settings);
    if (enriched.is_overdue) overdueCount += 1;
    else if (enriched.is_reminder) reminderCount += 1;
  });

  const { count: openCaseCount, error: ccErr } = await sb
    .from("consignment_case")
    .select("*", { count: "exact", head: true })
    .eq("status", "OPEN");
  if (ccErr) return fail(ccErr.message || String(ccErr));

  return ok({
    open_ar_count: openArCount,
    overdue_ar_count: overdueCount,
    reminder_ar_count: reminderCount,
    ar_reminder_days_before_overdue: settings.reminder_before,
    open_consignment_count: openCaseCount || 0,
    source: "supabase"
  });
}

function parseArIdsBatch_(p) {
  const pack = parseJsonArray(p.ar_ids_json, "ar_ids_json");
  if (Array.isArray(pack.data)) {
    const ids = pack.data.map((id) => normArId_(id)).filter(Boolean);
    if (ids.length) return { ok: true, ids: [...new Set(ids)] };
    return { ok: false, err: "ar_ids_json required" };
  }
  if (pack.err && String(p.ar_ids_json || "").trim()) {
    return { ok: false, err: pack.err };
  }
  const raw = String(p.ar_ids || p.ar_id || "").trim();
  if (!raw) return { ok: false, err: "ar_ids_json required" };
  const ids = raw
    .split(/[,，\s]+/)
    .map((id) => normArId_(id))
    .filter(Boolean);
  if (!ids.length) return { ok: false, err: "ar_ids_json required" };
  return { ok: true, ids: [...new Set(ids)] };
}

function arOutstanding_(arRow) {
  const due = roundMoney_(arRow?.amount_due);
  const rec = roundMoney_(arRow?.amount_received);
  return roundMoney_(Math.max(0, due - rec));
}

function arBatchSortCreatedMs_(row) {
  const ts = String(row?.created_at || "").trim();
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function sortArRowsForBatchAllocation_(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort(function (a, b) {
    const da = String(a?.ar_date || "");
    const db = String(b?.ar_date || "");
    if (da !== db) return da < db ? -1 : da > db ? 1 : 0;
    const ta = arBatchSortCreatedMs_(a);
    const tb = arBatchSortCreatedMs_(b);
    if (ta !== tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
    const ia = normArId_(a?.ar_id);
    const ib = normArId_(b?.ar_id);
    return ia.localeCompare(ib);
  });
}

function buildBatchPaymentAllocations_(rows, totalAmount) {
  const total = roundMoney_(totalAmount);
  let remaining = total;
  const allocations = [];
  sortArRowsForBatchAllocation_(rows).forEach(function (ar) {
    if (remaining <= 1e-9) return;
    const outstanding = arOutstanding_(ar);
    if (outstanding <= 1e-9) return;
    const amount = roundMoney_(Math.min(outstanding, remaining));
    if (amount <= 1e-9) return;
    allocations.push({ ar: ar, amount: amount, outstanding_before: outstanding });
    remaining = roundMoney_(remaining - amount);
  });
  return { allocations: allocations, remaining: remaining };
}

async function registerArPaymentBatchBundle(p) {
  const idPack = parseArIdsBatch_(p);
  if (!idPack.ok) return fail(idPack.err || "ar_ids_json required");
  const arIds = idPack.ids || [];
  if (!arIds.length) return fail("ar_ids_json required");

  const totalAmount = roundMoney_(p.total_amount != null ? p.total_amount : p.amount);
  if (!(totalAmount > 0)) return fail("total_amount must be > 0");

  const paymentDate = String(p.payment_date || "").trim();
  if (!paymentDate) return fail("payment_date required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: arRows, error: arErr } = await sb.from("ar_receivable").select("*").in("ar_id", arIds);
  if (arErr) return fail(arErr.message || String(arErr));

  const foundMap = {};
  (arRows || []).forEach(function (row) {
    foundMap[normArId_(row.ar_id)] = row;
  });
  if (Object.keys(foundMap).length !== arIds.length) {
    const missing = arIds.filter(function (id) {
      return !foundMap[id];
    });
    return fail("AR not found: " + missing.join(", "));
  }

  const ordered = arIds.map(function (id) {
    return foundMap[id];
  });

  let customerId = "";
  let currency = "";
  for (let i = 0; i < ordered.length; i++) {
    const ar = ordered[i];
    const st = String(ar.status || "").trim().toUpperCase();
    if (st === "SETTLED") return fail("AR already SETTLED: " + normArId_(ar.ar_id));
    const cid = normArId_(ar.customer_id);
    const cur = String(ar.currency || "USD").trim().toUpperCase() || "USD";
    if (!customerId) customerId = cid;
    else if (customerId !== cid) return fail("批次收款僅限同一客戶");
    if (!currency) currency = cur;
    else if (currency !== cur) return fail("批次收款僅限同一幣別");
  }

  const totalOutstanding = roundMoney_(
    ordered.reduce(function (sum, ar) {
      return sum + arOutstanding_(ar);
    }, 0)
  );
  if (totalOutstanding <= 1e-9) return fail("所選 AR 已無未收");
  if (totalAmount - totalOutstanding > 1e-9) {
    return fail(
      "匯款總額不可大於未收合計（總額 " +
        totalAmount +
        "，未收合計 " +
        totalOutstanding +
        "）"
    );
  }

  const allocPack = buildBatchPaymentAllocations_(ordered, totalAmount);
  const allocations = allocPack.allocations || [];
  if (!allocations.length) return fail("無可分配的收款金額");

  const batchId = String(p.batch_id || "").trim() || buildId_("ARB");
  const remarkRaw = String(p.remark || "").trim();
  const remarkPrefix = remarkRaw ? remarkRaw : "批次收款 " + batchId;
  const ts = nowIso();
  const results = [];

  for (let i = 0; i < allocations.length; i++) {
    const item = allocations[i];
    const ar = item.ar;
    const arId = normArId_(ar.ar_id);
    const amount = roundMoney_(item.amount);
    const paymentId = buildId_("ARP");

    const { error: insErr } = await sb.from("ar_payment").insert({
      payment_id: paymentId,
      ar_id: arId,
      payment_date: paymentDate,
      amount: amount,
      remark: remarkPrefix,
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null,
      system_remark: "batch_id=" + batchId
    });
    if (insErr) return fail(insErr.message || String(insErr));

    const totalReceived = await sumArPayments_(sb, arId);
    const sync = buildArSyncPatch_(ar, ar.amount_due, totalReceived, actor, ts);
    const { error: updErr } = await sb.from("ar_receivable").update(sync.patch).eq("ar_id", arId);
    if (updErr) return fail(updErr.message || String(updErr));

    await writeAuditLog_(
      "ar_receivable",
      arId,
      "BUNDLE_REGISTER_AR_PAYMENT_BATCH",
      actor,
      JSON.stringify({
        batch_id: batchId,
        payment_id: paymentId,
        amount: amount,
        total_amount: totalAmount,
        amount_received: totalReceived,
        status: sync.nextStatus
      })
    );

    results.push({
      ar_id: arId,
      payment_id: paymentId,
      amount: amount,
      outstanding_before: roundMoney_(item.outstanding_before),
      outstanding_after: roundMoney_(
        Math.max(0, roundMoney_(sync.patch.amount_due) - roundMoney_(sync.patch.amount_received))
      ),
      status: sync.nextStatus
    });
  }

  return ok({
    message: "BATCH_PAYMENT_REGISTERED",
    batch_id: batchId,
    customer_id: customerId,
    currency: currency,
    total_amount: totalAmount,
    total_outstanding_before: totalOutstanding,
    remaining_unallocated: roundMoney_(allocPack.remaining),
    allocations: results
  });
}

async function registerArPaymentBundle(p) {
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");

  const amount = roundMoney_(p.amount);
  if (!(amount > 0)) return fail("amount must be > 0");

  const paymentDate = String(p.payment_date || "").trim();
  if (!paymentDate) return fail("payment_date required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return fail("AR not found: " + arId);
  if (String(ar.status || "").toUpperCase() === "SETTLED") return fail("AR already SETTLED");

  const gapWriteoffCode = String(p.gap_writeoff_code || "").trim().toUpperCase();
  let writeoffPlan = null;
  if (gapWriteoffCode) {
    const plan = planPaymentGapWriteoff_(ar, amount, gapWriteoffCode);
    if (plan.err) return fail(plan.err);
    writeoffPlan = plan;
  }

  const paymentId = String(p.payment_id || "").trim() || buildId_("ARP");
  const remark = String(p.remark || "");
  const ts = nowIso();

  const { error: insErr } = await sb.from("ar_payment").insert({
    payment_id: paymentId,
    ar_id: arId,
    payment_date: paymentDate,
    amount: amount,
    remark: remark,
    created_by: actor,
    created_at: nowIso(),
    updated_by: "",
    updated_at: null
  });
  if (insErr) return fail(insErr.message || String(insErr));

  const totalReceived = await sumArPayments_(sb, arId);
  let finalDue = roundMoney_(ar.amount_due);
  let arSysRemark = String(ar.system_remark || "");

  if (writeoffPlan) {
    const wo = await executePaymentGapWriteoff_(sb, {
      ar: ar,
      arId: arId,
      plan: writeoffPlan,
      actor: actor,
      paymentId: paymentId,
      ts: ts
    });
    if (wo.err) return fail(wo.err);
    finalDue = wo.newDue;
    arSysRemark = wo.system_remark;
  }

  const sync = buildArSyncPatch_(ar, finalDue, totalReceived, actor, ts);
  const arPatch = Object.assign({}, sync.patch);
  if (writeoffPlan) arPatch.system_remark = arSysRemark;

  const { error: updErr } = await sb.from("ar_receivable").update(arPatch).eq("ar_id", arId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_REGISTER_AR_PAYMENT",
    actor,
    JSON.stringify({
      payment_id: paymentId,
      amount: amount,
      amount_received: totalReceived,
      status: sync.nextStatus,
      gap_writeoff: writeoffPlan
        ? { code: writeoffPlan.code, gap: writeoffPlan.gap, amount_due_after: finalDue }
        : null
    })
  );

  return ok({
    message: writeoffPlan ? "PAYMENT_REGISTERED_GAP_WRITEOFF" : "PAYMENT_REGISTERED",
    ar_id: arId,
    payment_id: paymentId,
    amount_received: totalReceived,
    amount_due: finalDue,
    status: sync.nextStatus,
    gap_writeoff: writeoffPlan ? { gap: writeoffPlan.gap, label: writeoffPlan.label } : null
  });
}

async function updateArPaymentBundle(p) {
  const paymentId = String(p.payment_id || "").trim().toUpperCase();
  if (!paymentId) return fail("payment_id required");

  const amount = roundMoney_(p.amount);
  if (!(amount > 0)) return fail("amount must be > 0");

  const paymentDate = String(p.payment_date || "").trim();
  if (!paymentDate) return fail("payment_date required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: pay, error: payErr } = await sb.from("ar_payment").select("*").eq("payment_id", paymentId).maybeSingle();
  if (payErr) return fail(payErr.message || String(payErr));
  if (!pay) return fail("Payment not found: " + paymentId);
  if (isArPaymentVoided_(pay)) return fail("此收款已作廢，不可修改");

  const arId = String(pay.ar_id || "").trim().toUpperCase();
  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return fail("AR not found: " + arId);

  const beforeAmount = roundMoney_(pay.amount);
  const beforeDate = String(pay.payment_date || "");
  const beforeRemark = String(pay.remark || "");
  const remark = String(p.remark != null ? p.remark : pay.remark || "");
  const ts = nowIso();

  let adjCount = 0;
  try {
    adjCount = await countArAdjustments_(sb, arId);
  } catch (e) {
    return fail(e.message || String(e));
  }
  const hasAdjustments = adjCount > 0;
  const amountChanged = Math.abs(beforeAmount - amount) > 1e-9;
  const dateChanged = beforeDate !== paymentDate;
  const remarkChanged = beforeRemark !== remark;

  if (hasAdjustments && amountChanged) {
    return fail("此 AR 已有調整歷程，不可修改收款金額（僅可改日期／備註）");
  }
  if (!amountChanged && !dateChanged && !remarkChanged) {
    return fail("收款資料無變更");
  }

  const finalAmount = beforeAmount;
  let payRemarkLine = "[" + ts + "] " + actor + " 修改收款";
  if (amountChanged) payRemarkLine += " " + beforeAmount + "→" + amount;
  if (dateChanged) payRemarkLine += " · 日 " + beforeDate + "→" + paymentDate;
  if (remarkChanged) payRemarkLine += " · 備註已改";
  if (hasAdjustments && !amountChanged) payRemarkLine += "（已有調整歷程，金額鎖定）";
  const payRemark = appendSystemRemark_(pay.system_remark, payRemarkLine);

  const { error: updPayErr } = await sb
    .from("ar_payment")
    .update({
      payment_date: paymentDate,
      amount: finalAmount,
      remark: remark,
      updated_by: actor,
      updated_at: ts,
      system_remark: payRemark
    })
    .eq("payment_id", paymentId);
  if (updPayErr) return fail(updPayErr.message || String(updPayErr));

  if (!amountChanged) {
    await writeAuditLog_(
      "ar_receivable",
      arId,
      "BUNDLE_UPDATE_AR_PAYMENT",
      actor,
      JSON.stringify({
        payment_id: paymentId,
        amount: finalAmount,
        payment_date: paymentDate,
        meta_only: true,
        has_adjustments: hasAdjustments
      })
    );
    return ok({
      message: "PAYMENT_META_UPDATED",
      ar_id: arId,
      payment_id: paymentId,
      amount_received: roundMoney_(ar.amount_received),
      status: String(ar.status || "").toUpperCase(),
      meta_only: true
    });
  }

  const totalReceived = await sumArPayments_(sb, arId);
  const sync = buildArSyncPatch_(ar, ar.amount_due, totalReceived, actor, ts);
  let arRemark = String(ar.system_remark || "");
  if (sync.reopened) {
    arRemark = appendSystemRemark_(arRemark, "[" + ts + "] " + actor + " 修改收款後重開 AR（已收 " + totalReceived + "，應收 " + sync.patch.amount_due + "）");
  }

  const arPatch = Object.assign({}, sync.patch, { system_remark: arRemark });
  const { error: updArErr } = await sb.from("ar_receivable").update(arPatch).eq("ar_id", arId);
  if (updArErr) return fail(updArErr.message || String(updArErr));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_UPDATE_AR_PAYMENT",
    actor,
    JSON.stringify({
      payment_id: paymentId,
      amount_before: beforeAmount,
      amount_after: finalAmount,
      payment_date: paymentDate,
      amount_received: totalReceived,
      status: sync.nextStatus,
      reopened: sync.reopened
    })
  );

  return ok({
    message: "PAYMENT_UPDATED",
    ar_id: arId,
    payment_id: paymentId,
    amount_received: totalReceived,
    status: sync.nextStatus,
    reopened: sync.reopened
  });
}

async function applyVoidArPayment_(sb, pay, actor, voidReason) {
  const paymentId = normArId_(pay.payment_id);
  const arId = normArId_(pay.ar_id);
  if (!paymentId) return { ok: false, err: "payment_id required" };
  if (isArPaymentVoided_(pay)) return { ok: false, err: "此收款已作廢" };

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return { ok: false, err: arErr.message || String(arErr) };
  if (!ar) return { ok: false, err: "AR not found: " + arId };

  const ts = nowIso();
  const voidAmount = roundMoney_(pay.amount);
  const originalRemark = String(pay.remark || "").trim();
  const paySnapshot = {
    payment_id: paymentId,
    ar_id: arId,
    payment_date: String(pay.payment_date || ""),
    amount: voidAmount,
    remark: originalRemark,
    created_by: String(pay.created_by || ""),
    created_at: String(pay.created_at || ""),
    system_remark: String(pay.system_remark || "")
  };

  const voidRemark = formatArVoidRemarkDisplay_(ts, actor);
  const origEnc = encodeURIComponent(originalRemark);
  const paySysRemark = appendSystemRemark_(
    pay.system_remark,
    "VOIDED|amount=" +
      voidAmount +
      "|at=" +
      ts +
      "|by=" +
      actor +
      "|orig_remark=" +
      origEnc +
      (voidReason ? "|reason=" + voidReason : "")
  );

  const { error: updPayErr } = await sb
    .from("ar_payment")
    .update({
      amount: 0,
      remark: voidRemark,
      updated_by: actor,
      updated_at: ts,
      system_remark: paySysRemark
    })
    .eq("payment_id", paymentId);
  if (updPayErr) return { ok: false, err: updPayErr.message || String(updPayErr) };

  const totalReceived = await sumArPayments_(sb, arId);
  const restore = await restoreGapWriteoffOnVoid_(sb, ar, arId, pay, actor, ts);
  if (restore.err) return { ok: false, err: restore.err };
  const targetDue = restore.due;
  const sync = buildArSyncPatch_(ar, targetDue, totalReceived, actor, ts);
  let arRemark = appendSystemRemark_(
    ar.system_remark,
    "[" +
      ts +
      "] " +
      actor +
      " 作廢收款 " +
      voidAmount +
      "（" +
      paymentId +
      "）" +
      (voidReason ? "：" + voidReason : "")
  );
  if (restore.restored) {
    arRemark = appendSystemRemark_(
      arRemark,
      "[" + ts + "] " + actor + " 作廢收款還原沖銷差額（應收 " + roundMoney_(ar.amount_due) + " → " + targetDue + "）"
    );
  }
  if (sync.reopened) {
    arRemark = appendSystemRemark_(
      arRemark,
      "[" + ts + "] " + actor + " 作廢收款後重開 AR（已收 " + totalReceived + "，應收 " + sync.patch.amount_due + "）"
    );
  }

  const arPatch = Object.assign({}, sync.patch, { system_remark: arRemark });
  const { error: updArErr } = await sb.from("ar_receivable").update(arPatch).eq("ar_id", arId);
  if (updArErr) return { ok: false, err: updArErr.message || String(updArErr) };

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_VOID_AR_PAYMENT",
    actor,
    JSON.stringify({
      voided_payment: paySnapshot,
      void_reason: voidReason,
      amount_received: totalReceived,
      status: sync.nextStatus,
      reopened: sync.reopened
    })
  );

  return {
    ok: true,
    ar_id: arId,
    payment_id: paymentId,
    voided_amount: voidAmount,
    amount_received: totalReceived,
    status: sync.nextStatus,
    reopened: sync.reopened
  };
}

async function voidArPaymentBundle(p) {
  const paymentId = String(p.payment_id || "").trim().toUpperCase();
  if (!paymentId) return fail("payment_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: pay, error: payErr } = await sb.from("ar_payment").select("*").eq("payment_id", paymentId).maybeSingle();
  if (payErr) return fail(payErr.message || String(payErr));
  if (!pay) return fail("Payment not found: " + paymentId);

  const voidReason = String(p.void_reason || p.reason || "").trim();
  const result = await applyVoidArPayment_(sb, pay, actor, voidReason);
  if (!result.ok) return fail(result.err);

  return ok({
    message: "PAYMENT_VOIDED",
    ar_id: result.ar_id,
    payment_id: result.payment_id,
    voided_amount: result.voided_amount,
    amount_received: result.amount_received,
    status: result.status,
    reopened: result.reopened
  });
}

async function voidArPaymentBatchBundle(p) {
  const batchId = normArId_(p.batch_id || "");
  if (!batchId) return fail("batch_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: pays, error } = await sb
    .from("ar_payment")
    .select("*")
    .like("system_remark", "%batch_id=" + batchId + "%");
  if (error) return fail(error.message || String(error));

  const matched = (pays || []).filter(function (pay) {
    return parsePaymentBatchId_(pay.system_remark) === batchId;
  });
  if (!matched.length) return fail("Batch not found: " + batchId);

  const active = matched.filter(function (pay) {
    return !isArPaymentVoided_(pay);
  });
  if (!active.length) return fail("此批次收款已全部作廢");

  const voidReason = String(p.void_reason || p.reason || "").trim();
  const results = [];
  for (let i = 0; i < active.length; i++) {
    const result = await applyVoidArPayment_(sb, active[i], actor, voidReason);
    if (!result.ok) {
      return fail(
        result.err + "（" + normArId_(active[i].payment_id) + "）"
      );
    }
    results.push({
      ar_id: result.ar_id,
      payment_id: result.payment_id,
      voided_amount: result.voided_amount,
      amount_received: result.amount_received,
      status: result.status,
      reopened: result.reopened
    });
  }

  await writeAuditLog_(
    "ar_receivable",
    batchId,
    "BUNDLE_VOID_AR_PAYMENT_BATCH",
    actor,
    JSON.stringify({
      batch_id: batchId,
      void_reason: voidReason,
      voided_count: results.length,
      allocations: results
    })
  );

  return ok({
    message: "BATCH_PAYMENT_VOIDED",
    batch_id: batchId,
    voided_count: results.length,
    allocations: results
  });
}

async function adjustArAmountBundle(p) {
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");

  const newDue = roundMoney_(p.amount_due);
  if (newDue < 0) return fail("amount_due must be >= 0");

  const reason = String(p.reason || "").trim();
  if (!reason) return fail("reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const fromSettlementCredit = !!(p && p._from_settlement_dealer_credit);
  if (!fromSettlementCredit && !canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return fail("AR not found: " + arId);

  const received = roundMoney_(await sumArPayments_(sb, arId));
  if (newDue + 1e-9 < received) {
    return fail("新應收金額不可小於已收合計（已收 " + received + "）");
  }

  const before = roundMoney_(ar.amount_due);
  if (Math.abs(before - newDue) < 1e-9) return fail("amount_due unchanged");

  const reasonCode = inferAdjustReasonCode_(p);
  const directionErr = validateAdjustDirection_(reasonCode, before, newDue);
  if (directionErr) return fail(directionErr);

  const wasSettled = String(ar.status || "").toUpperCase() === "SETTLED";
  const closeMode = String(ar.close_mode || "").trim().toUpperCase();
  const isIncreaseAfterForce = wasSettled && closeMode === "FORCE" && newDue > before + 1e-9;
  if (isIncreaseAfterForce) {
    const okConfirm =
      p.confirm_reopen_after_force === true ||
      String(p.confirm_reopen_after_force || "").trim().toUpperCase() === "YES";
    if (!okConfirm) {
      return fail("此 AR 曾強制結案，調高應收須確認重開追款");
    }
  }

  const ts = nowIso();
  const adjustId = buildId_("ARA");
  const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
    adjust_id: adjustId,
    ar_id: arId,
    amount_before: before,
    amount_after: newDue,
    reason: reason,
    adjusted_by: actor,
    adjusted_at: ts
  });
  if (logErr) return fail(logErr.message || String(logErr));

  const sync = buildArSyncPatch_(ar, newDue, received, actor, ts);
  let sysRemark = appendSystemRemark_(ar.system_remark, "[" + ts + "] " + actor + " 調整應收 " + before + " → " + newDue + "：" + reason);
  if (wasSettled && sync.reopened) {
    sysRemark = appendSystemRemark_(sysRemark, "[" + ts + "] " + actor + " 重開 AR（已結案後再調整應收）");
  }

  const patch = Object.assign({}, sync.patch, { system_remark: sysRemark });
  const { error: updErr } = await sb.from("ar_receivable").update(patch).eq("ar_id", arId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_ADJUST_AR_AMOUNT",
    actor,
    JSON.stringify({
      adjust_id: adjustId,
      amount_before: before,
      amount_after: newDue,
      reason: reason,
      reopened: sync.reopened
    })
  );

  return ok({
    message: sync.reopened ? "REOPENED_AND_ADJUSTED" : "ADJUSTED",
    ar_id: arId,
    amount_due: newDue,
    status: sync.nextStatus,
    reopened: sync.reopened
  });
}

async function settleArBundle(p) {
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return fail("AR not found: " + arId);
  if (String(ar.status || "").toUpperCase() === "SETTLED") return fail("AR already SETTLED");

  const received = await sumArPayments_(sb, arId);
  const due = roundMoney_(ar.amount_due);
  if (received + 1e-9 < due) {
    return fail("Cannot settle: amount_received (" + received + ") < amount_due (" + due + ")");
  }

  const { error: updErr } = await sb
    .from("ar_receivable")
    .update({
      amount_received: received,
      status: "SETTLED",
      close_mode: "NORMAL",
      close_reason: "",
      closed_by: actor,
      closed_at: nowIso(),
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("ar_id", arId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_("ar_receivable", arId, "BUNDLE_SETTLE_AR", actor, JSON.stringify({ amount_received: received }));

  return ok({ message: "SETTLED", ar_id: arId });
}

async function forceCloseArBundle(p) {
  const arId = String(p.ar_id || "").trim().toUpperCase();
  if (!arId) return fail("ar_id required");

  const reason = String(p.close_reason || p.reason || "").trim();
  if (!reason) return fail("close_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (!canManageAr_(p._session)) return fail("Permission denied: AR operation");

  const sb = getSupabase();
  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return fail("AR not found: " + arId);
  if (String(ar.status || "").toUpperCase() === "SETTLED") return fail("AR already SETTLED");

  const received = roundMoney_(await sumArPayments_(sb, arId));
  const due = roundMoney_(ar.amount_due);
  const gap = roundMoney_(due - received);
  let finalDue = due;

  if (gap > 1e-9) {
    finalDue = received;
    const adjustId = buildId_("ARA");
    const adjReason = "強制結案沖銷：" + reason;
    const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
      adjust_id: adjustId,
      ar_id: arId,
      amount_before: due,
      amount_after: finalDue,
      reason: adjReason,
      adjusted_by: actor,
      adjusted_at: nowIso()
    });
    if (logErr) return fail(logErr.message || String(logErr));
  }

  const sysRemark = appendSystemRemark_(
    ar.system_remark,
    "[" + nowIso() + "] " + actor + " 強制結案" + (gap > 1e-9 ? "（應收 " + due + " → " + finalDue + "，差額 " + gap + "）" : "") + "：" + reason
  );

  const { error: updErr } = await sb
    .from("ar_receivable")
    .update({
      amount_due: finalDue,
      amount_received: received,
      status: "SETTLED",
      close_mode: "FORCE",
      close_reason: reason,
      closed_by: actor,
      closed_at: nowIso(),
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("ar_id", arId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_FORCE_CLOSE_AR",
    actor,
    JSON.stringify({
      close_reason: reason,
      amount_due_before: due,
      amount_due_after: finalDue,
      amount_received: received,
      gap: gap,
      auto_offset: gap > 1e-9
    })
  );

  return ok({ message: "FORCE_CLOSED", ar_id: arId, gap: gap, amount_due: finalDue });
}

async function voidArForCancelledCaseSettlement_(sb, arId, reason, actor, ts) {
  const aid = normId_(arId);
  if (!aid) return ok({ skipped: true });

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", aid).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return ok({ skipped: true, ar_id: aid });

  let received = 0;
  try {
    received = roundMoney_(await sumArPayments_(sb, aid));
  } catch (payErr) {
    return fail(payErr?.message || String(payErr));
  }
  if (received > 1e-9) {
    return fail("ERR_CONSIGNMENT_CASE_STL_HAS_PAYMENT: AR has payments, cannot void consignment settlement");
  }
  if (normId_(ar.status) === "SETTLED") {
    return fail("ERR_CONSIGNMENT_CASE_STL_AR_CLOSED: AR already closed, cannot void consignment settlement");
  }

  const voidReason = String(reason || "").trim() || "作廢寄賣結算";
  const due = roundMoney_(ar.amount_due);
  if (due > 1e-9) {
    const adjustId = buildId_("ARA");
    const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
      adjust_id: adjustId,
      ar_id: aid,
      amount_before: due,
      amount_after: 0,
      reason: "作廢寄賣結算：" + voidReason,
      adjusted_by: actor,
      adjusted_at: ts || nowIso()
    });
    if (logErr) return fail(logErr.message || String(logErr));
  }

  const sysRemark = appendSystemRemark_(
    ar.system_remark,
    "[" + (ts || nowIso()) + "] " + actor + " 作廢寄賣結算（應收 " + due + " → 0）：" + voidReason
  );

  const { error: updErr } = await sb
    .from("ar_receivable")
    .update({
      amount_due: 0,
      amount_received: received,
      status: "SETTLED",
      close_mode: "VOID",
      close_reason: voidReason,
      closed_by: actor,
      closed_at: ts || nowIso(),
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: ts || nowIso()
    })
    .eq("ar_id", aid);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    "ar_receivable",
    aid,
    "BUNDLE_VOID_AR_FROM_CASE_SETTLEMENT_CANCEL",
    actor,
    JSON.stringify({ ar_id: aid, void_reason: voidReason, amount_due_before: due })
  );

  return ok({ ar_id: aid, voided: true });
}

async function voidArForCancelledShipment_(sb, shipmentId, reason, actor, ts) {
  const sid = String(shipmentId || "").trim().toUpperCase();
  if (!sid) return ok({ skipped: true });
  const arId = "AR-" + sid;

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();
  if (arErr) return fail(arErr.message || String(arErr));
  if (!ar) return ok({ skipped: true, ar_id: arId });

  let received = 0;
  try {
    received = roundMoney_(await sumArPayments_(sb, arId));
  } catch (payErr) {
    return fail(payErr?.message || String(payErr));
  }
  if (received > 1e-9) {
    return fail("ERR_SHIPMENT_AR_HAS_PAYMENT: AR has payments, cannot void shipment AR");
  }
  if (String(ar.status || "").toUpperCase() !== "OPEN") {
    return fail("ERR_SHIPMENT_AR_NOT_OPEN: AR not OPEN, cannot void shipment AR");
  }

  const voidReason = String(reason || "").trim() || "作廢一般出貨";
  const due = roundMoney_(ar.amount_due);
  if (due > 1e-9) {
    const adjustId = buildId_("ARA");
    const { error: logErr } = await sb.from("ar_amount_adjustment_log").insert({
      adjust_id: adjustId,
      ar_id: arId,
      amount_before: due,
      amount_after: 0,
      reason: "作廢出貨：" + voidReason,
      adjusted_by: actor,
      adjusted_at: ts || nowIso()
    });
    if (logErr) return fail(logErr.message || String(logErr));
  }

  const sysRemark = appendSystemRemark_(
    ar.system_remark,
    "[" + (ts || nowIso()) + "] " + actor + " 作廢出貨（應收 " + due + " → 0）：" + voidReason
  );

  const arPatch = {
    amount_due: 0,
    amount_received: received,
    status: "SETTLED",
    close_mode: "VOID",
    close_reason: voidReason,
    closed_by: actor,
    closed_at: ts || nowIso(),
    system_remark: sysRemark,
    dealer_cumulative_added: 0,
    updated_by: actor,
    updated_at: ts || nowIso()
  };
  const { error: updErr } = await sb.from("ar_receivable").update(arPatch).eq("ar_id", arId);
  if (updErr) {
    if (/dealer_cumulative_added|column.*does not exist|could not find/i.test(updErr.message || "")) {
      delete arPatch.dealer_cumulative_added;
      const { error: updErr2 } = await sb.from("ar_receivable").update(arPatch).eq("ar_id", arId);
      if (updErr2) return fail(updErr2.message || String(updErr2));
    } else {
      return fail(updErr.message || String(updErr));
    }
  }

  await writeAuditLog_(
    "ar_receivable",
    arId,
    "BUNDLE_VOID_AR_FROM_SHIPMENT_CANCEL",
    actor,
    JSON.stringify({ ar_id: arId, shipment_id: sid, void_reason: voidReason, amount_due_before: due })
  );

  return ok({ ar_id: arId, voided: true });
}

async function assertNoArForShipmentCancel_(sb, shipmentId) {
  const arId = "AR-" + shipmentId;
  const { data: ar } = await sb.from("ar_receivable").select("ar_id, status, amount_received").eq("ar_id", arId).maybeSingle();
  if (!ar) return null;
  const rec = Number(ar.amount_received || 0);
  if (rec > 1e-9 || String(ar.status || "").toUpperCase() !== "OPEN") {
    return fail("ERR_AR_EXISTS: Shipment has AR with payments or non-OPEN status. Resolve AR first.");
  }
  return arId;
}

module.exports = {
  canManageAr_,
  canOperateConsignmentAr_,
  canViewArData_,
  calcOverdueDays_,
  loadCompanyArSettings_,
  createArFromShipment_,
  createArFromCaseSettlement_,
  listArReceivableEnriched_,
  listArPaymentByAr_,
  listArAdjustmentByAr_,
  listArPaymentBatchBundle_,
  getArPaymentBatchBundle_,
  listArDashboardSummary_,
  registerArPaymentBundle,
  registerArPaymentBatchBundle,
  updateArPaymentBundle,
  voidArPaymentBundle,
  voidArPaymentBatchBundle,
  adjustArAmountBundle,
  settleArBundle,
  forceCloseArBundle,
  voidArForCancelledCaseSettlement_,
  voidArForCancelledShipment_,
  assertNoArForShipmentCancel_
};
