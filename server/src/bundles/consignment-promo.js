const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { readSessionValid } = require("../session");
const { nowIso, buildShortPromoSchemeId_, buildShortMasterId_, parseJsonArray, writeAuditLog_ } = require("./shared");
const { canManageAr_ } = require("./ar");
const {
  resolveCumulativeDealerPriceForSettlement_,
  applyCumulativeDealerPriceToLines_,
  applyDealerCreditAtShipment_,
  processCumulativeOnGeneralShipment_,
  syncCustomerCumulativeFromSources_
} = require("./commercial-dealer");
const { createArFromShipment_ } = require("./ar");

const PROMO_TYPES_ = {
  FIXED_PRICE: 1,
  DISCOUNT_PCT: 1,
  BUY_N_GET_M: 1
};

const SCOPE_PRIORITY_ = {
  CASE: 30,
  CUSTOMER: 20,
  GLOBAL: 10
};

function normId_(v) {
  return String(v || "").trim().toUpperCase();
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function roundQty_(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function normPriceBasis_(v) {
  const s = normId_(v);
  return s === "LIST" ? "LIST" : "DEALER";
}

function resolveDealerUnitPrice_(listPrice, dealerCtx, fallbackUnitPrice) {
  const list = Number(listPrice || 0);
  if (dealerCtx?.enabled && Number(dealerCtx.price_rate) > 0 && list > 0) {
    return roundMoney_(list * Number(dealerCtx.price_rate) / 100);
  }
  const fb = Number(fallbackUnitPrice || 0);
  if (fb > 0) return roundMoney_(fb);
  return list > 0 ? roundMoney_(list) : 0;
}

function resolvePromoBaseUnitPrice_(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const priceBasis = normPriceBasis_(o.priceBasis);
  const listPrice = Number(o.listPrice || 0);
  const dealerCtx = o.dealerCtx || { enabled: false };
  const fallback = Number(o.fallbackUnitPrice || 0);
  if (priceBasis === "LIST") {
    if (listPrice > 0) return roundMoney_(listPrice);
    return fallback > 0 ? roundMoney_(fallback) : 0;
  }
  return resolveDealerUnitPrice_(listPrice, dealerCtx, fallback);
}

function isDateInRange_(ymd, fromYmd, toYmd) {
  const d = String(ymd || "").trim();
  const f = String(fromYmd || "").trim();
  const t = String(toYmd || "").trim();
  if (!d || !f || !t) return false;
  return d >= f && d <= t;
}

function scopePriority_(scopeType) {
  return SCOPE_PRIORITY_[normId_(scopeType)] || 0;
}

function requireConsignmentPromoSession_(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const sess = readSessionValid(tok);
  if (!sess) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const mods = String(sess.allowed_modules || "").trim().toLowerCase();
  if (mods && mods !== "*") {
    const list = mods.split(",").map((x) => x.trim()).filter(Boolean);
    const ok =
      list.includes("consignment") ||
      list.includes("commercial_promo");
    if (!ok) return fail("Permission denied: consignment module", "ERR_PERMISSION_DENIED");
  }
  return null;
}

function parsePromoOverrides_(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out = {};
    Object.keys(raw).forEach((k) => {
      out[normId_(k)] = normId_(raw[k]);
    });
    return out;
  }
  const pack = parseJsonArray(raw, "promo_overrides_json");
  if (pack.err) return {};
  const out = {};
  (pack.data || []).forEach((row) => {
    const pid = normId_(row?.product_id);
    const sid = normId_(row?.scheme_id);
    if (pid && sid) out[pid] = sid;
  });
  return out;
}

function promoChannelAllows_(schemeChannel, wantChannel) {
  const ch = normId_(schemeChannel) || "CONSIGNMENT";
  const want = normId_(wantChannel) || "CONSIGNMENT";
  if (ch === "ALL") return true;
  return ch === want;
}

async function loadPromoSchemePacks_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cid = normId_(o.caseId);
  const cust = normId_(o.customerId);
  const ymd = String(o.dateYmd || "").trim();
  const channel = normId_(o.channel) || "CONSIGNMENT";
  const excludeCaseScope = !!o.excludeCaseScope;
  const forHistory = !!o.forHistory;
  if (!cust || !ymd) return [];
  if (channel === "CONSIGNMENT" && !cid) return [];

  let schemeQuery = sb.from("consignment_promo_scheme").select("*");
  schemeQuery = forHistory ? schemeQuery.in("status", ["ACTIVE", "ENDED"]) : schemeQuery.eq("status", "ACTIVE");
  const { data: schemes, error } = await schemeQuery;
  if (error) throw new Error(error.message || String(error));

  const matched = (schemes || []).filter((s) => {
    if (!promoChannelAllows_(s.channel, channel)) return false;
    if (!isDateInRange_(ymd, s.date_from, s.date_to)) return false;
    const scope = normId_(s.scope_type);
    if (excludeCaseScope && scope === "CASE") return false;
    if (scope === "CASE") return normId_(s.case_id) === cid;
    if (scope === "CUSTOMER") return normId_(s.customer_id) === cust;
    if (scope === "GLOBAL") return true;
    return false;
  });
  if (!matched.length) return [];

  const schemeIds = matched.map((s) => normId_(s.scheme_id)).filter(Boolean);
  const { data: lines, error: lineErr } = await sb
    .from("consignment_promo_scheme_line")
    .select("*")
    .in("scheme_id", schemeIds);
  if (lineErr) throw new Error(lineErr.message || String(lineErr));

  const lineMap = {};
  (lines || []).forEach((ln) => {
    const sid = normId_(ln.scheme_id);
    if (!lineMap[sid]) lineMap[sid] = [];
    lineMap[sid].push(ln);
  });

  return matched.map((s) => {
    const sid = normId_(s.scheme_id);
    return {
      scheme: s,
      lines: lineMap[sid] || [],
      priority: scopePriority_(s.scope_type)
    };
  });
}

