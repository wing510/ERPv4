/*********************************
 * Consignment 寄賣案件 v4.2.2 — 共用
 *********************************/

var CC_ACTIVE_CASE_KEY_ = "erp_consignment_active_case_id";
var ccCustomers_ = {};
var ccProducts_ = {};
var ccWarehouses_ = {};

var CC_RETURN_REASON_LABELS_ = {
  UNSOLD: "未售收回",
  CASE_CLOSE: "合約終止",
  DAMAGED: "商品瑕疵",
  EXPIRED: "效期不足",
  WRONG_GOODS: "出貨寄錯",
  OTHER: "其他原因"
};

var CC_CASE_STATUS_LABELS_ = {
  OPEN: "進行中",
  CLOSED: "已結案"
};

function ccEsc_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ccFmtMoney_(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return "0";
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function ccFmtReceivedNetPct_(row) {
  const received = Number(row && row.total_received_amount != null ? row.total_received_amount : 0);
  const net = Number(
    row && row.total_net_amount != null
      ? row.total_net_amount
      : Math.max(0, Number((row && row.total_ship_amount) || 0) - Number((row && row.total_returned_amount) || 0))
  );
  const promo = Number(row && row.total_promo_allowance != null ? row.total_promo_allowance : 0);
  const denom = Math.max(0, net - promo);
  let pct = "—";
  if (denom > 1e-9) {
    pct = String(Math.round((received / denom) * 1000) / 10) + "%";
  } else if (received <= 1e-9) {
    pct = "0%";
  }
  return ccFmtMoney_(received) + " / " + ccFmtMoney_(denom) + " (" + pct + ")";
}

/** 寄賣案下拉選項：案件ID｜客戶名稱｜開案日YYYY-MM-DD */
function ccFormatCaseDropdownLabel_(c) {
  const id = String((c && c.case_id) || "").trim().toUpperCase();
  const cust = ccCustomerDisplayName_(c || {});
  const openDate = String((c && c.open_date) || "").trim() || "—";
  const st = String((c && c.status) || "").trim().toUpperCase();
  const closedTag = st === "CLOSED" ? "｜已結案" : "";
  return id + "｜" + cust + "｜開案日" + openDate + closedTag;
}

function ccTodayYmd_() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** 與後端 buildShortDocId_ 同格式，供結算／收回 idempotency */
function ccNewDocId_(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return String(prefix || "ID") + "-" + ymd + "-" + rnd;
}

/** 促銷方案編號：CP-YYMMDD-RR（與後端 buildShortPromoSchemeId_ 一致） */
function ccNewPromoSchemeId_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return "CP-" + ymd + "-" + rnd;
}

function cdNewDealerSchemeId_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return "CD-" + ymd + "-" + rnd;
}

function ccCanOperate_() {
  try {
    return typeof erpCanManageAr_ === "function" && erpCanManageAr_();
  } catch (_e) {
    return false;
  }
}

function ccReturnReasonLabel_(reason) {
  const r = String(reason || "").trim().toUpperCase();
  return CC_RETURN_REASON_LABELS_[r] || String(reason || "—");
}

function ccCaseStatusLabel_(status) {
  const s = String(status || "").trim().toUpperCase();
  return CC_CASE_STATUS_LABELS_[s] || String(status || "—");
}

function ccCaseFinanceOpen_(meta) {
  const n = Number(meta?.open_ar_count || 0);
  const out = Number(meta?.ar_outstanding_amount || 0);
  return n > 0 || out > 1e-9;
}

function ccGoArForCustomer_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  try {
    if (cid) sessionStorage.setItem("erp_ar_preset_customer", cid);
    else sessionStorage.removeItem("erp_ar_preset_customer");
  } catch (_e) {}
  if (typeof navigate === "function") navigate("ar");
}

function ccGoPromoForCustomer_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  try {
    if (cid) sessionStorage.setItem("erp_promo_preset_customer", cid);
    else sessionStorage.removeItem("erp_promo_preset_customer");
  } catch (_e) {}
  if (typeof navigate === "function") navigate("commercial_promo");
}

function ccBuildCaseSummaryHtml_(meta, opts) {
  const o = opts || {};
  const cname = ccCustomerDisplayName_(meta);
  const st = ccCaseStatusLabel_(meta.status);
  const closed = String(meta.status || "").trim().toUpperCase() === "CLOSED";
  const shipAmt = Number(meta.total_ship_amount || 0);
  const settledAmt = Number(meta.total_settled_amount || 0);
  const promoAllowance = Number(meta.total_promo_allowance || 0);
  const netAmt = Number(
    meta.total_net_amount != null
      ? meta.total_net_amount
      : Math.max(0, shipAmt - Number(meta.total_returned_amount || 0))
  );
  const receivedAmt = Number(meta.total_received_amount || 0);
  const remark = String(meta.remark || "").trim();
  let statusHtml = ccEsc_(st);
  if (closed && o.closedSettleHint) {
    statusHtml += '　<span style="color:#b45309;">（已結案，不可再結算）</span>';
  } else if (closed && o.closedReturnHint) {
    statusHtml += '　<span style="color:#b45309;">（已結案，不可再收回）</span>';
  }
  let amountLine =
    "金額：收款 <strong>" +
    ccEsc_(ccFmtMoney_(receivedAmt)) +
    "</strong> | 結算 <strong>" +
    ccEsc_(ccFmtMoney_(settledAmt)) +
    "</strong> | 促銷 <strong>" +
    ccEsc_(ccFmtMoney_(promoAllowance)) +
    "</strong> | 淨額 <strong>" +
    ccEsc_(ccFmtMoney_(netAmt)) +
    "</strong> | 出貨 <strong>" +
    ccEsc_(ccFmtMoney_(shipAmt)) +
    "</strong>" +
    '<span style="font-size:12px;color:#64748b;margin-left:6px;">（預估應收＝淨額−促銷）</span>';
  let financeHtml = "";
  if (closed && ccCaseFinanceOpen_(meta)) {
    const outAmt = Number(meta.ar_outstanding_amount || 0);
    const openCnt = Number(meta.open_ar_count || 0);
    const custId = String(meta.customer_id || "").trim().toUpperCase();
    financeHtml =
      '<div style="margin-top:8px;font-size:13px;color:#b45309;">' +
      "貨流已結案；尚有未收應收 <strong>" +
      ccEsc_(ccFmtMoney_(outAmt)) +
      "</strong>" +
      (openCnt > 0 ? "（" + openCnt + " 筆）" : "") +
      '　<button type="button" class="btn-secondary btn-sm" onclick="event.stopPropagation();ccGoArForCustomer_(\'' +
      custId.replace(/'/g, "\\'") +
      "');return false;\">前往 AR</button></div>";
  }
  return (
    "<div><strong>客戶</strong>：" +
    ccEsc_(cname) +
    "　<strong>開案日</strong>：" +
    ccEsc_(meta.open_date || "—") +
    "　<strong>狀態</strong>：" +
    statusHtml +
    "</div>" +
    '<div style="margin-top:6px;color:#475569;">' +
    amountLine +
    "</div>" +
    (remark
      ? '<div style="margin-top:6px;"><strong>備註</strong>：' + ccEsc_(remark) + "</div>"
      : "") +
    financeHtml
  );
}

function ccGetActiveCaseId_() {
  try {
    return String(sessionStorage.getItem(CC_ACTIVE_CASE_KEY_) || "").trim().toUpperCase();
  } catch (_e) {
    return "";
  }
}

function ccSetActiveCaseId_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  try {
    if (id) sessionStorage.setItem(CC_ACTIVE_CASE_KEY_, id);
    else sessionStorage.removeItem(CC_ACTIVE_CASE_KEY_);
  } catch (_e) {}
}

function ccGoSettlement_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  ccSetActiveCaseId_(id);
  try {
    if (id) sessionStorage.setItem("erp_consignment_stl_preset", id);
    else sessionStorage.removeItem("erp_consignment_stl_preset");
  } catch (_e) {}
  navigate("consignment_settlement");
}

