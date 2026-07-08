/*********************************
 * COMMERCIAL · Dealer 方案客戶
 *********************************/

var cdcListRows_ = [];
var cdcEditingId_ = "";
var cdcSortState_ = { field: "", asc: true };
var cdcSchemeRows_ = [];
var cdcPromoSchemeRows_ = [];
var cdcPromoRowsLoaded_ = false;
var cdcPromoExpandedSchemeId_ = "";
var cdcPromoLinesCache_ = {};
var cdcPromoRenderCache_ = null;
var cdcStatPreviewOpen_ = false;
var cdcStatPreviewPack_ = null;

function cdcEsc_(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cdcFmtMoney_(n) {
  const v = Number(n || 0);
  return typeof formatMoney === "function" ? formatMoney(v) : v.toFixed(2);
}

function cdcFmtTierLine_(label, rate) {
  const name = String(label || "").trim();
  const r = Number(rate || 0);
  if (!name && !(r > 0)) return "—";
  if (name && r > 0) return name + "（" + r + " 折）";
  if (name) return name;
  return r > 0 ? r + " 折" : "—";
}

/** 次月結算折抵餘額（無餘額顯示 0.00） */
function cdcFmtNextMonthCredit_(row) {
  return cdcFmtMoney_(Number(row?.dealer_rebate_credit_balance || 0));
}

/** 次月等級：有升級待生效顯示 pending；否則與目前等級相同 */
function cdcFmtNextMonthTier_(row) {
  if (!String(row?.dealer_cumulative_scheme_id || "").trim()) return "—";
  const pendingLabel = String(row.dealer_cumulative_pending_tier_label || "").trim();
  const pendingRate =
    row.dealer_cumulative_pending_price_rate != null && row.dealer_cumulative_pending_price_rate !== ""
      ? Number(row.dealer_cumulative_pending_price_rate)
      : null;
  if (pendingLabel || (pendingRate != null && pendingRate > 0)) {
    return cdcFmtTierLine_(pendingLabel, pendingRate);
  }
  return cdcFmtTierLine_(row.dealer_cumulative_tier_label, row.dealer_cumulative_price_rate);
}

/** 次月等級是否有升級待生效（與目前不同） */
function cdcNextMonthTierPendingUpgrade_(row) {
  return !!String(row?.dealer_cumulative_pending_tier_label || "").trim();
}

function cdcNextMonthTierCellHtml_(row) {
  const text = cdcFmtNextMonthTier_(row);
  if (cdcNextMonthTierPendingUpgrade_(row)) {
    return (
      '<span class="cdc-next-tier-upgrade" style="color:#15803d;font-weight:600;" title="月結判定次月升級">' +
      cdcEsc_(text) +
      "</span>"
    );
  }
  return cdcEsc_(text);
}

function cdcCanOperate_() {
  try {
    return typeof erpCanOperateCommercialDealerCustomer_ === "function" && erpCanOperateCommercialDealerCustomer_();
  } catch (_e) {
    return false;
  }
}

function cdcResolveRebateSchemeId_(row) {
  const c = row || {};
  return String(c.dealer_rebate_scheme_id || c.dealer_scheme_id || "").trim().toUpperCase();
}

function cdcSyncListRowHighlight_() {
  const sel = String(cdcEditingId_ || "").trim().toUpperCase();
  document.querySelectorAll("#cdc_list_tbody tr[data-row-id]").forEach(function (tr) {
    const id = String(tr.getAttribute("data-row-id") || "").trim().toUpperCase();
    tr.classList.toggle("erp-list-row-open", id === sel);
  });
}

function cdcSchemeCellHtml_(schemeId, schemeName) {
  const id = String(schemeId || "").trim().toUpperCase();
  if (!id) return '<span class="text-muted">—</span>';
  if (typeof masterListIdNameHtml_ === "function") return masterListIdNameHtml_(id, schemeName);
  return cdcEsc_(id) + (schemeName ? " " + cdcEsc_(schemeName) : "");
}

async function cdcLoadSchemeRows_(force) {
  if (!force && (cdcSchemeRows_ || []).length) return cdcSchemeRows_;
  try {
    const r = await callAPI({ action: "list_commercial_dealer_scheme_enriched" }, { method: "GET" });
    cdcSchemeRows_ = (r?.data || []).filter(function (row) {
      return String(row.status || "").trim().toUpperCase() === "ACTIVE";
    });
  } catch (_e) {
    cdcSchemeRows_ = [];
  }
  return cdcSchemeRows_;
}

function cdcFillSchemeSelect_(el, schemeType, selected) {
  if (!el) return;
  const sel = String(selected != null ? selected : el.value || "").trim().toUpperCase();
  const want = String(schemeType || "").trim().toUpperCase();
  const rows = (cdcSchemeRows_ || []).filter(function (r) {
    const st = String(r.scheme_type || "MONTHLY_REBATE").trim().toUpperCase();
    return want === "CUMULATIVE_AMOUNT" ? st === "CUMULATIVE_AMOUNT" : st !== "CUMULATIVE_AMOUNT";
  });
  let html = '<option value="">（未設定）</option>';
  rows.forEach(function (r) {
    const id = String(r.scheme_id || "").trim().toUpperCase();
    const label = id + " " + String(r.scheme_name || "");
    html += '<option value="' + cdcEsc_(id) + '"' + (id === sel ? " selected" : "") + ">" + cdcEsc_(label) + "</option>";
  });
  if (sel && !rows.some(function (r) { return String(r.scheme_id || "").trim().toUpperCase() === sel; })) {
    html += '<option value="' + cdcEsc_(sel) + '" selected>' + cdcEsc_(sel) + "｜（非生效）</option>";
  }
  el.innerHTML = html;
}

async function cdcRefreshSchemeSelects_(rebateSelected, cumulativeSelected) {
  await cdcLoadSchemeRows_();
  cdcFillSchemeSelect_(document.getElementById("cdc_dealer_rebate_scheme_id"), "MONTHLY_REBATE", rebateSelected);
  cdcFillSchemeSelect_(document.getElementById("cdc_dealer_cumulative_scheme_id"), "CUMULATIVE_AMOUNT", cumulativeSelected);
}

function cdcSetFormFields_(row) {
  const c = row || {};
  const rebateEl = document.getElementById("cdc_dealer_rebate_scheme_id");
  if (rebateEl) rebateEl.value = cdcResolveRebateSchemeId_(c);
  const cumEl = document.getElementById("cdc_dealer_cumulative_scheme_id");
  if (cumEl) cumEl.value = String(c.dealer_cumulative_scheme_id || "").trim().toUpperCase();
  const modeEl = document.getElementById("cdc_dealer_rebate_settle_mode");
  if (modeEl) modeEl.value = String(c.dealer_rebate_settle_mode || "CREDIT_NOTE").trim().toUpperCase() || "CREDIT_NOTE";
  const exclEl = document.getElementById("cdc_dealer_rebate_excluded");
  if (exclEl) {
    const ex = c.dealer_rebate_excluded === true || String(c.dealer_rebate_excluded || "").toUpperCase() === "TRUE";
    exclEl.value = ex ? "true" : "false";
  }
  const startedEl = document.getElementById("cdc_dealer_cumulative_started_at");
  if (startedEl) startedEl.value = String(c.dealer_cumulative_started_at || "").slice(0, 10);
  cdcSyncDependentFields_();
}

function cdcCollectDealerFields_() {
  const exclRaw = String(document.getElementById("cdc_dealer_rebate_excluded")?.value || "false").trim().toLowerCase();
  const rebateSchemeId = String(document.getElementById("cdc_dealer_rebate_scheme_id")?.value || "").trim().toUpperCase();
  const cumulativeSchemeId = String(document.getElementById("cdc_dealer_cumulative_scheme_id")?.value || "").trim().toUpperCase();
  const startedRaw = String(document.getElementById("cdc_dealer_cumulative_started_at")?.value || "").trim();
  return {
    dealer_rebate_scheme_id: rebateSchemeId,
    dealer_scheme_id: rebateSchemeId,
    dealer_cumulative_scheme_id: cumulativeSchemeId,
    dealer_rebate_settle_mode: String(document.getElementById("cdc_dealer_rebate_settle_mode")?.value || "CREDIT_NOTE").trim().toUpperCase(),
    dealer_rebate_excluded: exclRaw === "true",
    dealer_cumulative_started_at: startedRaw || null
  };
}

function cdcDealerFieldsForSave_() {
  const base = cdcCollectDealerFields_();
  if (!base.dealer_cumulative_scheme_id) {
    base.dealer_cumulative_tier_label = "";
    base.dealer_cumulative_price_rate = null;
    base.dealer_cumulative_pending_tier_label = "";
    base.dealer_cumulative_pending_price_rate = null;
    base.dealer_cumulative_started_at = null;
  }
  if (!base.dealer_rebate_scheme_id) {
    base.dealer_scheme_id = "";
  }
  return base;
}

function cdcOnRebateSchemeChange_() {
  const rebateScheme = String(document.getElementById("cdc_dealer_rebate_scheme_id")?.value || "").trim();
  if (!rebateScheme) {
    const modeEl = document.getElementById("cdc_dealer_rebate_settle_mode");
    if (modeEl) modeEl.value = "CREDIT_NOTE";
    const exclEl = document.getElementById("cdc_dealer_rebate_excluded");
    if (exclEl) exclEl.value = "false";
  }
  cdcSyncDependentFields_();
}

function cdcOnCumulativeSchemeChange_() {
  const cumScheme = String(document.getElementById("cdc_dealer_cumulative_scheme_id")?.value || "").trim();
  if (!cumScheme) {
    const startedEl = document.getElementById("cdc_dealer_cumulative_started_at");
    if (startedEl) startedEl.value = "";
  }
  cdcSyncDependentFields_();
}

function cdcSyncDependentFields_() {
  const hasRebate = !!String(document.getElementById("cdc_dealer_rebate_scheme_id")?.value || "").trim();
  const hasCumulative = !!String(document.getElementById("cdc_dealer_cumulative_scheme_id")?.value || "").trim();
  const modeEl = document.getElementById("cdc_dealer_rebate_settle_mode");
  const exclEl = document.getElementById("cdc_dealer_rebate_excluded");
  const startedEl = document.getElementById("cdc_dealer_cumulative_started_at");
  if (modeEl) modeEl.disabled = !hasRebate;
  if (exclEl) exclEl.disabled = !hasRebate;
  if (startedEl) startedEl.disabled = !hasCumulative;
}

function cdcClearForm_() {
  cdcEditingId_ = "";
  cdcSyncListRowHighlight_();
  const idEl = document.getElementById("cdc_customer_id");
  if (idEl) idEl.value = "";
  const title = document.getElementById("cdc_edit_title");
  if (title) title.textContent = "—";
  const promoTbody = document.getElementById("cdc_promo_tbody");
  if (promoTbody) promoTbody.innerHTML = '<tr><td colspan="7" class="text-muted">請先點選上方客戶</td></tr>';
  cdcPromoExpandedSchemeId_ = "";
  cdcPromoLinesCache_ = {};
  cdcPromoRenderCache_ = null;
  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cdc_promo_card");
  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cdc_edit_card");
  cdcSetFormFields_({
    dealer_rebate_scheme_id: "",
    dealer_scheme_id: "",
    dealer_cumulative_scheme_id: "",
    dealer_rebate_settle_mode: "CREDIT_NOTE",
    dealer_rebate_excluded: false,
    dealer_cumulative_started_at: ""
  });
  cdcStatResetPreview_();
}

function cdcTodayYmd_() {
  const d = new Date();
  const pad = function (n) {
    return String(n).padStart(2, "0");
  };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function cdcPromoStatusLabel_(status) {
  const s = String(status || "").trim().toUpperCase();
  if (typeof ccPromoStatusLabel_ === "function") return ccPromoStatusLabel_(s);
  if (s === "ACTIVE") return "生效";
  if (s === "DRAFT") return "草稿";
  if (s === "ENDED") return "結束";
  return s || "—";
}

function cdcPromoChannelLabel_(channel) {
  const ch = String(channel || "CONSIGNMENT").trim().toUpperCase();
  if (typeof ccPromoChannelLabel_ === "function") return ccPromoChannelLabel_({ channel: ch });
  if (ch === "GENERAL") return "一般銷售";
  if (ch === "ALL") return "全部";
  return "寄賣";
}

function cdcResolveCustomerName_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return "—";
  const hit = (cdcListRows_ || []).find(function (c) {
    return String(c.customer_id || "").trim().toUpperCase() === cid;
  });
  if (hit && String(hit.customer_name || "").trim()) return String(hit.customer_name).trim();
  const fromMaster = String(ccCustomers_[cid]?.customer_name || "").trim();
  if (fromMaster) return fromMaster;
  if (cid === String(cdcEditingId_ || "").trim().toUpperCase()) {
    const t = String(document.getElementById("cdc_edit_title")?.textContent || "").trim();
    if (t && t !== "—") return t;
  }
  return "—";
}

function cdcPromoScopeLabel_(row, cases, customerId) {
  const scope = String(row?.scope_type || "").trim().toUpperCase();
  if (scope === "GLOBAL") return "全站";
  if (scope === "CUSTOMER") {
    const schemeCust = String(row.customer_id || "").trim().toUpperCase();
    const viewCust = String(customerId || "").trim().toUpperCase();
    const nm = cdcResolveCustomerName_(schemeCust || viewCust);
    return "客戶：" + nm;
  }
  if (scope === "CASE") {
    const caseId = String(row.case_id || "").trim().toUpperCase();
    const hit = (cases || []).find(function (c) {
      return String(c.case_id || "").trim().toUpperCase() === caseId;
    });
    const nm = hit ? ccCustomerDisplayName_(hit) : cdcResolveCustomerName_(customerId);
    return "寄賣案：" + (nm || caseId || "—");
  }
  return scope || "—";
}

async function cdcListCasesByCustomer_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return [];
  const r = await callAPI(
    { action: "list_consignment_case_lite", status: "ALL", customer_id: cid, limit: "500" },
    { method: "GET", silent: true }
  );
  return r?.data || [];
}

