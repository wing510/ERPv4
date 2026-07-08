/*********************************
 * Consignment 寄賣 · 案件 v4.2.2
 *********************************/

var ccSelectedCaseId_ = "";
var ccSelectedCaseMeta_ = null;
var ccCaseRows_ = [];

function ccApplyCasePermissions_() {
  const ok = ccCanOperate_();
  const btn = document.getElementById("cc_create_btn");
  if (btn) btn.disabled = !ok;
}

function ccIsNewCasePanelOpen_() {
  const panel = document.getElementById("cc_new_case_panel");
  return !!(panel && panel.style.display !== "none");
}

function ccSyncNewCaseToggleBtn_() {
  const btn = document.getElementById("cc_toggle_new_case_btn");
  if (!btn) return;
  btn.textContent = ccIsNewCasePanelOpen_() ? "收起開案" : "開新寄賣案";
}

function ccToggleNewCasePanel_(forceOpen) {
  const panel = document.getElementById("cc_new_case_panel");
  if (!panel) return;
  const open = forceOpen === true ? true : forceOpen === false ? false : !ccIsNewCasePanelOpen_();
  panel.style.display = open ? "" : "none";
  ccSyncNewCaseToggleBtn_();
  if (open) {
    const cust = document.getElementById("cc_new_customer_id");
    if (cust) cust.focus();
    if (typeof scrollToEditorTop === "function") scrollToEditorTop();
  }
}

function ccRefreshNewCaseId_() {
  if (typeof erpInitAutoId_ === "function") {
    erpInitAutoId_("cc_new_case_id", {
      gen: function () {
        return typeof generateShortId === "function" ? generateShortId("CC") : "";
      },
      force: true
    });
    return;
  }
  const el = document.getElementById("cc_new_case_id");
  if (el && typeof generateShortId === "function") el.value = generateShortId("CC");
}

function ccClearNewCaseForm_() {
  const cust = document.getElementById("cc_new_customer_id");
  const remark = document.getElementById("cc_new_remark");
  const openDate = document.getElementById("cc_new_open_date");
  if (cust) cust.value = "";
  if (remark) remark.value = "";
  if (openDate) openDate.value = ccTodayYmd_();
  ccRefreshNewCaseId_();
  if (cust) cust.focus();
}

function ccInitCustomerDropdown_() {
  const sel = document.getElementById("cc_new_customer_id");
  if (!sel) return;
  const rows = Object.values(ccCustomers_ || {}).slice();
  rows.sort(function (a, b) {
    return String(a.customer_name || a.customer_id || "").localeCompare(String(b.customer_name || b.customer_id || ""));
  });
  sel.innerHTML =
    '<option value="">請選擇</option>' +
    rows
      .map(function (c) {
        const id = String(c.customer_id || "").trim();
        const name = String(c.customer_name || id).trim();
        return '<option value="' + ccEsc_(id) + '">' + ccEsc_(name + " (" + id + ")") + "</option>";
      })
      .join("");
}

function ccSyncCaseListRowHighlight_() {
  const sel = String(ccSelectedCaseId_ || "").trim().toUpperCase();
  document.querySelectorAll("#cc_case_tbody tr.cc-case-row").forEach(function (tr) {
    const rid = String(tr.getAttribute("data-case-id") || "").trim().toUpperCase();
    const on = !!sel && rid === sel;
    tr.classList.toggle("erp-list-row-open", on);
    tr.setAttribute("aria-expanded", on ? "true" : "false");
  });
}

function ccScrollToCaseDetail_() {
  const card = document.getElementById("cc_detail_card");
  if (!card || card.style.display === "none") return;
  try {
    const content = document.getElementById("content");
    if (content && typeof content.scrollTo === "function") {
      content.scrollTo({ top: Math.max(0, card.offsetTop - 12), behavior: "smooth" });
      return;
    }
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (_e) {
    try {
      card.scrollIntoView();
    } catch (_e2) {}
  }
}

function ccCloseCaseDetail_() {
  ccSelectedCaseId_ = "";
  ccSelectedCaseMeta_ = null;
  const card = document.getElementById("cc_detail_card");
  if (card) card.style.display = "none";
  ccSyncCaseListRowHighlight_();
}

function ccToggleCaseRow_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return;
  const card = document.getElementById("cc_detail_card");
  const open = card && card.style.display !== "none" && ccSelectedCaseId_ === id;
  if (open) {
    ccCloseCaseDetail_();
    return;
  }
  ccSelectCase_(id);
}

