/*********************************
 * AR 應收帳款 / 收款 v4.2
 *********************************/

var arSelectedId_ = "";
var arEditPaymentId_ = "";
var arPaymentsById_ = {};
var arHasAdjustments_ = false;
var arSelectedRow_ = null;
var arRows_ = [];
var arCustomers_ = {};
var arBatchSelectedIds_ = {};
var arExpandedCustomerIds_ = {};
var arViewMode_ = "ar";
var arSelectedBatchId_ = "";
var arBatchHistoryRows_ = [];
var arRowsAll_ = [];

function arCanOperate_() {
  try {
    return typeof erpCanManageAr_ === "function" && erpCanManageAr_();
  } catch (_e) {
    return false;
  }
}

function arEsc_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function arFmtMoney_(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

/** 原始金額 − 應收金額（>0 表示曾調降應收，含折讓／議價） */
function arDueReduction_(row) {
  const sys = Number(row?.amount_system || 0);
  const due = Number(row?.amount_due || 0);
  const diff = Math.round((sys - due) * 100) / 100;
  return diff > 0.009 ? diff : 0;
}

/** 結算／出貨作廢後寫入的 AR（status 仍為 SETTLED，close_mode = VOID） */
function arIsVoidedAr_(row) {
  return String(row?.close_mode || "").trim().toUpperCase() === "VOID";
}

/** 客戶合計列／表尾加總：作廢列不計入 */
function arCountsInTotals_(row) {
  return !arIsVoidedAr_(row);
}

function arFmtDueCell_(row) {
  const due = Number(row?.amount_due || 0);
  if (arIsVoidedAr_(row)) return arEsc_(arFmtMoney_(due));
  const reduced = arDueReduction_(row);
  if (!(reduced > 0)) return arEsc_(arFmtMoney_(due));
  return (
    arEsc_(arFmtMoney_(due)) +
    '<div class="logs-stack-sub" style="color:#b45309;font-weight:600;">已調降 ' +
    arEsc_(arFmtMoney_(reduced)) +
    "</div>"
  );
}

function arTodayYmd_() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function arSourceTypeTag_(row) {
  const t = String(row?.source_type || "").trim().toUpperCase();
  if (t === "SHIPMENT") return "一般出貨";
  if (t === "CONSIGNMENT_SETTLEMENT" || t === "CONSIGNMENT_CASE_SETTLEMENT") return "寄賣結算";
  const raw = String(row?.source_type || "").trim();
  return raw || "—";
}

function arSourceDocId_(row) {
  const t = String(row?.source_type || "").trim().toUpperCase();
  if (t === "SHIPMENT") return String(row.shipment_id || row.source_id || "").trim();
  if (t === "CONSIGNMENT_SETTLEMENT" || t === "CONSIGNMENT_CASE_SETTLEMENT") {
    return String(row.settlement_id || row.source_id || "").trim();
  }
  return String(row.source_id || "").trim();
}

function arFormatSourceListCell_(row) {
  const tag = arSourceTypeTag_(row);
  const docId = arSourceDocId_(row);
  if (!docId) return '<div class="logs-stack-main">' + arEsc_(tag) + "</div>";
  return (
    '<div class="logs-stack-main">' + arEsc_(tag) + "</div>" +
    '<div class="logs-stack-sub">' + arEsc_(docId) + "</div>"
  );
}

function arCustomerName_(row) {
  const cid = String(row?.customer_id || "").trim().toUpperCase();
  return arCustomers_[cid]?.customer_name || cid || "—";
}

function arSummaryHeadline_(row) {
  const cname = arCustomerName_(row);
  const tag = arSourceTypeTag_(row);
  const currency = String(row?.currency || "USD").trim() || "USD";
  const st = arStatusLabelForRow_(row);
  const stTitle = arIsVoidedAr_(row) ? "VOID" : arStatusTitle_(row?.status);
  const stHtml = arIsVoidedAr_(row)
    ? '<span style="color:#94a3b8;font-weight:600;">' + arEsc_(st) + "</span>"
    : arEsc_(st);
  return (
    "<strong>客戶：</strong>" + arEsc_(cname) + "（" + arEsc_(tag) + "）| " +
    "<strong>幣別：</strong>" + arEsc_(currency) + " | " +
    '<strong>狀態：</strong><span title="' + arEsc_(stTitle) + '">' + stHtml + "</span>"
  );
}

function arSummaryCloseNote_(row) {
  if (!row) return "";
  const parts = [];
  if (row.close_mode) {
    parts.push(
      '<strong>結案方式：</strong><span title="' +
        arEsc_(arCloseModeTitle_(row.close_mode)) +
        '">' +
        arEsc_(arCloseModeLabel_(row.close_mode)) +
        "</span>"
    );
  }
  if (row.close_reason) {
    parts.push("<strong>原因：</strong>" + arEsc_(row.close_reason));
  }
  return parts.length ? "<div>" + parts.join(" · ") + "</div>" : "";
}

function arFormatTimeFromTs_(v, bizDateYmd) {
  if (typeof erpFormatLocalTimeHmForBizDate_ === "function" && bizDateYmd) {
    return erpFormatLocalTimeHmForBizDate_(v, bizDateYmd);
  }
  if (typeof erpFormatLocalTimeHm_ === "function") return erpFormatLocalTimeHm_(v);
  const raw = String(v || "").trim();
  if (!raw) return "";
  const full =
    typeof formatLocalTime === "function"
      ? formatLocalTime(raw)
      : typeof erpFormatListDateTime_ === "function"
        ? erpFormatListDateTime_(raw)
        : raw;
  const m = String(full || "").match(/(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

function arFormatPaymentDateCell_(p) {
  const date = String(p?.payment_date || "").slice(0, 10) || "—";
  const timeSub = arFormatTimeFromTs_(p?.created_at, p?.payment_date);
  if (!timeSub) return arEsc_(date);
  return (
    '<div class="logs-stack-main">' + arEsc_(date) + "</div>" +
    '<div class="logs-stack-sub">' + arEsc_(timeSub) + "</div>"
  );
}

function arIsPaymentVoided_(p) {
  const sm = String(p?.system_remark || "");
  if (sm.indexOf("VOIDED|") >= 0) return true;
  return roundMoney_(p?.amount) <= 1e-9 && String(p?.remark || "").indexOf("[已作廢]") === 0;
}

function arPaymentVoidOriginalAmount_(p) {
  const sm = String(p?.system_remark || "");
  const m = sm.match(/VOIDED\|amount=([0-9.]+)/);
  if (m) return roundMoney_(m[1]);
  const rm = String(p?.remark || "");
  const m2 = rm.match(/^\[已作廢\]\s*原\s*([0-9.]+)/);
  if (m2) return roundMoney_(m2[1]);
  return roundMoney_(p?.amount);
}

function arFormatPaymentAmountCell_(p) {
  if (!arIsPaymentVoided_(p)) return arEsc_(arFmtMoney_(p.amount));
  const orig = arPaymentVoidOriginalAmount_(p);
  return (
    '<span style="text-decoration:line-through;color:#94a3b8;">' +
    arEsc_(arFmtMoney_(orig)) +
    "</span>"
  );
}

function arBuildPaymentRemarkFromFields_(opts) {
  const remark = String((opts && opts.remark) || "").trim();
  const last5 = String((opts && opts.last5) || "").trim();
  const acctName = String((opts && opts.accountName) || "").trim();
  const parts = [];
  if (remark) parts.push(remark);
  if (last5) parts.push("末五碼" + last5);
  if (acctName) parts.push("帳戶" + acctName);
  return parts.join(" · ");
}

function arParsePaymentRemarkMeta_(remark) {
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

function arPaymentOrigRemark_(p) {
  const sm = String(p?.system_remark || "");
  const m = sm.match(/(?:\||^)orig_remark=([^|]*)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch (_e) {
    return m[1];
  }
}

function arPaymentVoidMeta_(p) {
  const sm = String(p?.system_remark || "");
  const atM = sm.match(/VOIDED\|(?:[^|]*\|)*at=([^|]+)/);
  const byM = sm.match(/VOIDED\|(?:[^|]*\|)*by=([^|]+)/);
  return {
    at: atM ? String(atM[1] || "").trim() : "",
    by: byM ? String(byM[1] || "").trim() : ""
  };
}

function arFormatPaymentBankCell_(p) {
  const src = arIsPaymentVoided_(p) ? arPaymentOrigRemark_(p) : String(p?.remark || "");
  const meta = arParsePaymentRemarkMeta_(src);
  const parts = [meta.last5, meta.accountName].filter(Boolean);
  if (!parts.length) return "—";
  return arEsc_(parts.join("／"));
}

function arFormatVoidRemarkDisplay_(at, by) {
  const dt = at ? erpFormatListDateTime_(at) : "";
  const who =
    typeof erpDisplayOperatorName_ === "function"
      ? erpDisplayOperatorName_(by)
      : by || "—";
  if (dt) return "[已作廢] " + dt + "· " + who;
  if (who && who !== "—") return "[已作廢] · " + who;
  return "[已作廢]";
}

function arFormatPaymentRemarkCell_(p) {
  if (arIsPaymentVoided_(p)) {
    const vm = arPaymentVoidMeta_(p);
    return arEsc_(arFormatVoidRemarkDisplay_(vm.at, vm.by));
  }
  const meta = arParsePaymentRemarkMeta_(String(p?.remark || ""));
  return arEsc_(meta.userRemark || "—");
}

const AR_GAP_WRITEOFF_MAX_ = 100;
const AR_GAP_WRITEOFF_LABELS_ = {
  REMIT_FEE: "匯費扣除",
  HANDLING_FEE: "手續費損",
  ROUNDING: "尾數折讓"
};

function arGapWriteoffLabel_(code) {
  return AR_GAP_WRITEOFF_LABELS_[String(code || "").trim().toUpperCase()] || "";
}

function arComputeGapAfterNewPayment_(payAmount) {
  const row = arSelectedRow_;
  if (!row) return null;
  const due = Number(row.amount_due || 0);
  const received = Number(row.amount_received || 0);
  const amt = Number(payAmount || 0);
  if (!(amt > 0)) return null;
  return roundMoney_(Math.max(0, due - received - amt));
}

function arResetGapWriteoffForm_() {
  const sel = document.getElementById("ar_pay_gap_writeoff");
  if (sel) sel.value = "";
  arUpdateGapWriteoffUi_();
}

function arOnGapWriteoffChange_() {
  arUpdateGapWriteoffUi_();
}

function arSetGapWriteoffHint_(hint, text, tone) {
  if (!hint) return;
  hint.textContent = text || "";
  hint.style.display = text ? "" : "none";
  if (tone === "confirm") {
    hint.style.color = "#b45309";
    hint.style.fontWeight = "600";
  } else if (tone === "warn") {
    hint.style.color = "#b42318";
    hint.style.fontWeight = "500";
  } else {
    hint.style.color = "#64748b";
    hint.style.fontWeight = "400";
  }
}

function arUpdateGapWriteoffUi_() {
  const rowEl = document.getElementById("ar_pay_gap_writeoff_group");
  const sel = document.getElementById("ar_pay_gap_writeoff");
  const hint = document.getElementById("ar_pay_gap_writeoff_hint");
  const amtEl = document.getElementById("ar_pay_amount");
  const editingPay = !!String(arEditPaymentId_ || "").trim();
  const row = arSelectedRow_;
  const settled = String(row?.status || "").toUpperCase() === "SETTLED";
  const canOp = arCanOperate_();

  if (!rowEl || !sel) return;

  if (!canOp || editingPay || settled || !row) {
    rowEl.style.display = "none";
    arSetGapWriteoffHint_(hint, "", "");
    if (sel) sel.value = "";
    return;
  }

  rowEl.style.display = "";
  const gap = arComputeGapAfterNewPayment_(amtEl?.value);
  const eligible = gap != null && gap > 1e-9 && gap <= AR_GAP_WRITEOFF_MAX_ + 1e-9;

  sel.disabled = !eligible;
  if (!eligible && sel.value) sel.value = "";

  if (!hint) return;
  if (gap == null || !(Number(amtEl?.value || 0) > 0)) {
    arSetGapWriteoffHint_(hint, "", "");
    return;
  }
  if (gap <= 1e-9) {
    arSetGapWriteoffHint_(hint, "登記後無差額，將一般結清（不需沖銷）。", "");
    return;
  }
  if (gap > AR_GAP_WRITEOFF_MAX_ + 1e-9) {
    arSetGapWriteoffHint_(hint, "", "");
    return;
  }
  const code = String(sel.value || "").trim();
  if (code) {
    arSetGapWriteoffHint_(
      hint,
      "登記後未收 " +
        arFmtMoney_(gap) +
        " → 將以「" +
        arGapWriteoffLabel_(code) +
        "」沖銷並結案。",
      "confirm"
    );
    return;
  }
  arSetGapWriteoffHint_(hint, "登記後未收 " + arFmtMoney_(gap) + "。", "");
}

function arReadSinglePaymentFields_() {
  return {
    remark: String(document.getElementById("ar_pay_remark")?.value || "").trim(),
    last5: String(document.getElementById("ar_pay_last5")?.value || "").trim(),
    accountName: String(document.getElementById("ar_pay_account_name")?.value || "").trim()
  };
}

function arFillSinglePaymentFields_(opts) {
  const o = opts || {};
  const meta =
    o.remark != null
      ? arParsePaymentRemarkMeta_(o.remark)
      : { userRemark: "", last5: "", accountName: "" };
  const rm = document.getElementById("ar_pay_remark");
  const l5 = document.getElementById("ar_pay_last5");
  const ac = document.getElementById("ar_pay_account_name");
  if (rm) rm.value = o.userRemark != null ? o.userRemark : meta.userRemark;
  if (l5) l5.value = o.last5 != null ? o.last5 : meta.last5;
  if (ac) ac.value = o.accountName != null ? o.accountName : meta.accountName;
}

function arFormatArDateCell_(row) {
  const date = String(row?.ar_date || "").slice(0, 10) || "—";
  const timeSub = arFormatTimeFromTs_(row?.created_at, row?.ar_date);
  if (!timeSub) return arEsc_(date);
  return (
    '<div class="logs-stack-main">' + arEsc_(date) + "</div>" +
    '<div class="logs-stack-sub">' + arEsc_(timeSub) + "</div>"
  );
}

function arApplyPermissions_() {
  const ok = arCanOperate_();
  arShowBatchColumns_(ok && !arIsBatchHistoryView_());
  arSyncBatchToolbar_();
  ["ar_adjust_btn", "ar_force_btn"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.disabled = !ok;
  });
  const payAmt = document.getElementById("ar_pay_amount");
  const payDate = document.getElementById("ar_pay_date");
  const payRemark = document.getElementById("ar_pay_remark");
  const payLast5 = document.getElementById("ar_pay_last5");
  const payAcct = document.getElementById("ar_pay_account_name");
  const row = arRows_.find(function (x) { return String(x.ar_id || "").toUpperCase() === arSelectedId_; });
  const settled = String(row?.status || "").toUpperCase() === "SETTLED";
  const editingPay = !!String(arEditPaymentId_ || "").trim();
  const lockPayAmt = editingPay && arHasAdjustments_;
  if (payAmt) {
    payAmt.disabled = !ok || (settled && !editingPay) || lockPayAmt;
    payAmt.title = lockPayAmt ? "已有調整歷程，不可改收款金額" : "";
  }
  [payDate, payRemark, payLast5, payAcct].forEach(function (el) {
    if (el) el.disabled = !ok || (settled && !editingPay);
  });
  const payBtn = document.getElementById("ar_pay_btn");
  if (payBtn) payBtn.disabled = !ok || (settled && !editingPay);
  const cancelBtn = document.getElementById("ar_pay_cancel_btn");
  if (cancelBtn) cancelBtn.style.display = ok && editingPay ? "" : "none";
  if (payBtn) payBtn.textContent = editingPay ? "儲存修改" : "登記收款";
  const hint = document.getElementById("ar_pay_edit_hint");
  if (hint) hint.style.display = ok && lockPayAmt ? "" : "none";
  arUpdateGapWriteoffUi_();
}

const AR_REASON_LABELS_ADJUST_ = {
  DISCOUNT: "折讓",
  NEGOTIATE: "議價調整",
  AMOUNT_FIX: "金額更正",
  OTHER: "其他"
};

const AR_REASON_LABELS_FORCE_ = {
  BAD_DEBT: "呆帳",
  DISPUTE: "爭議款",
  WAIVE: "老闆決定不追",
  OTHER: "其他"
};

const AR_STATUS_LABELS_ = {
  OPEN: "未收",
  PARTIAL: "部分收",
  SETTLED: "已結清"
};

const AR_CLOSE_MODE_LABELS_ = {
  NORMAL: "正常結清",
  FORCE: "手動沖銷結案",
  VOID: "來源已作廢"
};

function arStatusLabel_(status) {
  const s = String(status || "").trim().toUpperCase();
  return AR_STATUS_LABELS_[s] || String(status || "—");
}

function arStatusLabelForRow_(row) {
  if (arIsVoidedAr_(row)) return "已作廢";
  return arStatusLabel_(row?.status);
}

function arStatusCellHtml_(row) {
  if (arIsVoidedAr_(row)) {
    return '<span style="color:#94a3b8;font-weight:600;">已作廢</span>';
  }
  const st = String(row?.status || "").toUpperCase();
  return arEsc_(arStatusLabel_(st));
}

function arCloseModeLabel_(mode) {
  const s = String(mode || "").trim().toUpperCase();
  return AR_CLOSE_MODE_LABELS_[s] || String(mode || "");
}

function arStatusTitle_(status) {
  const s = String(status || "").trim().toUpperCase();
  if (!s || AR_STATUS_LABELS_[s]) return s;
  return "";
}

function arCloseModeTitle_(mode) {
  const s = String(mode || "").trim().toUpperCase();
  if (!s || AR_CLOSE_MODE_LABELS_[s]) return s;
  return "";
}

function arOnReasonCodeChange_(kind) {
  const k = String(kind || "").trim().toLowerCase();
  const isAdjust = k === "adjust";
  const sel = document.getElementById(isAdjust ? "ar_adjust_reason_code" : "ar_force_reason_code");
  const row = document.getElementById(isAdjust ? "ar_adjust_reason_other_row" : "ar_force_reason_other_row");
  const detail = document.getElementById(isAdjust ? "ar_adjust_reason_detail" : "ar_force_reason_detail");
  const isOther = String(sel?.value || "").trim().toUpperCase() === "OTHER";
  if (row) row.style.display = isOther ? "" : "none";
  if (detail && !isOther) detail.value = "";
}

function arResetReasonForm_(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "adjust" || k === "all") {
    const sel = document.getElementById("ar_adjust_reason_code");
    const detail = document.getElementById("ar_adjust_reason_detail");
    if (sel) sel.value = "";
    if (detail) detail.value = "";
    arOnReasonCodeChange_("adjust");
  }
  if (k === "force" || k === "all") {
    const sel = document.getElementById("ar_force_reason_code");
    const detail = document.getElementById("ar_force_reason_detail");
    if (sel) sel.value = "";
    if (detail) detail.value = "";
    arOnReasonCodeChange_("force");
  }
}

function arCollectReason_(kind) {
  const isAdjust = String(kind || "").trim().toLowerCase() === "adjust";
  const codeEl = document.getElementById(isAdjust ? "ar_adjust_reason_code" : "ar_force_reason_code");
  const detailEl = document.getElementById(isAdjust ? "ar_adjust_reason_detail" : "ar_force_reason_detail");
  const labels = isAdjust ? AR_REASON_LABELS_ADJUST_ : AR_REASON_LABELS_FORCE_;
  const code = String(codeEl?.value || "").trim().toUpperCase();
  if (!code) {
    return { err: isAdjust ? "請選擇調整原因" : "請選擇手動沖銷結案原因" };
  }
  if (code === "OTHER") {
    const detail = String(detailEl?.value || "").trim();
    if (!detail) return { err: "選擇「其他」時，請填寫說明" };
    return { reason: "其他：" + detail, code: "OTHER" };
  }
  const label = labels[code] || code;
  return { reason: label, code: code };
}

function arValidateAdjust_(amountDue, reasonCode) {
  const row = arSelectedRow_;
  if (!row) return { err: "請先選擇 AR" };
  const before = roundMoney_(row.amount_due);
  const newDue = roundMoney_(amountDue);
  const code = String(reasonCode || "").trim().toUpperCase();
  if (code === "DISCOUNT" || code === "NEGOTIATE") {
    if (newDue + 1e-9 >= before) {
      return { err: "折讓／議價僅可減少應收（新應收須小於目前 " + before.toFixed(2) + "）" };
    }
  }
  const st = String(row.status || "").toUpperCase();
  const closeMode = String(row.close_mode || "").trim().toUpperCase();
  if (st === "SETTLED" && closeMode === "FORCE" && newDue > before + 1e-9) {
    const msg =
      "此 AR 曾手動沖銷結案（" +
      arCloseModeLabel_(closeMode) +
      (row.close_reason ? "：" + row.close_reason : "") +
      "）。\n\n調高應收 " +
      before.toFixed(2) +
      " → " +
      newDue.toFixed(2) +
      " 將重開追款。\n\n確定繼續？";
    if (!confirm(msg)) return { err: "CANCELLED" };
    return { confirmReopenAfterForce: true };
  }
  return {};
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function arOutstanding_(row) {
  return roundMoney_(Math.max(0, Number(row?.amount_due || 0) - Number(row?.amount_received || 0)));
}

function arDueReceivedOutstandingHtml_(row) {
  if (!row) return "";
  return (
    "<strong>應收金額：</strong>" + arEsc_(arFmtMoney_(row.amount_due)) +
    " · <strong>已收：</strong>" + arEsc_(arFmtMoney_(row.amount_received)) +
    " · <strong>未收：</strong>" + arEsc_(arFmtMoney_(arOutstanding_(row)))
  );
}

function arRenderAdjustDueSummary_(row) {
  const el = document.getElementById("ar_adjust_due_summary");
  if (!el) return;
  if (!row) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.innerHTML = arDueReceivedOutstandingHtml_(row);
  el.style.display = "";
}

function arListColspan_() {
  return arCanOperate_() ? 9 : 8;
}

function arSortCreatedMs_(row) {
  const ts = String(row?.created_at || "").trim();
  if (!ts) return 0;
  if (typeof erpParseLocalDateTime_ === "function") {
    const d = erpParseLocalDateTime_(ts);
    return d ? d.getTime() : 0;
  }
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function arSortForBatchAllocation_(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort(function (a, b) {
    const da = String(a?.ar_date || "");
    const db = String(b?.ar_date || "");
    if (da !== db) return da < db ? -1 : da > db ? 1 : 0;
    const ta = arSortCreatedMs_(a);
    const tb = arSortCreatedMs_(b);
    if (ta !== tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
    return String(a?.ar_id || "").toUpperCase().localeCompare(String(b?.ar_id || "").toUpperCase());
  });
}

function arComputeBatchAllocation_(rows, totalAmount) {
  const total = roundMoney_(totalAmount);
  let remaining = total;
  const lines = [];
  arSortForBatchAllocation_(rows).forEach(function (row) {
    if (remaining <= 1e-9) return;
    const before = arOutstanding_(row);
    if (before <= 1e-9) return;
    const alloc = roundMoney_(Math.min(before, remaining));
    if (alloc <= 1e-9) return;
    const after = roundMoney_(Math.max(0, before - alloc));
    lines.push({ row: row, before: before, alloc: alloc, after: after });
    remaining = roundMoney_(remaining - alloc);
  });
  return {
    lines: lines,
    totalOutstanding: roundMoney_(
      rows.reduce(function (sum, row) {
        return sum + arOutstanding_(row);
      }, 0)
    ),
    remaining: remaining
  };
}

function arGetBatchSelectedRows_() {
  const ids = Object.keys(arBatchSelectedIds_ || {});
  return arRows_.filter(function (row) {
    const id = String(row.ar_id || "").trim().toUpperCase();
    return id && arBatchSelectedIds_[id];
  });
}

function arBatchEligibleRow_(row) {
  const st = String(row?.status || "").trim().toUpperCase();
  return st === "OPEN" || st === "PARTIAL";
}

function arHasCustomerFilter_() {
  return !!String(document.getElementById("ar_filter_customer")?.value || "").trim();
}

function arRowArDateYmd_(row) {
  return String(row?.ar_date || "").slice(0, 10);
}

function arMonthBoundsYmd_(refDate) {
  const dt = refDate instanceof Date && !Number.isNaN(refDate.getTime()) ? refDate : new Date();
  const y = dt.getFullYear();
  const m = dt.getMonth();
  const p = function (n) {
    return String(n).padStart(2, "0");
  };
  const last = new Date(y, m + 1, 0);
  return {
    from: y + "-" + p(m + 1) + "-01",
    to: y + "-" + p(m + 1) + "-" + p(last.getDate())
  };
}

function arIsRowInArDateRange_(row, fromYmd, toYmd) {
  const d = arRowArDateYmd_(row);
  if (!d) return false;
  if (fromYmd && d < fromYmd) return false;
  if (toYmd && d > toYmd) return false;
  return true;
}

function arClearDateFilter_() {
  const from = document.getElementById("ar_filter_date_from");
  const to = document.getElementById("ar_filter_date_to");
  if (from) from.value = "";
  if (to) to.value = "";
  arApplyListFilters_();
}

function arSyncBatchToolbar_() {
  const eligible = (arRows_ || []).filter(arBatchEligibleRow_);
  const canSelectAll = arCanOperate_() && eligible.length > 0;
  const bounds = arMonthBoundsYmd_();
  const monthEligible = eligible.filter(function (row) {
    return arIsRowInArDateRange_(row, bounds.from, bounds.to);
  });
  const canSelectMonth = arCanOperate_() && monthEligible.length > 0;
  const btn = document.getElementById("ar_batch_select_all_btn");
  const monthBtn = document.getElementById("ar_batch_select_month_btn");
  if (btn) {
    btn.disabled = !canSelectAll;
    btn.title = canSelectAll ? "全選列表上所有未結清 AR" : "本頁無可勾選的未結清 AR";
  }
  if (monthBtn) {
    monthBtn.disabled = !canSelectMonth;
    monthBtn.title = canSelectMonth
      ? "勾選起算日 " + bounds.from + "～" + bounds.to + " 的未結清 AR"
      : "本月起算日無可勾選的未結清 AR";
  }
}

function arIsGroupedList_() {
  return !arHasCustomerFilter_();
}

function arBuildCustomerGroups_(rows) {
  const map = {};
  (rows || []).forEach(function (row) {
    const cid = String(row.customer_id || "").trim().toUpperCase();
    if (!cid) return;
    if (!map[cid]) map[cid] = [];
    map[cid].push(row);
  });
  return Object.keys(map)
    .map(function (cid) {
      const list = map[cid];
      const name = arCustomers_[cid]?.customer_name || cid;
      let sumSystem = 0;
      let sumDue = 0;
      let sumRec = 0;
      let sumOut = 0;
      let maxOverdue = 0;
      let worstReminder = null;
      let earliestDate = "";
      list.forEach(function (row) {
        if (arCountsInTotals_(row)) {
          sumSystem += Number(row.amount_system || 0);
          sumDue += Number(row.amount_due || 0);
          sumRec += Number(row.amount_received || 0);
          sumOut += arOutstanding_(row);
        }
        const st = String(row.status || "").toUpperCase();
        const od = Number(row.overdue_days || 0);
        if (!arIsVoidedAr_(row) && st !== "SETTLED" && od > maxOverdue) maxOverdue = od;
        if (!arIsVoidedAr_(row) && st !== "SETTLED" && od <= 0 && row.is_reminder) {
          const du = row.days_until_overdue;
          if (du != null && (worstReminder == null || du < worstReminder)) worstReminder = du;
        }
        const d = String(row.ar_date || "").slice(0, 10);
        if (d && (!earliestDate || d < earliestDate)) earliestDate = d;
      });
      return {
        customer_id: cid,
        customer_name: name,
        rows: list.slice().sort(function (a, b) {
          const da = String(a.ar_date || "");
          const db = String(b.ar_date || "");
          if (da !== db) return da < db ? -1 : da > db ? 1 : 0;
          return arSortCreatedMs_(a) - arSortCreatedMs_(b);
        }),
        count: list.length,
        sumSystem: sumSystem,
        sumDue: sumDue,
        sumRec: sumRec,
        sumOut: sumOut,
        maxOverdue: maxOverdue,
        worstReminder: worstReminder,
        earliestDate: earliestDate
      };
    })
    .sort(function (a, b) {
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), "zh-Hant");
    });
}

function arCustomerGroupStatusSummary_(rows) {
  let open = 0;
  let partial = 0;
  (rows || []).forEach(function (row) {
    const st = String(row.status || "").toUpperCase();
    if (st === "OPEN") open += 1;
    else if (st === "PARTIAL") partial += 1;
  });
  const parts = [];
  if (open) parts.push("未收 " + open);
  if (partial) parts.push("部分 " + partial);
  return parts.length ? parts.join(" · ") : "—";
}

function arToggleCustomerGroup_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  if (arExpandedCustomerIds_[cid]) delete arExpandedCustomerIds_[cid];
  else arExpandedCustomerIds_[cid] = true;
  arRenderListBody_();
}

function arBatchToggleCustomer_(customerId, checked, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  const rows = arRows_.filter(function (row) {
    return String(row.customer_id || "").trim().toUpperCase() === cid && arBatchEligibleRow_(row);
  });
  if (!rows.length) return;
  if (checked) {
    const selected = arGetBatchSelectedRows_();
    if (selected.length) {
      const firstCid = String(selected[0].customer_id || "").trim().toUpperCase();
      if (firstCid && firstCid !== cid) {
        showToast("批次收款僅限同一客戶，已改為只勾選此客戶", "warning");
        arBatchSelectedIds_ = {};
      }
    }
    rows.forEach(function (row) {
      arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()] = true;
    });
  } else {
    rows.forEach(function (row) {
      delete arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()];
    });
  }
  arUpdateBatchUi_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arSyncCustomerGroupCheckboxes_() {
  if (!arIsGroupedList_()) return;
  document.querySelectorAll("#ar_list_tbody input.ar-batch-customer-pick").forEach(function (cb) {
    const cid = String(cb.getAttribute("data-customer-id") || "").trim().toUpperCase();
    const rows = arRows_.filter(function (row) {
      return String(row.customer_id || "").trim().toUpperCase() === cid && arBatchEligibleRow_(row);
    });
    const allSelected =
      rows.length > 0 &&
      rows.every(function (row) {
        return arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()];
      });
    const someSelected = rows.some(function (row) {
      return arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()];
    });
    cb.checked = allSelected;
    cb.indeterminate = !allSelected && someSelected;
  });
}

function arRenderCustomerGroupRow_(group) {
  const cid = group.customer_id;
  const safeCid = cid.replace(/'/g, "\\'");
  const expanded = !!arExpandedCustomerIds_[cid];
  const eligible = group.rows.filter(arBatchEligibleRow_);
  const allSelected =
    eligible.length > 0 &&
    eligible.every(function (row) {
      return arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()];
    });
  let odTxt = "—";
  let extraStyle = ' style="background:#f8fafc;"';
  if (group.maxOverdue > 0) {
    odTxt = '<span style="color:#b42318;font-weight:600;">逾期 ' + group.maxOverdue + " 天</span>";
    extraStyle = ' style="background:#fef2f2;"';
  } else if (group.worstReminder != null) {
    odTxt = '<span style="color:#b45309;font-weight:600;">還有 ' + group.worstReminder + " 天</span>";
    extraStyle = ' style="background:#fffbeb;"';
  }
  const pickCell =
    arCanOperate_() && eligible.length
      ? '<td class="ar-col-pick" onclick="event.stopPropagation()"><input type="checkbox" class="ar-batch-customer-pick" data-customer-id="' +
        arEsc_(cid) +
        '" ' +
        (allSelected ? "checked" : "") +
        ' onchange="arBatchToggleCustomer_(\'' +
        safeCid +
        "', this.checked, event)\"></td>"
      : arCanOperate_()
        ? '<td class="ar-col-pick"></td>'
        : "";
  const openCls = expanded ? " ar-list-customer-open" : "";
  let html =
    '<tr class="ar-list-customer-row erp-list-row-selectable' +
    openCls +
    '"' +
    extraStyle +
    ' data-customer-id="' +
    arEsc_(cid) +
    '" onclick="arToggleCustomerGroup_(\'' +
    safeCid +
    "')\">" +
    pickCell +
    '<td class="logs-stack-cell ar-list-date-cell"><div class="logs-stack-main">' +
    group.count +
    ' 筆</div><div class="logs-stack-sub">點開明細</div></td>' +
    '<td><strong>' +
    arEsc_(group.customer_name) +
    "</strong></td>" +
    "<td><strong>" +
    arEsc_(arFmtMoney_(group.sumSystem)) +
    "</strong></td>" +
    "<td><strong>" +
    arEsc_(arFmtMoney_(group.sumDue)) +
    "</strong></td>" +
    "<td><strong>" +
    arEsc_(arFmtMoney_(group.sumRec)) +
    "</strong></td>" +
    "<td><strong>" +
    arEsc_(arFmtMoney_(group.sumOut)) +
    "</strong></td>" +
    "<td>" +
    arEsc_(arCustomerGroupStatusSummary_(group.rows)) +
    "</td>" +
    "<td>" +
    odTxt +
    "</td></tr>";
  if (expanded) {
    html += group.rows
      .map(function (row) {
        return arRenderListRow_(row, { nested: true });
      })
      .join("");
  }
  return html;
}

function arRenderListBody_() {
  const body = document.getElementById("ar_list_tbody");
  const colspan = arListColspan_();
  const rows = arRows_ || [];
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="' + colspan + '" class="text-muted">尚無符合條件的應收</td></tr>';
    arRenderListTotals_([]);
    return;
  }
  if (arIsGroupedList_()) {
    body.innerHTML = arBuildCustomerGroups_(rows).map(arRenderCustomerGroupRow_).join("");
  } else {
    body.innerHTML = rows
      .map(function (row) {
        return arRenderListRow_(row);
      })
      .join("");
  }
  arRenderListTotals_(rows);
  arSyncListRowHighlight_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arShowBatchColumns_(show) {
  const on = !!show && !arIsBatchHistoryView_();
  ["ar_col_pick", "ar_th_pick", "ar_total_pick"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? "" : "none";
  });
  const toolbar = document.getElementById("ar_batch_toolbar");
  if (toolbar) toolbar.style.display = on ? "" : "none";
  if (on) arSyncBatchToolbar_();
}