async function cdcLoadPromoSchemeRows_(force) {
  if (cdcPromoRowsLoaded_ && !force) return cdcPromoSchemeRows_;
  const r = await callAPI({ action: "list_consignment_promo_scheme_enriched" }, { method: "GET" });
  cdcPromoSchemeRows_ = r?.data || [];
  cdcPromoRowsLoaded_ = true;
  return cdcPromoSchemeRows_;
}

function cdcPromoAppliesToCustomer_(scheme, customerId, caseSet) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return false;
  const scope = String(scheme?.scope_type || "").trim().toUpperCase();
  if (scope === "GLOBAL") return true;
  if (scope === "CUSTOMER") return String(scheme?.customer_id || "").trim().toUpperCase() === cid;
  if (scope === "CASE") {
    const caseId = String(scheme?.case_id || "").trim().toUpperCase();
    return !!(caseId && caseSet && caseSet.has(caseId));
  }
  return false;
}

function cdcPromoIsActiveToday_(scheme, todayYmd) {
  const st = String(scheme?.status || "").trim().toUpperCase();
  if (st !== "ACTIVE") return false;
  const f = String(scheme?.date_from || "").trim().slice(0, 10);
  const t = String(scheme?.date_to || "").trim().slice(0, 10);
  if (!f || !t) return false;
  return todayYmd >= f && todayYmd <= t;
}