async function loadPromoSchemesForCase_(sb, caseId, customerId, settlementDate, opts) {
  return loadPromoSchemePacks_(sb, {
    caseId,
    customerId,
    dateYmd: settlementDate,
    channel: "CONSIGNMENT",
    forHistory: !!(opts && opts.forHistory)
  });
}

async function loadPromoSchemesForGeneralShipment_(sb, customerId, shipDate, opts) {
  return loadPromoSchemePacks_(sb, {
    customerId,
    dateYmd: shipDate,
    channel: "GENERAL",
    excludeCaseScope: true,
    forHistory: !!(opts && opts.forHistory)
  });
}

async function loadSoItemsMapForPromo_(sb, soItemIds) {
  const map = {};
  const ids = [...new Set((soItemIds || []).map((id) => normId_(id)).filter(Boolean))];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const { data } = await sb.from("sales_order_item").select("*").eq("so_item_id", id).maybeSingle();
    if (data) map[id] = data;
  }
  return map;
}

async function loadProductListPriceMap_(sb, productIds) {
  const map = {};
  const ids = [...new Set((productIds || []).map((id) => normId_(id)).filter(Boolean))];
  for (let i = 0; i < ids.length; i++) {
    const pid = ids[i];
    const { data } = await sb.from("product").select("product_id, suggested_retail_price").eq("product_id", pid).maybeSingle();
    if (data) {
      const raw = data.suggested_retail_price;
      map[pid] = raw != null && raw !== "" && Number(raw) >= 0 ? Number(raw) : null;
    }
  }
  return map;
}

function buildPromoCandidates_(schemePacks) {
  const candidates = [];
  (schemePacks || []).forEach((pack) => {
    const scheme = pack.scheme;
    const sid = normId_(scheme.scheme_id);
    (pack.lines || []).forEach((ln) => {
      const promoType = normId_(ln.promo_type);
      if (!PROMO_TYPES_[promoType]) return;
      candidates.push({
        scheme_id: sid,
        scheme_name: String(scheme.scheme_name || sid),
        scope_type: normId_(scheme.scope_type),
        product_id: normId_(ln.product_id),
        promo_type: promoType,
        price_basis: normPriceBasis_(scheme.price_basis),
        promo_unit_price: Number(ln.promo_unit_price || 0),
        discount_pct: Number(ln.discount_pct || 0),
        buy_qty: Number(ln.buy_qty || 0),
        free_qty: Number(ln.free_qty || 0),
        priority: pack.priority,
        created_at: String(scheme.created_at || "")
      });
    });
  });
  return candidates;
}

function pickPromoForProduct_(productId, candidates, overrides, createdAtSortDesc) {
  const pid = normId_(productId);
  let pool = (candidates || []).filter((c) => c.product_id === pid);
  if (!pool.length) return null;

  const forced = normId_(overrides && overrides[pid]);
  if (forced) {
    pool = pool.filter((c) => c.scheme_id === forced);
    if (!pool.length) return null;
  }

  pool.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (createdAtSortDesc) return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });
  return pool[0];
}

function settleUnitPrice_(listPrice, promo) {
  const list = Number(listPrice || 0);
  if (!promo) return list;
  const type = normId_(promo.promo_type);
  if (type === "FIXED_PRICE") {
    const p = Number(promo.promo_unit_price || 0);
    return p > 0 ? p : list;
  }
  if (type === "DISCOUNT_PCT") {
    const pct = Number(promo.discount_pct || 0);
    if (pct > 0) return roundMoney_(list * (pct / 100));
    return list;
  }
  return list;
}

function allocateFreeQtyHighPriceFirst_(rows, freeTotal) {
  const sorted = rows
    .slice()
    .sort((a, b) => Number(b.list_unit_price || 0) - Number(a.list_unit_price || 0));
  let remaining = roundQty_(freeTotal);
  const freeMap = {};
  sorted.forEach((r) => {
    const pid = normId_(r.pool_item_id);
    const sq = roundQty_(r.settle_qty);
    const fq = roundQty_(Math.min(remaining, sq));
    freeMap[pid] = fq;
    remaining = roundQty_(remaining - fq);
  });
  return freeMap;
}