function ccGoReturn_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  ccSetActiveCaseId_(id);
  try {
    if (id) sessionStorage.setItem("erp_consignment_ret_preset", id);
    else sessionStorage.removeItem("erp_consignment_ret_preset");
  } catch (_e) {}
  navigate("consignment_return");
}

async function ccLoadMasterData_() {
  const [cust, prod, wh] = await Promise.all([
    getAll("customer").catch(function () { return []; }),
    getAll("product").catch(function () { return []; }),
    getAll("warehouse").catch(function () { return []; })
  ]);
  ccCustomers_ = {};
  (cust || []).forEach(function (c) {
    ccCustomers_[String(c.customer_id || "").trim().toUpperCase()] = c;
  });
  ccProducts_ = {};
  (prod || []).forEach(function (p) {
    ccProducts_[String(p.product_id || "").trim().toUpperCase()] = p;
  });
  ccWarehouses_ = {};
  (wh || []).forEach(function (w) {
    ccWarehouses_[String(w.warehouse_id || "").trim().toUpperCase()] = w;
  });
}

function ccCustomerName_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  const name = String(ccCustomers_[cid]?.customer_name || "").trim();
  return name || "—";
}

/** 寄賣案列／下拉：優先 API 的 customer_name，再查主檔；不顯示客戶 ID */
function ccCustomerDisplayName_(rowOrCustomerId) {
  if (rowOrCustomerId && typeof rowOrCustomerId === "object") {
    const fromRow = String(rowOrCustomerId.customer_name || "").trim();
    if (fromRow) return fromRow;
    return ccCustomerName_(rowOrCustomerId.customer_id);
  }
  return ccCustomerName_(rowOrCustomerId);
}

function ccProductName_(productId) {
  const pid = String(productId || "").trim().toUpperCase();
  return ccProducts_[pid]?.product_name || pid || "—";
}

function ccPoolUnit_(it) {
  const fromRow = String(it && it.unit != null ? it.unit : "").trim();
  if (fromRow) return fromRow;
  const pid = String(it && it.product_id != null ? it.product_id : "").trim().toUpperCase();
  return String(ccProducts_[pid]?.unit || "").trim() || "—";
}

function ccResolveFactoryLot_(it) {
  const direct = String(it && it.factory_lot != null ? it.factory_lot : "").trim();
  if (direct) return direct;
  const pid = String(it && it.pool_item_id != null ? it.pool_item_id : "").trim().toUpperCase();
  if (!pid) return "";
  const pools =
    typeof ccStlPoolItems_ !== "undefined" && Array.isArray(ccStlPoolItems_)
      ? ccStlPoolItems_
      : typeof ccRetPoolItems_ !== "undefined" && Array.isArray(ccRetPoolItems_)
        ? ccRetPoolItems_
        : typeof ccPoolItems_ !== "undefined" && Array.isArray(ccPoolItems_)
          ? ccPoolItems_
          : [];
  const pool = pools.find(function (p) {
    return String(p.pool_item_id || "").trim().toUpperCase() === pid;
  });
  return String(pool && pool.factory_lot != null ? pool.factory_lot : "").trim();
}

function ccWarehouseName_(warehouseId) {
  const wid = String(warehouseId || "").trim().toUpperCase();
  const w = ccWarehouses_[wid];
  return w?.warehouse_name || w?.warehouse_id || wid || "—";
}

const ccEnrichedCaseMap_ = {};

function ccMergeEnrichedCases_(rows) {
  (rows || []).forEach(function (c) {
    const id = String(c.case_id || "").trim().toUpperCase();
    if (id) ccEnrichedCaseMap_[id] = c;
  });
}

function ccGetEnrichedCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  return id ? ccEnrichedCaseMap_[id] || null : null;
}

function ccInvalidateEnrichedCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (id) delete ccEnrichedCaseMap_[id];
}

async function ccEnsureEnrichedCase_(caseId, opts) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return null;
  const force = !!(opts && opts.force);
  if (!force) {
    const cached = ccGetEnrichedCase_(id);
    if (cached) return cached;
  }
  const rows = await ccListCases_({ status: "ALL", case_id: id });
  return rows[0] || null;
}

async function ccListCases_(opts) {
  const p = opts || {};
  const r = await callAPI({
    action: "list_consignment_case_enriched",
    status: String(p.status || "OPEN"),
    customer_id: String(p.customer_id || ""),
    case_id: String(p.case_id || "").trim().toUpperCase(),
    limit: String(p.limit || "500")
  }, { method: "GET" });
  const rows = r?.data || [];
  ccMergeEnrichedCases_(rows);
  return rows;
}

/** 下拉專用：僅案件主檔 + 客戶名稱（不打 pool／結算／AR 彙總） */
async function ccListCasesForDropdown_(opts) {
  const p = opts || {};
  const r = await callAPI({
    action: "list_consignment_case_lite",
    status: String(p.status || "OPEN"),
    customer_id: String(p.customer_id || ""),
    case_id: String(p.case_id || "").trim().toUpperCase(),
    limit: String(p.limit || "500")
  }, { method: "GET" });
  return r?.data || [];
}

async function ccEnsureLiteCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return null;
  const rows = await ccListCasesForDropdown_({ status: "ALL", case_id: id });
  return rows[0] || null;
}

async function ccListPool_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return [];
  const r = await callAPI({ action: "list_consignment_case_pool_by_case", case_id: id }, { method: "GET" });
  return r?.data || [];
}

async function ccListSettlements_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return [];
  const r = await callAPI({ action: "list_consignment_case_settlement_by_case", case_id: id }, { method: "GET" });
  return r?.data || [];
}

async function ccListReturns_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return [];
  const r = await callAPI({ action: "list_consignment_case_return_by_case", case_id: id }, { method: "GET" });
  return r?.data || [];
}

async function ccCreateCase_(payload) {
  return callAPI(Object.assign({ action: "create_consignment_case_bundle" }, payload), { method: "POST" });
}

async function ccPostSettlement_(payload, callOpts) {
  return callAPI(
    Object.assign({ action: "post_consignment_case_settlement_bundle" }, payload),
    Object.assign({ method: "POST" }, callOpts || {})
  );
}

async function ccPreviewSettlementPromo_(payload, callOpts) {
  return callAPI(
    Object.assign({ action: "preview_consignment_case_settlement_promo" }, payload),
    Object.assign({ method: "POST" }, callOpts || {})
  );
}

async function ccPreviewCumulativeDealerForSettlement_(customerId, settlementDate, callOpts) {
  const cid = String(customerId || "").trim().toUpperCase();
  const ymd = String(settlementDate || "").trim();
  if (!cid || !ymd) return { enabled: false };
  return callAPI(
    {
      action: "preview_cumulative_dealer_for_settlement",
      customer_id: cid,
      settlement_date: ymd
    },
    Object.assign({ method: "POST" }, callOpts || {})
  );
}

function ccApplyCumulativeDealerPriceToLines_(lines, dealerCtx) {
  const src = lines || [];
  const out = src.map(function (ln) {
    if (!dealerCtx || !dealerCtx.enabled || String(ln.promo_scheme_id || "").trim()) return ln;
    return Object.assign({}, ln, {
      dealer_cumulative_tier_label: String(dealerCtx.tier_label || ""),
      dealer_cumulative_price_rate:
        dealerCtx.price_rate != null && dealerCtx.price_rate !== "" ? Number(dealerCtx.price_rate) : null,
      dealer_cumulative_price_source: String(dealerCtx.price_source || "CURRENT")
    });
  });
  const amountSystem = out.reduce(function (s, ln) {
    return s + Number(ln.amount || 0);
  }, 0);
  return { lines: out, amount_system: Math.round(amountSystem * 100) / 100 };
}