function cdcPromoLineTypeLabel_(type) {
  const t = String(type || "").trim().toUpperCase();
  if (t === "FIXED_PRICE") return "固定促銷價";
  if (t === "DISCOUNT_PCT") return "折扣％";
  if (t === "BUY_N_GET_M") return "買N送M";
  return t || "—";
}

function cdcPromoLineDetailText_(ln) {
  const type = String(ln?.promo_type || "").trim().toUpperCase();
  if (type === "FIXED_PRICE") {
    const p = Number(ln.promo_unit_price || 0);
    return typeof formatMoney === "function" ? formatMoney(p) : String(p);
  }
  if (type === "DISCOUNT_PCT") return String(ln.discount_pct != null ? ln.discount_pct : "—") + "％";
  if (type === "BUY_N_GET_M") {
    return "買 " + String(ln.buy_qty != null ? ln.buy_qty : "—") + " 送 " + String(ln.free_qty != null ? ln.free_qty : "—");
  }
  return "—";
}

function cdcPromoProductDisplay_(productId) {
  const pid = String(productId || "").trim().toUpperCase();
  if (!pid) return "—";
  const p = typeof ccProducts_ !== "undefined" && ccProducts_ ? ccProducts_[pid] : null;
  const name = (p && p.product_name) || (typeof ccProductName_ === "function" ? ccProductName_(pid) : pid);
  const spec = String((p && p.spec) || "").trim();
  return spec ? name + "（" + spec + "）" : name;
}

function cdcPromoDetailHeadCellStyle_() {
  return "padding:8px 12px 4px;background:#f8fafc;border-top:none;font-size:11px;color:#64748b;font-weight:600;";
}