function computeSettlementPromoLines_(rawItems, poolMap, schemePacks, promoOverrides) {
  const overrides = promoOverrides || {};
  const candidates = buildPromoCandidates_(schemePacks);

  const grouped = {};
  (rawItems || []).forEach((it) => {
    const poolItemId = normId_(it.pool_item_id);
    const poolItem = poolMap[poolItemId];
    if (!poolItem) return;
    const settleQty = roundQty_(it.settle_qty);
    if (!(settleQty > 0)) return;
    const productId = normId_(poolItem.product_id);
    if (!grouped[productId]) grouped[productId] = [];
    grouped[productId].push({
      pool_item_id: poolItemId,
      pool_item: poolItem,
      settle_qty: settleQty,
      list_unit_price: Number(poolItem.unit_price || 0)
    });
  });

  const computedByPool = {};

  Object.keys(grouped).forEach((productId) => {
    const rows = grouped[productId];
    const promo = pickPromoForProduct_(productId, candidates, overrides, true);
    const sumSettle = roundQty_(rows.reduce((s, r) => s + r.settle_qty, 0));

    let freeTotal = 0;
    if (promo && normId_(promo.promo_type) === "BUY_N_GET_M") {
      const buy = Number(promo.buy_qty || 0);
      const free = Number(promo.free_qty || 0);
      if (buy > 0 && free > 0) {
        const bundle = buy + free;
        freeTotal = Math.floor(sumSettle / bundle + 1e-9) * free;
      }
    }

    const freeMap = allocateFreeQtyHighPriceFirst_(rows, freeTotal);

    rows.forEach((r) => {
      const pid = normId_(r.pool_item_id);
      const settleQty = r.settle_qty;
      const freeQty = roundQty_(freeMap[pid] || 0);
      const billableQty = roundQty_(settleQty - freeQty);
      const listPrice = r.list_unit_price;
      const settlePrice = settleUnitPrice_(listPrice, promo);
      const amount = roundMoney_(billableQty * settlePrice);

      computedByPool[pid] = {
        pool_item_id: pid,
        settle_qty: settleQty,
        billable_qty: billableQty,
        free_qty: freeQty,
        list_unit_price: listPrice,
        settle_unit_price: settlePrice,
        unit_price: settlePrice,
        amount,
        promo_scheme_id: promo ? promo.scheme_id : "",
        promo_type: promo ? promo.promo_type : "",
        promo_scheme_name: promo ? promo.scheme_name : "",
        promo_discount_pct:
          promo && normId_(promo.promo_type) === "DISCOUNT_PCT" ? Number(promo.discount_pct || 0) : null,
        promo_buy_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.buy_qty || 0) : null,
        promo_scheme_free_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.free_qty || 0) : null
      };
    });
  });

  const result = [];
  (rawItems || []).forEach((it) => {
    const poolItemId = normId_(it.pool_item_id);
    const settleQty = roundQty_(it.settle_qty);
    if (!(settleQty > 0)) return;
    const poolItem = poolMap[poolItemId];
    if (!poolItem) return;

    if (computedByPool[poolItemId]) {
      result.push(computedByPool[poolItemId]);
      return;
    }

    const listPrice = Number(poolItem.unit_price || 0);
    result.push({
      pool_item_id: poolItemId,
      settle_qty: settleQty,
      billable_qty: settleQty,
      free_qty: 0,
      list_unit_price: listPrice,
      settle_unit_price: listPrice,
      unit_price: listPrice,
      amount: roundMoney_(listPrice * settleQty),
      promo_scheme_id: "",
      promo_type: "",
      promo_scheme_name: ""
    });
  });

  return result;
}