function ccFormatCumulativeDealerSettlementHtml_(ctx) {
  if (!ctx || !ctx.enabled) return "";
  let html =
    '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;font-size:13px;line-height:1.55;">' +
    "<strong>累積金額制經銷價</strong>：" +
    ccEsc_(ctx.tier_label || "—");
  if (ctx.price_rate != null) html += "（" + ctx.price_rate + " 折）";
  if (ctx.pending_effective) {
    html +=
      ' <span style="color:#15803d;">（套用次月待生效等級）</span>';
  } else if (ctx.pending_tier_label && ctx.price_source === "CURRENT") {
    html +=
      '<div style="color:#64748b;margin-top:4px;">次月待生效：' +
      ccEsc_(ctx.pending_tier_label);
    if (ctx.pending_price_rate != null) html += "（" + ctx.pending_price_rate + " 折）";
    html += "</div>";
  }
  html += '<div style="color:#64748b;margin-top:4px;">出貨已帶入經銷價；無促銷品項結算單價＝經銷價（不再乘等級折數）</div></div>';
  return html;
}

async function ccCancelSettlement_(payload) {
  return callAPI(Object.assign({ action: "cancel_consignment_case_settlement_bundle" }, payload), { method: "POST" });
}

async function ccCancelReturn_(payload) {
  return callAPI(Object.assign({ action: "cancel_consignment_case_return_bundle" }, payload), { method: "POST" });
}

async function ccPreviewReturn_(payload, callOpts) {
  return callAPI(
    Object.assign({ action: "preview_consignment_case_return_bundle" }, payload),
    Object.assign({ method: "POST" }, callOpts || {})
  );
}

async function ccPostReturn_(payload, callOpts) {
  return callAPI(
    Object.assign({ action: "post_consignment_case_return_bundle" }, payload),
    Object.assign({ method: "POST" }, callOpts || {})
  );
}

var CC_PROMO_TYPE_LABELS_ = {
  FIXED_PRICE: "固定促銷價",
  DISCOUNT_PCT: "折扣％",
  BUY_N_GET_M: "買N送M"
};

var CC_PROMO_CHANNEL_LABELS_ = {
  CONSIGNMENT: "寄賣",
  GENERAL: "一般銷售",
  ALL: "全部"
};

var CC_PROMO_SCOPE_LABELS_ = {
  CASE: "寄賣案",
  CUSTOMER: "客戶",
  GLOBAL: "全站"
};

var CC_PROMO_STATUS_LABELS_ = {
  DRAFT: "草稿",
  ACTIVE: "生效",
  ENDED: "結束"
};

function ccPromoChannelLabel_(row) {
  const ch = String(row?.channel || "CONSIGNMENT").trim().toUpperCase();
  return CC_PROMO_CHANNEL_LABELS_[ch] || ch;
}

function ccPromoStatusLabel_(status) {
  const s = String(status || "").trim().toUpperCase();
  return CC_PROMO_STATUS_LABELS_[s] || String(status || "—");
}

async function ccListPromoSchemes_() {
  const r = await callAPI({ action: "list_consignment_promo_scheme_enriched" }, { method: "GET" });
  return r?.data || [];
}

async function ccListPromoActiveForCase_(caseId, settlementDate) {
  const id = String(caseId || "").trim().toUpperCase();
  if (!id) return { promos: [], conflicts: {} };
  const r = await callAPI(
    {
      action: "list_consignment_promo_active_for_case",
      case_id: id,
      settlement_date: String(settlementDate || ccTodayYmd_()).trim()
    },
    { method: "GET" }
  );
  return r || { promos: [], conflicts: {} };
}

async function ccSavePromoScheme_(payload) {
  return callAPI(Object.assign({ action: "save_consignment_promo_scheme_bundle" }, payload), { method: "POST" });
}

async function ccEndPromoScheme_(payload) {
  return callAPI(Object.assign({ action: "end_consignment_promo_scheme_bundle" }, payload), { method: "POST" });
}

function ccPromoScopePriority_(scopeType) {
  const s = String(scopeType || "").trim().toUpperCase();
  if (s === "CASE") return 30;
  if (s === "CUSTOMER") return 20;
  if (s === "GLOBAL") return 10;
  return 0;
}

function ccBuildPromoCandidatesFromActive_(activePack) {
  if (activePack?.candidates && activePack.candidates.length) return activePack.candidates;
  const promos = activePack?.promos || [];
  return promos.map(function (p) {
    return {
      scheme_id: String(p.scheme_id || "").trim().toUpperCase(),
      scheme_name: String(p.scheme_name || p.scheme_id || ""),
      scope_type: String(p.scope_type || "").trim().toUpperCase(),
      product_id: String(p.product_id || "").trim().toUpperCase(),
      promo_type: String(p.promo_type || "").trim().toUpperCase(),
      promo_unit_price: Number(p.promo_unit_price || 0),
      discount_pct: Number(p.discount_pct || 0),
      buy_qty: Number(p.buy_qty || 0),
      free_qty: Number(p.free_qty || 0),
      priority: ccPromoScopePriority_(p.scope_type),
      created_at: String(p.created_at || "")
    };
  });
}