function cdcPromoDetailLineCellStyle_() {
  return "padding:4px 12px 6px;background:#f8fafc;border-top:none;font-size:12px;line-height:1.45;";
}

function cdcBuildPromoDetailRowsHtml_(sid, cached, expanded) {
  const sidAttr = cdcEsc_(sid);
  const detailStyle = expanded ? "" : ' style="display:none;"';
  const cellBg = "background:#f8fafc;border-top:none;";
  if (cached === "loading" || (expanded && !Array.isArray(cached))) {
    return (
      '<tr class="cdc-promo-detail" data-scheme-detail="' +
      sidAttr +
      '"' +
      detailStyle +
      '><td colspan="7" style="padding:8px 12px 10px;' +
      cellBg +
      'color:#64748b;font-size:12px;">載入中…</td></tr>'
    );
  }
  if (!Array.isArray(cached) || !cached.length) {
    return (
      '<tr class="cdc-promo-detail" data-scheme-detail="' +
      sidAttr +
      '"' +
      detailStyle +
      '><td colspan="7" style="padding:8px 12px 10px;' +
      cellBg +
      'color:#94a3b8;font-size:12px;">無明細</td></tr>'
    );
  }
  const headStyle = cdcPromoDetailHeadCellStyle_();
  const head =
    '<tr class="cdc-promo-detail cdc-promo-detail-head" data-scheme-detail="' +
    sidAttr +
    '"' +
    detailStyle +
    ">" +
    '<td class="col-master-idname" style="' +
    headStyle +
    '">品項</td>' +
    '<td class="col-master-name-desk" style="' +
    headStyle +
    '"></td>' +
    '<td style="' +
    headStyle +
    '">促銷類型</td>' +
    '<td style="' +
    headStyle +
    '">內容</td>' +
    '<td style="' +
    headStyle +
    '"></td>' +
    '<td style="' +
    headStyle +
    '"></td>' +
    '<td style="' +
    headStyle +
    '"></td>' +
    "</tr>";
  const lineStyle = cdcPromoDetailLineCellStyle_();
  const lines = cached
    .map(function (ln) {
      return (
        '<tr class="cdc-promo-detail cdc-promo-detail-line" data-scheme-detail="' +
        sidAttr +
        '"' +
        detailStyle +
        ">" +
        '<td class="col-master-idname" style="' +
        lineStyle +
        '"><div class="master-list-name">' +
        cdcEsc_(cdcPromoProductDisplay_(ln.product_id)) +
        "</div></td>" +
        '<td class="col-master-name-desk" style="' +
        lineStyle +
        '"></td>' +
        '<td style="' +
        lineStyle +
        '">' +
        cdcEsc_(cdcPromoLineTypeLabel_(ln.promo_type)) +
        "</td>" +
        '<td style="' +
        lineStyle +
        '">' +
        cdcEsc_(cdcPromoLineDetailText_(ln)) +
        "</td>" +
        '<td style="' +
        lineStyle +
        '"></td>' +
        '<td style="' +
        lineStyle +
        '"></td>' +
        '<td style="' +
        lineStyle +
        '"></td>' +
        "</tr>"
      );
    })
    .join("");
  return head + lines;
}

function cdcBuildPromoSchemeRowsHtml_(s, ctx) {
  const sid = String(s.scheme_id || "").trim().toUpperCase();
  const sidAttr = cdcEsc_(sid);
  const nm = String(s.scheme_name || "").trim() || sid;
  const expanded = cdcPromoExpandedSchemeId_ === sid;
  const summaryCls = "cdc-promo-summary erp-list-row-selectable" + (expanded ? " erp-list-row-open" : "");
  const cached = cdcPromoLinesCache_[sid];

  const nameCells =
    typeof masterListNameOnlyCells_ === "function"
      ? masterListNameOnlyCells_
      : function (name) {
          return "<td>" + cdcEsc_(name) + "</td><td>" + cdcEsc_(name) + "</td>";
        };
  const statusLabel = cdcPromoStatusLabel_(s.status) + (s.has_settlement ? "｜已結算" : "");
  const period = cdcEsc_(String(s.date_from || "").slice(0, 10) + "～" + String(s.date_to || "").slice(0, 10));
  const scopeLabel = cdcPromoScopeLabel_(s, ctx.cases, ctx.cid);
  const chLabel = cdcPromoChannelLabel_(s.channel);
  const lineCnt = String(s.line_count != null ? s.line_count : "0");

  return (
    '<tr class="' +
    summaryCls +
    '" data-scheme-id="' +
    sidAttr +
    '" onclick="cdcTogglePromoDetail_(this.getAttribute(\'data-scheme-id\'))" title="點擊展開／收合明細">' +
    nameCells(nm) +
    "<td>" +
    cdcEsc_(statusLabel) +
    "</td>" +
    "<td>" +
    period +
    "</td>" +
    "<td>" +
    cdcEsc_(scopeLabel) +
    "</td>" +
    "<td>" +
    cdcEsc_(chLabel) +
    "</td>" +
    "<td>" +
    cdcEsc_(lineCnt) +
    "</td>" +
    "</tr>" +
    cdcBuildPromoDetailRowsHtml_(sid, cached, expanded)
  );
}

function cdcPaintPromoList_() {
  const tbody = document.getElementById("cdc_promo_tbody");
  const cache = cdcPromoRenderCache_;
  if (!tbody || !cache) return;
  const matched = Array.isArray(cache.matched) ? cache.matched : [];
  if (!matched.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="text-muted">此客戶目前無生效中的促銷方案（含全站／客戶／寄賣案）</td></tr>';
    return;
  }
  tbody.innerHTML = matched.map(function (s) {
    return cdcBuildPromoSchemeRowsHtml_(s, cache);
  }).join("");
}

