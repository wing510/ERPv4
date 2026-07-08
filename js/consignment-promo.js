/*********************************
 * Consignment 寄賣 · 促銷方案 v4.2.3
 *********************************/

var ccPromoEditing_ = false;
var ccPromoSettlementLocked_ = false;
var ccPromoLineSeq_ = 0;
var ccPromoListRows_ = [];
var ccPromoSelectedSchemeId_ = "";
var ccPromoSort_ = { field: "", asc: true };
/** 寄賣案 ID → 客戶 ID（列表客戶篩選用） */
var ccPromoCaseCustomerMap_ = {};
/** 寄賣案 ID → 客戶名稱（列表範圍欄顯示用） */
var ccPromoCaseCustomerNameMap_ = {};

function ccPromoSyncListRowHighlight_() {
  const sel = String(ccPromoSelectedSchemeId_ || "").trim().toUpperCase();
  document.querySelectorAll("#cc_promo_list_tbody tr[data-scheme-id]").forEach(function (tr) {
    const id = String(tr.getAttribute("data-scheme-id") || "").trim().toUpperCase();
    tr.classList.toggle("erp-list-row-open", id === sel);
  });
}

function ccPromoOnScopeChange_() {
  const scope = String(document.getElementById("cc_promo_scope_type")?.value || "CUSTOMER").trim().toUpperCase();
  const custGrp = document.getElementById("cc_promo_customer_group");
  const caseGrp = document.getElementById("cc_promo_case_group");
  if (custGrp) custGrp.style.display = scope === "CUSTOMER" ? "" : "none";
  if (caseGrp) caseGrp.style.display = scope === "CASE" ? "" : "none";
}

function ccPromoOnChannelChange_() {
  const channel = String(document.getElementById("cc_promo_channel")?.value || "CONSIGNMENT").trim().toUpperCase();
  const scopeEl = document.getElementById("cc_promo_scope_type");
  const caseOpt = scopeEl?.querySelector('option[value="CASE"]');
  if (caseOpt) caseOpt.disabled = channel === "GENERAL";
  if (channel === "GENERAL" && String(scopeEl?.value || "").trim().toUpperCase() === "CASE") {
    if (scopeEl) scopeEl.value = "CUSTOMER";
  }
  ccPromoOnScopeChange_();
  const hint = document.getElementById("ccPromoStatusHint");
  if (hint && !ccPromoSettlementLocked_) {
    hint.textContent =
      channel === "GENERAL"
        ? "於一般出貨過帳套用"
        : channel === "ALL"
          ? "寄賣結算＋一般出貨過帳皆可套用"
          : "於寄賣結算套用";
  }
}

function ccPromoSetButtons_() {
  const createBtn = document.getElementById("cc_promo_create_btn");
  const updateBtn = document.getElementById("cc_promo_update_btn");
  const endBtn = document.getElementById("cc_promo_end_btn");
  if (createBtn) createBtn.disabled = !!ccPromoEditing_;
  if (updateBtn) updateBtn.disabled = !ccPromoEditing_ || !!ccPromoSettlementLocked_;
  if (endBtn) {
    const st = String(document.getElementById("cc_promo_status")?.value || "").trim().toUpperCase();
    endBtn.style.display = ccPromoEditing_ && ccPromoSettlementLocked_ && st === "ACTIVE" ? "" : "none";
    endBtn.disabled = !(ccPromoEditing_ && ccPromoSettlementLocked_ && st === "ACTIVE");
    endBtn.title = "已有結算紀錄時，將方案改為結束且有效期迄改為今天（或指定日），之後結算不再套用";
  }
}

function ccPromoTodayYmd_() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function ccPromoApplySettlementLock_(locked) {
  ccPromoSettlementLocked_ = !!locked;
  const hint = document.getElementById("ccPromoStatusHint");
  if (hint) {
    hint.textContent = locked
      ? "已有結算紀錄，明細不可改；要停止套用請按「提前結束」"
      : "於寄賣結算套用";
    hint.style.color = locked ? "#b45309" : "#64748b";
  }
  ["cc_promo_name", "cc_promo_status", "cc_promo_date_from", "cc_promo_date_to", "cc_promo_channel", "cc_promo_price_basis", "cc_promo_scope_type", "cc_promo_customer_id", "cc_promo_case_id", "cc_promo_remark"].forEach(
    function (id) {
      const el = document.getElementById(id);
      if (el) el.disabled = locked;
    }
  );
  const addBtn = document.querySelector('button[onclick="ccPromoAddLine_()"]');
  if (addBtn) addBtn.disabled = locked;
  document.querySelectorAll("#cc_promo_lines_tbody input, #cc_promo_lines_tbody select, #cc_promo_lines_tbody button").forEach(function (el) {
    el.disabled = locked;
  });
  ccPromoSetButtons_();
}