function arHasBatchSelection_() {
  return Object.keys(arBatchSelectedIds_ || {}).length > 0;
}

function arIsBatchHistoryView_() {
  return arViewMode_ === "batch";
}

function arSyncViewModeUi_() {
  const batchMode = arIsBatchHistoryView_();
  const listPanel = document.getElementById("ar_list_panel");
  const histPanel = document.getElementById("ar_batch_history_panel");
  const foot = document.getElementById("ar_list_tfoot");
  const statusSel = document.getElementById("ar_filter_status");
  const batchToolbar = document.getElementById("ar_batch_toolbar");
  const batchCard = document.getElementById("ar_batch_card");
  const viewBtn = document.getElementById("ar_view_mode_btn");
  if (listPanel) listPanel.style.display = batchMode ? "none" : "";
  if (histPanel) histPanel.style.display = batchMode ? "" : "none";
  if (statusSel) statusSel.disabled = batchMode;
  ["ar_filter_date_from", "ar_filter_date_to"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.disabled = batchMode;
  });
  if (batchToolbar && batchMode) batchToolbar.style.display = "none";
  if (batchCard && batchMode) batchCard.style.display = "none";
  if (viewBtn) viewBtn.textContent = batchMode ? "應收列表" : "批次收款紀錄";
  if (batchMode && foot) foot.style.display = "none";
}