async function cdcTogglePromoDetail_(schemeId) {
  const sid = String(schemeId || "").trim().toUpperCase();
  if (!sid) return;
  const was = cdcPromoExpandedSchemeId_;
  cdcPromoExpandedSchemeId_ = was === sid ? "" : sid;

  if (cdcPromoExpandedSchemeId_ === sid && !Array.isArray(cdcPromoLinesCache_[sid]) && cdcPromoLinesCache_[sid] !== "loading") {
    cdcPromoLinesCache_[sid] = "loading";
    cdcPaintPromoList_();
    try {
      const linesR = await callAPI(
        { action: "list_consignment_promo_scheme_line", scheme_id: sid },
        { method: "GET", silent: true }
      );
      const lines = (linesR?.data || [])
        .filter(function (ln) {
          return String(ln.scheme_id || "").trim().toUpperCase() === sid;
        })
        .sort(function (a, b) {
          return Number(a.sort_order || 0) - Number(b.sort_order || 0);
        });
      cdcPromoLinesCache_[sid] = lines;
    } catch (e) {
      cdcPromoLinesCache_[sid] = [];
      showToast(String(e?.message || e || "載入明細失敗"), "error");
    }
  }
  cdcPaintPromoList_();
}

async function cdcRenderPromoForCustomer_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  const tbody = document.getElementById("cdc_promo_tbody");
  if (!tbody) return;
  if (!cid) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">請先點選上方客戶</td></tr>';
    cdcPromoExpandedSchemeId_ = "";
    cdcPromoLinesCache_ = {};
    cdcPromoRenderCache_ = null;
    return;
  }

  cdcPromoExpandedSchemeId_ = "";
  cdcPromoLinesCache_ = {};
  cdcPromoRenderCache_ = null;
  tbody.innerHTML = '<tr><td colspan="7" class="text-muted">載入中…</td></tr>';
  const today = cdcTodayYmd_();
  try {
    const [schemes, cases] = await Promise.all([cdcLoadPromoSchemeRows_(), cdcListCasesByCustomer_(cid)]);
    const caseSet = new Set(
      (cases || []).map(function (c) {
        return String(c.case_id || "").trim().toUpperCase();
      }).filter(Boolean)
    );
    const matched = (schemes || [])
      .filter(function (s) {
        return cdcPromoIsActiveToday_(s, today) && cdcPromoAppliesToCustomer_(s, cid, caseSet);
      })
      .sort(function (a, b) {
        const af = String(a.date_from || "");
        const bf = String(b.date_from || "");
        if (af !== bf) return bf.localeCompare(af);
        return String(b.created_at || "").localeCompare(String(a.created_at || ""));
      });

    if (!matched.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="text-muted">此客戶目前無生效中的促銷方案（含全站／客戶／寄賣案）</td></tr>';
    } else {
      cdcPromoRenderCache_ = { cid: cid, matched: matched, cases: cases || [] };
      cdcPaintPromoList_();
    }

    if (typeof showMasterEditCard_ === "function") showMasterEditCard_("cdc_promo_card");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">載入失敗</td></tr>';
    showToast(String(e?.message || e || "載入失敗"), "error");
  }
}

function cdcGoPromoForEditingCustomer_() {
  const cid = String(document.getElementById("cdc_customer_id")?.value || cdcEditingId_ || "").trim().toUpperCase();
  try {
    if (cid) sessionStorage.setItem("erp_promo_preset_customer", cid);
    else sessionStorage.removeItem("erp_promo_preset_customer");
  } catch (_e) {}
  if (typeof navigate === "function") navigate("commercial_promo");
}

function cdcStatDefaultPeriodYm_() {
  const d = new Date();
  const pad = function (n) {
    return String(n).padStart(2, "0");
  };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1);
}

function cdcStatResetPreview_() {
  cdcStatPreviewOpen_ = false;
  cdcStatPreviewPack_ = null;
  const btn = document.getElementById("cdc_stat_toggle_btn");
  if (btn) {
    btn.textContent = "本月預覽";
    btn.disabled = false;
  }
  const box = document.getElementById("cdc_stat_preview");
  if (box) {
    box.classList.add("cdc-stat-box-hidden");
    box.innerHTML = "";
  }
}

function cdcStatShowLoading_() {
  const box = document.getElementById("cdc_stat_preview");
  if (box) {
    box.innerHTML = '<div class="text-muted">載入中…</div>';
    box.classList.remove("cdc-stat-box-hidden");
  }
  const btn = document.getElementById("cdc_stat_toggle_btn");
  if (btn) btn.disabled = true;
}

async function cdcStatTogglePreview_() {
  const cid = String(document.getElementById("cdc_customer_id")?.value || cdcEditingId_ || "").trim().toUpperCase();
  if (!cid) return showToast("請先選擇客戶", "warn");
  cdcStatPreviewOpen_ = !cdcStatPreviewOpen_;
  const btn = document.getElementById("cdc_stat_toggle_btn");
  if (btn) btn.textContent = cdcStatPreviewOpen_ ? "收合預覽" : "本月預覽";
  if (!cdcStatPreviewOpen_) {
    const box = document.getElementById("cdc_stat_preview");
    if (box) {
      box.classList.add("cdc-stat-box-hidden");
      box.innerHTML = "";
    }
    if (btn) btn.disabled = false;
    return;
  }
  cdcStatShowLoading_();
  await cdcStatLoadPreview_();
}