/** 一般出貨過帳：單次出貨套用 Promo（買 N 送 M 僅計本批出貨量） */
function computeShipmentPromoLines_(rawItems, soItemMap, productListMap, schemePacks, promoOverrides, dealerCtx) {
  const overrides = promoOverrides || {};
  const candidates = buildPromoCandidates_(schemePacks);
  const dealer = dealerCtx || { enabled: false };

  const grouped = {};
  (rawItems || []).forEach((it) => {
    const soItemId = normId_(it.so_item_id);
    const soItem = soItemMap[soItemId];
    if (!soItem) return;
    const shipQty = roundQty_(it.ship_qty);
    if (!(shipQty > 0)) return;
    const productId = normId_(soItem.product_id);
    const listFromProduct = productListMap[productId];
    const listPrice =
      listFromProduct != null && listFromProduct !== "" && Number(listFromProduct) >= 0
        ? Number(listFromProduct)
        : Number(soItem.unit_price || 0);
    if (!grouped[productId]) grouped[productId] = [];
    grouped[productId].push({
      so_item_id: soItemId,
      so_item: soItem,
      ship_qty: shipQty,
      list_unit_price: listPrice
    });
  });

  const computedBySoItem = {};

  Object.keys(grouped).forEach((productId) => {
    const rows = grouped[productId];
    const promo = pickPromoForProduct_(productId, candidates, overrides, true);
    const sumShip = roundQty_(rows.reduce((s, r) => s + r.ship_qty, 0));
    const firstRow = rows[0];
    const listPrice =
      productListMap[productId] != null &&
      productListMap[productId] !== "" &&
      Number(productListMap[productId]) >= 0
        ? Number(productListMap[productId])
        : Number(firstRow?.list_unit_price || firstRow?.so_item?.unit_price || 0);
    const priceBasis = promo ? normPriceBasis_(promo.price_basis) : "DEALER";
    const baseUnitPrice = resolvePromoBaseUnitPrice_({
      priceBasis,
      listPrice,
      dealerCtx: dealer,
      fallbackUnitPrice: Number(firstRow?.so_item?.unit_price || listPrice)
    });

    let freeTotal = 0;
    if (promo && normId_(promo.promo_type) === "BUY_N_GET_M") {
      const buy = Number(promo.buy_qty || 0);
      const free = Number(promo.free_qty || 0);
      if (buy > 0 && free > 0) {
        const bundle = buy + free;
        freeTotal = Math.floor(sumShip / bundle + 1e-9) * free;
      }
    }

    const freeMap = allocateFreeQtyHighPriceFirst_(
      rows.map((r) => ({
        pool_item_id: r.so_item_id,
        settle_qty: r.ship_qty,
        list_unit_price: baseUnitPrice
      })),
      freeTotal
    );

    rows.forEach((r) => {
      const sid = normId_(r.so_item_id);
      const shipQty = r.ship_qty;
      const freeQty = roundQty_(freeMap[sid] || 0);
      const billableQty = roundQty_(shipQty - freeQty);
      const settlePrice = settleUnitPrice_(baseUnitPrice, promo);
      const amount = roundMoney_(billableQty * settlePrice);

      computedBySoItem[sid] = {
        so_item_id: sid,
        product_id: normId_(r.so_item.product_id),
        ship_qty: shipQty,
        billable_qty: billableQty,
        free_qty: freeQty,
        list_unit_price: baseUnitPrice,
        base_unit_price: baseUnitPrice,
        settle_unit_price: settlePrice,
        unit_price: settlePrice,
        amount,
        promo_scheme_id: promo ? promo.scheme_id : "",
        promo_type: promo ? promo.promo_type : "",
        promo_scheme_name: promo ? promo.scheme_name : "",
        promo_price_basis: promo ? normPriceBasis_(promo.price_basis) : "",
        promo_discount_pct:
          promo && normId_(promo.promo_type) === "DISCOUNT_PCT" ? Number(promo.discount_pct || 0) : null,
        promo_buy_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.buy_qty || 0) : null,
        promo_scheme_free_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.free_qty || 0) : null
      };
    });
  });

  const result = [];
  (rawItems || []).forEach((it) => {
    const soItemId = normId_(it.so_item_id);
    const shipQty = roundQty_(it.ship_qty);
    if (!(shipQty > 0)) return;
    const soItem = soItemMap[soItemId];
    if (!soItem) return;

    if (computedBySoItem[soItemId]) {
      result.push(computedBySoItem[soItemId]);
      return;
    }

    const productId = normId_(soItem.product_id);
    const listFromProduct = productListMap[productId];
    const listPrice =
      listFromProduct != null && listFromProduct !== "" && Number(listFromProduct) >= 0
        ? Number(listFromProduct)
        : Number(soItem.unit_price || 0);
    result.push({
      so_item_id: soItemId,
      product_id: productId,
      ship_qty: shipQty,
      billable_qty: shipQty,
      free_qty: 0,
      list_unit_price: listPrice,
      settle_unit_price: Number(soItem.unit_price || listPrice),
      unit_price: Number(soItem.unit_price || listPrice),
      amount: roundMoney_(Number(soItem.unit_price || listPrice) * shipQty),
      promo_scheme_id: "",
      promo_type: "",
      promo_scheme_name: ""
    });
  });

  return result;
}

/** 一般銷售單：單品項促銷計價（建單／預覽用） */
async function computeSalesOrderPromoLine_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const customerId = normId_(o.customerId);
  const orderDate = String(o.orderDate || "").trim().slice(0, 10);
  const productId = normId_(o.productId);
  const orderQty = roundQty_(o.orderQty);
  const unitPriceHint = Number(o.unitPriceHint || 0);

  const productListMap = await loadProductListPriceMap_(sb, [productId]);
  const listFromProduct = productListMap[productId];
  const listPrice =
    listFromProduct != null && listFromProduct !== "" && Number(listFromProduct) >= 0
      ? Number(listFromProduct)
      : unitPriceHint;

  let dealerCtx = { enabled: false };
  if (customerId && orderDate) {
    dealerCtx = await resolveCumulativeDealerPriceForSettlement_(sb, customerId, orderDate, "GENERAL");
  }

  let schemePacks = [];
  if (customerId && orderDate) {
    schemePacks = await loadPromoSchemesForGeneralShipment_(sb, customerId, orderDate);
  }
  const candidates = buildPromoCandidates_(schemePacks);
  const promo = pickPromoForProduct_(productId, candidates, {}, true);

  const priceBasis = promo ? normPriceBasis_(promo.price_basis) : "DEALER";
  const baseUnitPrice = resolvePromoBaseUnitPrice_({
    priceBasis,
    listPrice,
    dealerCtx,
    fallbackUnitPrice: unitPriceHint
  });

  let freeQty = 0;
  let billableQty = orderQty;
  if (promo && normId_(promo.promo_type) === "BUY_N_GET_M") {
    const buy = Number(promo.buy_qty || 0);
    const free = Number(promo.free_qty || 0);
    if (buy > 0 && free > 0) {
      const bundle = buy + free;
      freeQty = Math.floor(orderQty / bundle + 1e-9) * free;
      billableQty = roundQty_(orderQty - freeQty);
    }
  }

  const settleUnitPrice = settleUnitPrice_(baseUnitPrice, promo);
  let unitPrice;
  if (promo) {
    unitPrice = settleUnitPrice;
  } else if (unitPriceHint > 0) {
    unitPrice = roundMoney_(unitPriceHint);
  } else {
    unitPrice = baseUnitPrice;
  }
  const amount = roundMoney_(billableQty * unitPrice);

  return {
    product_id: productId,
    order_qty: orderQty,
    billable_qty: billableQty,
    free_qty: freeQty,
    base_unit_price: baseUnitPrice,
    settle_unit_price: unitPrice,
    unit_price: unitPrice,
    amount,
    promo_scheme_id: promo ? promo.scheme_id : "",
    promo_scheme_name: promo ? promo.scheme_name : "",
    promo_type: promo ? promo.promo_type : "",
    promo_price_basis: promo ? normPriceBasis_(promo.price_basis) : "",
    promo_discount_pct:
      promo && normId_(promo.promo_type) === "DISCOUNT_PCT" ? Number(promo.discount_pct || 0) : null,
    promo_buy_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.buy_qty || 0) : null,
    promo_scheme_free_qty: promo && normId_(promo.promo_type) === "BUY_N_GET_M" ? Number(promo.free_qty || 0) : null
  };
}