async function arSetViewMode_(mode) {
  arViewMode_ = mode === "batch" ? "batch" : "ar";
  arSyncViewModeUi_();
  arApplyPermissions_();
  if (arIsBatchHistoryView_()) {
    arCloseDetail_();
    arBatchClearSelection_();
    await arReloadBatchHistory_();
  } else {
    arCloseBatchDetail_();
    await arReloadList_();
  }
}

function arToggleViewMode_() {
  void arSetViewMode_(arIsBatchHistoryView_() ? "ar" : "batch");
}

function arCloseBatchDetail_() {
  arSelectedBatchId_ = "";
  arSetBatchDetailVisible_(false);
  arSyncBatchVoidBtn_(null);
  arRenderBatchHistoryBody_();
}

function arSetBatchDetailVisible_(visible) {
  const card = document.getElementById("ar_batch_history_detail_card");
  if (card) card.style.display = visible ? "" : "none";
}

function arFormatBankMetaLine_(last5, accountName) {
  const parts = [String(last5 || "").trim(), String(accountName || "").trim()].filter(Boolean);
  if (!parts.length) return "—";
  return arEsc_(parts.join("／"));
}

function arFormatBatchTotalCell_(row) {
  if (row?.all_voided) {
    return (
      '<span style="text-decoration:line-through;color:#94a3b8;">' +
      arEsc_(arFmtMoney_(row?.total_original)) +
      "</span>"
    );
  }
  return arEsc_(arFmtMoney_(row?.total_amount));
}