async function cdcStatLoadPreview_() {
  const cid = String(document.getElementById("cdc_customer_id")?.value || cdcEditingId_ || "").trim().toUpperCase();
  const periodYm = cdcStatDefaultPeriodYm_();
  if (!cid || !periodYm) {
    cdcStatRenderPreview_(null);
    const btn = document.getElementById("cdc_stat_toggle_btn");
    if (btn) btn.disabled = false;
    return;
  }
  try {
    const pack = await callAPI(
      {
        action: "preview_commercial_dealer_monthly_stat_bundle",
        customer_id: cid,
        period_ym: periodYm
      },
      { method: "POST", silent: true }
    );
    cdcStatPreviewPack_ = pack;
    cdcStatRenderPreview_(pack);
    const idx = (cdcListRows_ || []).findIndex(function (c) {
      return String(c?.customer_id || "").trim().toUpperCase() === cid;
    });
    if(idx >= 0){
      const merged = await cdcMaybeSyncCumulativeTier_(cdcListRows_[idx]);
      cdcListRows_[idx] = Object.assign({}, cdcListRows_[idx], merged);
      cdcRenderList_();
    }
  } catch (err) {
    cdcStatPreviewPack_ = null;
    cdcStatRenderPreview_(null);
    if (!(err && err.erpApiToastShown)) showToast("載入本月統計失敗", "error");
  } finally {
    const btn = document.getElementById("cdc_stat_toggle_btn");
    if (btn) btn.disabled = false;
  }
}

function cdcStatCumulativeSchemeLabel_(cum) {
  if (typeof drRebateCumulativeSchemeLabel_ === "function") return drRebateCumulativeSchemeLabel_(cum);
  return String(cum?.scheme_name || cum?.scheme_id || "—").trim() || "—";
}

function cdcStatRenderPreview_(pack) {
  const box = document.getElementById("cdc_stat_preview");
  if (!box) return;
  if (!cdcStatPreviewOpen_) {
    box.classList.add("cdc-stat-box-hidden");
    box.innerHTML = "";
    return;
  }
  if (!pack) {
    box.innerHTML = '<div class="text-muted">無統計資料</div>';
    box.classList.remove("cdc-stat-box-hidden");
    return;
  }

  const billingNet = Number(pack.billing_net || 0);
  const billingCons = Number(pack.billing_net_consignment || 0);
  const billingGen = Number(pack.billing_net_general || 0);
  const settleCnt = Number(pack.settlement_count || 0);
  const shipCnt = Number(pack.shipment_count || 0);
  const cumAdd = Number(pack.cumulative_add_consignment || 0);

  let html = "";

  if (pack.already_posted) {
    html +=
      '<div style="color:#15803d;margin-bottom:6px;">本月月結統計已過帳（' +
      cdcEsc_(pack.existing_stat_id || "—") +
      "）</div>";
  }

  if (!(billingNet > 0)) {
    html += '<div class="text-muted">本月無請款淨額</div>';
    box.innerHTML = html;
    box.classList.remove("cdc-stat-box-hidden");
    return;
  }

  const generalOnly = billingCons <= 0.009 && settleCnt <= 0;

  if (generalOnly) {
    html +=
      "<div><strong>本月請款淨額</strong>：" +
      cdcFmtMoney_(billingNet) +
      "（一般出貨 " +
      String(shipCnt) +
      " 筆；累積已於出貨過帳，無須月結統計）</div>";
  } else {
    html +=
      "<div><strong>請款淨額合計</strong>：" +
      cdcFmtMoney_(billingNet) +
      "（寄賣 " +
      cdcFmtMoney_(billingCons) +
      (settleCnt > 0 ? "，" + settleCnt + " 筆結算" : "") +
      "；一般 " +
      cdcFmtMoney_(billingGen) +
      (shipCnt > 0 ? "，" + shipCnt + " 筆出貨" : "") +
      "）</div>";
    if (pack.cumulative_note) {
      html += '<div style="color:#64748b;margin-top:4px;">' + cdcEsc_(pack.cumulative_note) + "</div>";
    }
    html +=
      '<div style="margin-top:6px;"><strong>本次寄賣累積</strong>：+' +
      cdcFmtMoney_(cumAdd) +
      "；<strong>一般</strong>：" +
      cdcFmtMoney_(billingGen) +
      "（已於出貨過帳計入，不重複加）</div>";
    if (!pack.already_posted && billingCons > 0.009) {
      html +=
        '<div style="margin-top:6px;color:#b45309;">有寄賣請款，須至 FINANCE 財務 → <strong>月結統計</strong> 過帳。</div>';
    }
    const cum = pack.cumulative_preview || {};
    if (cum.enabled) {
      html +=
        '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;"><strong>方案</strong>：' +
        cdcEsc_(cdcStatCumulativeSchemeLabel_(cum)) +
        "</div>" +
        "<div><strong>目前等級</strong>：" +
        cdcEsc_(cum.current_tier_label || "—") +
        (cum.current_price_rate != null ? "（" + String(cum.current_price_rate) + " 折）" : "") +
        "</div>" +
        "<div><strong>月結累積</strong>：" +
        cdcFmtMoney_(cum.cumulative_before) +
        " → " +
        cdcFmtMoney_(cum.cumulative_after) +
        "（本月寄賣 +" +
        cdcFmtMoney_(cumAdd) +
        "）</div>";
      if (cum.upgrade && cum.pending_tier_label) {
        html +=
          '<div style="color:#15803d;"><strong>次月待生效</strong>：' +
          cdcEsc_(cum.pending_tier_label) +
          (cum.pending_price_rate != null ? "（" + String(cum.pending_price_rate) + " 折）" : "") +
          "</div>";
      }
    } else if (cum.err) {
      html += '<div style="margin-top:6px;color:#b45309;">' + cdcEsc_(cum.err) + "</div>";
    }
  }

  box.innerHTML = html;
  box.classList.remove("cdc-stat-box-hidden");
}