function ccPickPromoForProduct_(productId, candidates, overrides) {
  const pid = String(productId || "").trim().toUpperCase();
  let pool = (candidates || []).filter(function (c) {
    return c.product_id === pid;
  });
  if (!pool.length) return null;
  const forced = String((overrides && overrides[pid]) || "").trim().toUpperCase();
  if (forced) {
    pool = pool.filter(function (c) {
      return c.scheme_id === forced;
    });
    if (!pool.length) return null;
  }
  pool.sort(function (a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
  return pool[0];
}

function ccSettleUnitPriceForPromo_(listPrice, promo) {
  const list = Number(listPrice || 0);
  if (!promo) return list;
  const type = String(promo.promo_type || "").trim().toUpperCase();
  if (type === "FIXED_PRICE") {
    const p = Number(promo.promo_unit_price || 0);
    return p > 0 ? p : list;
  }
  if (type === "DISCOUNT_PCT") {
    const pct = Number(promo.discount_pct || 0);
    if (pct > 0) return Math.round(list * (pct / 100) * 100) / 100;
  }
  return list;
}

function ccRoundQty3_(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function ccAllocatePromoFreeHighPrice_(rows, freeTotal) {
  const sorted = rows
    .slice()
    .sort(function (a, b) {
      return Number(b.list_unit_price || 0) - Number(a.list_unit_price || 0);
    });
  let remaining = ccRoundQty3_(freeTotal);
  const freeMap = {};
  sorted.forEach(function (r) {
    const pid = String(r.pool_item_id || "").trim().toUpperCase();
    const sq = ccRoundQty3_(r.settle_qty);
    const fq = ccRoundQty3_(Math.min(remaining, sq));
    freeMap[pid] = fq;
    remaining = ccRoundQty3_(remaining - fq);
  });
  return freeMap;
}

function ccComputeSettlementPromoPreview_(rawItems, poolItems, activePack, promoOverrides) {
  const poolMap = {};
  (poolItems || []).forEach(function (it) {
    poolMap[String(it.pool_item_id || "").trim().toUpperCase()] = it;
  });
  const candidates = ccBuildPromoCandidatesFromActive_(activePack);
  const overrides = promoOverrides || {};
  const grouped = {};

  (rawItems || []).forEach(function (it) {
    const poolItemId = String(it.pool_item_id || "").trim().toUpperCase();
    const poolItem = poolMap[poolItemId];
    if (!poolItem) return;
    const settleQty = ccRoundQty3_(it.settle_qty);
    if (!(settleQty > 0)) return;
    const productId = String(poolItem.product_id || "").trim().toUpperCase();
    if (!grouped[productId]) grouped[productId] = [];
    grouped[productId].push({
      pool_item_id: poolItemId,
      settle_qty: settleQty,
      list_unit_price: Number(poolItem.unit_price || 0)
    });
  });

  const byPool = {};
  Object.keys(grouped).forEach(function (productId) {
    const rows = grouped[productId];
    const promo = ccPickPromoForProduct_(productId, candidates, overrides);
    const sumSettle = ccRoundQty3_(
      rows.reduce(function (s, r) {
        return s + r.settle_qty;
      }, 0)
    );
    let freeTotal = 0;
    if (promo && String(promo.promo_type || "").toUpperCase() === "BUY_N_GET_M") {
      const buy = Number(promo.buy_qty || 0);
      const free = Number(promo.free_qty || 0);
      if (buy > 0 && free > 0) {
        const bundle = buy + free;
        freeTotal = Math.floor(sumSettle / bundle + 1e-9) * free;
      }
    }
    const freeMap = ccAllocatePromoFreeHighPrice_(rows, freeTotal);
    rows.forEach(function (r) {
      const pid = String(r.pool_item_id || "").trim().toUpperCase();
      const settleQty = r.settle_qty;
      const freeQty = ccRoundQty3_(freeMap[pid] || 0);
      const billableQty = ccRoundQty3_(settleQty - freeQty);
      const listPrice = r.list_unit_price;
      const settlePrice = ccSettleUnitPriceForPromo_(listPrice, promo);
      const amount = Math.round(billableQty * settlePrice * 100) / 100;
      byPool[pid] = {
        pool_item_id: pid,
        settle_qty: settleQty,
        billable_qty: billableQty,
        free_qty: freeQty,
        list_unit_price: listPrice,
        settle_unit_price: settlePrice,
        amount: amount,
        promo_scheme_id: promo ? promo.scheme_id : "",
        promo_scheme_name: promo ? promo.scheme_name : "",
        promo_type: promo ? promo.promo_type : "",
        promo_discount_pct:
          promo && String(promo.promo_type || "").toUpperCase() === "DISCOUNT_PCT" ? Number(promo.discount_pct || 0) : null,
        promo_buy_qty:
          promo && String(promo.promo_type || "").toUpperCase() === "BUY_N_GET_M" ? Number(promo.buy_qty || 0) : null,
        promo_scheme_free_qty:
          promo && String(promo.promo_type || "").toUpperCase() === "BUY_N_GET_M" ? Number(promo.free_qty || 0) : null
      };
    });
  });

  const lines = [];
  let amountSystem = 0;
  (rawItems || []).forEach(function (it) {
    const poolItemId = String(it.pool_item_id || "").trim().toUpperCase();
    const settleQty = ccRoundQty3_(it.settle_qty);
    if (!(settleQty > 0)) return;
    const poolItem = poolMap[poolItemId];
    if (!poolItem) return;
    const row =
      byPool[poolItemId] ||
      (function () {
        const listPrice = Number(poolItem.unit_price || 0);
        return {
          pool_item_id: poolItemId,
          settle_qty: settleQty,
          billable_qty: settleQty,
          free_qty: 0,
          list_unit_price: listPrice,
          settle_unit_price: listPrice,
          amount: Math.round(listPrice * settleQty * 100) / 100,
          promo_scheme_id: "",
          promo_scheme_name: "",
          promo_type: ""
        };
      })();
    lines.push(row);
    amountSystem += Number(row.amount || 0);
  });
  return { lines: lines, amount_system: Math.round(amountSystem * 100) / 100 };
}

function ccFormatPromoProductDetail_(p) {
  const pname = ccProductName_(p.product_id);
  const type = String(p.promo_type || "").toUpperCase();
  if (type === "DISCOUNT_PCT") return pname + " " + p.discount_pct + "折";
  if (type === "BUY_N_GET_M") return pname + " 買" + p.buy_qty + "送" + p.free_qty;
  if (type === "FIXED_PRICE") return pname + " $" + ccFmtMoney_(p.promo_unit_price);
  const typeLabel = CC_PROMO_TYPE_LABELS_[type] || p.promo_type;
  return pname + " " + typeLabel;
}

function ccFormatActivePromoSummaryHtml_(activePack) {
  const promos = activePack?.promos || [];
  if (!promos.length) {
    return '<span class="text-muted">（本案目前無適用促銷）</span>';
  }
  const groups = {};
  const order = [];
  promos.forEach(function (p) {
    const sid = String(p.scheme_id || p.scheme_name || "").trim();
    if (!groups[sid]) {
      groups[sid] = {
        scheme_name: String(p.scheme_name || p.scheme_id || sid),
        items: []
      };
      order.push(sid);
    }
    groups[sid].items.push(p);
  });
  const parts = order.map(function (sid) {
    const g = groups[sid];
    const details = g.items
      .map(function (p) {
        return ccEsc_(ccFormatPromoProductDetail_(p));
      })
      .join("；");
    return ccEsc_(g.scheme_name) + "：" + details;
  });
  return (
    '<strong>適用促銷：</strong>' +
    parts.join("；") +
    ' <button type="button" class="btn-secondary btn-sm" style="margin-left:8px;" onclick="navigate(\'commercial_promo\')">方案管理</button>'
  );
}

function ccRenderCaseSelectOptions_(cases, selectedId, includeClosedHint) {
  const selId = String(selectedId || "").trim().toUpperCase();
  const rows = cases || [];
  if (!rows.length) {
    return '<option value="">（尚無寄賣案，請先到「案件」開案）</option>';
  }
  let html = '<option value="">請選擇</option>';
  rows.forEach(function (c) {
    const id = String(c.case_id || "").trim().toUpperCase();
    const label = ccFormatCaseDropdownLabel_(c);
    html += '<option value="' + ccEsc_(id) + '"' + (id === selId ? " selected" : "") + ">" + ccEsc_(label) + "</option>";
  });
  if (includeClosedHint && selId && !rows.some(function (c) { return String(c.case_id || "").trim().toUpperCase() === selId; })) {
    html += '<option value="' + ccEsc_(selId) + '" selected>' + ccEsc_(selId) + "｜（已結案或非進行中）</option>";
  }
  return html;
}

async function ccPopulateCaseDropdown_(selectId, opts) {
  const sel = document.getElementById(selectId);
  if (!sel) return [];
  const p = opts || {};
  let activeId = "";
  if (p.defaultEmpty) {
    activeId = String(p.selectedId || "").trim().toUpperCase();
  } else {
    activeId = String(p.selectedId || ccGetActiveCaseId_() || "").trim().toUpperCase();
  }
  sel.innerHTML = '<option value="">載入中…</option>';
  await ccLoadMasterData_();
  const status = String(p.status || "OPEN");
  const cases = await ccListCasesForDropdown_({ status: status, customer_id: p.customer_id || "" });
  let list = cases;
  if (activeId && !list.some(function (c) { return String(c.case_id || "").trim().toUpperCase() === activeId; })) {
    try {
      const extra = await ccEnsureLiteCase_(activeId);
      if (extra) list = [extra].concat(list);
    } catch (_e) {}
  }
  sel.innerHTML = ccRenderCaseSelectOptions_(list, activeId, true);
  sel.value = activeId || "";
  return list;
}

function ccBindCaseSelectChange_(selectId, onChange) {
  const sel = document.getElementById(selectId);
  if (!sel || sel.dataset.ccBound === "1") return;
  sel.dataset.ccBound = "1";
  sel.addEventListener("change", function () {
    const id = String(sel.value || "").trim().toUpperCase();
    ccSetActiveCaseId_(id);
    if (typeof onChange === "function") onChange(id);
  });
}

function ccExtractVoidReasonFromSystemRemark_(sys) {
  const voidLines = [];
  String(sys || "")
    .split("\n")
    .forEach(function (line) {
      const m = String(line || "")
        .trim()
        .match(/^\[作廢[^\]]*\]\s*(.+)$/);
      if (m && m[1]) voidLines.push(String(m[1]).trim());
    });
  return voidLines.join("；");
}

function ccPeriodYmFromYmd_(ymd) {
  const s = String(ymd || "").trim();
  if (s.length >= 7 && /^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  return "";
}

async function ccLoadLockedDealerRebateMonths_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return new Set();
  try {
    const r = await callAPI({ action: "list_commercial_dealer_rebate_enriched" }, { method: "GET" });
    const rows = Array.isArray(r?.data) ? r.data : [];
    const set = new Set();
    rows.forEach(function (row) {
      if (String(row.customer_id || "").trim().toUpperCase() !== cid) return;
      if (String(row.status || "").trim().toUpperCase() === "VOID") return;
      const ym = String(row.period_ym || "").trim();
      if (ym) set.add(ym);
    });
    return set;
  } catch (_e) {
    return new Set();
  }
}

function ccRenderHistoryRows_(settlements, returns, opts) {
  const kindFilter = (opts && opts.kindFilter) || "all";
  const rows = [];
  if (kindFilter === "all" || kindFilter === "settle") {
    (settlements || []).forEach(function (s) {
      const st = String(s.status || "POSTED").trim().toUpperCase();
      const createdAt = String(s.created_at || "").trim();
      const dateYmd = String(s.settlement_date || "").trim();
      rows.push({
        kind: "settle",
        sortDate: createdAt || dateYmd,
        typeLabel: st === "VOID" ? "結算（已作廢）" : "結算",
        docId: String(s.settlement_id || ""),
        date: dateYmd,
        createdAt: createdAt,
        amount: ccFmtMoney_(s.amount_system),
        arId: String(s.ar_id || ""),
        remark: String(s.remark || ""),
        voidReason: st === "VOID" ? ccExtractVoidReasonFromSystemRemark_(s.system_remark) : "",
        status: st,
        caseId: String(s.case_id || ""),
        items: Array.isArray(s.items) ? s.items : []
      });
    });
  }
  if (kindFilter === "all" || kindFilter === "return") {
    (returns || []).forEach(function (r) {
      const st = String(r.status || "POSTED").trim().toUpperCase();
      const reasonLabel = ccReturnReasonLabel_(r.return_reason);
      const reasonText = reasonLabel;
      const typeLabel = "收回（" + reasonText + (st === "VOID" ? "（已作廢）" : "") + "）";
      const createdAt = String(r.created_at || "").trim();
      const dateYmd = String(r.return_date || "").trim();
      rows.push({
        kind: "return",
        sortDate: createdAt || dateYmd,
        typeLabel: typeLabel,
        docId: String(r.return_id || ""),
        date: dateYmd,
        createdAt: createdAt,
        amount: "—",
        arId: "",
        reasonText: reasonText,
        warehouseId: String(r.return_warehouse_id || ""),
        warehouseName: ccWarehouseName_(r.return_warehouse_id),
        remark: String(r.remark || ""),
        voidReason: st === "VOID" ? ccExtractVoidReasonFromSystemRemark_(r.system_remark) : "",
        status: st,
        caseId: String(r.case_id || ""),
        items: Array.isArray(r.items) ? r.items : []
      });
    });
  }
  rows.sort(function (a, b) {
    if (typeof erpCompareNewestFirst_ === "function") {
      return erpCompareNewestFirst_(a, b, ["date", "createdAt"], "docId");
    }
    var da = String(a.date || a.createdAt || "");
    var db = String(b.date || b.createdAt || "");
    if (da !== db) return db.localeCompare(da);
    var ca = String(a.createdAt || "");
    var cb = String(b.createdAt || "");
    if (ca !== cb) return cb.localeCompare(ca);
    return b.docId.localeCompare(a.docId);
  });
  return rows;
}

function ccFormatHistoryTypeDocCell_(typeLabel, docId) {
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' +
    ccEsc_(typeLabel) +
    "</div>" +
    '<div class="cc-pool-stack-sub">' +
    ccEsc_(docId) +
    "</div>" +
    "</div>"
  );
}

function ccFormatReturnStoredRemarkHtml_(remark) {
  const raw = String(remark || "").trim();
  if (!raw) return "";
  const structured = [];
  const general = [];
  raw.split("\n").forEach(function (line) {
    const t = String(line || "").trim();
    if (!t) return;
    const mOther = t.match(/^【其他原因】(.+)$/);
    const mWh = t.match(/^【改倉】(.+)$/);
    if (mOther) structured.push({ label: "原因", text: String(mOther[1] || "").trim() });
    else if (mWh) structured.push({ label: "改倉", text: String(mWh[1] || "").trim() });
    else general.push(t);
  });
  if (!structured.length && !general.length) return "";
  if (!structured.length) {
    return (
      '<div class="cc-pool-stack-cell"><div class="cc-pool-stack-main">' +
      ccEsc_("備註：" + general.join(" ")) +
      "</div></div>"
    );
  }
  let html = '<div class="cc-pool-stack-cell">';
  structured.forEach(function (row, idx) {
    html +=
      '<div class="' +
      (idx === 0 && !general.length ? "cc-pool-stack-main" : "cc-pool-stack-sub") +
      '" style="' +
      (idx > 0 || general.length ? "color:#64748b;" : "") +
      '">' +
      ccEsc_(row.label + "：" + row.text) +
      "</div>";
  });
  if (general.length) {
    html +=
      '<div class="' +
      (structured.length ? "cc-pool-stack-sub" : "cc-pool-stack-main") +
      '">' +
      ccEsc_(general.length === 1 ? "備註：" + general[0] : general.join(" ")) +
      "</div>";
  }
  html += "</div>";
  return html;
}

function ccBuildReturnRemarkForApi_(otherNote, whChangeNote, generalRemark) {
  const parts = [];
  const o = String(otherNote || "").trim();
  const w = String(whChangeNote || "").trim();
  const g = String(generalRemark || "").trim();
  if (o) parts.push("【其他原因】" + o);
  if (w) parts.push("【改倉】" + w);
  if (g) parts.push(g);
  return parts.join("\n");
}

function ccFormatReturnHistoryRemarkCell_(remark, voidReason, status) {
  const body = ccFormatReturnStoredRemarkHtml_(remark);
  const st = String(status || "").trim().toUpperCase();
  const vr = st === "VOID" ? String(voidReason || "").trim() : "";
  const voidLine = vr ? "作廢：" + vr : "";
  if (!voidLine) return body || "";
  if (!body) {
    return (
      '<div class="cc-pool-stack-cell">' +
      '<div class="cc-pool-stack-sub" style="color:#94a3b8;">' +
      ccEsc_(voidLine) +
      "</div></div>"
    );
  }
  return (
    body.replace(/<\/div>\s*$/, "") +
    '<div class="cc-pool-stack-sub" style="color:#94a3b8;">' +
    ccEsc_(voidLine) +
    "</div></div>"
  );
}

function ccFormatHistoryRemarkCell_(remark, voidReason, status) {
  const st = String(status || "").trim().toUpperCase();
  const user = String(remark || "").trim();
  const vr = st === "VOID" ? String(voidReason || "").trim() : "";
  const voidLine = vr ? "作廢：" + vr : "";
  if (!voidLine) return user ? ccEsc_(user) : "";
  if (!user) {
    return (
      '<div class="cc-pool-stack-cell">' +
      '<div class="cc-pool-stack-sub" style="color:#94a3b8;">' +
      ccEsc_(voidLine) +
      "</div></div>"
    );
  }
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' +
    ccEsc_(user) +
    "</div>" +
    '<div class="cc-pool-stack-sub" style="color:#94a3b8;">' +
    ccEsc_(voidLine) +
    "</div></div>"
  );
}