function arFormatBatchHistoryRemarkCell_(row) {
  if (row?.all_voided) {
    return arEsc_(arFormatVoidRemarkDisplay_(row.void_at, row.void_by));
  }
  const remark = String(row?.remark || "").trim();
  return arEsc_(remark || "—");
}

function arFormatBatchLineAmountCell_(line) {
  if (!line?.voided) return arEsc_(arFmtMoney_(line.amount));
  return (
    '<span style="text-decoration:line-through;color:#94a3b8;">' +
    arEsc_(arFmtMoney_(line.original_amount)) +
    "</span>"
  );
}

function arFormatBatchLineStatusCell_(line) {
  if (line?.voided) return '<span style="color:#b42318;font-weight:600;">已作廢</span>';
  return arEsc_(arStatusLabel_(line?.ar_status));
}

function arFormatBatchLineSourceCell_(line) {
  return arFormatSourceListCell_({
    source_type: line?.source_type,
    shipment_id: line?.shipment_id,
    settlement_id: line?.settlement_id,
    source_id: line?.source_id
  });
}

function arFormatBatchHistoryPayDateCell_(row) {
  const date = String(row?.payment_date || "").slice(0, 10) || "—";
  const timeSub = arFormatTimeFromTs_(row?.created_at, row?.ar_date);
  if (!timeSub) return arEsc_(date);
  return (
    '<div class="logs-stack-main">' +
    arEsc_(date) +
    "</div>" +
    '<div class="logs-stack-sub">' +
    arEsc_(timeSub) +
    "</div>"
  );
}

function arFormatBatchHistoryOperatorCell_(row) {
  const who =
    typeof erpDisplayOperatorName_ === "function"
      ? erpDisplayOperatorName_(row?.created_by)
      : row?.created_by || "—";
  return arEsc_(who);
}

function arRenderBatchHistoryBody_() {
  const body = document.getElementById("ar_batch_history_tbody");
  if (!body) return;
  const rows = arBatchHistoryRows_ || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">尚無批次收款紀錄</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(function (row) {
      const bid = String(row.batch_id || "").trim().toUpperCase();
      const safeBid = bid.replace(/'/g, "\\'");
      const open = bid === arSelectedBatchId_;
      return (
        '<tr class="erp-list-row-selectable' +
        (open ? " erp-list-row-open" : "") +
        '" data-batch-id="' +
        arEsc_(bid) +
        '" onclick="arSelectBatch_(\'' +
        safeBid +
        "')\">" +
        '<td class="logs-stack-cell">' +
        arFormatBatchHistoryPayDateCell_(row) +
        "</td><td>" +
        arEsc_(arCustomerName_({ customer_id: row.customer_id })) +
        "</td><td>" +
        arFormatBatchTotalCell_(row) +
        "</td><td>" +
        arFormatBankMetaLine_(row.last5, row.account_name) +
        "</td><td>" +
        arFormatBatchHistoryOperatorCell_(row) +
        "</td><td>" +
        arFormatBatchHistoryRemarkCell_(row) +
        "</td></tr>"
      );
    })
    .join("");
}