async function previewSalesOrderPromoLineBundle(p) {
  const customerId = normId_(p.customer_id);
  const orderDate = String(p.order_date || "").trim();
  const productId = normId_(p.product_id);
  const orderQty = roundQty_(p.order_qty);
  if (!customerId) return fail("customer_id required");
  if (!orderDate) return fail("order_date required");
  if (!productId) return fail("product_id required");
  if (!(orderQty > 0)) return fail("order_qty must be > 0");

  const sb = getSupabase();
  try {
    const line = await computeSalesOrderPromoLine_(sb, {
      customerId,
      orderDate,
      productId,
      orderQty,
      unitPriceHint: Number(p.unit_price || 0)
    });
    return ok(line);
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

async function buildShipmentArPricing_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const customerId = normId_(o.customerId);
  const shipDate = String(o.shipDate || "").trim();
  const items = Array.isArray(o.items) ? o.items : [];
  if (!customerId || !shipDate || !items.length) {
    return { err: "buildShipmentArPricing_: customerId, shipDate and items required" };
  }

  const soItemIds = items.map((it) => normId_(it.so_item_id)).filter(Boolean);
  const soItemMap = await loadSoItemsMapForPromo_(sb, soItemIds);
  const productIds = Object.keys(soItemMap).map((id) => normId_(soItemMap[id].product_id)).filter(Boolean);
  const productListMap = await loadProductListPriceMap_(sb, productIds);

  let dealerCtx = { enabled: false };
  try {
    dealerCtx = await resolveCumulativeDealerPriceForSettlement_(sb, customerId, shipDate, "GENERAL");
  } catch (dealerErr) {
    return { err: dealerErr?.message || String(dealerErr) };
  }

  let schemePacks = [];
  try {
    schemePacks = await loadPromoSchemesForGeneralShipment_(sb, customerId, shipDate);
  } catch (promoErr) {
    return { err: promoErr?.message || String(promoErr) };
  }

  let lines = computeShipmentPromoLines_(
    items,
    soItemMap,
    productListMap,
    schemePacks,
    o.promoOverrides || {},
    dealerCtx
  );

  lines = applyCumulativeDealerPriceToLines_(lines, dealerCtx);
  lines = (lines || []).map((ln) => {
    if (String(ln.promo_scheme_id || "").trim()) return ln;
    const soItem = soItemMap[normId_(ln.so_item_id)];
    const unitPrice = Number(soItem?.unit_price || ln.settle_unit_price || ln.list_unit_price || 0);
    const billable = roundQty_(ln.billable_qty != null ? ln.billable_qty : ln.ship_qty);
    return Object.assign({}, ln, {
      settle_unit_price: unitPrice,
      unit_price: unitPrice,
      amount: roundMoney_(billable * unitPrice)
    });
  });

  const amountSystem = roundMoney_((lines || []).reduce((s, ln) => s + Number(ln.amount || 0), 0));
  const promoNames = [
    ...new Set(
      (lines || [])
        .map((ln) => String(ln.promo_scheme_name || "").trim())
        .filter(Boolean)
    )
  ];
  const remarkParts = ["General shipment commercial"];
  if (promoNames.length) remarkParts.push("Promo: " + promoNames.join(", "));
  if (dealerCtx.enabled) {
    remarkParts.push(
      "Dealer tier " + String(dealerCtx.tier_label || "") + " @ " + String(dealerCtx.price_rate || "") + "%"
    );
  }

  return {
    amount_system: amountSystem,
    lines,
    dealer_cumulative: dealerCtx,
    promo_scheme_count: schemePacks.length,
    system_remark: remarkParts.join(" | ")
  };
}

/** 一般出貨過帳：Promo → 經銷價 → 建 AR → 次月折抵 */
async function createGeneralShipmentArWithCommercial_(ctx) {
  const {
    sb,
    shipmentId,
    soId,
    customerId,
    txId,
    shipDate,
    items,
    currency,
    actor,
    ts,
    session
  } = ctx || {};
  const sid = normId_(shipmentId);
  if (!sid) return fail("shipment_id required");

  const pricing = await buildShipmentArPricing_(sb, { customerId, shipDate, items });
  if (pricing.err) return fail(pricing.err);

  const arRes = await createArFromShipment_({
    sb,
    shipmentId: sid,
    soId,
    customerId,
    txId,
    shipDate,
    items,
    currency,
    actor,
    ts,
    amountSystem: pricing.amount_system,
    systemRemark: pricing.system_remark
  });
  if (arRes && arRes.success === false) return arRes;

  const arId = String(arRes?.ar_id || "AR-" + sid).trim().toUpperCase();
  const creditRes = await applyDealerCreditAtShipment_({
    sb,
    shipmentId: sid,
    arId,
    customerId,
    shipDate,
    actor,
    session,
    ts
  });
  if (creditRes && creditRes.err) return fail(creditRes.err);

  let cumulativeRes = { skipped: true };
  try {
    cumulativeRes = await processCumulativeOnGeneralShipment_(sb, {
      customerId,
      shipDate,
      billingNet: pricing.amount_system,
      arId,
      shipmentId: sid,
      actor,
      ts
    });
  } catch (cumErr) {
    return fail("累積採購更新失敗：" + (cumErr?.message || String(cumErr)));
  }
  if (cumulativeRes.err) return fail(cumulativeRes.err);

  let cumulativeRecalc = { skipped: true };
  try {
    cumulativeRecalc = await syncCustomerCumulativeFromSources_(sb, customerId, actor, ts);
    if (cumulativeRecalc && cumulativeRecalc.err) {
      return fail("月結累積重算失敗：" + cumulativeRecalc.err);
    }
  } catch (cumRecalcErr) {
    return fail("月結累積重算失敗：" + (cumRecalcErr?.message || String(cumRecalcErr)));
  }

  return ok(
    Object.assign({}, arRes, {
      amount_system: pricing.amount_system,
      commercial: pricing,
      dealer_credit: creditRes,
      cumulative: cumulativeRes.skipped ? null : cumulativeRes,
      cumulative_recalc: cumulativeRecalc.skipped ? null : cumulativeRecalc
    })
  );
}

function summarizeActivePromos_(schemePacks) {
  const candidates = buildPromoCandidates_(schemePacks);
  const byProduct = {};
  candidates.forEach((c) => {
    const cur = byProduct[c.product_id];
    if (!cur || c.priority > cur.priority) byProduct[c.product_id] = c;
    else if (c.priority === cur.priority && String(c.created_at) > String(cur.created_at)) {
      byProduct[c.product_id] = c;
    }
  });
  return Object.keys(byProduct).map((pid) => byProduct[pid]);
}

async function loadSchemeIdsWithPostedSettlement_(sb, schemeIds) {
  const locked = new Set();
  const ids = (schemeIds || []).map((id) => normId_(id)).filter(Boolean);
  if (!ids.length) return locked;

  const { data: stlItemsById, error: errById } = await sb
    .from("consignment_case_settlement_item")
    .select("promo_scheme_id, promo_scheme_name, settlement_id")
    .in("promo_scheme_id", ids);
  if (errById) throw new Error(errById.message || String(errById));

  const { data: schemes } = await sb.from("consignment_promo_scheme").select("scheme_id, scheme_name").in("scheme_id", ids);
  const nameToId = {};
  (schemes || []).forEach((s) => {
    const sid = normId_(s.scheme_id);
    const nm = String(s.scheme_name || "").trim();
    if (sid && nm) nameToId[nm] = sid;
  });
  const schemeNames = Object.keys(nameToId);
  let stlItemsByName = [];
  if (schemeNames.length) {
    const { data, error: errByName } = await sb
      .from("consignment_case_settlement_item")
      .select("promo_scheme_id, promo_scheme_name, settlement_id")
      .in("promo_scheme_name", schemeNames);
    if (errByName) throw new Error(errByName.message || String(errByName));
    stlItemsByName = data || [];
  }

  const allItems = [...(stlItemsById || []), ...stlItemsByName];
  const stlIds = [...new Set(allItems.map((r) => normId_(r.settlement_id)).filter(Boolean))];
  if (!stlIds.length) return locked;

  const { data: stls, error: stlErr } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id")
    .in("settlement_id", stlIds)
    .eq("status", "POSTED");
  if (stlErr) throw new Error(stlErr.message || String(stlErr));

  const postedStl = new Set((stls || []).map((s) => normId_(s.settlement_id)));
  allItems.forEach((row) => {
    const stlId = normId_(row.settlement_id);
    if (!postedStl.has(stlId)) return;
    const schemeId = normId_(row.promo_scheme_id);
    if (schemeId && ids.includes(schemeId)) {
      locked.add(schemeId);
      return;
    }
    const nm = String(row.promo_scheme_name || "").trim();
    if (nm && nameToId[nm]) locked.add(nameToId[nm]);
  });
  return locked;
}

async function listConsignmentPromoActiveForCase_(p) {
  const gate = requireConsignmentPromoSession_(p);
  if (gate) return gate;
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");

  const settlementDate = String(p.settlement_date || "").trim() || String(new Date()).slice(0, 10);
  const sb = getSupabase();
  const { data: ccase, error } = await sb.from("consignment_case").select("*").eq("case_id", caseId).maybeSingle();
  if (error) return fail(error.message || String(error));
  if (!ccase) return fail("Consignment case not found: " + caseId);

  const schemePacks = await loadPromoSchemesForCase_(sb, caseId, ccase.customer_id, settlementDate);
  const promos = summarizeActivePromos_(schemePacks);
  const candidates = buildPromoCandidates_(schemePacks);
  const conflicts = {};
  const byProduct = {};
  candidates.forEach((c) => {
    if (!byProduct[c.product_id]) byProduct[c.product_id] = [];
    byProduct[c.product_id].push(c);
  });
  Object.keys(byProduct).forEach((pid) => {
    const uniq = {};
    byProduct[pid].forEach((c) => {
      uniq[c.scheme_id] = c;
    });
    const ids = Object.keys(uniq);
    if (ids.length > 1) conflicts[pid] = ids.map((id) => uniq[id]);
  });

  return ok({
    case_id: caseId,
    settlement_date: settlementDate,
    promos,
    conflicts,
    candidates,
    scheme_count: schemePacks.length
  });
}

async function previewConsignmentCaseSettlementPromo_(p) {
  const gate = requireConsignmentPromoSession_(p);
  if (gate) return gate;
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");
  const settlementDate = String(p.settlement_date || "").trim();
  if (!settlementDate) return fail("settlement_date required");

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);

  const sb = getSupabase();
  const { data: ccase, error: caseErr } = await sb.from("consignment_case").select("*").eq("case_id", caseId).maybeSingle();
  if (caseErr) return fail(caseErr.message || String(caseErr));
  if (!ccase) return fail("Consignment case not found: " + caseId);

  const { data: poolItems } = await sb.from("consignment_case_pool_item").select("*").eq("case_id", caseId);
  const poolMap = {};
  (poolItems || []).forEach((row) => {
    poolMap[normId_(row.pool_item_id)] = row;
  });

  const schemePacks = await loadPromoSchemesForCase_(sb, caseId, ccase.customer_id, settlementDate);
  const overrides = parsePromoOverrides_(p.promo_overrides_json);
  let lines = computeSettlementPromoLines_(itemsPack.data, poolMap, schemePacks, overrides);
  let dealerCtx = { enabled: false };
  try {
    dealerCtx = await resolveCumulativeDealerPriceForSettlement_(sb, ccase.customer_id, settlementDate);
  } catch (dealerErr) {
    return fail(dealerErr?.message || String(dealerErr));
  }
  lines = applyCumulativeDealerPriceToLines_(lines, dealerCtx);
  const amountSystem = roundMoney_(lines.reduce((s, ln) => s + Number(ln.amount || 0), 0));

  return ok({
    case_id: caseId,
    settlement_date: settlementDate,
    lines,
    amount_system: amountSystem,
    dealer_cumulative: dealerCtx
  });
}