function ccInferBuyNGetM_(settleQty, freeAllocated) {
  const settle = Number(settleQty || 0);
  const free = Number(freeAllocated || 0);
  if (!(settle > 0) || !(free > 0)) return null;
  let best = null;
  for (let buy = 1; buy <= Math.floor(settle); buy++) {
    for (let schemeFree = 1; schemeFree <= 10; schemeFree++) {
      const bundle = buy + schemeFree;
      if (bundle > settle + 1e-9) continue;
      const inferredFree = Math.floor(settle / bundle + 1e-9) * schemeFree;
      if (inferredFree !== free) continue;
      if (!best || buy < best.buy || (buy === best.buy && schemeFree < best.free)) {
        best = { buy: buy, free: schemeFree };
      }
    }
  }
  return best;
}

function ccFormatSettlementPromoLabelShort_(it) {
  const type = String(it.promo_type || "").trim().toUpperCase();
  const free = Number(it.free_qty || 0);
  const list = Number(it.list_unit_price != null ? it.list_unit_price : 0);
  const settle = Number(it.settle_unit_price != null ? it.settle_unit_price : it.unit_price || 0);
  const hasPricePromo = list > 0 && Math.abs(list - settle) > 1e-9;

  if (!type && free <= 0 && !hasPricePromo) return "";

  if (type === "BUY_N_GET_M" || (!type && free > 0)) {
    const buy = Number(it.promo_buy_qty || 0);
    const schemeFree = Number(it.promo_scheme_free_qty || 0);
    if (buy > 0 && schemeFree > 0) return "買" + buy + "送" + schemeFree;
    const inferred = ccInferBuyNGetM_(it.settle_qty, free);
    if (inferred) return "買" + inferred.buy + "送" + inferred.free;
    return free > 0 ? "買N送M" : "";
  }

  if (type === "FIXED_PRICE") {
    if (!(settle > 0)) return "";
    return "$" + ccFmtMoney_(settle);
  }

  if (type === "DISCOUNT_PCT" || hasPricePromo) {
    const pctFromLine = Number(it.promo_discount_pct || 0);
    let pct = pctFromLine > 0 ? pctFromLine : list > 0 && settle > 0 ? (settle / list) * 100 : 0;
    if (!(pct > 0)) return "";
    pct = Math.round(pct * 10) / 10;
    const pctStr = Math.abs(pct - Math.round(pct)) < 1e-9 ? String(Math.round(pct)) : String(pct);
    return pctStr + "%";
  }

  return "";
}