function cdcGoMonthlyStat_() {
  const cid = String(document.getElementById("cdc_customer_id")?.value || cdcEditingId_ || "").trim().toUpperCase();
  const periodYm = cdcStatDefaultPeriodYm_();
  if (!cid) return showToast("請先選擇客戶", "warn");
  try {
    sessionStorage.setItem(
      "erp_dealer_rebate_preset",
      JSON.stringify({ customer_id: cid, period_ym: periodYm })
    );
  } catch (_e) {}
  if (typeof navigate === "function") navigate("dealer_rebate");
}

async function cdcMaybeSyncCumulativeTier_(row) {
  const cid = String(row?.customer_id || "").trim().toUpperCase();
  const schemeId = String(row?.dealer_cumulative_scheme_id || "").trim();
  if (!cid || !schemeId) return row;
  try {
    const resp = await callAPI(
      {
        action: "sync_customer_cumulative_tier",
        customer_id: cid,
        updated_by: typeof getCurrentUser === "function" ? getCurrentUser() : ""
      },
      { method: "POST", silent: true }
    );
    const r = resp && resp.success !== false ? resp : null;
    if (!r) return row;
    if (r.backfill_error) {
      console.warn("cdc sync backfill:", r.backfill_error);
    }
    return Object.assign({}, row, {
      dealer_cumulative_amount:
        r.dealer_cumulative_amount != null
          ? r.dealer_cumulative_amount
          : r.cumulative_after != null
            ? r.cumulative_after
            : r.recalc && r.recalc.cumulative_after != null
              ? r.recalc.cumulative_after
              : row.dealer_cumulative_amount,
      dealer_cumulative_tier_label: r.dealer_cumulative_tier_label || row.dealer_cumulative_tier_label,
      dealer_cumulative_price_rate:
        r.dealer_cumulative_price_rate != null ? r.dealer_cumulative_price_rate : row.dealer_cumulative_price_rate,
      dealer_cumulative_pending_tier_label:
        r.dealer_cumulative_pending_tier_label || row.dealer_cumulative_pending_tier_label,
      dealer_cumulative_pending_price_rate:
        r.dealer_cumulative_pending_price_rate != null
          ? r.dealer_cumulative_pending_price_rate
          : row.dealer_cumulative_pending_price_rate
    });
  } catch (e) {
    console.warn("cdc sync cumulative:", e?.message || e);
    return row;
  }
}

function cdcGetFilters_() {
  return {
    keyword: String(document.getElementById("search_cdc_keyword")?.value || "").trim(),
    category: String(document.getElementById("search_cdc_category")?.value || "").trim(),
    bind_status: String(document.getElementById("search_cdc_bind_status")?.value || "ALL").trim().toUpperCase(),
    status: String(document.getElementById("search_cdc_status")?.value || "ACTIVE").trim().toUpperCase()
  };
}

async function cdcFetchList_() {
  const f = cdcGetFilters_();
  const r = await callAPI(
    {
      action: "list_commercial_dealer_customer_enriched",
      keyword: f.keyword,
      category: f.category,
      bind_status: f.bind_status,
      status: f.status
    },
    { method: "GET" }
  );
  cdcListRows_ = r?.data || [];
  return cdcListRows_;
}