async function arVoidBatchPayment_(batchId, triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  const bid = String(batchId || "").trim().toUpperCase();
  if (!bid) return showToast("請先選擇批次", "error");
  const row =
    (arBatchHistoryRows_ || []).find(function (x) {
      return String(x.batch_id || "").trim().toUpperCase() === bid;
    }) || null;
  const activeCount = row
    ? Math.max(0, Number(row.allocation_count || 0) - Number(row.voided_count || 0))
    : 0;
  if (!activeCount) return showToast("此批次收款已全部作廢", "error");
  const payDate = String(row?.payment_date || "").slice(0, 10) || "—";
  const total = arFmtMoney_(row?.total_amount != null ? row.total_amount : row?.total_original);
  const msg =
    "確定作廢這批批次收款？\n\n收款日：" +
    payDate +
    "\n匯款總額：" +
    total +
    "\n將作廢 " +
    activeCount +
    " 筆分配收款；各 AR 已收／狀態會重算。";
  if (!confirm(msg)) return;

  showSaveHint(triggerEl);
  try {
    await callAPI(
      {
        action: "void_ar_payment_batch_bundle",
        batch_id: bid,
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("批次收款已作廢", "success");
    await arReloadBatchHistory_();
    if (String(arSelectedBatchId_ || "").trim().toUpperCase() === bid) {
      await arSelectBatch_(bid, true);
    }
    await arReloadList_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢批次收款失敗", "error");
  } finally {
    hideSaveHint();
  }
}

function arSyncBatchVoidBtn_(pack) {
  const btn = document.getElementById("ar_batch_void_btn");
  if (!btn) return;
  const activeCount = pack
    ? Math.max(0, Number(pack.allocation_count || 0) - Number(pack.voided_count || 0))
    : 0;
  const show = arCanOperate_() && !!pack && activeCount > 0;
  btn.style.display = show ? "" : "none";
}

async function arReloadBatchHistory_() {
  const body = document.getElementById("ar_batch_history_tbody");
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="text-muted">載入中…</td></tr>';
  const customerId = String(document.getElementById("ar_filter_customer")?.value || "").trim().toUpperCase();
  try {
    const r = await callAPI(
      {
        action: "list_ar_payment_batch_bundle",
        customer_id: customerId,
        _ts: String(Date.now())
      },
      { method: "POST" }
    );
    arBatchHistoryRows_ = Array.isArray(r?.data) ? r.data : [];
    arRenderBatchHistoryBody_();
    if (arSelectedBatchId_) {
      const still = arBatchHistoryRows_.some(function (x) {
        return String(x.batch_id || "").trim().toUpperCase() === arSelectedBatchId_;
      });
      if (still) await arSelectBatch_(arSelectedBatchId_, true);
      else arCloseBatchDetail_();
    }
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">載入失敗</td></tr>';
  }
}

function arRenderBatchDetail_(pack) {
  const title = document.getElementById("ar_batch_history_detail_title");
  const summary = document.getElementById("ar_batch_history_summary");
  const body = document.getElementById("ar_batch_history_lines_tbody");
  if (!pack || !body) return;
  if (title) title.textContent = String(pack.batch_id || "—");
  const who =
    typeof erpDisplayOperatorName_ === "function"
      ? erpDisplayOperatorName_(pack.created_by)
      : pack.created_by || "—";
  if (summary) {
    let totalHtml = arEsc_(arFmtMoney_(pack.total_amount));
    if (pack.all_voided) {
      totalHtml =
        '<span style="text-decoration:line-through;color:#94a3b8;">' +
        arEsc_(arFmtMoney_(pack.total_original)) +
        "</span>";
    }
    summary.innerHTML =
      "<div><strong>客戶：</strong>" +
      arEsc_(arCustomerName_({ customer_id: pack.customer_id })) +
      " · <strong>收款日：</strong>" +
      arEsc_(String(pack.payment_date || "").slice(0, 10) || "—") +
      " · <strong>匯款總額：</strong>" +
      totalHtml +
      "</div>" +
      "<div><strong>分配筆數：</strong>" +
      arEsc_(String(pack.allocation_count || 0)) +
      " · <strong>登記人：</strong>" +
      arEsc_(who) +
      " · <strong>登記時間：</strong>" +
      arEsc_(erpFormatListDateTime_(pack.created_at) || "—") +
      "</div>" +
      "<div><strong>備註：</strong>" +
      arFormatBatchHistoryRemarkCell_(pack) +
      "</div>" +
      (pack.last5 || pack.account_name
        ? "<div><strong>末五碼／帳戶名：</strong>" + arFormatBankMetaLine_(pack.last5, pack.account_name) + "</div>"
        : "");
  }
  arSyncBatchVoidBtn_(pack);
  const lines = Array.isArray(pack.lines) ? pack.lines : [];
  body.innerHTML = lines.length
    ? lines
        .map(function (line) {
          const arId = String(line.ar_id || "").trim().toUpperCase();
          const safeId = arId.replace(/'/g, "\\'");
          return (
            "<tr><td class=\"logs-stack-cell\">" +
            arFormatArDateCell_({ ar_date: line.ar_date, created_at: line.ar_created_at }) +
            "</td><td>" +
            '<a href="#" onclick="arOpenArFromBatch_(\'' +
            safeId +
            "');return false;\">" +
            arEsc_(arId) +
            "</a></td><td class=\"logs-stack-cell\">" +
            arFormatBatchLineSourceCell_(line) +
            "</td><td>" +
            arFormatBatchLineAmountCell_(line) +
            "</td><td>" +
            arFormatBatchLineStatusCell_(line) +
            "</td></tr>"
          );
        })
        .join("")
    : '<tr><td colspan="5" class="text-muted">尚無分配明細</td></tr>';
}

async function arSelectBatch_(batchId, keepScroll) {
  const nextId = String(batchId || "").trim().toUpperCase();
  if (!nextId) return;
  if (typeof erpListRowToggleClose_ === "function" && erpListRowToggleClose_(arSelectedBatchId_, nextId)) {
    const card = document.getElementById("ar_batch_history_detail_card");
    const open = card && card.style.display !== "none";
    if (open) {
      arSelectedBatchId_ = "";
      arSetBatchDetailVisible_(false);
      arRenderBatchHistoryBody_();
      return;
    }
  }
  arSelectedBatchId_ = nextId;
  arCloseDetail_();
  arBatchClearSelection_();
  arRenderBatchHistoryBody_();
  arSetBatchDetailVisible_(true);
  const card = document.getElementById("ar_batch_history_detail_card");
  if (card && !keepScroll) {
    try {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_e) {}
  }
  const body = document.getElementById("ar_batch_history_lines_tbody");
  if (body) body.innerHTML = '<tr><td colspan="5" class="text-muted">載入中…</td></tr>';
  try {
    const r = await callAPI(
      { action: "get_ar_payment_batch_bundle", batch_id: nextId, _ts: String(Date.now()) },
      { method: "POST" }
    );
    arRenderBatchDetail_(r?.data || null);
  } catch (_e) {
    if (body) body.innerHTML = '<tr><td colspan="5" class="text-muted">載入失敗</td></tr>';
  }
}

function arOpenArFromBatch_(arId) {
  const id = String(arId || "").trim().toUpperCase();
  if (!id) return;
  void arSetViewMode_("ar").then(function () {
    return arSelect_(id);
  });
}

function arCloseDetail_() {
  arSelectedId_ = "";
  arSelectedRow_ = null;
  arSetDetailPanelsVisible_(false);
  arSyncListRowHighlight_();
}

function arBatchClearSelection_() {
  arBatchSelectedIds_ = {};
  arUpdateBatchUi_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arBatchToggle_(arId, checked, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const id = String(arId || "").trim().toUpperCase();
  if (!id) return;
  const row = arRows_.find(function (x) {
    return String(x.ar_id || "").trim().toUpperCase() === id;
  });
  if (!row || !arBatchEligibleRow_(row)) return;
  if (checked) {
    const selected = arGetBatchSelectedRows_();
    const cid = String(row.customer_id || "").trim().toUpperCase();
    if (selected.length) {
      const firstCid = String(selected[0].customer_id || "").trim().toUpperCase();
      if (firstCid && cid && firstCid !== cid) {
        showToast("批次收款僅限同一客戶，已改為只勾選此列", "warning");
        arBatchSelectedIds_ = {};
      }
    }
    arBatchSelectedIds_[id] = true;
  } else {
    delete arBatchSelectedIds_[id];
  }
  arUpdateBatchUi_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arSyncBatchCheckboxes_() {
  document.querySelectorAll("#ar_list_tbody input.ar-batch-pick").forEach(function (cb) {
    const id = String(cb.getAttribute("data-ar-id") || "").trim().toUpperCase();
    cb.checked = !!arBatchSelectedIds_[id];
  });
}

function arBatchSelectAllOpen_() {
  const eligible = (arRows_ || []).filter(arBatchEligibleRow_);
  if (!eligible.length) return showToast("本頁無可勾選的未結清 AR", "warning");
  arBatchSelectedIds_ = {};
  eligible.forEach(function (row) {
    arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()] = true;
  });
  arUpdateBatchUi_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arBatchSelectThisMonthOpen_() {
  const bounds = arMonthBoundsYmd_();
  const eligible = (arRows_ || []).filter(function (row) {
    return arBatchEligibleRow_(row) && arIsRowInArDateRange_(row, bounds.from, bounds.to);
  });
  if (!eligible.length) {
    return showToast("本月起算日（" + bounds.from + "～" + bounds.to + "）無可勾選的未結清 AR", "warning");
  }
  const customerIds = {};
  eligible.forEach(function (row) {
    const cid = String(row.customer_id || "").trim().toUpperCase();
    if (cid) customerIds[cid] = true;
  });
  const cids = Object.keys(customerIds);
  if (cids.length > 1) {
    return showToast("本月未結清 AR 含多客戶，請先篩選單一客戶", "warning");
  }
  arBatchSelectedIds_ = {};
  eligible.forEach(function (row) {
    arBatchSelectedIds_[String(row.ar_id || "").trim().toUpperCase()] = true;
  });
  arUpdateBatchUi_();
  arSyncBatchCheckboxes_();
  arSyncCustomerGroupCheckboxes_();
}

function arUpdateBatchUi_() {
  const rows = arGetBatchSelectedRows_();
  const card = document.getElementById("ar_batch_card");
  const label = document.getElementById("ar_batch_customer_label");
  const submitBtn = document.getElementById("ar_batch_submit_btn");
  if (arIsBatchHistoryView_()) {
    if (card) card.style.display = "none";
    return;
  }
  const show = arCanOperate_() && rows.length > 0;
  if (show) arCloseDetail_();
  if (card) card.style.display = show ? "" : "none";
  if (label && rows.length) {
    const cid = String(rows[0].customer_id || "").trim().toUpperCase();
    label.textContent = arCustomerName_(rows[0]) + "（" + rows.length + " 筆）";
  }
  if (submitBtn) {
    submitBtn.disabled = !show;
    submitBtn.title = show ? "確認批次收款" : "請勾選 AR 並填匯款總額";
  }
  arUpdateBatchPreview_();
  if (show && card) {
    try {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_e) {}
  }
}

function arUpdateBatchPreview_() {
  const body = document.getElementById("ar_batch_preview_tbody");
  const summary = document.getElementById("ar_batch_summary");
  const submitBtn = document.getElementById("ar_batch_submit_btn");
  const rows = arGetBatchSelectedRows_();
  if (!body) return;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">請勾選 AR 並填匯款總額</td></tr>';
    if (summary) summary.innerHTML = "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.title = "請勾選 AR 並填匯款總額";
    }
    return;
  }

  const totalInput = Number(document.getElementById("ar_batch_pay_amount")?.value || 0);
  const pack = arComputeBatchAllocation_(rows, totalInput);
  const outstanding = pack.totalOutstanding;
  const diff = roundMoney_(outstanding - totalInput);
  let summaryHtml =
    "<div><strong>勾選筆數：</strong>" +
    rows.length +
    " · <strong>未收合計：</strong>" +
    arEsc_(arFmtMoney_(outstanding)) +
    " · <strong>本次匯款總額：</strong>" +
    arEsc_(arFmtMoney_(totalInput)) +
    "</div>";
  if (totalInput > 1e-9) {
    if (totalInput - outstanding > 1e-9) {
      summaryHtml +=
        '<div style="color:#b42318;margin-top:6px;"><strong>超出未收合計 ' +
        arEsc_(arFmtMoney_(roundMoney_(totalInput - outstanding))) +
        "</strong>，請調整總額或減少勾選</div>";
    } else if (diff > 1e-9) {
      summaryHtml +=
        '<div style="color:#b45309;margin-top:6px;"><strong>差額：</strong>' +
        arEsc_(arFmtMoney_(diff)) +
        "（尚有未分配，下次再收）</div>";
    } else {
      summaryHtml += '<div style="color:#047857;margin-top:6px;">本次可一次結清所勾選 AR</div>';
    }
  }
  if (summary) summary.innerHTML = summaryHtml;

  if (!(totalInput > 0)) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">請填匯款總額以預覽分配</td></tr>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.title = "請填匯款總額";
    }
    return;
  }
  if (totalInput - outstanding > 1e-9) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">總額大於未收合計，無法提交</td></tr>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.title = "匯款總額不可大於未收合計";
    }
    return;
  }
  if (!pack.lines.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">所選 AR 已無未收</td></tr>';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.title = "所選 AR 已無未收";
    }
    return;
  }

  body.innerHTML = pack.lines
    .map(function (line) {
      const row = line.row;
      const stAfter =
        line.after <= 1e-9 ? "SETTLED" : String(row.status || "").toUpperCase() === "OPEN" ? "PARTIAL" : "PARTIAL";
      return (
        "<tr><td class=\"logs-stack-cell\">" +
        arFormatArDateCell_(row) +
        "</td><td class=\"logs-stack-cell\">" +
        arFormatSourceListCell_(row) +
        "</td><td>" +
        arEsc_(arFmtMoney_(line.before)) +
        "</td><td><strong>" +
        arEsc_(arFmtMoney_(line.alloc)) +
        "</strong></td><td>" +
        arEsc_(arFmtMoney_(line.after)) +
        '</td><td title="' +
        arEsc_(stAfter) +
        '">' +
        arEsc_(arStatusLabel_(stAfter)) +
        "</td></tr>"
      );
    })
    .join("");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.title = "確認批次收款";
  }
}

function arBuildBatchPaymentRemark_() {
  return arBuildPaymentRemarkFromFields_({
    remark: document.getElementById("ar_batch_pay_remark")?.value,
    last5: document.getElementById("ar_batch_pay_last5")?.value,
    accountName: document.getElementById("ar_batch_pay_account_name")?.value
  });
}