function ccSummarizeSettlementPromos_(items) {
  const map = {};
  (items || []).forEach(function (it) {
    const sid = String(it.promo_scheme_id || "").trim().toUpperCase();
    const name = String(it.promo_scheme_name || "").trim();
    if (!sid && !name) return;
    const key = sid || "NAME:" + name;
    if (!map[key]) map[key] = { scheme_id: sid, scheme_name: name };
  });
  return Object.keys(map).map(function (k) {
    return map[k];
  });
}

function ccFormatSettlementHistoryIdCell_(settlementId, items) {
  const promos = ccSummarizeSettlementPromos_(items);
  let promoLine = "—";
  if (promos.length === 1) {
    const p = promos[0];
    promoLine = p.scheme_id || p.scheme_name || "—";
  } else if (promos.length > 1) {
    promoLine = promos
      .map(function (p) {
        return p.scheme_id || p.scheme_name;
      })
      .filter(Boolean)
      .join("、");
  }
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' +
    ccEsc_(settlementId || "—") +
    "</div>" +
    '<div class="cc-pool-stack-sub">' +
    ccEsc_(promoLine) +
    "</div></div>"
  );
}

function ccSettlementItemPromoKind_(it) {
  const type = String(it.promo_type || "").trim().toUpperCase();
  if (type === "BUY_N_GET_M" || type === "DISCOUNT_PCT" || type === "FIXED_PRICE") return type;
  const free = Number(it.free_qty || 0);
  if (free > 0) return "BUY_N_GET_M";
  const list = Number(it.list_unit_price != null ? it.list_unit_price : 0);
  const settle = Number(it.settle_unit_price != null ? it.settle_unit_price : it.unit_price || 0);
  if (list > 0 && Math.abs(list - settle) > 1e-9) {
    if (Number(it.promo_discount_pct || 0) > 0) return "DISCOUNT_PCT";
    const pct = (settle / list) * 100;
    if (pct > 0 && pct < 99.99) return "DISCOUNT_PCT";
    return "FIXED_PRICE";
  }
  if (String(it.promo_scheme_id || "").trim() || String(it.promo_scheme_name || "").trim()) {
    const cols = ccSettlementPromoCols_(it);
    if (cols.free !== "—") return "BUY_N_GET_M";
    if (cols.discount !== "—") return "DISCOUNT_PCT";
    if (cols.fixedPrice !== "—") return "FIXED_PRICE";
  }
  return "";
}

function ccDetectSettlementPromoColFlags_(items) {
  const flags = { free: false, discount: false, fixedPrice: false };
  (items || []).forEach(function (it) {
    const kind = ccSettlementItemPromoKind_(it);
    if (kind === "BUY_N_GET_M") flags.free = true;
    else if (kind === "DISCOUNT_PCT") flags.discount = true;
    else if (kind === "FIXED_PRICE") flags.fixedPrice = true;
  });
  return flags;
}

function ccDetectPromoColFlagsFromActive_(activePack) {
  const flags = { free: false, discount: false, fixedPrice: false };
  (activePack?.promos || []).forEach(function (p) {
    const t = String(p.promo_type || "").trim().toUpperCase();
    if (t === "BUY_N_GET_M") flags.free = true;
    if (t === "DISCOUNT_PCT") flags.discount = true;
    if (t === "FIXED_PRICE") flags.fixedPrice = true;
  });
  return flags;
}

function ccSettlementPromoCols_(it) {
  const dash = "—";
  const type = String(it.promo_type || "").trim().toUpperCase();
  const free = Number(it.free_qty || 0);
  const list = Number(it.list_unit_price != null ? it.list_unit_price : 0);
  const settle = Number(it.settle_unit_price != null ? it.settle_unit_price : it.unit_price || 0);
  let freeCol = dash;
  let pctCol = dash;
  let priceCol = dash;

  function fmtPct_(pct) {
    pct = Math.round(pct * 10) / 10;
    const pctStr = Math.abs(pct - Math.round(pct)) < 1e-9 ? String(Math.round(pct)) : String(pct);
    return pctStr + "%";
  }

  if (type === "BUY_N_GET_M" || (!type && free > 0)) {
    freeCol = free > 0 ? String(Math.round(free * 1000) / 1000) : dash;
  } else if (type === "DISCOUNT_PCT") {
    let pct = Number(it.promo_discount_pct || 0);
    if (!(pct > 0) && list > 0 && settle > 0) pct = (settle / list) * 100;
    if (pct > 0) pctCol = fmtPct_(pct);
  } else if (type === "FIXED_PRICE") {
    priceCol = settle > 0 ? ccFmtMoney_(settle) : dash;
  } else if (list > 0 && Math.abs(list - settle) > 1e-9) {
    let pct = Number(it.promo_discount_pct || 0);
    if (!(pct > 0)) pct = (settle / list) * 100;
    if (pct > 0) pctCol = fmtPct_(pct);
    else priceCol = settle > 0 ? ccFmtMoney_(settle) : dash;
  }

  return { free: freeCol, discount: pctCol, fixedPrice: priceCol };
}

function ccFormatSettlementPromoSubline_(it) {
  const detail = ccFormatSettlementPromoLabelShort_(it);
  const schemeName = String(it.promo_scheme_name || "").trim();
  let text = "";
  if (schemeName && detail) text = schemeName + "：" + detail;
  else if (schemeName) text = schemeName;
  else if (detail) text = detail;
  if (!text) return "";
  return '<div class="cc-pool-stack-sub">' + ccEsc_(text) + "</div>";
}

function ccFormatSettlementItemQty_(it) {
  const settle = Math.round(Number(it.settle_qty || 0) * 1000) / 1000;
  const billable = Number(it.billable_qty != null ? it.billable_qty : settle);
  const free = Number(it.free_qty || 0);
  return { settle: settle, billable: billable, free: free };
}

function ccFormatSettlementUnitPriceCell_(it) {
  const settle = Number(it.settle_unit_price != null ? it.settle_unit_price : it.unit_price || 0);
  const list = Number(it.list_unit_price != null ? it.list_unit_price : settle);
  if (Math.abs(list - settle) > 1e-9) {
    return (
      ccEsc_(ccFmtMoney_(settle)) +
      '<div style="font-size:12px;color:#64748b;margin-top:2px;">經銷價 ' +
      ccEsc_(ccFmtMoney_(list)) +
      "</div>"
    );
  }
  return ccEsc_(ccFmtMoney_(settle));
}