function ccRenderCaseList_() {
  const body = document.getElementById("cc_case_tbody");
  if (!body) return;
  const rows = ccCaseRows_ || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">尚無寄賣案</td></tr>';
    return;
  }
  const selId = String(ccSelectedCaseId_ || "").trim().toUpperCase();
  body.innerHTML = rows
    .map(function (c) {
      const id = String(c.case_id || "").trim().toUpperCase();
      const cust = ccCustomerDisplayName_(c);
      const st = ccCaseStatusLabel_(c.status);
      const caseClosed = String(c.status || "").trim().toUpperCase() === "CLOSED";
      let stCell = ccEsc_(st);
      if (caseClosed && ccCaseFinanceOpen_(c)) {
        stCell +=
          ' <span style="font-size:11px;color:#b45309;font-weight:600;white-space:nowrap;">財務未結清</span>';
      }
      const amtCell = ccFmtReceivedNetPct_(c);
      const safeId = id.replace(/'/g, "\\'");
      const open = selId === id;
      return (
        '<tr class="cc-case-row erp-list-row-selectable' +
        (open ? " erp-list-row-open" : "") +
        '" data-case-id="' +
        ccEsc_(id) +
        '" onclick="ccToggleCaseRow_(\'' +
        safeId +
        '\')" aria-expanded="' +
        (open ? "true" : "false") +
        '">' +
        "<td>" +
        ccEsc_(id) +
        "</td>" +
        "<td>" +
        ccEsc_(cust) +
        "</td>" +
        "<td>" +
        ccEsc_(c.open_date || "—") +
        "</td>" +
        "<td>" +
        stCell +
        "</td>" +
        "<td>" +
        ccEsc_(amtCell) +
        "</td>" +
        "<td>" +
        ccEsc_(String(c.remark || "").trim() || "—") +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function ccRenderSummary_() {
  const box = document.getElementById("cc_summary_box");
  if (!box) return;
  const meta = ccSelectedCaseMeta_ || {};
  box.innerHTML = ccBuildCaseSummaryHtml_(meta, {});
}

function ccFormatPoolProductLotCell_(it) {
  const prod = ccEsc_(ccProductName_(it.product_id));
  const fl = ccEsc_(String(it.factory_lot || "").trim() || "—");
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' + prod + "</div>" +
    '<div class="cc-pool-stack-sub">' + fl + "</div>" +
    "</div>"
  );
}

function ccFormatPoolShipExpiryCell_(it) {
  const ship = ccEsc_(String(it.ship_date || "").trim() || "—");
  const expRaw = String(it.expiry_date || "").trim();
  const exp = expRaw ? ccEsc_(expRaw) : "未填";
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' + ship + "</div>" +
    '<div class="cc-pool-stack-sub">' + exp + "</div>" +
    "</div>"
  );
}

function ccRenderPoolTable_(items) {
  const body = document.getElementById("cc_pool_tbody");
  if (!body) return;
  const rows = items || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="text-muted">尚無品項（請先在出貨管理完成寄賣出貨）</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(function (it) {
      const rem = Number(it.unsold_qty != null ? it.unsold_qty : it.remaining_qty || 0);
      return (
        "<tr>" +
        "<td>" + ccFormatPoolProductLotCell_(it) + "</td>" +
        "<td>" + ccFormatPoolShipExpiryCell_(it) + "</td>" +
        "<td>" + ccEsc_(String(it.ship_qty || 0)) + "</td>" +
        "<td>" + ccEsc_(String(it.settled_qty || 0)) + "</td>" +
        "<td>" + ccEsc_(String(it.returned_qty || 0)) + "</td>" +
        "<td>" + ccEsc_(String(Math.round(rem * 1000) / 1000)) + "</td>" +
        "<td>" + ccEsc_(ccPoolUnit_(it)) + "</td>" +
        "<td>" + ccEsc_(ccFmtMoney_(it.unit_price)) + "</td>" +
        "</tr>"
      );
    })
    .join("");
}

async function ccReloadCaseList_() {
  const body = document.getElementById("cc_case_tbody");
  if (body) body.innerHTML = '<tr><td colspan="6" class="text-muted">載入中…</td></tr>';
  const status = String(document.getElementById("cc_filter_status")?.value || "OPEN");
  try {
    ccCaseRows_ = await ccListCases_({ status: status });
    ccRenderCaseList_();
    const sel = String(ccSelectedCaseId_ || "").trim().toUpperCase();
    if (
      sel &&
      !(ccCaseRows_ || []).some(function (c) {
        return String(c.case_id || "").trim().toUpperCase() === sel;
      })
    ) {
      ccCloseCaseDetail_();
    }
  } catch (_e) {
    if (body) body.innerHTML = '<tr><td colspan="6" class="text-muted">載入失敗</td></tr>';
  }
}

async function ccSelectCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return;
  ccSelectedCaseId_ = id;
  ccSetActiveCaseId_(id);

  try {
    ccSelectedCaseMeta_ = (await ccEnsureEnrichedCase_(id, { force: true })) || null;
  } catch (_e) {
    ccSelectedCaseMeta_ = null;
  }

  const card = document.getElementById("cc_detail_card");
  const title = document.getElementById("cc_detail_title");
  if (title) title.textContent = id;
  if (card) card.style.display = "";

  ccRenderSummary_();

  const poolBody = document.getElementById("cc_pool_tbody");
  if (poolBody) poolBody.innerHTML = '<tr><td colspan="8" class="text-muted">載入中…</td></tr>';
  try {
    const [pool, stls, rets] = await Promise.all([
      ccListPool_(id),
      ccListSettlements_(id),
      ccListReturns_(id)
    ]);
    ccRenderPoolTable_(pool);
    ccRenderHistoryTableHtml_(stls, rets, "cc_history_tbody", { caseDetail: true });
  } catch (_e) {
    if (poolBody) poolBody.innerHTML = '<tr><td colspan="8" class="text-muted">載入失敗</td></tr>';
    const hist = document.getElementById("cc_history_tbody");
    if (hist) hist.innerHTML = '<tr><td colspan="5" class="text-muted">載入失敗</td></tr>';
  }

  ccSyncCaseListRowHighlight_();
  ccScrollToCaseDetail_();
}

function ccGoSettlementFromDetail_() {
  if (!ccSelectedCaseId_) return showToast("請先選擇案件", "error");
  ccGoSettlement_(ccSelectedCaseId_);
}

function ccGoReturnFromDetail_() {
  if (!ccSelectedCaseId_) return showToast("請先選擇案件", "error");
  ccGoReturn_(ccSelectedCaseId_);
}

async function ccCreateCaseSubmit_(triggerEl) {
  if (!ccCanOperate_()) return showToast("您沒有權限開案（須會計／CEO／GA／ADMIN）", "error");

  const caseId = String(document.getElementById("cc_new_case_id")?.value || "").trim().toUpperCase();
  if (!caseId && typeof erpInitAutoId_ === "function") {
    erpInitAutoId_("cc_new_case_id", "master", "CC");
  }
  const resolvedCaseId = String(document.getElementById("cc_new_case_id")?.value || "").trim().toUpperCase();
  const customerId = String(document.getElementById("cc_new_customer_id")?.value || "").trim();
  const openDate = String(document.getElementById("cc_new_open_date")?.value || "").trim();
  const remark = String(document.getElementById("cc_new_remark")?.value || "").trim();

  if (!customerId) return showToast("請選擇客戶", "error");
  if (!openDate) return showToast("請填開案日", "error");

  if (triggerEl) triggerEl.disabled = true;
  try {
    const payload = {
      customer_id: customerId,
      open_date: openDate,
      remark: remark,
      created_by: getCurrentUser()
    };
    if (resolvedCaseId) payload.case_id = resolvedCaseId;

    const r = await ccCreateCase_(payload);
    const newId = String(r?.case_id || resolvedCaseId || "").trim().toUpperCase();
    showToast("寄賣案已建立：" + (newId || "—"), "success", 5000);

    if (typeof erpInitAutoId_ === "function") {
      erpInitAutoId_("cc_new_case_id", { gen: function () { return typeof generateShortId === "function" ? generateShortId("CC") : ""; }, force: true });
    } else {
      ccRefreshNewCaseId_();
    }
    document.getElementById("cc_new_remark").value = "";

    ccToggleNewCasePanel_(false);
    await ccReloadCaseList_();
    if (newId) await ccSelectCase_(newId);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("開案失敗：請稍後重試", "error");
  } finally {
    if (triggerEl) triggerEl.disabled = !ccCanOperate_();
  }
}

async function consignmentCaseInit() {
  ccApplyCasePermissions_();
  await ccLoadMasterData_();
  ccInitCustomerDropdown_();

  const dt = document.getElementById("cc_new_open_date");
  if (dt && !dt.value) dt.value = ccTodayYmd_();

  if (typeof erpInitAutoId_ === "function") {
    erpInitAutoId_("cc_new_case_id", { gen: function () { return typeof generateShortId === "function" ? generateShortId("CC") : ""; }, force: true });
  } else {
    ccRefreshNewCaseId_();
  }

  ccSyncNewCaseToggleBtn_();
  ccSelectedCaseId_ = "";
  ccSelectedCaseMeta_ = null;
  await ccReloadCaseList_();
}