function arClearBatchPaymentForm_() {
  ["ar_batch_pay_amount", "ar_batch_pay_remark", "ar_batch_pay_last5", "ar_batch_pay_account_name"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

async function arSubmitBatchPayment_(triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  const rows = arGetBatchSelectedRows_();
  if (!rows.length) return showToast("請先勾選 AR", "error");
  const paymentDate = String(document.getElementById("ar_batch_pay_date")?.value || "").trim();
  const totalAmount = roundMoney_(document.getElementById("ar_batch_pay_amount")?.value || 0);
  const remark = arBuildBatchPaymentRemark_();
  if (!paymentDate) return showToast("請填收款日", "error");
  if (!(totalAmount > 0)) return showToast("匯款總額須 > 0", "error");

  const pack = arComputeBatchAllocation_(rows, totalAmount);
  if (totalAmount - pack.totalOutstanding > 1e-9) {
    return showToast("匯款總額不可大於未收合計", "error");
  }
  if (!pack.lines.length) return showToast("所選 AR 已無未收", "error");
  if (!confirm("確定以 " + arFmtMoney_(totalAmount) + " 批次登記收款？\n\n共 " + pack.lines.length + " 張 AR 將寫入收款明細。")) {
    return;
  }

  showSaveHint(triggerEl);
  let batchId = "";
  try {
    const res = await callAPI(
      {
        action: "register_ar_payment_batch_bundle",
        ar_ids_json: JSON.stringify(rows.map(function (row) {
          return String(row.ar_id || "").trim().toUpperCase();
        })),
        payment_date: paymentDate,
        total_amount: totalAmount,
        remark: remark,
        created_by: getCurrentUser()
      },
      { method: "POST" }
    );
    batchId = String(res?.batch_id || "").trim().toUpperCase();
    showToast("批次收款已登記", "success");
    arBatchClearSelection_();
    arClearBatchPaymentForm_();
    if (batchId) {
      await arSetViewMode_("batch");
      await arSelectBatch_(batchId);
    } else {
      await arReloadList_();
      if (arSelectedId_) await arSelect_(arSelectedId_);
    }
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("批次收款失敗", "error");
  } finally {
    hideSaveHint();
  }
}

function arCollapseExceptionCard_() {
  const card = document.getElementById("ar_exception_card");
  const btn = document.getElementById("ar_exception_toggle");
  const row = arRows_.find(function (x) { return String(x.ar_id || "").toUpperCase() === arSelectedId_; });
  if (card) card.style.display = "none";
  if (btn) btn.textContent = arGetExceptionToggleLabel_(row);
}

function arSetDetailPanelsVisible_(visible) {
  const show = !!visible;
  const card = document.getElementById("ar_detail_card");
  const hist = document.getElementById("ar_adjust_history_card");
  if (card) card.style.display = show ? "" : "none";
  if (hist) hist.style.display = show ? "" : "none";
  if (!show) arCollapseExceptionCard_();
}

function arPrefillAdjustDue_(row) {
  const adjDue = document.getElementById("ar_adjust_due");
  if (!adjDue || !row) return;
  const st = String(row.status || "").toUpperCase();
  if (st === "SETTLED") {
    adjDue.value = String(Number(row.amount_due || 0));
    return;
  }
  const rec = Number(row.amount_received || 0);
  adjDue.value = Number.isFinite(rec) ? String(rec) : "";
}

function arClearPaymentForm_() {
  arEditPaymentId_ = "";
  const amt = document.getElementById("ar_pay_amount");
  const dt = document.getElementById("ar_pay_date");
  if (amt) amt.value = "";
  if (dt) dt.value = arTodayYmd_();
  arFillSinglePaymentFields_({ userRemark: "", last5: "", accountName: "" });
  arResetGapWriteoffForm_();
  arApplyPermissions_();
}

function arStartEditPayment_(payment) {
  if (!arCanOperate_() || !payment) return;
  arEditPaymentId_ = String(payment.payment_id || "").trim().toUpperCase();
  const amt = document.getElementById("ar_pay_amount");
  const dt = document.getElementById("ar_pay_date");
  if (amt) amt.value = String(Number(payment.amount || 0));
  if (dt) dt.value = String(payment.payment_date || "").slice(0, 10) || arTodayYmd_();
  arFillSinglePaymentFields_({ remark: String(payment.remark || "") });
  arApplyPermissions_();
  try {
    if (arHasAdjustments_) document.getElementById("ar_pay_date")?.focus();
    else document.getElementById("ar_pay_amount")?.focus();
  } catch (_e) {}
}

function arCancelEditPayment_() {
  arClearPaymentForm_();
}

function arGetExceptionToggleLabel_(row) {
  const card = document.getElementById("ar_exception_card");
  const st = String(row?.status || "").toUpperCase();
  const open = card && card.style.display !== "none";
  if (open) {
    return st === "SETTLED" ? "收起重開調整" : "收起例外處理";
  }
  return st === "SETTLED" ? "重開調整" : "例外處理（調整應收／手動沖銷結案）";
}

function arToggleExceptionCard_(triggerEl) {
  const card = document.getElementById("ar_exception_card");
  if (!card) return;
  const open = card.style.display !== "none";
  if (open) {
    arCollapseExceptionCard_();
    return;
  }
  card.style.display = "";
  const row = arRows_.find(function (x) { return String(x.ar_id || "").toUpperCase() === arSelectedId_; });
  if (triggerEl) {
    triggerEl.textContent = String(row?.status || "").toUpperCase() === "SETTLED" ? "收起重開調整" : "收起例外處理";
  }
  if (row) {
    arPrefillAdjustDue_(row);
    arRenderAdjustDueSummary_(row);
  }
}

function arUpdateExceptionUi_(row, adjustmentCount) {
  const toggleRow = document.getElementById("ar_exception_toggle_row");
  const toggleBtn = document.getElementById("ar_exception_toggle");
  const forms = document.getElementById("ar_exception_forms");
  const adjustBlock = document.getElementById("ar_adjust_section");
  const forceBlock = document.getElementById("ar_force_section");
  const title = document.getElementById("ar_exception_card_title");
  const st = String(row?.status || "").toUpperCase();
  const canOp = arCanOperate_();
  const adjCount = Number(adjustmentCount || 0);
  const settled = st === "SETTLED";

  arCollapseExceptionCard_();
  arResetReasonForm_("all");

  if (!canOp) {
    if (toggleRow) toggleRow.style.display = "none";
    return;
  }

  if (settled) {
    if (forms) forms.style.display = "";
    if (adjustBlock) adjustBlock.style.display = "";
    if (forceBlock) forceBlock.style.display = "none";
    if (title) title.textContent = "重開調整";
    if (toggleRow) toggleRow.style.display = "";
    if (toggleBtn) toggleBtn.textContent = arGetExceptionToggleLabel_(row);
    arPrefillAdjustDue_(row);
    arRenderAdjustDueSummary_(row);
    return;
  }

  if (forms) forms.style.display = "";
  if (adjustBlock) adjustBlock.style.display = "";
  if (forceBlock) forceBlock.style.display = "";
  if (title) title.textContent = "例外處理";
  if (toggleRow) toggleRow.style.display = "";
  if (toggleBtn) toggleBtn.textContent = arGetExceptionToggleLabel_(row);
  arPrefillAdjustDue_(row);
  arRenderAdjustDueSummary_(row);
}

function arPopulateCustomerFilter_() {
  const sel = document.getElementById("ar_filter_customer");
  if (!sel) return;
  const prev = String(sel.value || "").trim().toUpperCase();
  const list = Object.keys(arCustomers_ || {})
    .map(function (id) {
      const c = arCustomers_[id];
      return {
        id: id,
        name: String(c?.customer_name || id || "").trim() || id
      };
    })
    .sort(function (a, b) {
      return a.name.localeCompare(b.name, "zh-Hant");
    });
  sel.innerHTML =
    '<option value="">全部客戶</option>' +
    list
      .map(function (c) {
        return '<option value="' + arEsc_(c.id) + '">' + arEsc_(c.name) + "</option>";
      })
      .join("");
  if (prev) {
    const hit = list.some(function (c) {
      return c.id === prev;
    });
    if (hit) sel.value = prev;
  }
  arSyncBatchToolbar_();
}

function arFilterRows_(rows, statusFilter) {
  let out = Array.isArray(rows) ? rows.slice() : [];
  const filter = String(statusFilter || "UNCLOSED").trim().toUpperCase();
  if (filter === "ALL" || filter === "UNCLOSED") {
    out = out.filter(function (row) {
      const st = String(row.status || "").toUpperCase();
      return st === "OPEN" || st === "PARTIAL";
    });
  } else if (filter !== "ANY") {
    out = out.filter(function (row) {
      return String(row.status || "").toUpperCase() === filter;
    });
  }
  const customerFilter = String(document.getElementById("ar_filter_customer")?.value || "")
    .trim()
    .toUpperCase();
  if (customerFilter) {
    out = out.filter(function (row) {
      return String(row.customer_id || "").trim().toUpperCase() === customerFilter;
    });
  }
  const dateFrom = String(document.getElementById("ar_filter_date_from")?.value || "").trim();
  const dateTo = String(document.getElementById("ar_filter_date_to")?.value || "").trim();
  if (dateFrom || dateTo) {
    out = out.filter(function (row) {
      return arIsRowInArDateRange_(row, dateFrom, dateTo);
    });
  }
  return out;
}

function arApplyListFilters_() {
  const body = document.getElementById("ar_list_tbody");
  const foot = document.getElementById("ar_list_tfoot");
  const colspan = arListColspan_();
  if (!body) return;
  const filter = String(document.getElementById("ar_filter_status")?.value || "UNCLOSED").trim().toUpperCase();
  const rows = arFilterRows_(arRowsAll_ || [], filter);
  arRows_ = rows;
  const selectedKeys = Object.keys(arBatchSelectedIds_ || {});
  if (selectedKeys.length) {
    const visible = {};
    rows.forEach(function (row) {
      const id = String(row.ar_id || "").trim().toUpperCase();
      if (id && arBatchSelectedIds_[id]) visible[id] = true;
    });
    arBatchSelectedIds_ = visible;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="' + colspan + '" class="text-muted">尚無符合條件的應收</td></tr>';
    arRenderListTotals_([]);
    arUpdateBatchUi_();
    arSyncBatchToolbar_();
    return;
  }
  if (!arIsGroupedList_()) arExpandedCustomerIds_ = {};
  arRenderListBody_();
  arRenderListTotals_(rows);
  arUpdateBatchUi_();
  arSyncBatchToolbar_();
}

function arRenderListTotals_(rows) {
  const foot = document.getElementById("ar_list_tfoot");
  const countEl = document.getElementById("ar_total_count");
  const sysEl = document.getElementById("ar_total_system");
  const dueEl = document.getElementById("ar_total_due");
  const recEl = document.getElementById("ar_total_rec");
  const outEl = document.getElementById("ar_total_out");
  const list = rows || [];
  if (!foot) return;
  if (!list.length) {
    foot.style.display = "none";
    return;
  }
  let sumSystem = 0;
  let sumDue = 0;
  let sumRec = 0;
  let sumOut = 0;
  list.forEach(function (row) {
    if (!arCountsInTotals_(row)) return;
    sumSystem += Number(row.amount_system || 0);
    sumDue += Number(row.amount_due || 0);
    sumRec += Number(row.amount_received || 0);
    sumOut += arOutstanding_(row);
  });
  let countText = "（" + list.length + " 筆）";
  if (arIsGroupedList_()) {
    const custSet = {};
    list.forEach(function (row) {
      const cid = String(row.customer_id || "").trim().toUpperCase();
      if (cid) custSet[cid] = true;
    });
    const custN = Object.keys(custSet).length;
    if (custN > 1) countText = "（" + list.length + " 筆 · " + custN + " 客戶）";
  }
  if (countEl) countEl.textContent = countText;
  if (sysEl) sysEl.innerHTML = "<strong>" + arEsc_(arFmtMoney_(sumSystem)) + "</strong>";
  if (dueEl) dueEl.innerHTML = "<strong>" + arEsc_(arFmtMoney_(sumDue)) + "</strong>";
  if (recEl) recEl.innerHTML = "<strong>" + arEsc_(arFmtMoney_(sumRec)) + "</strong>";
  if (outEl) outEl.innerHTML = "<strong>" + arEsc_(arFmtMoney_(sumOut)) + "</strong>";
  foot.style.display = "";
}

function arFormatCustomerCell_(row) {
  const cid = String(row.customer_id || "").trim().toUpperCase();
  const cname = arCustomers_[cid]?.customer_name || cid || "—";
  const caseClosed = String(row.consignment_case_status || "").trim().toUpperCase() === "CLOSED";
  if (!caseClosed) return "<td>" + arEsc_(cname) + "</td>";
  return (
    '<td class="logs-stack-cell">' +
    '<div class="logs-stack-main">' + arEsc_(cname) + "</div>" +
    '<div class="logs-stack-sub" style="color:#b45309;font-weight:600;">已結案</div>' +
    "</td>"
  );
}

function arRenderListRow_(row, opts) {
  const nested = !!(opts && opts.nested);
  const arId = String(row.ar_id || "");
  const safeId = arId.replace(/'/g, "\\'");
  const isOpen = arId.toUpperCase() === String(arSelectedId_ || "").toUpperCase();
  const st = String(row.status || "").toUpperCase();
  const voided = arIsVoidedAr_(row);
  const overdue = Number(row.overdue_days || 0);
  const isReminder = !!row.is_reminder;
  const daysUntil = row.days_until_overdue;
  let odTxt = "—";
  let extraStyle = nested ? "" : "";
  if (voided) {
    extraStyle = "";
  } else if (overdue > 0 && st !== "SETTLED") {
    odTxt = '<span style="color:#b42318;font-weight:600;">逾期 ' + overdue + " 天</span>";
    if (!nested) extraStyle = ' style="background:#fef2f2;"';
  } else if (isReminder && st !== "SETTLED" && daysUntil != null) {
    odTxt = '<span style="color:#b45309;font-weight:600;">還有 ' + daysUntil + " 天</span>";
    if (!nested) extraStyle = ' style="background:#fffbeb;"';
  }
  const srcCell = arFormatSourceListCell_(row);
  const openCls = isOpen ? " erp-list-row-open" : "";
  const nestedCls = nested ? " ar-list-child-row" : "";
  const voidCls = voided ? " ar-list-void-row" : "";
  const idUp = arId.toUpperCase();
  const canPick = arCanOperate_() && arBatchEligibleRow_(row);
  const pickCell = canPick
    ? '<td class="ar-col-pick" onclick="event.stopPropagation()"><input type="checkbox" class="ar-batch-pick" data-ar-id="' +
      arEsc_(arId) +
      '" ' +
      (arBatchSelectedIds_[idUp] ? "checked" : "") +
      ' onchange="arBatchToggle_(\'' +
      safeId +
      "', this.checked, event)\"></td>"
    : arCanOperate_()
      ? '<td class="ar-col-pick"></td>'
      : "";
  const custSrcCell = '<td class="logs-stack-cell ar-list-src-cell">' + srcCell + "</td>";
  return (
    '<tr class="erp-list-row-selectable' + openCls + nestedCls + voidCls + '"' + extraStyle +
    ' data-ar-id="' + arEsc_(arId) + '" onclick="arSelect_(\'' + safeId + "')\">" +
    pickCell +
    '<td class="logs-stack-cell ar-list-date-cell">' + arFormatArDateCell_(row) + "</td>" +
    custSrcCell +
    "<td>" + arEsc_(arFmtMoney_(row.amount_system)) + "</td>" +
    "<td class=\"logs-stack-cell\"><div class=\"logs-stack-main\">" + arFmtDueCell_(row) + "</div></td>" +
    "<td>" + arEsc_(arFmtMoney_(row.amount_received)) + "</td>" +
    "<td>" + arEsc_(arFmtMoney_(arOutstanding_(row))) + "</td>" +
    '<td title="' + arEsc_(arIsVoidedAr_(row) ? "VOID" : st) + '">' + arStatusCellHtml_(row) + "</td>" +
    "<td>" + odTxt + "</td>" +
    "</tr>"
  );
}

function arSyncListRowHighlight_() {
  const sel = String(arSelectedId_ || "").toUpperCase();
  document.querySelectorAll("#ar_list_tbody tr[data-ar-id]").forEach(function (tr) {
    const id = String(tr.getAttribute("data-ar-id") || "").toUpperCase();
    tr.classList.toggle("erp-list-row-open", id === sel);
  });
}

async function arInit() {
  arViewMode_ = "ar";
  arSelectedBatchId_ = "";
  arExpandedCustomerIds_ = {};
  arSetBatchDetailVisible_(false);
  arCloseDetail_();
  arBatchClearSelection_();
  arApplyPermissions_();
  arResetReasonForm_("all");
  arSyncViewModeUi_();
  const dt = document.getElementById("ar_pay_date");
  if (dt && !dt.value) dt.value = arTodayYmd_();
  const batchDt = document.getElementById("ar_batch_pay_date");
  if (batchDt && !batchDt.value) batchDt.value = arTodayYmd_();
  const payAmt = document.getElementById("ar_pay_amount");
  if (payAmt && !payAmt.dataset.arGapBound) {
    payAmt.dataset.arGapBound = "1";
    payAmt.addEventListener("input", arUpdateGapWriteoffUi_);
  }
  try {
    const cust = await getAll("customer").catch(function () { return []; });
    arCustomers_ = {};
    (cust || []).forEach(function (c) {
      arCustomers_[String(c.customer_id || "").trim().toUpperCase()] = c;
    });
  } catch (_e) {}
  arPopulateCustomerFilter_();
  try {
    const presetCust = String(sessionStorage.getItem("erp_ar_preset_customer") || "").trim().toUpperCase();
    if (presetCust) {
      sessionStorage.removeItem("erp_ar_preset_customer");
      const sel = document.getElementById("ar_filter_customer");
      if (sel) sel.value = presetCust;
    }
  } catch (_e) {}
  await arReloadList_();
}

async function arReloadList_() {
  if (arIsBatchHistoryView_()) {
    await arReloadBatchHistory_();
    return;
  }
  const body = document.getElementById("ar_list_tbody");
  const foot = document.getElementById("ar_list_tfoot");
  const colspan = arListColspan_();
  if (!body) return;
  body.innerHTML = '<tr><td colspan="' + colspan + '" class="text-muted">載入中…</td></tr>';
  if (foot) foot.style.display = "none";

  const filter = String(document.getElementById("ar_filter_status")?.value || "UNCLOSED").trim().toUpperCase();
  const apiStatus = filter === "OPEN" || filter === "PARTIAL" || filter === "SETTLED" ? filter : "";
  try {
    const r = await callAPI(
      { action: "list_ar_receivable_enriched", status: apiStatus, _ts: String(Date.now()) },
      { method: "POST" }
    );
    arRowsAll_ = Array.isArray(r?.data) ? r.data : [];
    if (!arIsGroupedList_()) arExpandedCustomerIds_ = {};
    arApplyListFilters_();
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="' + colspan + '" class="text-muted">載入失敗</td></tr>';
    arRenderListTotals_([]);
    arUpdateBatchUi_();
    arSyncBatchToolbar_();
  }
}

async function arSelect_(arId) {
  const nextId = String(arId || "").trim().toUpperCase();
  if (!nextId) return;
  if (typeof erpListRowToggleClose_ === "function" && erpListRowToggleClose_(arSelectedId_, nextId)) {
    const card = document.getElementById("ar_detail_card");
    const open = card && card.style.display !== "none";
    if (open) {
      arSelectedId_ = "";
      arSelectedRow_ = null;
      arSetDetailPanelsVisible_(false);
      arRenderListBody_();
      arUpdateBatchUi_();
      return;
    }
  }
  if (arHasBatchSelection_()) arBatchClearSelection_();
  arCloseBatchDetail_();
  arSelectedId_ = nextId;
  arClearPaymentForm_();

  const selectedRowEarly = arRows_.find(function (x) {
    return String(x.ar_id || "").trim().toUpperCase() === arSelectedId_;
  });
  if (selectedRowEarly && arIsGroupedList_()) {
    const expandCid = String(selectedRowEarly.customer_id || "").trim().toUpperCase();
    if (expandCid) arExpandedCustomerIds_[expandCid] = true;
  }

  const title = document.getElementById("ar_detail_title");
  const histTitle = document.getElementById("ar_adjust_history_title");
  if (title) title.textContent = arSelectedId_;
  if (histTitle) histTitle.textContent = arSelectedId_;
  arSetDetailPanelsVisible_(true);
  const card = document.getElementById("ar_detail_card");
  if (card) {
    try { card.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_eScroll) {}
  }

  let row = arRows_.find(function (x) { return String(x.ar_id || "").toUpperCase() === arSelectedId_; });
  if (!row) {
    try {
      const r = await callAPI({ action: "list_ar_receivable_enriched", status: "", _ts: String(Date.now()) }, { method: "POST" });
      const all = Array.isArray(r?.data) ? r.data : [];
      row = all.find(function (x) { return String(x.ar_id || "").toUpperCase() === arSelectedId_; });
    } catch (_e) {}
  }
  if (!row) return showToast("找不到 AR", "error");
  arSelectedRow_ = row;

  const box = document.getElementById("ar_summary_box");
  if (box) {
    const reduced = arDueReduction_(row);
    let adjustNote = "";
    if (reduced > 0 && !arIsVoidedAr_(row)) {
      adjustNote =
        '<div style="color:#b45309;margin-top:6px;"><strong>已調降應收：</strong>' +
        arEsc_(arFmtMoney_(reduced)) +
        "（請看下方「調整歷程」原因，例如經銷月結回饋折讓）</div>";
    }
    box.innerHTML =
      "<div>" + arSummaryHeadline_(row) + "</div>" +
      "<div><strong>原始金額：</strong>" + arEsc_(arFmtMoney_(row.amount_system)) +
      ' <span style="font-size:12px;color:#64748b;font-weight:400;">建立 AR 時明細加總，對照用不可修改</span></div>' +
      "<div>" + arDueReceivedOutstandingHtml_(row) + "</div>" +
      adjustNote +
      arSummaryCloseNote_(row);
  }
  arRenderAdjustDueSummary_(row);

  const adjDue = document.getElementById("ar_adjust_due");
  if (adjDue) arPrefillAdjustDue_(row);

  const hidden = document.getElementById("ar_selected_id");
  if (!hidden) {
    const inp = document.createElement("input");
    inp.type = "hidden";
    inp.id = "ar_selected_id";
    inp.value = arSelectedId_;
    document.getElementById("ar_detail_card")?.appendChild(inp);
  } else {
    hidden.value = arSelectedId_;
  }

  await arLoadPaymentsAndAdjustments_(row);
  arApplyPermissions_();
  arRenderListBody_();
}

async function arLoadPaymentsAndAdjustments_(row) {
  if (!arSelectedId_) return;
  const payBody = document.getElementById("ar_payment_tbody");
  const adjBody = document.getElementById("ar_adjust_tbody");
  try {
    const [payR, adjR] = await Promise.all([
      callAPI({ action: "list_ar_payment_by_ar", ar_id: arSelectedId_ }, { method: "POST" }),
      callAPI({ action: "list_ar_adjustment_by_ar", ar_id: arSelectedId_ }, { method: "POST" })
    ]);
    const pays = Array.isArray(payR?.data) ? payR.data : [];
    const adjs = Array.isArray(adjR?.data) ? adjR.data : [];
    arHasAdjustments_ = adjs.length > 0;

    if (payBody) {
      const canEditPay = arCanOperate_();
      payBody.innerHTML = pays.length
        ? pays
            .map(function (p) {
              const pid = String(p.payment_id || "");
              const voided = arIsPaymentVoided_(p);
              const editBtn =
                canEditPay && !voided
                  ? ' <button class="btn-secondary btn-sm" type="button" onclick="arStartEditPayment_(arPaymentsById_[\'' +
                    pid.replace(/'/g, "\\'") +
                    "'])\">修改</button>"
                  : "";
              const voidBtn =
                canEditPay && !voided
                  ? ' <button class="btn-secondary btn-sm" type="button" style="color:#b42318;border-color:#fecdca;" onclick="arVoidPayment_(arPaymentsById_[\'' +
                    pid.replace(/'/g, "\\'") +
                    "'], this)\">作廢</button>"
                  : "";
              const rowStyle = voided ? ' style="background:#f8fafc;color:#64748b;"' : "";
              return (
                "<tr" +
                rowStyle +
                "><td class=\"logs-stack-cell\">" +
                arFormatPaymentDateCell_(p) +
                "</td><td class=\"logs-stack-cell\">" +
                arFormatPaymentAmountCell_(p) +
                "</td><td>" +
                arFormatPaymentBankCell_(p) +
                "</td><td>" +
                arEsc_(typeof erpDisplayOperatorName_ === "function" ? erpDisplayOperatorName_(p.created_by) : p.created_by || "") +
                "</td><td>" +
                arFormatPaymentRemarkCell_(p) +
                "</td><td>" +
                editBtn +
                voidBtn +
                "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="6" class="text-muted">尚無收款</td></tr>';
      arPaymentsById_ = {};
      pays.forEach(function (p) {
        arPaymentsById_[String(p.payment_id || "").trim().toUpperCase()] = p;
      });
    }
    if (adjBody) {
      adjBody.innerHTML = adjs.length
        ? adjs.map(function (a) {
            return (
              "<tr><td>" + arEsc_(erpFormatListDateTime_(a.adjusted_at)) + "</td><td>" +
              arEsc_(arFmtMoney_(a.amount_before)) + "</td><td>" + arEsc_(arFmtMoney_(a.amount_after)) + "</td><td>" +
              arEsc_(a.reason) + "</td><td>" + arEsc_(typeof erpDisplayOperatorName_ === "function" ? erpDisplayOperatorName_(a.adjusted_by) : (a.adjusted_by || "")) + "</td></tr>"
            );
          }).join("")
        : '<tr><td colspan="5" class="text-muted">尚無調整紀錄</td></tr>';
    }
    if (row) arUpdateExceptionUi_(row, adjs.length);
    arApplyPermissions_();
  } catch (_e) {}
}

async function arVoidPayment_(payment, triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  if (!payment || !arSelectedId_) return showToast("請先選擇 AR", "error");
  const paymentId = String(payment.payment_id || "").trim().toUpperCase();
  if (!paymentId) return showToast("找不到收款紀錄", "error");
  const amount = arFmtMoney_(payment.amount);
  const date = String(payment.payment_date || "").slice(0, 10) || "—";
  const msg =
    "確定作廢這筆收款？\n\n日期：" +
    date +
    "\n金額：" +
    amount +
    "\n\n作廢後會保留紀錄（標示已作廢），並重算本 AR 的已收／狀態。";
  if (!confirm(msg)) return;

  showSaveHint(triggerEl);
  try {
    await callAPI(
      {
        action: "void_ar_payment_bundle",
        payment_id: paymentId,
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    if (String(arEditPaymentId_ || "").trim().toUpperCase() === paymentId) {
      arClearPaymentForm_();
    }
    showToast("收款已作廢", "success");
    await arReloadList_();
    await arSelect_(arSelectedId_);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢收款失敗", "error");
  } finally {
    hideSaveHint();
  }
}

async function arRegisterPayment_(triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  if (!arSelectedId_) return showToast("請先選擇 AR", "error");
  const amountInput = Number(document.getElementById("ar_pay_amount")?.value || 0);
  const paymentDate = String(document.getElementById("ar_pay_date")?.value || "").trim();
  if (!paymentDate) return showToast("請填收款日", "error");

  const editingId = String(arEditPaymentId_ || "").trim().toUpperCase();
  let amount = amountInput;
  if (editingId && arHasAdjustments_) {
    const orig = arPaymentsById_[editingId];
    amount = Number(orig?.amount || 0);
    if (!(amount > 0)) return showToast("無法讀取原收款金額", "error");
  } else if (!(amount > 0)) {
    return showToast("收款金額須 > 0", "error");
  }
  const remark = arBuildPaymentRemarkFromFields_(arReadSinglePaymentFields_());
  const gapCode = editingId ? "" : String(document.getElementById("ar_pay_gap_writeoff")?.value || "").trim().toUpperCase();
  if (!editingId && gapCode) {
    const gap = arComputeGapAfterNewPayment_(amount);
    if (!(gap > 1e-9)) return showToast("登記後無差額，不需沖銷", "error");
    if (gap > AR_GAP_WRITEOFF_MAX_ + 1e-9) {
      return showToast("差額超過 " + AR_GAP_WRITEOFF_MAX_ + "，請用例外處理", "error");
    }
    const label = arGapWriteoffLabel_(gapCode);
    if (!label) return showToast("請選擇有效的沖銷差額原因", "error");
    const msg =
      "登記後未收 " +
      arFmtMoney_(gap) +
      " 將以「" +
      label +
      "」沖銷並結案。\n\n確定登記收款？";
    if (!confirm(msg)) return;
  }
  showSaveHint(triggerEl);
  try {
    if (editingId) {
      await callAPI(
        {
          action: "update_ar_payment_bundle",
          payment_id: editingId,
          payment_date: paymentDate,
          amount: amount,
          remark: remark,
          updated_by: getCurrentUser()
        },
        { method: "POST" }
      );
      showToast("收款已修改", "success");
    } else {
      await callAPI(
        {
          action: "register_ar_payment_bundle",
          ar_id: arSelectedId_,
          payment_date: paymentDate,
          amount: amount,
          remark: remark,
          gap_writeoff_code: gapCode || undefined,
          created_by: getCurrentUser()
        },
        { method: "POST" }
      );
      showToast(gapCode ? "收款已登記並沖銷差額結案" : "收款已登記", "success");
    }
    arClearPaymentForm_();
    await arReloadList_();
    await arSelect_(arSelectedId_);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast(editingId ? "修改失敗" : "登記失敗", "error");
  } finally {
    hideSaveHint();
  }
}

async function arAdjustAmount_(triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  if (!arSelectedId_) return showToast("請先選擇 AR", "error");
  const amountDue = Number(document.getElementById("ar_adjust_due")?.value || 0);
  const reasonPack = arCollectReason_("adjust");
  if (reasonPack.err) return showToast(reasonPack.err, "error");
  const reason = reasonPack.reason;
  if (amountDue < 0) return showToast("應收金額不可小於 0", "error");

  const guard = arValidateAdjust_(amountDue, reasonPack.code);
  if (guard.err) {
    if (guard.err !== "CANCELLED") showToast(guard.err, "error");
    return;
  }

  showSaveHint(triggerEl);
  try {
    const payload = {
      action: "adjust_ar_amount_bundle",
      ar_id: arSelectedId_,
      amount_due: amountDue,
      reason: reason,
      reason_code: reasonPack.code,
      updated_by: getCurrentUser()
    };
    if (guard.confirmReopenAfterForce) payload.confirm_reopen_after_force = "YES";
    await callAPI(payload, { method: "POST" });
    showToast("應收金額已調整", "success");
    arResetReasonForm_("adjust");
    arCollapseExceptionCard_();
    await arReloadList_();
    await arSelect_(arSelectedId_);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("調整失敗", "error");
  } finally {
    hideSaveHint();
  }
}

async function arForceClose_(triggerEl) {
  if (!arCanOperate_()) return showToast("僅會計／CEO／GA／ADMIN 可操作", "error");
  if (!arSelectedId_) return showToast("請先選擇 AR", "error");
  const reasonPack = arCollectReason_("force");
  if (reasonPack.err) return showToast(reasonPack.err, "error");
  const reason = reasonPack.reason;
  if (!confirm("確定手動沖銷結案？差額將保留在紀錄中。")) return;

  showSaveHint(triggerEl);
  try {
    await callAPI(
      {
        action: "force_close_ar_bundle",
        ar_id: arSelectedId_,
        close_reason: reason,
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("已手動沖銷結案", "success");
    arResetReasonForm_("force");
    arCollapseExceptionCard_();
    await arReloadList_();
    await arSelect_(arSelectedId_);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("手動沖銷結案失敗", "error");
  } finally {
    hideSaveHint();
  }
}

try {
  window.arInit = arInit;
  window.arReloadList_ = arReloadList_;
  window.arSelect_ = arSelect_;
  window.arRegisterPayment_ = arRegisterPayment_;
  window.arVoidPayment_ = arVoidPayment_;
  window.arStartEditPayment_ = arStartEditPayment_;
  window.arCancelEditPayment_ = arCancelEditPayment_;
  window.arAdjustAmount_ = arAdjustAmount_;
  window.arForceClose_ = arForceClose_;
  window.arOnReasonCodeChange_ = arOnReasonCodeChange_;
  window.arToggleExceptionCard_ = arToggleExceptionCard_;
  window.arCollapseExceptionCard_ = arCollapseExceptionCard_;
  window.arOnGapWriteoffChange_ = arOnGapWriteoffChange_;
  window.arBatchToggle_ = arBatchToggle_;
  window.arBatchSelectAllOpen_ = arBatchSelectAllOpen_;
  window.arBatchSelectThisMonthOpen_ = arBatchSelectThisMonthOpen_;
  window.arBatchClearSelection_ = arBatchClearSelection_;
  window.arApplyListFilters_ = arApplyListFilters_;
  window.arClearDateFilter_ = arClearDateFilter_;
  window.arComputeBatchAllocation_ = arComputeBatchAllocation_;
  window.arToggleCustomerGroup_ = arToggleCustomerGroup_;
  window.arBatchToggleCustomer_ = arBatchToggleCustomer_;
  window.arUpdateBatchPreview_ = arUpdateBatchPreview_;
  window.arSubmitBatchPayment_ = arSubmitBatchPayment_;
  window.arToggleViewMode_ = arToggleViewMode_;
  window.arSelectBatch_ = arSelectBatch_;
  window.arVoidBatchPayment_ = arVoidBatchPayment_;
  window.arOpenArFromBatch_ = arOpenArFromBatch_;
} catch (_e) {}