function ccPromoInitNewId_(force) {
  if (ccPromoEditing_) return String(document.getElementById("cc_promo_id")?.value || "").trim().toUpperCase();
  if (typeof erpInitAutoId_ === "function") {
    return erpInitAutoId_("cc_promo_id", {
      gen: function () {
        return typeof ccNewPromoSchemeId_ === "function" ? ccNewPromoSchemeId_() : "";
      },
      force: !!force
    });
  }
  const el = document.getElementById("cc_promo_id");
  if (el && typeof ccNewPromoSchemeId_ === "function" && (!String(el.value || "").trim() || force)) {
    el.value = ccNewPromoSchemeId_();
  }
  return String(document.getElementById("cc_promo_id")?.value || "").trim().toUpperCase();
}

function ccPromoProductOptionsHtml_(selected) {
  const sel = String(selected || "").trim().toUpperCase();
  const products = Object.keys(ccProducts_ || {})
    .sort()
    .map(function (pid) {
      const label = ccProductName_(pid);
      const selectedAttr = pid === sel ? " selected" : "";
      return '<option value="' + ccEsc_(pid) + '"' + selectedAttr + ">" + ccEsc_(pid + " " + label) + "</option>";
    });
  return '<option value="">請選擇</option>' + products.join("");
}

function ccPromoLineRowHtml_(line) {
  const ln = line || {};
  const idx = ++ccPromoLineSeq_;
  const type = String(ln.promo_type || "DISCOUNT_PCT").trim().toUpperCase();
  return (
    '<tr data-line-idx="' +
    idx +
    '">' +
    '<td><select class="cc-promo-line-product" style="min-width:160px;">' +
    ccPromoProductOptionsHtml_(ln.product_id) +
    "</select></td>" +
    '<td><select class="cc-promo-line-type" onchange="ccPromoSyncLineFields_(this)">' +
    '<option value="FIXED_PRICE"' +
    (type === "FIXED_PRICE" ? " selected" : "") +
    ">固定促銷價</option>" +
    '<option value="DISCOUNT_PCT"' +
    (type === "DISCOUNT_PCT" ? " selected" : "") +
    ">折扣％</option>" +
    '<option value="BUY_N_GET_M"' +
    (type === "BUY_N_GET_M" ? " selected" : "") +
    ">買N送M</option>" +
    "</select></td>" +
    '<td><input type="number" class="cc-promo-line-fixed" min="0" step="0.01" value="' +
    ccEsc_(ln.promo_unit_price != null ? ln.promo_unit_price : "") +
    '" style="width:90px;"></td>' +
    '<td><input type="number" class="cc-promo-line-discount" min="1" max="100" step="0.1" value="' +
    ccEsc_(ln.discount_pct != null ? ln.discount_pct : "") +
    '" style="width:80px;"></td>' +
    '<td><input type="number" class="cc-promo-line-buy" min="1" step="1" value="' +
    ccEsc_(ln.buy_qty != null ? ln.buy_qty : "") +
    '" style="width:60px;"></td>' +
    '<td><input type="number" class="cc-promo-line-free" min="1" step="1" value="' +
    ccEsc_(ln.free_qty != null ? ln.free_qty : "") +
    '" style="width:60px;"></td>' +
    '<td><button type="button" class="btn-secondary btn-sm" onclick="ccPromoRemoveLine_(this)">刪除</button></td>' +
    "</tr>"
  );
}

function ccPromoSyncLineFields_(el) {
  const tr = el && el.closest ? el.closest("tr") : null;
  if (!tr) return;
  const type = String(tr.querySelector(".cc-promo-line-type")?.value || "").trim().toUpperCase();
  const fixed = tr.querySelector(".cc-promo-line-fixed");
  const disc = tr.querySelector(".cc-promo-line-discount");
  const buy = tr.querySelector(".cc-promo-line-buy");
  const free = tr.querySelector(".cc-promo-line-free");
  if (fixed) fixed.disabled = type !== "FIXED_PRICE";
  if (disc) disc.disabled = type !== "DISCOUNT_PCT";
  if (buy) buy.disabled = type !== "BUY_N_GET_M";
  if (free) free.disabled = type !== "BUY_N_GET_M";
}