async function listConsignmentPromoSchemeEnriched_(p) {
  const gate = requireConsignmentPromoSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const { data: schemes, error } = await sb
    .from("consignment_promo_scheme")
    .select("*")
    .order("date_from", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return fail(error.message || String(error));

  const ids = (schemes || []).map((s) => normId_(s.scheme_id)).filter(Boolean);
  let lineCounts = {};
  if (ids.length) {
    const { data: lines } = await sb.from("consignment_promo_scheme_line").select("scheme_id").in("scheme_id", ids);
    (lines || []).forEach((ln) => {
      const sid = normId_(ln.scheme_id);
      lineCounts[sid] = (lineCounts[sid] || 0) + 1;
    });
  }

  let settlementLocked = new Set();
  if (ids.length) {
    try {
      settlementLocked = await loadSchemeIdsWithPostedSettlement_(sb, ids);
    } catch (lockErr) {
      return fail(lockErr?.message || String(lockErr));
    }
  }

  const rows = (schemes || []).map((s) => {
    const sid = normId_(s.scheme_id);
    return Object.assign({}, s, {
      line_count: lineCounts[sid] || 0,
      has_settlement: settlementLocked.has(sid)
    });
  });
  return ok({ data: rows, source: "supabase" });
}

async function saveConsignmentPromoSchemeBundle(p) {
  if (!canManageAr_(p._session)) return fail("Permission denied: consignment promo");

  const schemeId = normId_(p.scheme_id) || buildShortPromoSchemeId_();
  const schemeName = String(p.scheme_name || "").trim();
  if (!schemeName) return fail("scheme_name required");

  const status = normId_(p.status) || "ACTIVE";
  if (!["DRAFT", "ACTIVE", "ENDED"].includes(status)) return fail("status invalid");

  const dateFrom = String(p.date_from || "").trim();
  const dateTo = String(p.date_to || "").trim();
  if (!dateFrom || !dateTo) return fail("date_from and date_to required");
  if (dateFrom > dateTo) return fail("date_from must be <= date_to");

  const scopeType = normId_(p.scope_type) || "CUSTOMER";
  if (!["CASE", "CUSTOMER", "GLOBAL"].includes(scopeType)) return fail("scope_type invalid");

  const channel = normId_(p.channel) || "CONSIGNMENT";
  if (!["CONSIGNMENT", "GENERAL", "ALL"].includes(channel)) return fail("channel invalid");
  if (channel === "GENERAL" && scopeType === "CASE") return fail("一般管道不可選寄賣案範圍");

  const priceBasis = normPriceBasis_(p.price_basis);

  const caseId = normId_(p.case_id);
  const customerId = normId_(p.customer_id);
  if (scopeType === "CASE" && !caseId) return fail("case_id required for CASE scope");
  if (scopeType === "CUSTOMER" && !customerId) return fail("customer_id required for CUSTOMER scope");

  const linesPack = parseJsonArray(p.lines_json, "lines_json");
  if (linesPack.err) return fail(linesPack.err);
  if (!linesPack.data.length) return fail("lines_json required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const ts = nowIso();
  const { data: existed } = await sb.from("consignment_promo_scheme").select("scheme_id").eq("scheme_id", schemeId).maybeSingle();
  const isNew = !existed;

  const header = {
    scheme_id: schemeId,
    scheme_name: schemeName,
    status,
    date_from: dateFrom,
    date_to: dateTo,
    scope_type: scopeType,
    channel,
    price_basis: priceBasis,
    case_id: scopeType === "CASE" ? caseId : "",
    customer_id: scopeType === "CUSTOMER" ? customerId : "",
    remark: String(p.remark || ""),
    updated_by: actor,
    updated_at: ts
  };

  if (isNew) {
    header.created_by = actor;
    header.created_at = ts;
    const { error } = await sb.from("consignment_promo_scheme").insert(header);
    if (error) return fail(error.message || String(error));
  } else {
    let settlementLocked;
    try {
      settlementLocked = await loadSchemeIdsWithPostedSettlement_(sb, [schemeId]);
    } catch (lockErr) {
      return fail(lockErr?.message || String(lockErr));
    }
    if (settlementLocked.has(schemeId)) return fail("此促銷方案已有結算紀錄，不可更新");
    const { error } = await sb.from("consignment_promo_scheme").update(header).eq("scheme_id", schemeId);
    if (error) return fail(error.message || String(error));
  }

  await sb.from("consignment_promo_scheme_line").delete().eq("scheme_id", schemeId);

  for (let i = 0; i < linesPack.data.length; i++) {
    const ln = linesPack.data[i] || {};
    const productId = normId_(ln.product_id);
    const promoType = normId_(ln.promo_type);
    if (!productId) return fail("product_id required (lines[" + i + "])");
    if (!PROMO_TYPES_[promoType]) return fail("promo_type invalid (lines[" + i + "])");

    if (promoType === "FIXED_PRICE" && !(Number(ln.promo_unit_price || 0) > 0)) {
      return fail("promo_unit_price required for FIXED_PRICE (lines[" + i + "])");
    }
    if (promoType === "DISCOUNT_PCT") {
      const pct = Number(ln.discount_pct || 0);
      if (!(pct > 0 && pct <= 100)) return fail("discount_pct must be 1..100 (lines[" + i + "])");
    }
    if (promoType === "BUY_N_GET_M") {
      const buy = Number(ln.buy_qty || 0);
      const free = Number(ln.free_qty || 0);
      if (!(buy > 0 && free > 0)) return fail("buy_qty and free_qty required for BUY_N_GET_M (lines[" + i + "])");
    }

    const lineId = schemeId + "-LN-" + String(i + 1).padStart(3, "0");
    const { error: insErr } = await sb.from("consignment_promo_scheme_line").insert({
      line_id: lineId,
      scheme_id: schemeId,
      product_id: productId,
      promo_type: promoType,
      promo_unit_price: ln.promo_unit_price != null ? Number(ln.promo_unit_price) : null,
      discount_pct: ln.discount_pct != null ? Number(ln.discount_pct) : null,
      buy_qty: ln.buy_qty != null ? Number(ln.buy_qty) : null,
      free_qty: ln.free_qty != null ? Number(ln.free_qty) : null,
      sort_order: i + 1,
      remark: String(ln.remark || ""),
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null
    });
    if (insErr) return fail(insErr.message || String(insErr));
  }

  await writeAuditLog_(
    "consignment_promo_scheme",
    schemeId,
    isNew ? "BUNDLE_CREATE_CONSIGNMENT_PROMO" : "BUNDLE_UPDATE_CONSIGNMENT_PROMO",
    actor,
    JSON.stringify({ scheme_id: schemeId, line_count: linesPack.data.length })
  );

  return ok({ scheme_id: schemeId, message: isNew ? "CREATED" : "UPDATED" });
}

async function endConsignmentPromoSchemeBundle(p) {
  if (!canManageAr_(p._session)) return fail("Permission denied: consignment promo");

  const schemeId = normId_(p.scheme_id);
  if (!schemeId) return fail("scheme_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const endDate = String(p.end_date || "").trim() || String(new Date().toISOString()).slice(0, 10);

  const sb = getSupabase();
  const { data: scheme, error: getErr } = await sb
    .from("consignment_promo_scheme")
    .select("*")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!scheme) return fail("Promo scheme not found: " + schemeId);

  const curStatus = normId_(scheme.status);
  if (curStatus === "ENDED") return fail("方案已是結束狀態");

  const dateFrom = String(scheme.date_from || "").trim();
  let dateTo = String(scheme.date_to || "").trim();
  if (endDate < dateFrom) return fail("結束日不可早於有效期起（" + dateFrom + "）");
  if (endDate < dateTo) dateTo = endDate;

  const ts = nowIso();
  const { error: updErr } = await sb
    .from("consignment_promo_scheme")
    .update({
      status: "ENDED",
      date_to: dateTo,
      updated_by: actor,
      updated_at: ts
    })
    .eq("scheme_id", schemeId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    "consignment_promo_scheme",
    schemeId,
    "BUNDLE_END_CONSIGNMENT_PROMO",
    actor,
    JSON.stringify({ scheme_id: schemeId, end_date: endDate, date_to: dateTo })
  );

  return ok({ scheme_id: schemeId, status: "ENDED", date_to: dateTo, message: "ENDED" });
}

module.exports = {
  loadPromoSchemesForCase_,
  loadPromoSchemesForGeneralShipment_,
  buildPromoCandidates_,
  computeSettlementPromoLines_,
  computeShipmentPromoLines_,
  computeSalesOrderPromoLine_,
  buildShipmentArPricing_,
  createGeneralShipmentArWithCommercial_,
  listConsignmentPromoActiveForCase_,
  previewConsignmentCaseSettlementPromo_,
  previewSalesOrderPromoLineBundle,
  listConsignmentPromoSchemeEnriched_,
  saveConsignmentPromoSchemeBundle,
  endConsignmentPromoSchemeBundle
};