function ccFormatSettlementItemDetailHtml_(items) {
  const rows = items || [];
  if (!rows.length) {
    return '<div class="text-muted" style="padding:8px 12px;">尚無明細資料</div>';
  }
  const hasPromoSplit = rows.some(function (it) {
    const q = ccFormatSettlementItemQty_(it);
    return q.free > 0 || Math.abs(q.billable - q.settle) > 1e-9;
  });
  const promoFlags = ccDetectSettlementPromoColFlags_(rows);
  let html =
    '<table class="data-table" style="margin:8px 0;font-size:13px;background:#fff;">' +
    "<thead><tr>" +
    "<th>產品</th><th>加工廠 Lot</th><th>結算量</th>";
  if (promoFlags.free) html += "<th>贈送</th>";
  if (promoFlags.discount) html += "<th>折扣%</th>";
  if (promoFlags.fixedPrice) html += "<th>促銷單價</th>";
  html += "<th>計價量</th><th>單位</th><th>單價</th><th>金額</th></tr></thead><tbody>";
  rows.forEach(function (it) {
    const q = ccFormatSettlementItemQty_(it);
    const promoCols = ccSettlementPromoCols_(it);
    html +=
      "<tr>" +
      "<td>" +
      '<div class="cc-pool-stack-cell">' +
      '<div class="cc-pool-stack-main">' +
      ccEsc_(ccProductName_(it.product_id)) +
      "</div>" +
      ccFormatSettlementPromoSubline_(it) +
      "</div>" +
      "</td>" +
      "<td>" +
      ccEsc_(ccResolveFactoryLot_(it) || "—") +
      "</td>" +
      "<td>" +
      ccEsc_(String(q.settle)) +
      "</td>";
    if (promoFlags.free) html += "<td>" + ccEsc_(promoCols.free) + "</td>";
    if (promoFlags.discount) html += "<td>" + ccEsc_(promoCols.discount) + "</td>";
    if (promoFlags.fixedPrice) html += "<td>" + ccEsc_(promoCols.fixedPrice) + "</td>";
    html +=
      "<td>" +
      ccEsc_(String(q.billable)) +
      "</td>" +
      "<td>" +
      ccEsc_(ccPoolUnit_(it)) +
      "</td>" +
      "<td>" +
      ccFormatSettlementUnitPriceCell_(it) +
      "</td>" +
      "<td>" +
      ccEsc_(ccFmtMoney_(it.amount)) +
      "</td>" +
      "</tr>";
  });
  html += "</tbody></table>";
  if (hasPromoSplit && promoFlags.free) {
    html +=
      '<div style="font-size:12px;color:#64748b;padding:0 12px 8px;">※ 金額＝計價量×結算單價（贈送件不計價）</div>';
  }
  return html;
}

function ccFormatReturnQtyWithUnit_(it) {
  const qty = Number(it.return_qty != null ? it.return_qty : 0);
  const qtyStr = String(Math.round(qty * 1000) / 1000);
  const unit = ccPoolUnit_(it);
  if (!unit || unit === "—") return qtyStr;
  return qtyStr + unit;
}

function ccFormatReturnItemDetailHtml_(items) {
  const rows = items || [];
  if (!rows.length) {
    return '<div class="text-muted" style="padding:8px 12px;">尚無明細資料</div>';
  }
  let html =
    '<table class="data-table" style="margin:8px 0;font-size:13px;background:#fff;">' +
    "<thead><tr>" +
    "<th>產品</th><th>加工廠 Lot</th><th>收回量</th><th>出貨日</th><th>出貨倉</th>" +
    "</tr></thead><tbody>";
  rows.forEach(function (it) {
    const shipDate = String(it.ship_date || "").trim() || "—";
    const wh = ccWarehouseName_(it.ship_warehouse_id || it.warehouse_id);
    html +=
      "<tr>" +
      "<td>" +
      ccEsc_(ccProductName_(it.product_id)) +
      "</td>" +
      "<td>" +
      ccEsc_(ccResolveFactoryLot_(it) || "—") +
      "</td>" +
      "<td>" +
      ccEsc_(ccFormatReturnQtyWithUnit_(it)) +
      "</td>" +
      "<td>" +
      ccEsc_(shipDate) +
      "</td>" +
      "<td>" +
      ccEsc_(wh) +
      "</td>" +
      "</tr>";
  });
  html += "</tbody></table>";
  return html;
}

function ccToggleHistoryDetailRow_(detailId) {
  const id = String(detailId || "").trim();
  if (!id) return;
  const detailRow = document.querySelector('tr.cc-history-detail-row[data-cc-history-detail="' + id + '"]');
  const mainRow = document.querySelector('tr.cc-history-row[data-cc-history-detail="' + id + '"]');
  if (!detailRow) return;
  const open = detailRow.style.display !== "none";
  detailRow.style.display = open ? "none" : "";
  if (mainRow) {
    mainRow.classList.toggle("erp-list-row-open", !open);
    mainRow.setAttribute("aria-expanded", open ? "false" : "true");
  }
}

function ccHistoryStopProp_(handler) {
  return "event.stopPropagation();" + String(handler || "");
}

function ccIsoTimeHm_(isoLike) {
  if (typeof erpFormatLocalTimeHm_ === "function") return erpFormatLocalTimeHm_(isoLike);
  const raw = String(isoLike || "").trim();
  if (!raw) return "";
  const full = typeof erpFormatListDateTime_ === "function" ? erpFormatListDateTime_(raw) : raw;
  const m = String(full || "").match(/(\d{2}:\d{2})$/);
  return m ? m[1] : "";
}

function ccFormatHistoryDateTimeCell_(dateYmd, createdAt) {
  const d = String(dateYmd || "").trim() || "—";
  const t = ccIsoTimeHm_(createdAt);
  if (!t) return ccEsc_(d);
  return (
    '<div class="cc-pool-stack-cell">' +
    '<div class="cc-pool-stack-main">' +
    ccEsc_(d) +
    "</div>" +
    '<div class="cc-pool-stack-sub" style="color:#94a3b8;font-size:12px;margin-top:2px;">' +
    ccEsc_(t) +
    "</div>" +
    "</div>"
  );
}