function ccPromoSyncAllLineFields_() {
  document.querySelectorAll("#cc_promo_lines_tbody .cc-promo-line-type").forEach(function (sel) {
    ccPromoSyncLineFields_(sel);
  });
}

function ccPromoAddLine_(prefill) {
  const body = document.getElementById("cc_promo_lines_tbody");
  if (!body) return;
  if (!body.querySelector("tr")) body.innerHTML = "";
  body.insertAdjacentHTML("beforeend", ccPromoLineRowHtml_(prefill || { promo_type: "DISCOUNT_PCT", discount_pct: 90 }));
  ccPromoSyncAllLineFields_();
}

function ccPromoRemoveLine_(btn) {
  const tr = btn && btn.closest ? btn.closest("tr") : null;
  if (tr) tr.remove();
  const body = document.getElementById("cc_promo_lines_tbody");
  if (body && !body.querySelector("tr")) {
    body.innerHTML = '<tr><td colspan="7" class="text-muted">請新增至少一筆明細</td></tr>';
  }
}

function ccPromoCollectLines_() {
  const rows = document.querySelectorAll("#cc_promo_lines_tbody tr[data-line-idx]");
  const out = [];
  rows.forEach(function (tr) {
    const productId = String(tr.querySelector(".cc-promo-line-product")?.value || "").trim().toUpperCase();
    const promoType = String(tr.querySelector(".cc-promo-line-type")?.value || "").trim().toUpperCase();
    if (!productId) return;
    const row = { product_id: productId, promo_type: promoType };
    if (promoType === "FIXED_PRICE") {
      row.promo_unit_price = Number(tr.querySelector(".cc-promo-line-fixed")?.value || 0);
    } else if (promoType === "DISCOUNT_PCT") {
      row.discount_pct = Number(tr.querySelector(".cc-promo-line-discount")?.value || 0);
    } else if (promoType === "BUY_N_GET_M") {
      row.buy_qty = Number(tr.querySelector(".cc-promo-line-buy")?.value || 0);
      row.free_qty = Number(tr.querySelector(".cc-promo-line-free")?.value || 0);
    }
    out.push(row);
  });
  return out;
}