function cdcRenderList_() {
  const tbody = document.getElementById("cdc_list_tbody");
  if (!tbody) return;
  let list = (cdcListRows_ || []).slice();
  if (cdcSortState_.field) {
    const field = cdcSortState_.field;
    const asc = !!cdcSortState_.asc;
    list.sort(function (a, b) {
      let va = a[field];
      let vb = b[field];
      if (field === "dealer_cumulative_amount" || field === "dealer_rebate_credit_balance") {
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
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px;">查無符合條件的客戶。</td></tr>';
    return;
  }
  const openId = String(cdcEditingId_ || "").trim().toUpperCase();
  const nameCells =
    typeof masterListNameOnlyCells_ === "function"
      ? masterListNameOnlyCells_
      : function (name) {
          return "<td>" + cdcEsc_(name) + "</td><td>" + cdcEsc_(name) + "</td>";
        };
  tbody.innerHTML = list
    .map(function (c) {
      const cid = String(c.customer_id || "");
      const safeCid = cid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const open = openId === cid.trim().toUpperCase();
      const rebateHtml = cdcSchemeCellHtml_(cdcResolveRebateSchemeId_(c), c.dealer_rebate_scheme_name);
      const cumHtml = cdcSchemeCellHtml_(c.dealer_cumulative_scheme_id, c.dealer_cumulative_scheme_name);
      const tier = String(c.dealer_cumulative_scheme_id || "").trim()
        ? cdcFmtTierLine_(c.dealer_cumulative_tier_label, c.dealer_cumulative_price_rate)
        : "—";
      const nextCredit = cdcFmtNextMonthCredit_(c);
      const nextTierCell = cdcNextMonthTierCellHtml_(c);
      return (
        '<tr class="erp-list-row-selectable' +
        (open ? " erp-list-row-open" : "") +
        '" data-row-id="' +
        cdcEsc_(cid) +
        '" onclick="cdcOpenEdit_(\'' +
        safeCid +
        "')\">" +
        nameCells(String(c.customer_name || "").trim() || cid) +
        "<td>" +
        rebateHtml +
        "</td>" +
        "<td>" +
        cdcEsc_(nextCredit) +
        "</td>" +
        "<td>" +
        cumHtml +
        "</td>" +
        "<td>" +
        cdcEsc_(cdcFmtMoney_(c.dealer_cumulative_amount)) +
        "</td>" +
        "<td>" +
        cdcEsc_(tier) +
        "</td>" +
        "<td>" +
        nextTierCell +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function cdcSort_(field) {
  if (cdcSortState_.field === field) cdcSortState_.asc = !cdcSortState_.asc;
  else {
    cdcSortState_.field = field;
    cdcSortState_.asc = field === "customer_name" || field === "customer_id";
  }
  cdcRenderList_();
}

async function cdcSearch_() {
  const tbody = document.getElementById("cdc_list_tbody");
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted">載入中…</td></tr>';
  try {
    await cdcFetchList_();
    cdcRenderList_();
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted">載入失敗</td></tr>';
    showToast(String(e?.message || e || "載入失敗"), "error");
  }
}

async function cdcResetSearch_() {
  const kw = document.getElementById("search_cdc_keyword");
  if (kw) kw.value = "";
  const cat = document.getElementById("search_cdc_category");
  if (cat) cat.value = "";
  const bind = document.getElementById("search_cdc_bind_status");
  if (bind) bind.value = "ALL";
  if (typeof masterSearchStatusDefault_ === "function") masterSearchStatusDefault_("search_cdc_status");
  await cdcSearch_();
  if (typeof resetMasterListView_ === "function") resetMasterListView_("cdc_edit_card", cdcClearForm_);
}

async function cdcOpenEdit_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  if (
    cdcEditingId_ &&
    typeof erpTryToggleCloseMasterListRow_ === "function" &&
    erpTryToggleCloseMasterListRow_(cdcEditingId_, cid, "cdc_edit_card", cdcClearForm_, "cdc_list_tbody")
  ) {
    cdcRenderList_();
    return;
  }
  let row = (cdcListRows_ || []).find(function (c) {
    return String(c.customer_id || "").trim().toUpperCase() === cid;
  });
  if (!row) {
    try {
      row = await getOne("customer", "customer_id", cid);
    } catch (_e) {
      row = null;
    }
  }
  if (!row) return showToast("找不到客戶", "error");

  cdcEditingId_ = cid;
  cdcSyncListRowHighlight_();
  const title = document.getElementById("cdc_edit_title");
  const idEl = document.getElementById("cdc_customer_id");
  if (idEl) idEl.value = cid;
  if (title) title.textContent = String(row.customer_name || "").trim() || "—";

  // 先填列表已有資料並展開明細（比照主檔：不等 API）
  cdcSetFormFields_(row);
  cdcRenderList_();
  if (typeof showMasterEditCard_ === "function") showMasterEditCard_("cdc_edit_card");
  if (typeof scrollToMasterForm_ === "function") scrollToMasterForm_("cdc_edit_card");
  cdcStatResetPreview_();
  // 同頁：客戶促銷方案（層級 2）
  await cdcRenderPromoForCustomer_(cid);

  // 背景：方案下拉 + 累積等級校正（有綁等級方案才打 sync）
  await cdcRefreshSchemeSelects_(cdcResolveRebateSchemeId_(row), row.dealer_cumulative_scheme_id || "");
  cdcSetFormFields_(row);
  const merged = await cdcMaybeSyncCumulativeTier_(row);
  cdcSetFormFields_(merged);

  const idx = (cdcListRows_ || []).findIndex(function (c) {
    return String(c.customer_id || "").trim().toUpperCase() === cid;
  });
  if (idx >= 0) cdcListRows_[idx] = Object.assign({}, cdcListRows_[idx], merged);
  cdcRenderList_();
}

async function cdcUpdate_(triggerEl) {
  if (!cdcCanOperate_()) return showToast("無權限編輯 Dealer 方案客戶", "error");
  const cid = String(document.getElementById("cdc_customer_id")?.value || cdcEditingId_ || "").trim().toUpperCase();
  if (!cid) return showToast("請先選擇客戶", "error");

  showSaveHint(triggerEl);
  try {
    const customer = await getOne("customer", "customer_id", cid);
    if (!customer) return showToast("找不到客戶", "error");

    const newData = Object.assign({}, cdcDealerFieldsForSave_(), {
      updated_by: getCurrentUser(),
      updated_at: nowIsoTaipei()
    });
    await updateRecord("customer", "customer_id", cid, newData);
    await cdcSearch_();
    await cdcOpenEdit_(cid);
    showToast("客戶方案綁定已更新");
  } finally {
    hideSaveHint();
  }
}

async function commercialDealerCustomerInit() {
  if (typeof masterSearchStatusDefault_ === "function") masterSearchStatusDefault_("search_cdc_status");
  if (typeof bindAutoSearchToolbar_ === "function") {
    bindAutoSearchToolbar_(
      [
        ["search_cdc_keyword", "input"],
        ["search_cdc_category", "change"],
        ["search_cdc_bind_status", "change"],
        ["search_cdc_status", "change"]
      ],
      function () {
        cdcSearch_();
      }
    );
  }
  const cumSel = document.getElementById("cdc_dealer_cumulative_scheme_id");
  if (cumSel && !cumSel.dataset.boundCdc) {
    cumSel.dataset.boundCdc = "1";
    cumSel.addEventListener("change", cdcOnCumulativeSchemeChange_);
  }
  const rebateSel = document.getElementById("cdc_dealer_rebate_scheme_id");
  if (rebateSel && !rebateSel.dataset.boundCdc) {
    rebateSel.dataset.boundCdc = "1";
    rebateSel.addEventListener("change", cdcOnRebateSchemeChange_);
  }
  const btn = document.getElementById("cdc_update_btn");
  if (btn) btn.disabled = !cdcCanOperate_();

  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cdc_edit_card");
  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cdc_promo_card");
  cdcClearForm_();
  const masterLoad =
    typeof ccLoadMasterData_ === "function" ? ccLoadMasterData_() : Promise.resolve();
  await Promise.all([cdcSearch_(), cdcLoadSchemeRows_(), masterLoad]);

  let preset = "";
  try {
    preset = String(sessionStorage.getItem("erp_dealer_customer_preset") || "").trim();
    if (preset) sessionStorage.removeItem("erp_dealer_customer_preset");
  } catch (_e) {}
  if (preset) await cdcOpenEdit_(preset);
}