function ccRenderHistoryTableHtml_(settlements, returns, tbodyId, opts) {
  const body = document.getElementById(tbodyId);
  if (!body) return;
  const o = opts || {};
  const mode = o.mode || "full";
  const rows = ccRenderHistoryRows_(settlements, returns, o);
  const colCount = o.caseDetail ? 5 : mode === "labels" ? 1 : 6;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="' + colCount + '" class="text-muted">尚無紀錄</td></tr>';
    return;
  }
  if (mode === "labels") {
    body.innerHTML = rows
      .map(function (row) {
        const rowStyle = row.status === "VOID" ? ' style="color:#64748b;"' : "";
        return (
          "<tr" +
          rowStyle +
          "><td>" +
          ccFormatHistoryTypeDocCell_(row.typeLabel, row.docId) +
          "</td></tr>"
        );
      })
      .join("");
    return;
  }
  body.innerHTML = rows
    .map(function (row) {
      const actions = [];
      const settleDetail = o.settleDetail === true;
      const returnDetail = o.returnDetail === true;
      const caseDetail = o.caseDetail === true;
      let detailId = "";
      if (caseDetail && (row.kind === "settle" || row.kind === "return")) {
        detailId =
          "cc-case-d-" +
          row.kind +
          "-" +
          String(row.docId || "").replace(/[^A-Za-z0-9_-]/g, "");
      } else if (settleDetail && row.kind === "settle") {
        detailId = "cc-stl-d-" + String(row.docId || "").replace(/[^A-Za-z0-9_-]/g, "");
      } else if (returnDetail && row.kind === "return") {
        detailId = "cc-ret-d-" + String(row.docId || "").replace(/[^A-Za-z0-9_-]/g, "");
      }
      const clickable = !!detailId;
      if (!caseDetail) {
        if (row.kind === "settle" && row.arId && row.status !== "VOID") {
          actions.push(
            '<button class="btn-secondary btn-sm" type="button" onclick="' +
              (clickable
                ? ccHistoryStopProp_(
                    "navigate('ar');setTimeout(function(){arSelect_('" + row.arId.replace(/'/g, "\\'") + "');},400);"
                  )
                : "navigate('ar');setTimeout(function(){arSelect_('" + row.arId.replace(/'/g, "\\'") + "');},400);") +
              '">AR</button>'
          );
        }
        if (row.kind === "settle" && row.status === "POSTED" && ccCanOperate_()) {
          const locked = o.lockedRebatePeriods;
          const periodYm = ccPeriodYmFromYmd_(row.date);
          const rebateLocked =
            locked &&
            periodYm &&
            (locked instanceof Set ? locked.has(periodYm) : locked[periodYm]);
          if (rebateLocked) {
            actions.push(
              '<button class="btn-secondary btn-sm" type="button" disabled title="此月份已產生月結回饋，請先到 Rebate 月結回饋作廢該筆後，再作廢結算">作廢</button>'
            );
          } else {
          actions.push(
            '<button class="btn-secondary btn-sm" type="button" onclick="' +
              (clickable
                ? ccHistoryStopProp_(
                    "ccCancelSettlementPrompt_('" +
                      String(row.docId || "").replace(/'/g, "\\'") +
                      "','" +
                      String(row.caseId || "").replace(/'/g, "\\'") +
                      "')"
                  )
                : "ccCancelSettlementPrompt_('" +
                  String(row.docId || "").replace(/'/g, "\\'") +
                  "','" +
                  String(row.caseId || "").replace(/'/g, "\\'") +
                  "')") +
              '">作廢</button>'
          );
          }
        }
        if (row.kind === "return" && row.status === "POSTED" && ccCanOperate_()) {
          actions.push(
            '<button class="btn-secondary btn-sm" type="button" onclick="' +
              (clickable
                ? ccHistoryStopProp_(
                    "ccCancelReturnPrompt_('" +
                      String(row.docId || "").replace(/'/g, "\\'") +
                      "','" +
                      String(row.caseId || "").replace(/'/g, "\\'") +
                      "')"
                  )
                : "ccCancelReturnPrompt_('" +
                  String(row.docId || "").replace(/'/g, "\\'") +
                  "','" +
                  String(row.caseId || "").replace(/'/g, "\\'") +
                  "')") +
              '">作廢</button>'
          );
        }
      }
      let actionHtml;
      if (!caseDetail) {
        if (row.status === "VOID") {
          const vr = String(row.voidReason || "").trim();
          actionHtml =
            '<span class="text-muted" style="font-size:13px;">' +
            ccEsc_(vr ? "已作廢：" + vr : "已作廢") +
            "</span>";
        } else {
          actionHtml = actions.length ? actions.join(" ") : "—";
        }
      }
      const remarkHtml =
        row.kind === "return"
          ? caseDetail
            ? ccFormatReturnHistoryRemarkCell_(row.remark, row.voidReason, row.status)
            : ccFormatReturnStoredRemarkHtml_(row.remark)
          : caseDetail
          ? ccFormatHistoryRemarkCell_(row.remark, row.voidReason, row.status)
          : ccEsc_(row.remark);
      const rowStyle = row.status === "VOID" ? ' style="color:#64748b;"' : "";
      const mainTrOpen = clickable
        ? ' class="cc-history-row erp-list-row-selectable" data-cc-history-detail="' +
          detailId +
          '" onclick="ccToggleHistoryDetailRow_(\'' +
          detailId +
          '\')" aria-expanded="false" style="' +
          (row.status === "VOID" ? "color:#64748b;" : "") +
          '"'
        : rowStyle;
      let col1 = ccFormatHistoryTypeDocCell_(row.typeLabel, row.docId);
      if (caseDetail) {
        let kindLabel = row.kind === "settle" ? "結算" : "收回";
        if (row.status === "VOID") kindLabel += "（已作廢）";
        col1 = ccFormatHistoryTypeDocCell_(kindLabel, row.docId);
      } else if (settleDetail && row.kind === "settle") {
        col1 = ccFormatSettlementHistoryIdCell_(row.docId, row.items);
      }
      if (returnDetail && row.kind === "return") col1 = ccEsc_(row.docId || "—");
      let col3 = ccEsc_(row.amount);
      let col4 = ccEsc_(row.arId || "—");
      if (caseDetail) {
        col3 = row.kind === "settle" ? ccEsc_(row.amount) : ccEsc_(row.reasonText || "—");
        col4 = row.kind === "settle" ? ccEsc_(row.arId || "—") : ccEsc_(row.warehouseName || "—");
      } else if (returnDetail && row.kind === "return") {
        col3 = ccEsc_(row.reasonText || "—");
        col4 = ccEsc_(row.warehouseName || "—");
      }
      const mainTr =
        "<tr" +
        mainTrOpen +
        ">" +
        "<td>" +
        col1 +
        "</td>" +
        "<td>" +
        ccFormatHistoryDateTimeCell_(row.date, row.createdAt) +
        "</td>" +
        "<td>" +
        col3 +
        "</td>" +
        "<td>" +
        col4 +
        "</td>" +
        "<td>" +
        remarkHtml +
        "</td>" +
        (caseDetail ? "" : "<td>" + actionHtml + "</td>") +
        "</tr>";
      if (!detailId) return mainTr;
      const detailHtml =
        row.kind === "settle"
          ? ccFormatSettlementItemDetailHtml_(row.items)
          : ccFormatReturnItemDetailHtml_(row.items);
      const detailVoid = row.status === "VOID";
      return (
        mainTr +
        '<tr class="cc-history-detail-row' +
        (detailVoid ? " cc-history-detail-row-void" : "") +
        '" data-cc-history-detail="' +
        detailId +
        '" style="display:none;"><td colspan="' +
        colCount +
        '" style="background:#f8fafc;padding:0 8px 8px;' +
        (detailVoid ? "color:#64748b;" : "") +
        '">' +
        detailHtml +
        "</td></tr>"
      );
    })
    .join("");
}

async function ccRefreshPagesAfterCaseChange_(caseId) {
  const active = String(caseId || ccGetActiveCaseId_() || "").trim().toUpperCase();
  if (!active) return;
  ccInvalidateEnrichedCase_(active);
  if (typeof ccSelectCase_ === "function" && document.getElementById("cc_history_tbody")) {
    await ccSelectCase_(active);
  }
  if (typeof ccSettlementLoadCase_ === "function" && document.getElementById("cc_stl_history_tbody")) {
    await ccSettlementLoadCase_(active);
  }
  if (typeof ccReturnLoadCase_ === "function" && document.getElementById("cc_ret_history_tbody")) {
    await ccReturnLoadCase_(active);
  }
}

async function ccCancelSettlementPrompt_(settlementId, caseId) {
  if (!ccCanOperate_()) return showToast("您沒有權限作廢結算", "error");
  const sid = String(settlementId || "").trim().toUpperCase();
  if (!sid) return;

  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason == null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");

  const ok = window.erpConfirmActionKey_
    ? window.erpConfirmActionKey_("confirm.consignment.settlement.void", {
        fallback:
          "確定作廢結算 " +
          sid +
          "？\n\n將還原品項池結算量，並結清對應 AR（不可已有收款）。"
      })
    : window.confirm("確定作廢結算 " + sid + "？");
  if (!ok) return;

  try {
    await ccCancelSettlement_({
      settlement_id: sid,
      void_reason: String(reason).trim(),
      updated_by: getCurrentUser()
    });
    showToast("結算已作廢：" + sid, "success", 5000);
    await ccRefreshPagesAfterCaseChange_(caseId);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗：請稍後重試", "error");
  }
}

async function ccCancelReturnPrompt_(returnId, caseId) {
  if (!ccCanOperate_()) return showToast("您沒有權限作廢收回", "error");
  const rid = String(returnId || "").trim().toUpperCase();
  if (!rid) return;

  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason == null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");

  const ok = window.erpConfirmActionKey_
    ? window.erpConfirmActionKey_("confirm.consignment.return.void", {
        fallback:
          "確定作廢收回 " +
          rid +
          "？\n\n將沖銷退回倉庫的入庫異動，並還原品項池收回量（Lot 可用量須足夠）。"
      })
    : window.confirm("確定作廢收回 " + rid + "？");
  if (!ok) return;

  try {
    await ccCancelReturn_({
      return_id: rid,
      void_reason: String(reason).trim(),
      updated_by: getCurrentUser()
    });
    showToast("收回已作廢：" + rid, "success", 5000);
    await ccRefreshPagesAfterCaseChange_(caseId);
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗：請稍後重試", "error");
  }
}