function ccPromoClearForm_() {
  ccPromoEditing_ = false;
  ccPromoSelectedSchemeId_ = "";
  ccPromoSyncListRowHighlight_();
  ccPromoApplySettlementLock_(false);
  ["cc_promo_id", "cc_promo_name", "cc_promo_remark"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const st = document.getElementById("cc_promo_status");
  if (st) st.value = "ACTIVE";
  const scope = document.getElementById("cc_promo_scope_type");
  if (scope) scope.value = "CUSTOMER";
  const channel = document.getElementById("cc_promo_channel");
  if (channel) channel.value = "CONSIGNMENT";
  const priceBasis = document.getElementById("cc_promo_price_basis");
  if (priceBasis) priceBasis.value = "DEALER";
  ccPromoOnChannelChange_();
  const cust = document.getElementById("cc_promo_customer_id");
  if (cust) cust.value = "";
  const ccase = document.getElementById("cc_promo_case_id");
  if (ccase) ccase.value = "";
  const body = document.getElementById("cc_promo_lines_tbody");
  if (body) body.innerHTML = '<tr><td colspan="7" class="text-muted">請新增至少一筆明細</td></tr>';
  ccPromoInitNewId_(true);
}

async function ccPromoLoadScheme_(schemeId) {
  const sid = String(schemeId || "").trim().toUpperCase();
  if (
    ccPromoEditing_ &&
    typeof erpTryToggleCloseMasterListRow_ === "function" &&
    erpTryToggleCloseMasterListRow_(ccPromoSelectedSchemeId_, sid, "cc_promo_edit_card", ccPromoClearForm_)
  ) {
    return;
  }
  ccPromoSelectedSchemeId_ = sid;
  ccPromoSyncListRowHighlight_();
  const row = (ccPromoListRows_ || []).find(function (r) {
    return String(r.scheme_id || "").trim().toUpperCase() === sid;
  });
  if (!row) return showToast("找不到方案", "error");

  ccPromoEditing_ = true;
  ccPromoSetButtons_();
  const idEl = document.getElementById("cc_promo_id");
  if (idEl) idEl.value = sid;
  const nameEl = document.getElementById("cc_promo_name");
  if (nameEl) nameEl.value = String(row.scheme_name || "");
  const st = document.getElementById("cc_promo_status");
  if (st) st.value = String(row.status || "ACTIVE").toUpperCase();
  const df = document.getElementById("cc_promo_date_from");
  if (df) df.value = String(row.date_from || "").slice(0, 10);
  const dt = document.getElementById("cc_promo_date_to");
  if (dt) dt.value = String(row.date_to || "").slice(0, 10);
  const scope = document.getElementById("cc_promo_scope_type");
  if (scope) scope.value = String(row.scope_type || "CUSTOMER").toUpperCase();
  const channelEl = document.getElementById("cc_promo_channel");
  if (channelEl) {
    const ch = String(row.channel || "CONSIGNMENT").trim().toUpperCase();
    channelEl.value = ["CONSIGNMENT", "GENERAL", "ALL"].includes(ch) ? ch : "CONSIGNMENT";
  }
  const priceBasisEl = document.getElementById("cc_promo_price_basis");
  if (priceBasisEl) {
    const pb = String(row.price_basis || "DEALER").trim().toUpperCase();
    priceBasisEl.value = pb === "LIST" ? "LIST" : "DEALER";
  }
  ccPromoOnChannelChange_();
  const cust = document.getElementById("cc_promo_customer_id");
  if (cust) cust.value = String(row.customer_id || "").toUpperCase();
  const ccase = document.getElementById("cc_promo_case_id");
  if (ccase) ccase.value = String(row.case_id || "").toUpperCase();
  const rm = document.getElementById("cc_promo_remark");
  if (rm) rm.value = String(row.remark || "");

  const linesR = await callAPI({ action: "list_consignment_promo_scheme_line", scheme_id: sid }, { method: "GET" });
  const lines = (linesR?.data || []).filter(function (ln) {
    return String(ln.scheme_id || "").trim().toUpperCase() === sid;
  });
  const body = document.getElementById("cc_promo_lines_tbody");
  if (body) {
    body.innerHTML = "";
    if (!lines.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-muted">請新增至少一筆明細</td></tr>';
    } else {
      lines
        .sort(function (a, b) {
          return Number(a.sort_order || 0) - Number(b.sort_order || 0);
        })
        .forEach(function (ln) {
          ccPromoAddLine_(ln);
        });
    }
  }
  ccPromoSyncAllLineFields_();
  ccPromoApplySettlementLock_(!!row.has_settlement);
  if (typeof showMasterEditCard_ === "function") showMasterEditCard_("cc_promo_edit_card");
  if (typeof scrollToMasterForm_ === "function") scrollToMasterForm_("cc_promo_edit_card");
}

async function ccPromoEndEarly_(triggerEl) {
  if (!ccCanOperate_()) return showToast("您沒有權限維護促銷方案", "error");
  if (!ccPromoEditing_ || !ccPromoSettlementLocked_) return showToast("請先載入已結算的方案", "error");
  const schemeId = String(document.getElementById("cc_promo_id")?.value || "").trim().toUpperCase();
  if (!schemeId) return showToast("請先載入方案", "error");
  const st = String(document.getElementById("cc_promo_status")?.value || "").trim().toUpperCase();
  if (st === "ENDED") return showToast("方案已是結束狀態", "warn");

  const okGo = window.confirm
    ? window.confirm(
        "確定提前結束方案「" +
          schemeId +
          "」？\n\n• 狀態改為「結束」\n• 有效期迄改為今天（若原本較晚）\n• 已結算紀錄與快照保留\n• 之後新結算不再套用此方案"
      )
    : true;
  if (!okGo) return;

  if (typeof showSaveHint === "function") showSaveHint(triggerEl);
  try {
    const res = await ccEndPromoScheme_({
      scheme_id: schemeId,
      end_date: ccPromoTodayYmd_(),
      updated_by: getCurrentUser(),
      created_by: getCurrentUser()
    });
    showToast("方案已提前結束", "success");
    await ccPromoRenderList_(true);
    const sid = String(res?.scheme_id || schemeId).trim().toUpperCase();
    if (sid) await ccPromoLoadScheme_(sid);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("提前結束失敗", "error");
  } finally {
    if (typeof hideSaveHint === "function") hideSaveHint();
  }
}

async function ccPromoSave_(isUpdate) {
  if (!ccCanOperate_()) return showToast("您沒有權限維護促銷方案", "error");

  const schemeId = String(document.getElementById("cc_promo_id")?.value || "").trim().toUpperCase() || ccPromoInitNewId_(true);
  const schemeName = String(document.getElementById("cc_promo_name")?.value || "").trim();
  const status = String(document.getElementById("cc_promo_status")?.value || "ACTIVE").trim().toUpperCase();
  const dateFrom = String(document.getElementById("cc_promo_date_from")?.value || "").trim();
  const dateTo = String(document.getElementById("cc_promo_date_to")?.value || "").trim();
  const scopeType = String(document.getElementById("cc_promo_scope_type")?.value || "CUSTOMER").trim().toUpperCase();
  const channel = String(document.getElementById("cc_promo_channel")?.value || "CONSIGNMENT").trim().toUpperCase();
  const priceBasis = String(document.getElementById("cc_promo_price_basis")?.value || "DEALER").trim().toUpperCase();
  const customerId = String(document.getElementById("cc_promo_customer_id")?.value || "").trim().toUpperCase();
  const caseId = String(document.getElementById("cc_promo_case_id")?.value || "").trim().toUpperCase();
  const remark = String(document.getElementById("cc_promo_remark")?.value || "").trim();
  const lines = ccPromoCollectLines_();

  if (!schemeName) return showToast("請填方案名稱", "error");
  if (!dateFrom || !dateTo) return showToast("請填有效期", "error");
  if (!lines.length) return showToast("請至少一筆明細", "error");
  if (scopeType === "CUSTOMER" && !customerId) return showToast("請選客戶", "error");
  if (scopeType === "CASE" && !caseId) return showToast("請選寄賣案", "error");
  if (channel === "GENERAL" && scopeType === "CASE") return showToast("一般管道不可選寄賣案範圍", "error");
  if (isUpdate && !schemeId) return showToast("請先載入方案", "error");
  if (isUpdate && ccPromoSettlementLocked_) return showToast("已有結算紀錄，請用「提前結束」停止套用", "error");

  try {
    await ccSavePromoScheme_({
      scheme_id: schemeId,
      scheme_name: schemeName,
      status: status,
      date_from: dateFrom,
      date_to: dateTo,
      scope_type: scopeType,
      channel: channel,
      price_basis: priceBasis === "LIST" ? "LIST" : "DEALER",
      customer_id: customerId,
      case_id: caseId,
      remark: remark,
      lines_json: JSON.stringify(lines),
      created_by: getCurrentUser(),
      updated_by: getCurrentUser()
    });
    showToast(isUpdate ? "方案已更新" : "方案已建立", "success");
    await ccPromoRenderList_(true);
    if (!isUpdate) ccPromoClearForm_();
    else ccPromoEditing_ = true;
    ccPromoSetButtons_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("儲存失敗", "error");
  }
}

function ccPromoSchemeMatchesCustomerFilter_(row, customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return true;
  const scope = String(row?.scope_type || "").trim().toUpperCase();
  if (scope === "GLOBAL") return true;
  if (scope === "CUSTOMER") {
    return String(row.customer_id || "").trim().toUpperCase() === cid;
  }
  if (scope === "CASE") {
    const caseId = String(row.case_id || "").trim().toUpperCase();
    return String(ccPromoCaseCustomerMap_[caseId] || "").trim().toUpperCase() === cid;
  }
  return false;
}

function ccPromoRenderCustomerFilterOptions_(selectedId) {
  const sel = String(selectedId || "").trim().toUpperCase();
  const ids = Object.keys(ccCustomers_ || {}).sort();
  let html = '<option value="">全部客戶</option>';
  if (!ids.length) return html;
  html += ids
    .map(function (cid) {
      const label = ccCustomerName_(cid);
      const selected = cid === sel ? " selected" : "";
      return '<option value="' + ccEsc_(cid) + '"' + selected + ">" + ccEsc_(cid + " " + label) + "</option>";
    })
    .join("");
  return html;
}

function ccPromoRefreshCaseCustomerMap_(cases) {
  ccPromoCaseCustomerMap_ = {};
  ccPromoCaseCustomerNameMap_ = {};
  (cases || []).forEach(function (c) {
    const caseId = String(c.case_id || "").trim().toUpperCase();
    const cust = String(c.customer_id || "").trim().toUpperCase();
    if (caseId && cust) ccPromoCaseCustomerMap_[caseId] = cust;
    if (caseId) {
      const name = ccCustomerDisplayName_(c);
      if (name && name !== "—") ccPromoCaseCustomerNameMap_[caseId] = name;
    }
  });
}

function ccPromoCaseScopeDisplayName_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return "—";
  const fromCase = String(ccPromoCaseCustomerNameMap_[id] || "").trim();
  if (fromCase) return fromCase;
  const custId = String(ccPromoCaseCustomerMap_[id] || "").trim().toUpperCase();
  if (custId) {
    const fromCust = String(ccCustomerName_(custId) || "").trim();
    if (fromCust && fromCust !== "—") return fromCust;
  }
  return id;
}

function ccPromoScopeLabel_(row) {
  const scope = String(row.scope_type || "").trim().toUpperCase();
  const base = CC_PROMO_SCOPE_LABELS_[scope] || scope;
  if (scope === "CUSTOMER") return base + "：" + ccCustomerName_(row.customer_id);
  if (scope === "CASE") return base + "：" + ccPromoCaseScopeDisplayName_(row.case_id);
  return base;
}

function ccPromoFilterRows_(rows) {
  const kw = String(document.getElementById("search_cc_promo_keyword")?.value || "")
    .trim()
    .toUpperCase();
  const st = String(document.getElementById("search_cc_promo_status")?.value || "")
    .trim()
    .toUpperCase();
  const custFilter = String(document.getElementById("search_cc_promo_customer_id")?.value || "")
    .trim()
    .toUpperCase();
  let list = (rows || []).slice();
  if (custFilter) {
    list = list.filter(function (r) {
      return ccPromoSchemeMatchesCustomerFilter_(r, custFilter);
    });
  }
  if (st) {
    list = list.filter(function (r) {
      return String(r.status || "").trim().toUpperCase() === st;
    });
  }
  if (kw) {
    list = list.filter(function (r) {
      const id = String(r.scheme_id || "").trim().toUpperCase();
      const name = String(r.scheme_name || "").trim().toUpperCase();
      return id.includes(kw) || name.includes(kw);
    });
  }
  if (ccPromoSort_.field) {
    const field = ccPromoSort_.field;
    const asc = !!ccPromoSort_.asc;
    list.sort(function (a, b) {
      let va = a[field];
      let vb = b[field];
      if (field === "line_count") {
        va = Number(va || 0);
        vb = Number(vb || 0);
      } else {
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
      }
      if (va > vb) return asc ? 1 : -1;
      if (va < vb) return asc ? -1 : 1;
      return 0;
    });
  }
  return list;
}

function ccPromoSort_(field) {
  if (ccPromoSort_.field === field) ccPromoSort_.asc = !ccPromoSort_.asc;
  else {
    ccPromoSort_.field = field;
    ccPromoSort_.asc = true;
  }
  ccPromoRenderList_();
}

async function ccPromoResetSearch_() {
  const kw = document.getElementById("search_cc_promo_keyword");
  if (kw) kw.value = "";
  const cust = document.getElementById("search_cc_promo_customer_id");
  if (cust) cust.value = "";
  const st = document.getElementById("search_cc_promo_status");
  if (st) st.value = "ACTIVE";
  await ccPromoRenderList_();
  if (typeof resetMasterListView_ === "function") resetMasterListView_("cc_promo_edit_card", ccPromoClearForm_);
}

async function ccPromoRenderList_(refetch) {
  const body = document.getElementById("cc_promo_list_tbody");
  if (!body) return;
  body.innerHTML = '<tr><td colspan="7" class="text-muted">載入中…</td></tr>';
  try {
    if (refetch || !(ccPromoListRows_ || []).length) ccPromoListRows_ = await ccListPromoSchemes_();
    const rows = ccPromoFilterRows_(ccPromoListRows_ || []);
    if (!rows.length) {
      const custFilter = String(document.getElementById("search_cc_promo_customer_id")?.value || "").trim();
      const emptyMsg = custFilter
        ? "此客戶查無符合條件的促銷方案（含全站方案）"
        : "查無符合條件的促銷方案";
      body.innerHTML = '<tr><td colspan="7" class="text-muted">' + ccEsc_(emptyMsg) + "</td></tr>";
      return;
    }
    const sel = String(ccPromoSelectedSchemeId_ || "").trim().toUpperCase();
    const idNameCells =
      typeof masterListIdNameCells_ === "function"
        ? masterListIdNameCells_
        : function (id, name) {
            return "<td>" + ccEsc_(id) + "</td><td>" + ccEsc_(name) + "</td>";
          };
    body.innerHTML = rows
      .map(function (r) {
        const sid = String(r.scheme_id || "").trim();
        const safeSid = sid.replace(/'/g, "\\'");
        const open = sid.toUpperCase() === sel;
        const period = ccEsc_(String(r.date_from || "").slice(0, 10) + "～" + String(r.date_to || "").slice(0, 10));
        const statusLabel = ccPromoStatusLabel_(r.status) + (r.has_settlement ? "｜已結算" : "");
        return (
          '<tr class="erp-list-row-selectable' +
          (open ? " erp-list-row-open" : "") +
          '"' +
          ' data-scheme-id="' +
          ccEsc_(sid) +
          '" onclick="ccPromoLoadScheme_(\'' +
          safeSid +
          "')\">" +
          idNameCells(sid, r.scheme_name || "") +
          "<td>" +
          ccEsc_(statusLabel) +
          "</td>" +
          "<td>" +
          period +
          "</td>" +
          "<td>" +
          ccEsc_(ccPromoScopeLabel_(r)) +
          "</td>" +
          "<td>" +
          ccEsc_(ccPromoChannelLabel_(r)) +
          "</td>" +
          "<td>" +
          ccEsc_(String(r.line_count != null ? r.line_count : "0")) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="7" class="text-muted">載入失敗</td></tr>';
  }
}

async function consignmentPromoInit() {
  if (!ccCanOperate_()) {
    const hint = document.getElementById("ccPromoStatusHint");
    if (hint) hint.textContent = "您沒有權限維護促銷方案";
  }
  bindUppercaseInput("cc_promo_id");
  if (typeof bindAutoSearchToolbar_ === "function") {
    bindAutoSearchToolbar_(
      [
        ["search_cc_promo_keyword", "input"],
        ["search_cc_promo_customer_id", "change"],
        ["search_cc_promo_status", "change"]
      ],
      function () {
        ccPromoRenderList_();
      }
    );
  }
  await ccLoadMasterData_();
  const searchCustSel = document.getElementById("search_cc_promo_customer_id");
  let promoPresetCust = "";
  try {
    promoPresetCust = String(sessionStorage.getItem("erp_promo_preset_customer") || "").trim().toUpperCase();
    if (promoPresetCust) sessionStorage.removeItem("erp_promo_preset_customer");
  } catch (_ePreset) {}
  if (searchCustSel) {
    searchCustSel.innerHTML = ccPromoRenderCustomerFilterOptions_(promoPresetCust);
  }
  const custSel = document.getElementById("cc_promo_customer_id");
  if (custSel) {
    custSel.innerHTML = ccRenderCustomerSelectOptions_("");
  }
  const cases = await ccListCasesForDropdown_({ status: "ALL" });
  ccPromoRefreshCaseCustomerMap_(cases);
  const caseSel = document.getElementById("cc_promo_case_id");
  if (caseSel) {
    caseSel.innerHTML = ccRenderCaseSelectOptions_(cases, "", true);
  }
  ccPromoOnChannelChange_();
  ccPromoListRows_ = [];
  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cc_promo_edit_card");
  ccPromoClearForm_();
  await ccPromoRenderList_(true);
}

function ccRenderCustomerSelectOptions_(selectedId) {
  const sel = String(selectedId || "").trim().toUpperCase();
  const ids = Object.keys(ccCustomers_ || {}).sort();
  if (!ids.length) return '<option value="">（尚無客戶）</option>';
  return (
    '<option value="">請選擇</option>' +
    ids
      .map(function (cid) {
        const label = ccCustomerName_(cid);
        const selected = cid === sel ? " selected" : "";
        return '<option value="' + ccEsc_(cid) + '"' + selected + ">" + ccEsc_(cid + " " + label) + "</option>";
      })
      .join("")
  );
}
