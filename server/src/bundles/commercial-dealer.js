const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { readSessionValid } = require("../session");
const {
  nowIso,
  buildShortDealerSchemeId_,
  buildId_,
  parseJsonArray,
  writeAuditLog_,
  appendSystemRemark_
} = require("./shared");
const { canManageAr_, adjustArAmountBundle } = require("./ar");

function normId_(v) {
  return String(v || "").trim().toUpperCase();
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function parsePeriodYm_(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  if (!(y >= 2000 && m >= 1 && m <= 12)) return null;
  return { period_ym: s, year: y, month: m };
}

function monthRange_(periodYm) {
  const pack = parsePeriodYm_(periodYm);
  if (!pack) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = new Date(pack.year, pack.month, 0).getDate();
  return {
    period_ym: pack.period_ym,
    date_from: pack.period_ym + "-01",
    date_to: pack.period_ym + "-" + pad(lastDay)
  };
}

function periodYmFromDate_(dateStr) {
  const s = String(dateStr || "").trim();
  if (s.length >= 7 && /^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  return null;
}

/** 作廢寄賣結算前：該客戶該月已有月結回饋（未作廢）則阻擋 */
async function assertNoLockedDealerRebateForSettlementVoid_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  let cust = normId_(o.customerId);
  const caseId = normId_(o.caseId);
  const settlementDate = o.settlementDate;
  const periodYm = periodYmFromDate_(settlementDate);
  const settlementId = normId_(o.settlementId);
  let stlCreatedAt = o.settlementCreatedAt;

  if (!stlCreatedAt && settlementId) {
    const { data: stl, error: stlErr } = await sb
      .from("consignment_case_settlement")
      .select("created_at")
      .eq("settlement_id", settlementId)
      .maybeSingle();
    if (stlErr) throw new Error(stlErr.message || String(stlErr));
    stlCreatedAt = stl?.created_at;
  }

  const stlTs = stlCreatedAt ? new Date(stlCreatedAt).getTime() : NaN;

  function isLockedByDoc_(docCreatedAt) {
    if (!docCreatedAt) return true;
    if (!stlTs || Number.isNaN(stlTs)) return true;
    return stlTs < new Date(docCreatedAt).getTime();
  }

  if (!cust && caseId) {
    const { data: ccase, error: caseErr } = await sb
      .from("consignment_case")
      .select("customer_id")
      .eq("case_id", caseId)
      .maybeSingle();
    if (caseErr) throw new Error(caseErr.message || String(caseErr));
    cust = normId_(ccase?.customer_id);
  }

  if (!cust || !periodYm) {
    return {
      err:
        "無法確認客戶或結算月份，為避免繞過月結回饋護欄，暫不允許作廢結算。請聯絡管理員補齊結算客戶資料。"
    };
  }

  const { data, error } = await sb
    .from("commercial_dealer_rebate")
    .select("rebate_id, period_ym, status, created_at")
    .eq("customer_id", cust)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message || String(error));
  const hit = Array.isArray(data) && data.length ? data[0] : null;
  if (hit && isLockedByDoc_(hit.created_at)) {
    const rid = String(hit.rebate_id || "").trim();
    return {
      err:
        "此客戶 " +
        periodYm +
        " 已產生月結回饋（" +
        rid +
        "）。請先到「月結統計／回饋」作廢該筆回饋後，再作廢。"
    };
  }

  const { data: statHit, error: statErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("stat_id, period_ym, status, created_at")
    .eq("customer_id", cust)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .order("created_at", { ascending: false })
    .limit(1);
  if (statErr) throw new Error(statErr.message || String(statErr));
  const st = Array.isArray(statHit) && statHit.length ? statHit[0] : null;
  if (st && isLockedByDoc_(st.created_at)) {
    const sid = String(st.stat_id || "").trim();
    return {
      err:
        "此客戶 " +
        periodYm +
        " 已產生月結統計（" +
        sid +
        "）。請先到「月結統計」作廢該筆後，再作廢。"
    };
  }

  return null;
}

/** 月結統計已過帳：該客戶該月不可再新增請款（寄賣結算／一般出貨過帳） */
async function assertNoPostedMonthlyStatForNewBilling_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cust = normId_(o.customerId);
  const periodYm = periodYmFromDate_(o.billingDate || o.settlementDate || o.shipDate);
  if (!cust || !periodYm) return null;

  const { data: statHit, error: statErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("stat_id, status, period_ym")
    .eq("customer_id", cust)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .order("created_at", { ascending: false })
    .limit(1);
  if (statErr) throw new Error(statErr.message || String(statErr));
  const stat = Array.isArray(statHit) && statHit.length ? statHit[0] : null;
  if (!stat || normId_(stat.status) !== "POSTED") return null;

  const msg =
    "此客戶 " +
    periodYm +
    " 月結統計已過帳，不建議直接新增請款。\n請先至 FINANCE 財務 → 月結統計作廢後方可補單。";
  return { err: msg };
}

/** 作廢一般出貨前：該客戶該月已有月結回饋（未作廢）則阻擋 */
async function assertNoLockedDealerRebateForShipmentVoid_(sb, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cust = normId_(o.customerId);
  const periodYm = periodYmFromDate_(o.shipDate);
  if (!cust || !periodYm) {
    return {
      err: "無法確認客戶或出貨月份，為避免繞過月結回饋護欄，暫不允許作廢出貨。請聯絡管理員補齊資料。"
    };
  }
  return assertNoLockedDealerRebateForSettlementVoid_(sb, {
    customerId: cust,
    settlementDate: o.shipDate,
    settlementCreatedAt: o.shipmentCreatedAt
  });
}

function schemeOverlapsMonth_(scheme, monthStart, monthEnd) {
  const f = String(scheme.date_from || "").trim();
  const t = String(scheme.date_to || "").trim();
  if (!f || !t) return false;
  return monthStart <= t && monthEnd >= f;
}

function requireCommercialDealerSession_(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const sess = readSessionValid(tok);
  if (!sess) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const mods = String(sess.allowed_modules || "").trim().toLowerCase();
  if (mods && mods !== "*") {
    const list = mods.split(",").map((x) => x.trim()).filter(Boolean);
    const allowed =
      list.includes("commercial_dealer") ||
      list.includes("commercial_dealer_customer") ||
      list.includes("dealer_rebate") ||
      list.includes("commercial_promo") ||
      list.includes("consignment");
    if (!allowed) return fail("Permission denied: commercial_dealer module", "ERR_PERMISSION_DENIED");
  }
  return null;
}

function requireCommercialDealerCustomerSession_(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const sess = readSessionValid(tok);
  if (!sess) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const mods = String(sess.allowed_modules || "").trim().toLowerCase();
  if (mods && mods !== "*") {
    const list = mods.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.includes("commercial_dealer_customer")) {
      return fail("Permission denied: commercial_dealer_customer module", "ERR_PERMISSION_DENIED");
    }
  }
  return null;
}

/** 寫入：須 CEO／財務角色或 ar 模組，且 Users 勾選 commercial_dealer */
function canOperateCommercialDealer_(session) {
  if (!canManageAr_(session)) return false;
  const mods = String(session?.allowed_modules || "").trim().toLowerCase();
  if (!mods || mods === "*" || mods === "all") return true;
  const list = mods.split(",").map((x) => x.trim()).filter(Boolean);
  return list.includes("commercial_dealer");
}

/** 寫入：須 CEO／財務角色或 ar 模組，且 Users 勾選 dealer_rebate 或 commercial_dealer */
function canOperateDealerRebate_(session) {
  if (!canManageAr_(session)) return false;
  const mods = String(session?.allowed_modules || "").trim().toLowerCase();
  if (!mods || mods === "*" || mods === "all") return true;
  const list = mods.split(",").map((x) => x.trim()).filter(Boolean);
  return list.includes("dealer_rebate") || list.includes("commercial_dealer");
}

function dealerCreditSettlementReason_(settlementId) {
  return "經銷回饋折抵（結算 " + normId_(settlementId) + "）";
}

function dealerCreditShipmentReason_(shipmentId) {
  return "經銷回饋折抵（出貨 " + normId_(shipmentId) + "）";
}

/** stat_source：CONSIGNMENT／GENERAL／ALL；channel：CONSIGNMENT 或 GENERAL */
function schemeStatSourceAllows_(statSource, channel) {
  const src = normId_(statSource) || "CONSIGNMENT";
  const ch = normId_(channel) || "CONSIGNMENT";
  if (src === "ALL") return true;
  return src === ch;
}

/** 月結回饋過帳時寫入累積採購：一般出貨改在出貨過帳即時累加，避免重複 */
function resolveBillingNetForCumulativeOnRebate_(billingPack, rebateStatSource) {
  const src = normId_(rebateStatSource) || "CONSIGNMENT";
  if (src === "GENERAL") return 0;
  if (src === "ALL") return roundMoney_(billingPack?.billing_net_consignment);
  return roundMoney_(billingPack?.billing_net);
}

/**
 * 次月結算折抵：僅 period_ym 嚴格小於結算日所在月份的 POSTED CARRY_FORWARD 回饋可套用。
 * 已消耗額度依回饋月份 FIFO 分配（舊回饋先扣）。
 */
function computeEligibleDealerCreditForSettlement_(opts) {
  const settlementYm = periodYmFromDate_(opts && opts.settlementDate);
  const balance = roundMoney_(Number((opts && opts.creditBalance) || 0));
  const rebates = Array.isArray(opts && opts.postedCarryForwardRebates) ? opts.postedCarryForwardRebates : [];
  if (!settlementYm || balance <= 1e-9) return 0;

  const sorted = rebates
    .filter(function (r) {
      return normId_(r.status) === "POSTED" && normId_(r.settle_mode) === "CARRY_FORWARD";
    })
    .slice()
    .sort(function (a, b) {
      return String(a.period_ym || "").localeCompare(String(b.period_ym || ""));
    });

  const totalPosted = roundMoney_(
    sorted.reduce(function (s, r) {
      return s + Number(r.rebate_amount || 0);
    }, 0)
  );
  let consumed = roundMoney_(Math.max(0, totalPosted - balance));
  let eligibleRemaining = 0;

  sorted.forEach(function (r) {
    const amt = roundMoney_(Number(r.rebate_amount || 0));
    const used = roundMoney_(Math.min(amt, consumed));
    consumed = roundMoney_(Math.max(0, consumed - used));
    const remaining = roundMoney_(amt - used);
    if (String(r.period_ym || "").trim() < settlementYm) {
      eligibleRemaining = roundMoney_(eligibleRemaining + remaining);
    }
  });

  return roundMoney_(Math.min(balance, eligibleRemaining));
}

async function applyDealerCreditAtSettlement_(opts) {
  const { sb, settlementId, arId, customerId, actor, session, ts } = opts || {};
  const custId = normId_(customerId);
  const aid = normId_(arId);
  const sid = normId_(settlementId);
  if (!custId || !aid || !sid) return { skipped: true, credit_applied: 0 };

  let settlementDate = String((opts && opts.settlementDate) || "").trim();
  if (!settlementDate) {
    const { data: stl, error: stlErr } = await sb
      .from("consignment_case_settlement")
      .select("settlement_date")
      .eq("settlement_id", sid)
      .maybeSingle();
    if (stlErr) return { err: stlErr.message || String(stlErr) };
    settlementDate = String((stl && stl.settlement_date) || "").trim();
  }
  const settlementYm = periodYmFromDate_(settlementDate);

  const { data: customer, error: custErr } = await sb
    .from("customer")
    .select("dealer_rebate_credit_balance")
    .eq("customer_id", custId)
    .maybeSingle();
  if (custErr) return { err: custErr.message || String(custErr) };
  if (!customer) return { skipped: true, credit_applied: 0 };

  const balance = roundMoney_(Number(customer.dealer_rebate_credit_balance || 0));
  if (balance <= 1e-9) return { skipped: true, credit_applied: 0 };

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", aid).maybeSingle();
  if (arErr) return { err: arErr.message || String(arErr) };
  if (!ar) return { skipped: true, credit_applied: 0 };

  const due = roundMoney_(ar.amount_due);
  if (due <= 1e-9) return { skipped: true, credit_applied: 0 };

  const { data: rebates, error: rebErr } = await sb
    .from("commercial_dealer_rebate")
    .select("period_ym, rebate_amount, status, settle_mode")
    .eq("customer_id", custId)
    .eq("status", "POSTED")
    .eq("settle_mode", "CARRY_FORWARD");
  if (rebErr) return { err: rebErr.message || String(rebErr) };

  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate,
    creditBalance: balance,
    postedCarryForwardRebates: rebates || []
  });
  if (eligible <= 1e-9) {
    return {
      skipped: true,
      credit_applied: 0,
      credit_deferred: true,
      defer_reason:
        settlementYm && balance > 1e-9
          ? "折抵餘額 " +
            balance +
            " 元保留中；僅「回饋月份次月（含）起」的寄賣結算才自動折抵（本次結算 " +
            settlementYm +
            "）"
          : "尚無可折抵額度"
    };
  }

  const cut = roundMoney_(Math.min(eligible, due));
  const newDue = roundMoney_(due - cut);
  const reason = dealerCreditSettlementReason_(sid);

  const adjRes = await adjustArAmountBundle({
    ar_id: aid,
    amount_due: newDue,
    reason,
    reason_code: "DISCOUNT",
    updated_by: actor,
    created_by: actor,
    _session: session,
    _from_settlement_dealer_credit: true
  });
  if (adjRes && adjRes.success === false) {
    return { err: (adjRes.errors && adjRes.errors[0]) || "經銷折抵套用失敗" };
  }

  const newBal = roundMoney_(balance - cut);
  const { error: updErr } = await sb
    .from("customer")
    .update({ dealer_rebate_credit_balance: newBal, updated_by: actor, updated_at: ts })
    .eq("customer_id", custId);
  if (updErr) return { err: updErr.message || String(updErr) };

  await writeAuditLog_(
    "customer",
    custId,
    "BUNDLE_APPLY_DEALER_CREDIT_AT_SETTLEMENT",
    actor,
    JSON.stringify({
      settlement_id: sid,
      ar_id: aid,
      credit_applied: cut,
      balance_before: balance,
      balance_after: newBal
    })
  );

  return { credit_applied: cut, balance_before: balance, balance_after: newBal };
}

/** 一般出貨過帳建 AR 後：次月折抵（口徑同寄賣結算） */
async function applyDealerCreditAtShipment_(opts) {
  const { sb, shipmentId, arId, customerId, actor, session, ts } = opts || {};
  const custId = normId_(customerId);
  const aid = normId_(arId);
  const sid = normId_(shipmentId);
  if (!custId || !aid || !sid) return { skipped: true, credit_applied: 0 };

  let shipDate = String((opts && opts.shipDate) || "").trim();
  if (!shipDate) {
    const { data: sh, error: shErr } = await sb
      .from("shipment")
      .select("ship_date")
      .eq("shipment_id", sid)
      .maybeSingle();
    if (shErr) return { err: shErr.message || String(shErr) };
    shipDate = String((sh && sh.ship_date) || "").trim();
  }
  const shipYm = periodYmFromDate_(shipDate);

  const { data: customer, error: custErr } = await sb
    .from("customer")
    .select("dealer_rebate_credit_balance")
    .eq("customer_id", custId)
    .maybeSingle();
  if (custErr) return { err: custErr.message || String(custErr) };
  if (!customer) return { skipped: true, credit_applied: 0 };

  const balance = roundMoney_(Number(customer.dealer_rebate_credit_balance || 0));
  if (balance <= 1e-9) return { skipped: true, credit_applied: 0 };

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", aid).maybeSingle();
  if (arErr) return { err: arErr.message || String(arErr) };
  if (!ar) return { skipped: true, credit_applied: 0 };

  const due = roundMoney_(ar.amount_due);
  if (due <= 1e-9) return { skipped: true, credit_applied: 0 };

  const { data: rebates, error: rebErr } = await sb
    .from("commercial_dealer_rebate")
    .select("period_ym, rebate_amount, status, settle_mode")
    .eq("customer_id", custId)
    .eq("status", "POSTED")
    .eq("settle_mode", "CARRY_FORWARD");
  if (rebErr) return { err: rebErr.message || String(rebErr) };

  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate: shipDate,
    creditBalance: balance,
    postedCarryForwardRebates: rebates || []
  });
  if (eligible <= 1e-9) {
    return {
      skipped: true,
      credit_applied: 0,
      credit_deferred: true,
      defer_reason:
        shipYm && balance > 1e-9
          ? "折抵餘額 " +
            balance +
            " 元保留中；僅「回饋月份次月（含）起」的一般出貨才自動折抵（本次出貨 " +
            shipYm +
            "）"
          : "尚無可折抵額度"
    };
  }

  const cut = roundMoney_(Math.min(eligible, due));
  const newDue = roundMoney_(due - cut);
  const reason = dealerCreditShipmentReason_(sid);

  const adjRes = await adjustArAmountBundle({
    ar_id: aid,
    amount_due: newDue,
    reason,
    reason_code: "DISCOUNT",
    updated_by: actor,
    created_by: actor,
    _session: session,
    _from_settlement_dealer_credit: true
  });
  if (adjRes && adjRes.success === false) {
    return { err: (adjRes.errors && adjRes.errors[0]) || "經銷折抵套用失敗" };
  }

  const newBal = roundMoney_(balance - cut);
  const { error: updErr } = await sb
    .from("customer")
    .update({ dealer_rebate_credit_balance: newBal, updated_by: actor, updated_at: ts })
    .eq("customer_id", custId);
  if (updErr) return { err: updErr.message || String(updErr) };

  await writeAuditLog_(
    "customer",
    custId,
    "BUNDLE_APPLY_DEALER_CREDIT_AT_SHIPMENT",
    actor,
    JSON.stringify({
      shipment_id: sid,
      ar_id: aid,
      credit_applied: cut,
      balance_before: balance,
      balance_after: newBal
    })
  );

  return { credit_applied: cut, balance_before: balance, balance_after: newBal };
}

async function restoreDealerCreditOnSettlementVoid_(opts) {
  const { sb, settlementId, arId, customerId, actor, ts } = opts || {};
  const sid = normId_(settlementId);
  const aid = normId_(arId);
  const custId = normId_(customerId);
  if (!sid || !aid || !custId) return { skipped: true, credit_restored: 0 };

  const reason = dealerCreditSettlementReason_(sid);
  const { data: logs, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("amount_before, amount_after")
    .eq("ar_id", aid)
    .eq("reason", reason);
  if (error) throw new Error(error.message || String(error));

  let cut = 0;
  (logs || []).forEach((log) => {
    cut = roundMoney_(cut + Number(log.amount_before || 0) - Number(log.amount_after || 0));
  });
  if (cut <= 1e-9) return { skipped: true, credit_restored: 0 };

  const { data: customer, error: custErr } = await sb
    .from("customer")
    .select("dealer_rebate_credit_balance")
    .eq("customer_id", custId)
    .maybeSingle();
  if (custErr) throw new Error(custErr.message || String(custErr));

  const cur = roundMoney_(Number(customer?.dealer_rebate_credit_balance || 0));
  const newBal = roundMoney_(cur + cut);
  const { error: updErr } = await sb
    .from("customer")
    .update({ dealer_rebate_credit_balance: newBal, updated_by: actor, updated_at: ts })
    .eq("customer_id", custId);
  if (updErr) throw new Error(updErr.message || String(updErr));

  await writeAuditLog_(
    "customer",
    custId,
    "BUNDLE_RESTORE_DEALER_CREDIT_ON_SETTLEMENT_VOID",
    actor,
    JSON.stringify({
      settlement_id: sid,
      ar_id: aid,
      credit_restored: cut,
      balance_before: cur,
      balance_after: newBal
    })
  );

  return { credit_restored: cut, balance_before: cur, balance_after: newBal };
}

async function loadSchemeIdsWithPostedRebate_(sb, schemeIds) {
  const ids = (schemeIds || []).map(normId_).filter(Boolean);
  const locked = new Set();
  if (!ids.length) return locked;
  const { data, error } = await sb
    .from("commercial_dealer_rebate")
    .select("scheme_id")
    .in("scheme_id", ids)
    .neq("status", "VOID");
  if (error) throw new Error(error.message || String(error));
  (data || []).forEach((row) => {
    const sid = normId_(row.scheme_id);
    if (sid) locked.add(sid);
  });
  return locked;
}

function pickTierForBilling_(billingNet, tiers) {
  const net = roundMoney_(billingNet);
  const sorted = (tiers || [])
    .slice()
    .sort((a, b) => Number(b.amount_from || 0) - Number(a.amount_from || 0));
  for (const t of sorted) {
    const from = Number(t.amount_from || 0);
    const to = t.amount_to != null && t.amount_to !== "" ? Number(t.amount_to) : null;
    if (net + 1e-9 < from) continue;
    if (to != null && net - 1e-9 > to) continue;
    return t;
  }
  return null;
}

/** 累積金額制：依累積採購門檻取最高達標級距 */
function pickCumulativeTier_(cumulativeAmount, tiers) {
  const amt = roundMoney_(cumulativeAmount);
  const sorted = (tiers || [])
    .slice()
    .sort((a, b) => Number(b.amount_from || 0) - Number(a.amount_from || 0));
  for (const t of sorted) {
    const from = Number(t.amount_from || 0);
    if (amt + 1e-9 >= from) return t;
  }
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function cumulativeTierThreshold_(tier) {
  return Number(tier && tier.amount_from != null ? tier.amount_from : 0);
}

function matchCustomerToCumulativeTier_(customer, tiers) {
  const label = String(customer?.dealer_cumulative_tier_label || "").trim();
  if (label) {
    const found = (tiers || []).find((t) => String(t.tier_label || "").trim() === label);
    if (found) return found;
  }
  const rate = customer?.dealer_cumulative_price_rate;
  if (rate != null && rate !== "") {
    const byRate = (tiers || []).find((t) => Math.abs(Number(t.price_rate || 0) - Number(rate)) < 1e-9);
    if (byRate) return byRate;
  }
  return pickCumulativeTier_(Number(customer?.dealer_cumulative_amount || 0), tiers);
}

function isCumulativeTierUpgrade_(candidate, current) {
  if (!candidate) return false;
  if (!current) return cumulativeTierThreshold_(candidate) > 1e-9;
  return cumulativeTierThreshold_(candidate) > cumulativeTierThreshold_(current) + 1e-9;
}

async function loadCumulativeSchemeTiers_(sb, schemeId) {
  const sid = normId_(schemeId);
  if (!sid) return [];
  const { data, error } = await sb
    .from("commercial_dealer_scheme_tier")
    .select("*")
    .eq("scheme_id", sid)
    .order("line_no", { ascending: true });
  if (error) throw new Error(error.message || String(error));
  return data || [];
}

async function reloadCustomer_(sb, customerId) {
  const { data, error } = await sb.from("customer").select("*").eq("customer_id", customerId).maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function promotePendingCumulativeTierIfDue_(sb, customerId, settleYm, actor, ts) {
  const custId = normId_(customerId);
  const ym = String(settleYm || "").trim();
  if (!custId || !ym) return { promoted: false };

  let customer = await reloadCustomer_(sb, custId);
  if (!customer) return { promoted: false };

  const pendingLabel = String(customer.dealer_cumulative_pending_tier_label || "").trim();
  const pendingFromYm = String(customer.dealer_cumulative_pending_from_ym || "").trim();
  if (!pendingLabel || !pendingFromYm || ym <= pendingFromYm) {
    return { promoted: false };
  }

  customer = await applyPendingCumulativeTierOnCustomer_(sb, customer, actor, ts);
  return { promoted: true, customer_id: custId, tier_label: pendingLabel };
}

async function applyPendingCumulativeTierOnCustomer_(sb, customer, actor, ts) {
  const custId = normId_(customer?.customer_id);
  const pendingLabel = String(customer?.dealer_cumulative_pending_tier_label || "").trim();
  if (!custId || !pendingLabel) return customer;

  const patch = {
    dealer_cumulative_tier_label: pendingLabel,
    dealer_cumulative_price_rate:
      customer.dealer_cumulative_pending_price_rate != null && customer.dealer_cumulative_pending_price_rate !== ""
        ? Number(customer.dealer_cumulative_pending_price_rate)
        : null,
    dealer_cumulative_pending_tier_label: "",
    dealer_cumulative_pending_price_rate: null,
    dealer_cumulative_pending_from_ym: "",
    updated_by: actor,
    updated_at: ts
  };
  const { error } = await sb.from("customer").update(patch).eq("customer_id", custId);
  if (error) throw new Error(error.message || String(error));
  return reloadCustomer_(sb, custId);
}

async function ensureCustomerCumulativeCurrentTier_(sb, customer, tiers, actor, ts) {
  const custId = normId_(customer?.customer_id);
  if (!custId) return customer;
  if (String(customer?.dealer_cumulative_tier_label || "").trim()) return customer;

  const initTier = pickCumulativeTier_(Number(customer?.dealer_cumulative_amount || 0), tiers);
  if (!initTier) return customer;

  const patch = {
    dealer_cumulative_tier_label: String(initTier.tier_label || "").trim(),
    dealer_cumulative_price_rate: initTier.price_rate != null ? Number(initTier.price_rate) : null,
    updated_by: actor,
    updated_at: ts
  };
  const { error } = await sb.from("customer").update(patch).eq("customer_id", custId);
  if (error) throw new Error(error.message || String(error));
  return reloadCustomer_(sb, custId);
}

/** 客戶已綁累積制方案但尚未寫入等級時，依累積採購對級距帶出目前等級／經銷價 */
async function syncCustomerCumulativeTierIfNeeded_(sb, customerId, actor, opts) {
  const custId = normId_(customerId);
  if (!custId) return { skipped: true, reason: "no_customer_id" };

  let customer = await reloadCustomer_(sb, custId);
  if (!customer) return { skipped: true, reason: "no_customer" };

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return { skipped: true, reason: "no_scheme" };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_type, status, stat_source, date_from, date_to")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") {
    return { skipped: true, reason: "not_cumulative_scheme" };
  }

  const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
  if (!tiers.length) return { skipped: true, reason: "no_tiers" };

  const ts = opts?.ts || nowIso();
  const act = String(actor || "").trim();
  const beforeLabel = String(customer.dealer_cumulative_tier_label || "").trim();
  customer = await ensureCustomerCumulativeCurrentTier_(sb, customer, tiers, act, ts);
  const afterLabel = String(customer?.dealer_cumulative_tier_label || "").trim();

  return {
    synced: !!afterLabel && afterLabel !== beforeLabel,
    already_set: !!beforeLabel,
    customer_id: custId,
    dealer_cumulative_stat_source: normId_(scheme?.stat_source) || "CONSIGNMENT",
    dealer_cumulative_tier_label: String(customer?.dealer_cumulative_tier_label || "").trim(),
    dealer_cumulative_price_rate:
      customer?.dealer_cumulative_price_rate != null && customer.dealer_cumulative_price_rate !== ""
        ? Number(customer.dealer_cumulative_price_rate)
        : null,
    dealer_cumulative_pending_tier_label: String(customer?.dealer_cumulative_pending_tier_label || "").trim(),
    dealer_cumulative_pending_price_rate:
      customer?.dealer_cumulative_pending_price_rate != null && customer.dealer_cumulative_pending_price_rate !== ""
        ? Number(customer.dealer_cumulative_pending_price_rate)
        : null
  };
}

async function syncCustomerCumulativeTierBundle(p) {
  const customerId = normId_(p.customer_id);
  if (!customerId) return fail("customer_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  try {
    const ts = nowIso();
    let backfill = { skipped: true };
    try {
      backfill = await backfillGeneralShipmentCumulativeIfNeeded_(sb, customerId, actor, ts);
    } catch (bfErr) {
      backfill = { skipped: true, err: bfErr?.message || String(bfErr) };
    }
    const recalc = await recalculateCustomerCumulativeFromPostedRebates_(sb, customerId, actor, ts);
    const res = await syncCustomerCumulativeTierIfNeeded_(sb, customerId, actor, { ts });
    const customerAfter = await reloadCustomer_(sb, customerId);
    const out = Object.assign({}, res);
    if (!backfill.skipped) out.backfill = backfill;
    if (backfill.err) out.backfill_error = backfill.err;
    if (!recalc.skipped) {
      out.recalc = recalc;
      out.cumulative_before = recalc.cumulative_before;
      out.cumulative_after = recalc.cumulative_after;
    } else if (recalc.cumulative_amount != null) {
      out.cumulative_after = recalc.cumulative_amount;
    }
    if (customerAfter) {
      out.dealer_cumulative_amount = roundMoney_(customerAfter.dealer_cumulative_amount);
      out.dealer_cumulative_tier_label = String(customerAfter.dealer_cumulative_tier_label || "").trim();
      out.dealer_cumulative_price_rate =
        customerAfter.dealer_cumulative_price_rate != null && customerAfter.dealer_cumulative_price_rate !== ""
          ? Number(customerAfter.dealer_cumulative_price_rate)
          : null;
      out.dealer_cumulative_pending_tier_label = String(
        customerAfter.dealer_cumulative_pending_tier_label || ""
      ).trim();
      out.dealer_cumulative_pending_price_rate =
        customerAfter.dealer_cumulative_pending_price_rate != null &&
        customerAfter.dealer_cumulative_pending_price_rate !== ""
          ? Number(customerAfter.dealer_cumulative_pending_price_rate)
          : null;
      if (out.cumulative_after == null) out.cumulative_after = out.dealer_cumulative_amount;
    }
    return ok(out);
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

async function buildCumulativeClosePreview_(sb, customer, billingNet) {
  const schemeId = normId_(customer?.dealer_cumulative_scheme_id);
  if (!schemeId) return { enabled: false };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_name, scheme_type, status")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") return { enabled: false };

  const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
  if (!tiers.length) return { enabled: false, err: "累積金額制方案無級距" };

  const actualCurrentLabel = String(customer.dealer_cumulative_tier_label || "").trim();
  const actualCurrentRate =
    customer.dealer_cumulative_price_rate != null && customer.dealer_cumulative_price_rate !== ""
      ? Number(customer.dealer_cumulative_price_rate)
      : null;
  const existingPendingLabel = String(customer.dealer_cumulative_pending_tier_label || "").trim();
  const existingPendingRate =
    customer.dealer_cumulative_pending_price_rate != null &&
    customer.dealer_cumulative_pending_price_rate !== ""
      ? Number(customer.dealer_cumulative_pending_price_rate)
      : null;

  let sim = Object.assign({}, customer);
  if (String(sim.dealer_cumulative_pending_tier_label || "").trim()) {
    sim.dealer_cumulative_tier_label = sim.dealer_cumulative_pending_tier_label;
    sim.dealer_cumulative_price_rate = sim.dealer_cumulative_pending_price_rate;
    sim.dealer_cumulative_pending_tier_label = "";
    sim.dealer_cumulative_pending_price_rate = null;
  }
  if (!String(sim.dealer_cumulative_tier_label || "").trim()) {
    const initTier = pickCumulativeTier_(Number(sim.dealer_cumulative_amount || 0), tiers);
    if (initTier) {
      sim.dealer_cumulative_tier_label = initTier.tier_label;
      sim.dealer_cumulative_price_rate = initTier.price_rate;
    }
  }

  const before = roundMoney_(sim.dealer_cumulative_amount);
  const add = roundMoney_(billingNet);
  const after = roundMoney_(before + add);
  const currentTier = matchCustomerToCumulativeTier_(sim, tiers);
  const tierAfterAdd = pickCumulativeTier_(after, tiers);
  const upgrade = isCumulativeTierUpgrade_(tierAfterAdd, currentTier);
  let pendingLabel = "";
  let pendingRate = null;
  if (upgrade) {
    pendingLabel = String(tierAfterAdd?.tier_label || "").trim();
    pendingRate = tierAfterAdd?.price_rate != null ? Number(tierAfterAdd.price_rate) : null;
  } else if (existingPendingLabel) {
    pendingLabel = existingPendingLabel;
    pendingRate = existingPendingRate;
  }

  return {
    enabled: true,
    scheme_id: schemeId,
    scheme_name: String(scheme.scheme_name || "").trim(),
    cumulative_before: before,
    cumulative_add: add,
    cumulative_after: after,
    current_tier_label:
      actualCurrentLabel || String(sim.dealer_cumulative_tier_label || "").trim(),
    current_price_rate:
      actualCurrentRate != null
        ? actualCurrentRate
        : sim.dealer_cumulative_price_rate != null && sim.dealer_cumulative_price_rate !== ""
          ? Number(sim.dealer_cumulative_price_rate)
          : null,
    upgrade,
    pending_tier_label: pendingLabel,
    pending_price_rate: pendingRate,
    pending_from_this_stat: upgrade
  };
}

/** 已過帳月結統計：用當時快照，勿再以主檔累積 + 本月寄賣重算（避免重複加） */
async function buildCumulativePreviewFromPostedStat_(sb, customer, statRow) {
  const schemeId = normId_(statRow?.cumulative_scheme_id || customer?.dealer_cumulative_scheme_id);
  if (!schemeId) return { enabled: false };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_name, scheme_type, status")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") return { enabled: false };

  const beforeRaw = statRow?.cumulative_before;
  const afterRaw = statRow?.cumulative_after;
  if (beforeRaw == null && afterRaw == null) return { enabled: false };

  const before = roundMoney_(beforeRaw != null ? beforeRaw : 0);
  const after = roundMoney_(afterRaw != null ? afterRaw : before);
  const addCons = roundMoney_(statRow?.cumulative_add_consignment || 0);
  const addGen = roundMoney_(statRow?.cumulative_add_general || 0);
  const addFromCols = roundMoney_(addCons + addGen);
  const add = addFromCols > 1e-9 ? addFromCols : roundMoney_(Math.max(0, after - before));
  const pendingLabel = String(statRow?.cumulative_pending_tier_label || "").trim();
  const pendingRate =
    statRow?.cumulative_pending_price_rate != null && statRow?.cumulative_pending_price_rate !== ""
      ? Number(statRow.cumulative_pending_price_rate)
      : null;
  const actualCurrentLabel = String(customer?.dealer_cumulative_tier_label || "").trim();
  const actualCurrentRate =
    customer?.dealer_cumulative_price_rate != null && customer?.dealer_cumulative_price_rate !== ""
      ? Number(customer.dealer_cumulative_price_rate)
      : null;

  return {
    enabled: true,
    posted_snapshot: true,
    scheme_id: schemeId,
    scheme_name: String(scheme.scheme_name || "").trim(),
    cumulative_before: before,
    cumulative_add: add,
    cumulative_after: after,
    current_tier_label: actualCurrentLabel,
    current_price_rate: actualCurrentRate,
    upgrade: !!pendingLabel,
    pending_tier_label: pendingLabel,
    pending_price_rate: pendingRate,
    pending_from_this_stat: !!pendingLabel
  };
}

async function applyCustomerCumulativeAmountAdd_(sb, opts) {
  const customerId = normId_(opts?.customerId);
  const billingNet = roundMoney_(opts?.billingNet);
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();
  if (!customerId) return { skipped: true, reason: "no_customer" };
  if (billingNet <= 1e-9) return { skipped: true, reason: "no_billing" };

  let customer = await reloadCustomer_(sb, customerId);
  if (!customer) return { skipped: true, reason: "no_customer" };

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return { skipped: true, reason: "no_cumulative_scheme" };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_type")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") {
    return { skipped: true, reason: "not_cumulative_scheme" };
  }

  const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
  if (!tiers.length) return { err: "累積金額制方案無級距" };

  customer = await ensureCustomerCumulativeCurrentTier_(sb, customer, tiers, actor, ts);

  const before = roundMoney_(customer.dealer_cumulative_amount);
  const after = roundMoney_(before + billingNet);
  const currentTier = matchCustomerToCumulativeTier_(customer, tiers);
  const tierAfterAdd = pickCumulativeTier_(after, tiers);
  const upgrade = isCumulativeTierUpgrade_(tierAfterAdd, currentTier);
  const upgradeFromYm = String(opts?.upgradeFromYm || opts?.periodYm || "").trim();

  const patch = {
    dealer_cumulative_amount: after,
    updated_by: actor,
    updated_at: ts
  };

  let pendingTierLabel = "";
  let pendingPriceRate = null;
  if (upgrade && tierAfterAdd) {
    pendingTierLabel = String(tierAfterAdd.tier_label || "").trim();
    pendingPriceRate = tierAfterAdd.price_rate != null ? Number(tierAfterAdd.price_rate) : null;
    patch.dealer_cumulative_pending_tier_label = pendingTierLabel;
    patch.dealer_cumulative_pending_price_rate = pendingPriceRate;
    if (upgradeFromYm) patch.dealer_cumulative_pending_from_ym = upgradeFromYm;
  }

  const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
  if (updErr) throw new Error(updErr.message || String(updErr));

  return {
    cumulative_before: before,
    cumulative_after: after,
    cumulative_added: billingNet,
    upgrade,
    pending_tier_label: pendingTierLabel,
    pending_price_rate: pendingPriceRate
  };
}

async function processCumulativeOnMonthlyClose_(sb, opts) {
  const customerId = normId_(opts?.customerId);
  const billingNet = roundMoney_(opts?.billingNet);
  const rebateId = String(opts?.rebateId || "").trim();
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();

  const res = await applyCustomerCumulativeAmountAdd_(sb, { customerId, billingNet, actor, ts });
  if (res.skipped || res.err) return res;

  if (rebateId) {
    const { error: rebErr } = await sb
      .from("commercial_dealer_rebate")
      .update({
        cumulative_added: res.cumulative_added,
        cumulative_before: res.cumulative_before,
        cumulative_after: res.cumulative_after,
        cumulative_pending_tier_label: res.pending_tier_label,
        cumulative_pending_price_rate: res.pending_price_rate,
        updated_by: actor,
        updated_at: ts
      })
      .eq("rebate_id", rebateId);
    if (rebErr) throw new Error(rebErr.message || String(rebErr));
  }

  await writeAuditLog_(
    "customer",
    customerId,
    "BUNDLE_UPDATE_DEALER_CUMULATIVE_ON_REBATE",
    actor,
    JSON.stringify({
      rebate_id: rebateId,
      cumulative_before: res.cumulative_before,
      cumulative_after: res.cumulative_after,
      cumulative_added: res.cumulative_added,
      upgrade: res.upgrade,
      pending_tier_label: res.pending_tier_label,
      pending_price_rate: res.pending_price_rate
    })
  );

  return res;
}

/** 一般出貨過帳：累積改由月結統計過帳寫入（v4.2.11）；出貨僅產生請款 */
async function processCumulativeOnGeneralShipment_(sb, opts) {
  return { skipped: true, reason: "deferred_to_monthly_stat" };
}

async function reverseCumulativeOnGeneralShipmentVoid_(sb, opts) {
  return { skipped: true, reason: "deferred_to_monthly_stat" };
}

async function reverseCumulativeOnRebateVoid_(sb, rebate, actor, ts) {
  const customerId = normId_(rebate?.customer_id);
  if (!customerId) return { skipped: true };

  let removed = roundMoney_(rebate?.cumulative_added);
  if (removed <= 1e-9) return { skipped: true, reason: "no_cumulative_added" };

  const customer = await reloadCustomer_(sb, customerId);
  if (!customer) return { skipped: true, reason: "no_customer" };

  const before = roundMoney_(customer.dealer_cumulative_amount);
  const after = roundMoney_(Math.max(0, before - removed));

  const patch = {
    dealer_cumulative_amount: after,
    updated_by: actor,
    updated_at: ts
  };

  const snapPending = String(rebate?.cumulative_pending_tier_label || "").trim();
  const custPending = String(customer.dealer_cumulative_pending_tier_label || "").trim();
  if (snapPending && snapPending === custPending) {
    patch.dealer_cumulative_pending_tier_label = "";
    patch.dealer_cumulative_pending_price_rate = null;
  }

  const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
  if (updErr) throw new Error(updErr.message || String(updErr));

  await writeAuditLog_(
    "customer",
    customerId,
    "BUNDLE_REVERSE_DEALER_CUMULATIVE_ON_REBATE_VOID",
    actor,
    JSON.stringify({
      rebate_id: rebate.rebate_id,
      cumulative_before: before,
      cumulative_after: after,
      cumulative_removed: removed,
      cleared_pending: !!(snapPending && snapPending === custPending)
    })
  );

  return { cumulative_before: before, cumulative_after: after, cumulative_removed: removed };
}

/** 依仍有效（POSTED）月結回饋重算累積採購；作廢後若扣回漏掉可自動校正 */
async function sumPostedRebateCumulative_(sb, customerId, asOfYm) {
  const custId = normId_(customerId);
  if (!custId) return 0;
  let query = sb
    .from("commercial_dealer_rebate")
    .select("cumulative_added, billing_net, period_ym")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  const ymCut = String(asOfYm || "").trim();
  if (ymCut) query = query.lte("period_ym", ymCut);
  const { data: rebates, error: rebErr } = await query;
  if (rebErr) throw new Error(rebErr.message || String(rebErr));
  let total = 0;
  (rebates || []).forEach((r) => {
    const add = roundMoney_(r.cumulative_added);
    if (add > 1e-9) total += add;
  });
  return roundMoney_(total);
}

/** 一般出貨 AR 是否仍應計入月結累積（作廢出貨為 SETTLED + close_mode VOID，非 status VOID） */
function isArActiveForCumulative_(ar) {
  if (!ar) return false;
  const st = String(ar.status || "").trim().toUpperCase();
  const cm = String(ar.close_mode || "").trim().toUpperCase();
  if (st === "VOID" || cm === "VOID") return false;
  return true;
}

/** v4.2.11：一般累積改由月結統計過帳；出貨 AR 不再計入 as_of */
async function sumPostedGeneralShipmentCumulative_(sb, customerId, opts) {
  return 0;
}

async function sumPostedMonthlyStatCumulative_(sb, customerId, asOfYm) {
  const custId = normId_(customerId);
  if (!custId) return 0;
  const ymCut = String(asOfYm || "").trim();

  let lpQuery = sb
    .from("commercial_dealer_level_post")
    .select("cumulative_add_consignment, cumulative_add_general, period_ym")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  if (ymCut) lpQuery = lpQuery.lte("period_ym", ymCut);
  const { data: levelRows, error: lpErr } = await lpQuery;
  if (lpErr) throw new Error(lpErr.message || String(lpErr));

  const levelPeriods = new Set();
  let total = 0;
  (levelRows || []).forEach((r) => {
    levelPeriods.add(String(r.period_ym || "").trim());
    total += roundMoney_(r.cumulative_add_consignment);
    total += roundMoney_(r.cumulative_add_general);
  });

  let statQuery = sb
    .from("commercial_dealer_monthly_stat")
    .select("cumulative_add_consignment, cumulative_add_general, period_ym")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  if (ymCut) statQuery = statQuery.lte("period_ym", ymCut);
  const { data: statRows, error: statErr } = await statQuery;
  if (statErr) throw new Error(statErr.message || String(statErr));

  (statRows || []).forEach((r) => {
    const ym = String(r.period_ym || "").trim();
    if (levelPeriods.has(ym)) return;
    total += roundMoney_(r.cumulative_add_consignment);
    total += roundMoney_(r.cumulative_add_general);
  });
  return roundMoney_(total);
}

async function sumCustomerCumulativeFromSources_(sb, customerId, opts) {
  const customer = opts?.customer || (await reloadCustomer_(sb, normId_(customerId)));
  const asOfYm = String(opts?.asOfYm || "").trim();
  const rebateTotal = await sumPostedRebateCumulative_(sb, customerId, asOfYm);
  const statTotal = await sumPostedMonthlyStatCumulative_(sb, customerId, asOfYm);
  return roundMoney_(rebateTotal + statTotal);
}

/** v4.2.11：一般累積已改月結過帳，不再 backfill 出貨 AR */
async function backfillGeneralShipmentCumulativeIfNeeded_(sb, customerId, actor, ts) {
  return { skipped: true, reason: "deferred_to_monthly_stat" };
}

async function syncCustomerCumulativeFromSources_(sb, customerId, actor, ts) {
  const custId = normId_(customerId);
  if (!custId) return { skipped: true, reason: "no_customer" };
  const who = String(actor || "").trim();
  const when = ts || nowIso();
  try {
    return await recalculateCustomerCumulativeFromPostedRebates_(sb, custId, who, when);
  } catch (e) {
    return { err: e?.message || String(e) };
  }
}

async function recalculateCustomerCumulativeFromPostedRebates_(sb, customerId, actor, ts) {
  const custId = normId_(customerId);
  if (!custId) return { skipped: true, reason: "no_customer" };

  let customer = await reloadCustomer_(sb, custId);
  if (!customer) return { skipped: true, reason: "no_customer" };

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return { skipped: true, reason: "no_scheme" };

  const total = await sumCustomerCumulativeFromSources_(sb, custId, { customer });
  const before = roundMoney_(customer.dealer_cumulative_amount);
  if (Math.abs(before - total) < 1e-9) {
    return { skipped: true, reason: "already_synced", cumulative_amount: total };
  }

  const patch = {
    dealer_cumulative_amount: total,
    updated_by: actor,
    updated_at: ts
  };

  const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
  if (tiers.length) {
    const tier = pickCumulativeTier_(total, tiers);
    if (tier) {
      patch.dealer_cumulative_tier_label = String(tier.tier_label || "").trim();
      patch.dealer_cumulative_price_rate = tier.price_rate != null ? Number(tier.price_rate) : null;
    } else {
      patch.dealer_cumulative_tier_label = "";
      patch.dealer_cumulative_price_rate = null;
    }
    const { data: postedRebates } = await sb
      .from("commercial_dealer_rebate")
      .select("cumulative_pending_tier_label")
      .eq("customer_id", custId)
      .eq("status", "POSTED");
    const pendingLabels = new Set(
      (postedRebates || [])
        .map((r) => String(r.cumulative_pending_tier_label || "").trim())
        .filter(Boolean)
    );
    const custPending = String(customer.dealer_cumulative_pending_tier_label || "").trim();
    if (custPending && !pendingLabels.has(custPending)) {
      patch.dealer_cumulative_pending_tier_label = "";
      patch.dealer_cumulative_pending_price_rate = null;
    }
  }

  const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", custId);
  if (updErr) throw new Error(updErr.message || String(updErr));

  await writeAuditLog_(
    "customer",
    custId,
    "BUNDLE_RECALC_DEALER_CUMULATIVE_FROM_REBATES",
    actor,
    JSON.stringify({
      cumulative_before: before,
      cumulative_after: total
    })
  );

  return { cumulative_before: before, cumulative_after: total, recalculated: true };
}

/** 寄賣結算／一般出貨：解析當月有效累積制經銷價（含次月待生效） */
async function resolveCumulativeDealerPriceForSettlement_(sb, customerId, settlementDateYmd, channel) {
  const custId = normId_(customerId);
  const ymd = String(settlementDateYmd || "").trim();
  const settleYm = ymd.length >= 7 ? ymd.slice(0, 7) : "";
  const ch = normId_(channel) || "CONSIGNMENT";
  if (!custId || !ymd || !settleYm) return { enabled: false };

  const { data: customerRow, error: custErr } = await sb.from("customer").select("*").eq("customer_id", custId).maybeSingle();
  if (custErr) throw new Error(custErr.message || String(custErr));
  if (!customerRow) return { enabled: false };
  let customer = customerRow;

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return { enabled: false };

  const startedAt = String(customer.dealer_cumulative_started_at || "").trim();
  if (startedAt && ymd < startedAt) return { enabled: false };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("*")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") return { enabled: false };
  if (normId_(scheme.status) !== "ACTIVE") return { enabled: false };
  if (!schemeOverlapsMonth_(scheme, ymd, ymd)) return { enabled: false };
  if (!schemeStatSourceAllows_(scheme.stat_source, ch)) return { enabled: false };

  try {
    await promotePendingCumulativeTierIfDue_(sb, custId, settleYm, "system", nowIso());
  } catch (_ePromo) {}

  const { data: customer2, error: custErr2 } = await sb.from("customer").select("*").eq("customer_id", custId).maybeSingle();
  if (custErr2) throw new Error(custErr2.message || String(custErr2));
  if (customer2) customer = customer2;

  let tierLabel = String(customer.dealer_cumulative_tier_label || "").trim();
  let priceRate =
    customer.dealer_cumulative_price_rate != null && customer.dealer_cumulative_price_rate !== ""
      ? Number(customer.dealer_cumulative_price_rate)
      : null;
  let priceSource = "CURRENT";
  let pendingEffective = false;

  const pendingLabel = String(customer.dealer_cumulative_pending_tier_label || "").trim();
  const pendingRate =
    customer.dealer_cumulative_pending_price_rate != null && customer.dealer_cumulative_pending_price_rate !== ""
      ? Number(customer.dealer_cumulative_pending_price_rate)
      : null;

  if (pendingLabel && pendingRate != null) {
    const pendingFromYm = String(customer.dealer_cumulative_pending_from_ym || "").trim();
    if (pendingFromYm && settleYm > pendingFromYm) {
      tierLabel = pendingLabel;
      priceRate = pendingRate;
      priceSource = "PENDING";
      pendingEffective = true;
    }
  }

  if (!tierLabel || priceRate == null) {
    const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
    const initTier = pickCumulativeTier_(Number(customer.dealer_cumulative_amount || 0), tiers);
    if (initTier) {
      tierLabel = String(initTier.tier_label || "").trim();
      priceRate = initTier.price_rate != null ? Number(initTier.price_rate) : null;
    }
  }

  if (!(priceRate > 0)) return { enabled: false };

  return {
    enabled: true,
    scheme_id: schemeId,
    stat_source: normId_(scheme.stat_source) || "CONSIGNMENT",
    channel: ch,
    tier_label: tierLabel,
    price_rate: priceRate,
    price_source: priceSource,
    pending_effective: pendingEffective,
    current_tier_label: String(customer.dealer_cumulative_tier_label || "").trim(),
    current_price_rate:
      customer.dealer_cumulative_price_rate != null && customer.dealer_cumulative_price_rate !== ""
        ? Number(customer.dealer_cumulative_price_rate)
        : null,
    pending_tier_label: pendingLabel,
    pending_price_rate: pendingRate
  };
}

/** Promo 優先；無促銷時結算單價＝出貨經銷價（池子已含等級折數，不再重算） */
function applyCumulativeDealerPriceToLines_(lines, dealerCtx) {
  return (lines || []).map((ln) => {
    if (!dealerCtx?.enabled || String(ln.promo_scheme_id || "").trim()) return ln;
    return Object.assign({}, ln, {
      dealer_cumulative_tier_label: String(dealerCtx.tier_label || ""),
      dealer_cumulative_price_rate:
        dealerCtx.price_rate != null && dealerCtx.price_rate !== "" ? Number(dealerCtx.price_rate) : null,
      dealer_cumulative_price_source: String(dealerCtx.price_source || "CURRENT")
    });
  });
}

async function previewCumulativeDealerForSettlementBundle(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;

  const customerId = normId_(p.customer_id);
  const settlementDate = String(p.settlement_date || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!settlementDate) return fail("settlement_date required");

  const sb = getSupabase();
  try {
    const ctx = await resolveCumulativeDealerPriceForSettlement_(sb, customerId, settlementDate);
    return ok(ctx);
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

function dealerRebateDiscountReason_(periodYm) {
  return "經銷月結回饋折讓（" + String(periodYm || "").trim() + "）";
}

function dealerRebateVoidReason_(periodYm) {
  return "作廢經銷月結回饋（" + String(periodYm || "").trim() + "）";
}

/** 該 AR 上此月份經銷回饋折讓的淨額（折讓 − 作廢還原，≥0） */
function computeNetDealerRebateCutOnLogs_(logs, periodYm) {
  const reasonDiscount = dealerRebateDiscountReason_(periodYm);
  const reasonVoid = dealerRebateVoidReason_(periodYm);
  let net = 0;
  (logs || []).forEach((log) => {
    const r = String(log.reason || "").trim();
    if (r !== reasonDiscount && r !== reasonVoid) return;
    const before = Number(log.amount_before || 0);
    const after = Number(log.amount_after || 0);
    net += before - after;
  });
  return roundMoney_(Math.max(0, net));
}

async function fetchNetDealerRebateCutOnAr_(sb, arId, periodYm) {
  const aid = normId_(arId);
  if (!aid) return 0;
  const reasonDiscount = dealerRebateDiscountReason_(periodYm);
  const reasonVoid = dealerRebateVoidReason_(periodYm);
  const { data, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("amount_before, amount_after, reason")
    .eq("ar_id", aid)
    .in("reason", [reasonDiscount, reasonVoid]);
  if (error) throw new Error(error.message || String(error));
  return computeNetDealerRebateCutOnLogs_(data, periodYm);
}

/** 經銷回饋／結算折抵相關 AR 調整不計入請款淨額（避免作廢重產後淨額飄移） */
function isDealerRebateArAdjustmentReason_(reason) {
  const r = String(reason || "").trim();
  if (/^經銷月結回饋折讓（/.test(r)) return true;
  if (/^作廢經銷月結回饋（/.test(r)) return true;
  if (/^經銷回饋折抵（結算 /.test(r)) return true;
  return false;
}

async function sumArDiscountAdjustments_(sb, arIds) {
  const ids = (arIds || []).map(normId_).filter(Boolean);
  if (!ids.length) return 0;
  const { data, error } = await sb
    .from("ar_amount_adjustment_log")
    .select("ar_id, amount_before, amount_after, reason")
    .in("ar_id", ids);
  if (error) throw new Error(error.message || String(error));
  let net = 0;
  (data || []).forEach((row) => {
    if (isDealerRebateArAdjustmentReason_(row.reason)) return;
    const before = Number(row.amount_before || 0);
    const after = Number(row.amount_after || 0);
    net += before - after;
  });
  return roundMoney_(net);
}

async function computeConsignmentBillingNet_(sb, customerId, periodYm) {
  const cust = normId_(customerId);
  const range = monthRange_(periodYm);
  if (!cust || !range) return { err: "customer_id or period_ym invalid" };

  const { data: settlements, error } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, settlement_date, amount_system, ar_id, status, customer_id")
    .eq("customer_id", cust)
    .eq("status", "POSTED")
    .gte("settlement_date", range.date_from)
    .lte("settlement_date", range.date_to);
  if (error) throw new Error(error.message || String(error));

  const rows = settlements || [];
  let gross = 0;
  const arIds = [];
  rows.forEach((s) => {
    gross += Number(s.amount_system || 0);
    const aid = normId_(s.ar_id);
    if (aid) arIds.push(aid);
  });
  gross = roundMoney_(gross);
  const discountAdj = await sumArDiscountAdjustments_(sb, arIds);
  const billing_net = roundMoney_(Math.max(0, gross - discountAdj));

  return {
    period_ym: range.period_ym,
    date_from: range.date_from,
    date_to: range.date_to,
    customer_id: cust,
    settlement_count: rows.length,
    gross_settlement: gross,
    /** 結算應收上的非回饋調降（已售退貨等）；不含月結回饋折讓／作廢還原 */
    ar_discount_total: discountAdj,
    billing_net,
    settlements: rows.map((s) => ({
      settlement_id: s.settlement_id,
      settlement_date: s.settlement_date,
      amount_system: Number(s.amount_system || 0),
      ar_id: normId_(s.ar_id)
    })),
    ar_ids: [...new Set(arIds)]
  };
}

async function computeGeneralBillingNet_(sb, customerId, periodYm) {
  const cust = normId_(customerId);
  const range = monthRange_(periodYm);
  if (!cust || !range) return { err: "customer_id or period_ym invalid" };

  const { data: arRows, error } = await sb
    .from("ar_receivable")
    .select("ar_id, ar_date, amount_system, shipment_id, customer_id, source_type")
    .eq("customer_id", cust)
    .eq("source_type", "SHIPMENT")
    .gte("ar_date", range.date_from)
    .lte("ar_date", range.date_to);
  if (error) throw new Error(error.message || String(error));

  const shipIds = [...new Set((arRows || []).map((a) => normId_(a.shipment_id)).filter(Boolean))];
  const postedShips = new Set();
  if (shipIds.length) {
    const { data: ships, error: shErr } = await sb
      .from("shipment")
      .select("shipment_id, status")
      .in("shipment_id", shipIds);
    if (shErr) throw new Error(shErr.message || String(shErr));
    (ships || []).forEach((s) => {
      if (normId_(s.status) === "POSTED") postedShips.add(normId_(s.shipment_id));
    });
  }

  const rows = (arRows || []).filter((a) => postedShips.has(normId_(a.shipment_id)));
  let gross = 0;
  const arIds = [];
  rows.forEach((a) => {
    gross += Number(a.amount_system || 0);
    const aid = normId_(a.ar_id);
    if (aid) arIds.push(aid);
  });
  gross = roundMoney_(gross);
  const discountAdj = await sumArDiscountAdjustments_(sb, arIds);
  const billing_net = roundMoney_(Math.max(0, gross - discountAdj));

  return {
    period_ym: range.period_ym,
    date_from: range.date_from,
    date_to: range.date_to,
    customer_id: cust,
    shipment_count: rows.length,
    gross_shipment: gross,
    ar_discount_total: discountAdj,
    billing_net,
    shipments: rows.map((a) => ({
      shipment_id: normId_(a.shipment_id),
      ar_date: a.ar_date,
      amount_system: Number(a.amount_system || 0),
      ar_id: normId_(a.ar_id)
    })),
    ar_ids: [...new Set(arIds)]
  };
}

async function computeBillingNetForStatSource_(sb, customerId, periodYm, statSource) {
  const src = normId_(statSource) || "CONSIGNMENT";
  let cons = null;
  let gen = null;

  if (src === "CONSIGNMENT" || src === "ALL") {
    cons = await computeConsignmentBillingNet_(sb, customerId, periodYm);
    if (cons.err) return cons;
  }
  if (src === "GENERAL" || src === "ALL") {
    gen = await computeGeneralBillingNet_(sb, customerId, periodYm);
    if (gen.err) return gen;
  }

  const billing_net = roundMoney_((cons?.billing_net || 0) + (gen?.billing_net || 0));
  const gross_settlement = roundMoney_(cons?.gross_settlement || 0);
  const gross_shipment = roundMoney_(gen?.gross_shipment || 0);
  const ar_discount_total = roundMoney_((cons?.ar_discount_total || 0) + (gen?.ar_discount_total || 0));

  return {
    period_ym: (cons || gen).period_ym,
    date_from: (cons || gen).date_from,
    date_to: (cons || gen).date_to,
    customer_id: normId_(customerId),
    stat_source: src,
    billing_net,
    billing_net_consignment: roundMoney_(cons?.billing_net || 0),
    billing_net_general: roundMoney_(gen?.billing_net || 0),
    gross_settlement,
    gross_shipment,
    ar_discount_total,
    settlement_count: cons?.settlement_count || 0,
    shipment_count: gen?.shipment_count || 0,
    settlements: cons?.settlements || [],
    shipments: gen?.shipments || [],
    ar_ids: [...new Set([...(cons?.ar_ids || []), ...(gen?.ar_ids || [])])]
  };
}

async function resolveCustomerDealerContext_(sb, customerId, periodYm) {
  const cust = normId_(customerId);
  const range = monthRange_(periodYm);
  if (!cust || !range) return { err: "customer_id or period_ym invalid" };

  const { data: customer, error: custErr } = await sb
    .from("customer")
    .select("*")
    .eq("customer_id", cust)
    .maybeSingle();
  if (custErr) throw new Error(custErr.message || String(custErr));
  if (!customer) return { err: "Customer not found: " + cust };

  const schemeId =
    normId_(customer.dealer_rebate_scheme_id) || normId_(customer.dealer_scheme_id);
  if (!schemeId) return { err: "客戶未設定月結回饋方案" };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("*")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme) return { err: "經銷方案不存在: " + schemeId };
  if (normId_(scheme.status) !== "ACTIVE") return { err: "經銷方案未生效: " + schemeId };
  if (!schemeOverlapsMonth_(scheme, range.date_from, range.date_to)) {
    return { err: "經銷方案有效期未涵蓋此月份" };
  }

  const schemeType = normId_(scheme.scheme_type) || "MONTHLY_REBATE";
  if (schemeType === "CUMULATIVE_AMOUNT") {
    return { err: "客戶經銷方案為累積金額制，不適用寄賣月結回饋（請改用月結回饋方案或待累積制結算功能上線）" };
  }
  if (schemeType !== "MONTHLY_REBATE") {
    return { err: "不支援的經銷方案類型: " + schemeType };
  }

  const statSource = normId_(scheme.stat_source) || "CONSIGNMENT";
  const billingPack = await computeBillingNetForStatSource_(sb, cust, range.period_ym, statSource);
  if (billingPack.err) return { err: billingPack.err };

  const { data: tiers, error: tierErr } = await sb
    .from("commercial_dealer_scheme_tier")
    .select("*")
    .eq("scheme_id", schemeId)
    .order("line_no", { ascending: true });
  if (tierErr) throw new Error(tierErr.message || String(tierErr));
  if (!(tiers || []).length) return { err: "經銷方案無級距明細" };

  const tier = pickTierForBilling_(billingPack.billing_net, tiers);
  const rebatePct = tier ? Number(tier.rebate_pct || 0) : 0;
  const rebateAmount = roundMoney_((billingPack.billing_net * rebatePct) / 100);

  const settleMode =
    normId_(customer.dealer_rebate_settle_mode) === "CARRY_FORWARD"
      ? "CARRY_FORWARD"
      : "CREDIT_NOTE";

  return {
    customer,
    scheme,
    tiers,
    tier,
    rebate_pct: rebatePct,
    rebate_amount: rebateAmount,
    settle_mode_default: settleMode,
    billing: billingPack
  };
}

async function repairArDueIfAboveSystem_(arRow, actor, session) {
  const arId = normId_(arRow && arRow.ar_id);
  const sys = roundMoney_(arRow && arRow.amount_system);
  const due = roundMoney_(arRow && arRow.amount_due);
  if (!arId || due <= sys + 1e-9) return { ar_id: arId, amount_due: due, repaired: 0 };

  const adjRes = await adjustArAmountBundle({
    ar_id: arId,
    amount_due: sys,
    reason: "系統修復：應收異常高於原始金額（回饋作廢重複還原）",
    reason_code: "AMOUNT_FIX",
    updated_by: actor,
    created_by: actor,
    _session: session
  });
  if (adjRes && adjRes.success === false) {
    return { err: (adjRes.errors && adjRes.errors[0]) || "AR 修復失敗: " + arId };
  }
  return { ar_id: arId, amount_due: sys, repaired: roundMoney_(due - sys) };
}

async function applyRebateCreditNote_(sb, arIds, rebateAmount, periodYm, actor, session) {
  const ids = (arIds || []).map(normId_).filter(Boolean);
  if (!ids.length) return { err: "本月無可折讓的應收單" };

  const { data: ars, error } = await sb
    .from("ar_receivable")
    .select("ar_id, amount_due, amount_system, status")
    .in("ar_id", ids);
  if (error) throw new Error(error.message || String(error));

  const open = (ars || [])
    .filter((a) => {
      const st = normId_(a.status);
      return (st === "OPEN" || st === "PARTIAL") && Number(a.amount_due || 0) > 1e-9;
    })
    .sort((a, b) => Number(b.amount_due || 0) - Number(a.amount_due || 0));

  if (!open.length) return { err: "本月應收已結清或無餘額，請改用下期折抵" };

  let remaining = roundMoney_(rebateAmount);
  let primaryArId = "";
  let applied = 0;
  const reason = dealerRebateDiscountReason_(periodYm);

  for (const ar of open) {
    if (remaining <= 1e-9) break;
    const arId = normId_(ar.ar_id);
    const repairRes = await repairArDueIfAboveSystem_(ar, actor, session);
    if (repairRes.err) return { err: repairRes.err };
    let due = roundMoney_(repairRes.amount_due);
    const cut = roundMoney_(Math.min(remaining, due));
    if (cut <= 1e-9) continue;
    const newDue = roundMoney_(due - cut);
    const adjRes = await adjustArAmountBundle({
      ar_id: arId,
      amount_due: newDue,
      reason,
      reason_code: "DISCOUNT",
      updated_by: actor,
      created_by: actor,
      _session: session
    });
    if (adjRes && adjRes.success === false) {
      return { err: (adjRes.errors && adjRes.errors[0]) || "AR 折讓失敗" };
    }
    if (!primaryArId) primaryArId = arId;
    applied = roundMoney_(applied + cut);
    remaining = roundMoney_(remaining - cut);
  }

  if (remaining > 1e-9) {
    return { err: "應收餘額不足套用全部回饋（尚差 " + remaining + "），請改用下期折抵或調整後重試" };
  }

  return { ar_id: primaryArId, credit_applied: applied };
}

async function reverseRebateCreditNote_(sb, customerId, periodYm, rebateRow, actor, session) {
  const primaryAr = normId_(rebateRow && rebateRow.ar_id);
  const snapshotRestore = roundMoney_(rebateRow && rebateRow.credit_applied);
  if (!primaryAr) return { err: "回饋紀錄缺少應收單，無法還原折讓" };
  if (snapshotRestore <= 1e-9) return { ok: true, skipped: true, credit_restored: 0 };

  const netCut = await fetchNetDealerRebateCutOnAr_(sb, primaryAr, periodYm);
  const restore = roundMoney_(Math.min(snapshotRestore, netCut));
  if (restore <= 1e-9) {
    return { ok: true, skipped: true, credit_restored: 0 };
  }

  const { data: ar, error: arErr } = await sb.from("ar_receivable").select("*").eq("ar_id", primaryAr).maybeSingle();
  if (arErr) throw new Error(arErr.message || String(arErr));
  if (!ar) return { err: "應收單不存在: " + primaryAr };

  const voidReason = dealerRebateVoidReason_(periodYm);
  const newDue = roundMoney_(Number(ar.amount_due || 0) + restore);
  const adjRes = await adjustArAmountBundle({
    ar_id: primaryAr,
    amount_due: newDue,
    reason: voidReason,
    reason_code: "AMOUNT_FIX",
    updated_by: actor,
    created_by: actor,
    _session: session
  });
  if (adjRes && adjRes.success === false) {
    return { err: (adjRes.errors && adjRes.errors[0]) || "還原應收失敗: " + primaryAr };
  }
  return { ok: true, credit_restored: restore, ar_id: primaryAr };
}

async function voidRebateRowSystemRollback_(sb, opts) {
  const rebateId = String(opts?.rebateId || "").trim();
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();
  const reason = String(opts?.reason || "SYSTEM_ROLLBACK");
  if (!rebateId || !actor) return;

  const { data: row } = await sb
    .from("commercial_dealer_rebate")
    .select("system_remark, status")
    .eq("rebate_id", rebateId)
    .maybeSingle();
  if (!row || normId_(row.status) === "VOID") return;

  const sysRemark = appendSystemRemark_(row.system_remark, "[" + ts + "] " + actor + " " + reason);
  await sb
    .from("commercial_dealer_rebate")
    .update({
      status: "VOID",
      void_reason: reason,
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("rebate_id", rebateId);
}

/** 回饋過帳：結算失敗時還原 AR／折抵並作廢剛建立的回饋單 */
async function rollbackPostedRebateSettleFailure_(sb, opts) {
  const rebateId = String(opts?.rebateId || "").trim();
  const customerId = normId_(opts?.customerId);
  const periodYm = String(opts?.periodYm || "").trim();
  const settleMode = normId_(opts?.settleMode);
  const arId = String(opts?.arId || "").trim();
  const creditApplied = roundMoney_(opts?.creditApplied || 0);
  const rebateAmount = roundMoney_(opts?.rebateAmount || 0);
  const balanceUpdated = !!opts?.balanceUpdated;
  const actor = String(opts?.actor || "").trim();
  const session = opts?.session;
  const ts = opts?.ts || nowIso();

  if (rebateAmount > 1e-9) {
    if (settleMode === "CREDIT_NOTE" && arId && creditApplied > 1e-9) {
      try {
        const revRes = await reverseRebateCreditNote_(
          sb,
          customerId,
          periodYm,
          { ar_id: arId, credit_applied: creditApplied, period_ym: periodYm },
          actor,
          session
        );
        if (revRes && revRes.err) {
          await writeAuditLog_(
            "commercial_dealer_rebate",
            rebateId,
            "BUNDLE_REBATE_SETTLE_ROLLBACK_WARN",
            actor,
            JSON.stringify({ rebate_id: rebateId, err: revRes.err })
          );
        }
      } catch (e) {
        await writeAuditLog_(
          "commercial_dealer_rebate",
          rebateId,
          "BUNDLE_REBATE_SETTLE_ROLLBACK_WARN",
          actor,
          JSON.stringify({ rebate_id: rebateId, err: e?.message || String(e) })
        );
      }
    } else if (settleMode === "CARRY_FORWARD" && balanceUpdated) {
      const { data: customer } = await sb
        .from("customer")
        .select("dealer_rebate_credit_balance")
        .eq("customer_id", customerId)
        .maybeSingle();
      if (customer) {
        const newBal = roundMoney_(Math.max(0, Number(customer.dealer_rebate_credit_balance || 0) - rebateAmount));
        await sb
          .from("customer")
          .update({
            dealer_rebate_credit_balance: newBal,
            updated_by: actor,
            updated_at: ts
          })
          .eq("customer_id", customerId);
      }
    }
  }

  await voidRebateRowSystemRollback_(sb, {
    rebateId,
    actor,
    ts,
    reason: "SYSTEM_ROLLBACK_SETTLE_FAIL"
  });
}

async function listCommercialDealerSchemeEnriched_(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const { data: schemes, error } = await sb
    .from("commercial_dealer_scheme")
    .select("*")
    .order("date_from", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return fail(error.message || String(error));

  const ids = (schemes || []).map((s) => normId_(s.scheme_id)).filter(Boolean);
  const tierCounts = {};
  if (ids.length) {
    const { data: tiers } = await sb.from("commercial_dealer_scheme_tier").select("scheme_id").in("scheme_id", ids);
    (tiers || []).forEach((t) => {
      const sid = normId_(t.scheme_id);
      tierCounts[sid] = (tierCounts[sid] || 0) + 1;
    });
  }

  let rebateLocked = new Set();
  if (ids.length) {
    try {
      rebateLocked = await loadSchemeIdsWithPostedRebate_(sb, ids);
    } catch (lockErr) {
      return fail(lockErr?.message || String(lockErr));
    }
  }

  const rows = (schemes || []).map((s) => {
    const sid = normId_(s.scheme_id);
    return Object.assign({}, s, {
      tier_count: tierCounts[sid] || 0,
      has_rebate: rebateLocked.has(sid)
    });
  });
  return ok({ data: rows, source: "supabase" });
}

async function listCommercialDealerCustomerEnriched_(p) {
  const gate = requireCommercialDealerCustomerSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const statusFilter = String(p.status || "ACTIVE").trim().toUpperCase();
  const categoryFilter = String(p.category || "").trim();
  const bindFilter = String(p.bind_status || "ALL").trim().toUpperCase();
  const keyword = String(p.keyword || "").trim().toUpperCase();
  const limit = Math.min(Math.max(Number(p.limit || 500), 1), 1000);

  let query = sb
    .from("customer")
    .select(
      "customer_id, customer_name, category, status, " +
        "dealer_rebate_scheme_id, dealer_scheme_id, dealer_cumulative_scheme_id, " +
        "dealer_rebate_settle_mode, dealer_rebate_excluded, dealer_rebate_credit_balance, " +
        "dealer_cumulative_amount, dealer_cumulative_tier_label, dealer_cumulative_price_rate, " +
        "dealer_cumulative_pending_tier_label, dealer_cumulative_pending_price_rate, dealer_cumulative_started_at, " +
        "updated_at, created_at"
    )
    .order("customer_name", { ascending: true })
    .limit(limit);

  if (statusFilter && statusFilter !== "ALL") query = query.eq("status", statusFilter);
  if (categoryFilter) query = query.eq("category", categoryFilter);

  const { data, error } = await query;
  if (error) return fail(error.message || String(error));

  let rows = data || [];
  if (bindFilter === "ANY" || bindFilter === "BOUND") {
    rows = rows.filter((c) => {
      const rebate = normId_(c.dealer_rebate_scheme_id || c.dealer_scheme_id);
      const cum = normId_(c.dealer_cumulative_scheme_id);
      return !!(rebate || cum);
    });
  } else if (bindFilter === "NONE" || bindFilter === "UNBOUND") {
    rows = rows.filter((c) => {
      const rebate = normId_(c.dealer_rebate_scheme_id || c.dealer_scheme_id);
      const cum = normId_(c.dealer_cumulative_scheme_id);
      return !rebate && !cum;
    });
  }
  if (keyword) {
    rows = rows.filter((c) => {
      const id = normId_(c.customer_id);
      const name = String(c.customer_name || "")
        .trim()
        .toUpperCase();
      return id.includes(keyword) || name.includes(keyword);
    });
  }

  const schemeIds = new Set();
  rows.forEach((c) => {
    const rebate = normId_(c.dealer_rebate_scheme_id || c.dealer_scheme_id);
    const cum = normId_(c.dealer_cumulative_scheme_id);
    if (rebate) schemeIds.add(rebate);
    if (cum) schemeIds.add(cum);
  });
  const schemeNameMap = {};
  if (schemeIds.size) {
    const { data: schemes, error: schemeErr } = await sb
      .from("commercial_dealer_scheme")
      .select("scheme_id, scheme_name")
      .in("scheme_id", Array.from(schemeIds));
    if (schemeErr) return fail(schemeErr.message || String(schemeErr));
    (schemes || []).forEach((s) => {
      schemeNameMap[normId_(s.scheme_id)] = String(s.scheme_name || "").trim();
    });
  }

  const enriched = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const rebateId = normId_(c.dealer_rebate_scheme_id || c.dealer_scheme_id);
    const cumId = normId_(c.dealer_cumulative_scheme_id);
    const out = Object.assign({}, c, {
      dealer_rebate_scheme_name: rebateId ? schemeNameMap[rebateId] || "" : "",
      dealer_cumulative_scheme_name: cumId ? schemeNameMap[cumId] || "" : ""
    });
    if (cumId) {
      try {
        const syncRes = await syncCustomerCumulativeFromSources_(sb, c.customer_id, "", nowIso());
        if (syncRes && syncRes.err) throw new Error(syncRes.err);
        const live =
          syncRes && syncRes.cumulative_after != null
            ? roundMoney_(syncRes.cumulative_after)
            : await sumCustomerCumulativeFromSources_(sb, c.customer_id, { customer: c });
        out.dealer_cumulative_amount = live;
        if (syncRes && syncRes.recalculated) {
          const refreshed = await reloadCustomer_(sb, normId_(c.customer_id));
          if (refreshed) {
            out.dealer_cumulative_tier_label = refreshed.dealer_cumulative_tier_label;
            out.dealer_cumulative_price_rate = refreshed.dealer_cumulative_price_rate;
            out.dealer_cumulative_pending_tier_label = refreshed.dealer_cumulative_pending_tier_label;
            out.dealer_cumulative_pending_price_rate = refreshed.dealer_cumulative_pending_price_rate;
          }
        } else {
          const stored = roundMoney_(c.dealer_cumulative_amount);
          if (Math.abs(stored - live) > 1e-9) {
            await sb
              .from("customer")
              .update({
                dealer_cumulative_amount: live,
                updated_at: nowIso()
              })
              .eq("customer_id", normId_(c.customer_id));
          }
        }
      } catch (cumErr) {
        console.warn("listCommercialDealerCustomerEnriched cumulative:", cumErr?.message || cumErr);
      }
    }
    enriched.push(out);
  }
  return ok({ data: enriched, source: "supabase" });
}

async function listCommercialDealerRebateEnriched_(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  let query = sb
    .from("commercial_dealer_rebate")
    .select("*")
    .order("period_ym", { ascending: false })
    .order("created_at", { ascending: false });
  const cust = normId_(p.customer_id);
  const period = String(p.period_ym || "").trim();
  if (cust) query = query.eq("customer_id", cust);
  if (period) query = query.eq("period_ym", period);
  const { data, error } = await query.limit(500);
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function saveCommercialDealerSchemeBundle(p) {
  if (!canOperateCommercialDealer_(p._session)) return fail("Permission denied: commercial dealer");

  const schemeId = normId_(p.scheme_id) || buildShortDealerSchemeId_();
  const schemeName = String(p.scheme_name || "").trim();
  if (!schemeName) return fail("scheme_name required");

  const status = normId_(p.status) || "ACTIVE";
  if (!["DRAFT", "ACTIVE", "ENDED"].includes(status)) return fail("status invalid");

  const dateFrom = String(p.date_from || "").trim();
  const dateTo = String(p.date_to || "").trim();
  if (!dateFrom || !dateTo) return fail("date_from and date_to required");
  if (dateFrom > dateTo) return fail("date_from must be <= date_to");

  const schemeType = normId_(p.scheme_type) || "MONTHLY_REBATE";
  const statSource = normId_(p.stat_source) || "CONSIGNMENT";
  if (!["MONTHLY_REBATE", "CUMULATIVE_AMOUNT"].includes(schemeType)) {
    return fail("scheme_type invalid");
  }
  if (!["CONSIGNMENT", "GENERAL", "ALL"].includes(statSource)) {
    return fail("stat_source invalid");
  }
  const mutexGroup =
    schemeType === "CUMULATIVE_AMOUNT"
      ? String(p.mutex_group || "CUMULATIVE_AMOUNT").trim() || "CUMULATIVE_AMOUNT"
      : String(p.mutex_group || "MONTHLY_REBATE").trim() || "MONTHLY_REBATE";

  const tiersPack = parseJsonArray(p.tiers_json, "tiers_json");
  if (tiersPack.err) return fail(tiersPack.err);
  if (!tiersPack.data.length) return fail("tiers_json required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const ts = nowIso();
  const { data: existed } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  const isNew = !existed;

  const header = {
    scheme_id: schemeId,
    scheme_name: schemeName,
    status,
    date_from: dateFrom,
    date_to: dateTo,
    scheme_type: schemeType,
    stat_source: statSource,
    mutex_group: mutexGroup,
    remark: String(p.remark || ""),
    updated_by: actor,
    updated_at: ts
  };

  if (isNew) {
    header.created_by = actor;
    header.created_at = ts;
    const { error } = await sb.from("commercial_dealer_scheme").insert(header);
    if (error) return fail(error.message || String(error));
  } else {
    let rebateLocked;
    try {
      rebateLocked = await loadSchemeIdsWithPostedRebate_(sb, [schemeId]);
    } catch (lockErr) {
      return fail(lockErr?.message || String(lockErr));
    }
    if (rebateLocked.has(schemeId)) return fail("此經銷方案已有月結回饋紀錄，不可更新");
    const { error } = await sb.from("commercial_dealer_scheme").update(header).eq("scheme_id", schemeId);
    if (error) return fail(error.message || String(error));
  }

  await sb.from("commercial_dealer_scheme_tier").delete().eq("scheme_id", schemeId);

  for (let i = 0; i < tiersPack.data.length; i++) {
    const ln = tiersPack.data[i] || {};
    const amountFrom = Number(ln.amount_from != null ? ln.amount_from : 0);
    const amountTo = ln.amount_to != null && ln.amount_to !== "" ? Number(ln.amount_to) : null;
    let rebatePct = 0;
    let tierLabel = "";
    let priceRate = null;

    if (schemeType === "CUMULATIVE_AMOUNT") {
      tierLabel = String(ln.tier_label || "").trim();
      priceRate = Number(ln.price_rate != null ? ln.price_rate : 0);
      if (!tierLabel) return fail("tier_label required (tiers[" + i + "])");
      if (amountFrom < 0) return fail("amount_from must be >= 0 (tiers[" + i + "])");
      if (!(priceRate >= 1 && priceRate <= 100)) return fail("price_rate must be 1..100 (tiers[" + i + "])");
    } else {
      rebatePct = Number(ln.rebate_pct != null ? ln.rebate_pct : 0);
      if (amountFrom < 0) return fail("amount_from must be >= 0 (tiers[" + i + "])");
      if (amountTo != null && amountTo + 1e-9 < amountFrom) {
        return fail("amount_to must be >= amount_from (tiers[" + i + "])");
      }
      if (rebatePct < 0 || rebatePct > 100) return fail("rebate_pct must be 0..100 (tiers[" + i + "])");
    }

    const tierId = schemeId + "-TR-" + String(i + 1).padStart(3, "0");
    const { error: insErr } = await sb.from("commercial_dealer_scheme_tier").insert({
      tier_id: tierId,
      scheme_id: schemeId,
      line_no: i + 1,
      amount_from: amountFrom,
      amount_to: schemeType === "CUMULATIVE_AMOUNT" ? null : amountTo,
      rebate_pct: rebatePct,
      tier_label: tierLabel,
      price_rate: priceRate,
      remark: String(ln.remark || ""),
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null
    });
    if (insErr) return fail(insErr.message || String(insErr));
  }

  await writeAuditLog_(
    "commercial_dealer_scheme",
    schemeId,
    isNew ? "BUNDLE_CREATE_COMMERCIAL_DEALER" : "BUNDLE_UPDATE_COMMERCIAL_DEALER",
    actor,
    JSON.stringify({ scheme_id: schemeId, tier_count: tiersPack.data.length })
  );

  return ok({ scheme_id: schemeId, message: isNew ? "CREATED" : "UPDATED" });
}

async function resolveMonthlyStatContext_(sb, customerId, periodYm) {
  const cust = normId_(customerId);
  const range = monthRange_(periodYm);
  if (!cust || !range) return { err: "customer_id or period_ym invalid" };

  const customer = await reloadCustomer_(sb, cust);
  if (!customer) return { err: "Customer not found: " + cust };

  const cumSchemeId = normId_(customer.dealer_cumulative_scheme_id);
  let cumStatSource = "ALL";
  if (cumSchemeId) {
    const { data: scheme, error: schErr } = await sb
      .from("commercial_dealer_scheme")
      .select("scheme_id, scheme_type, status, stat_source")
      .eq("scheme_id", cumSchemeId)
      .maybeSingle();
    if (schErr) throw new Error(schErr.message || String(schErr));
    if (scheme && normId_(scheme.scheme_type) === "CUMULATIVE_AMOUNT") {
      cumStatSource = normId_(scheme.stat_source) || "ALL";
    }
  }

  /** 請款淨額口徑：固定寄賣＋一般；等級累積再加總時才依方案 stat_source 篩選 */
  const billing = await computeBillingNetForStatSource_(sb, cust, periodYm, "ALL");
  if (billing.err) return { err: billing.err };

  const billingTotal = roundMoney_(billing.billing_net);

  return {
    customer,
    billing,
    billing_total: billingTotal,
    cumulative_scheme_id: cumSchemeId,
    stat_source: cumStatSource
  };
}

function parseMonthlyStatCustomerIds_(p) {
  const raw = p.customer_ids;
  if (Array.isArray(raw)) return raw.map((x) => normId_(x)).filter(Boolean);
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[,;\s]+/)
    .map((x) => normId_(x))
    .filter(Boolean);
}

/** 已過帳月結 vs 即時請款淨額（過帳後新結算／出貨） */
function hasMonthlyStatPostedBaseline_(posted) {
  if (!posted) return false;
  if (normId_(posted.status) === "POSTED") return true;
  if (String(posted.stat_id || "").trim()) return true;
  const postedCons = roundMoney_(posted.billing_net_consignment || 0);
  const postedGen = roundMoney_(posted.billing_net_general || 0);
  const postedNet = roundMoney_(
    posted.billing_net_total != null ? posted.billing_net_total : postedCons + postedGen
  );
  return Math.abs(postedNet) > 1e-9;
}

function buildMonthlyStatBillingDrift_(posted, live) {
  const postedCons = roundMoney_(posted?.billing_net_consignment || 0);
  const postedGen = roundMoney_(posted?.billing_net_general || 0);
  const postedNet = roundMoney_(
    posted?.billing_net_total != null ? posted.billing_net_total : postedCons + postedGen
  );
  const liveCons = roundMoney_(live?.billing_net_consignment || 0);
  const liveGen = roundMoney_(live?.billing_net_general || 0);
  const liveNet = roundMoney_(live?.billing_net != null ? live.billing_net : liveCons + liveGen);
  const consDiff = roundMoney_(liveCons - postedCons);
  const genDiff = roundMoney_(liveGen - postedGen);
  const netDiff = roundMoney_(liveNet - postedNet);
  const hasPostedBaseline = hasMonthlyStatPostedBaseline_(posted);
  const hasNewBilling =
    hasPostedBaseline &&
    (Math.abs(consDiff) > 1e-9 || Math.abs(genDiff) > 1e-9 || Math.abs(netDiff) > 1e-9);
  return {
    has_new_billing: hasNewBilling,
    posted_billing_net_consignment: postedCons,
    posted_billing_net_general: postedGen,
    posted_billing_net: postedNet,
    live_billing_net_consignment: liveCons,
    live_billing_net_general: liveGen,
    live_billing_net: liveNet,
    billing_net_consignment_diff: consDiff,
    billing_net_general_diff: genDiff,
    billing_net_diff: netDiff
  };
}

function attachMonthlyStatBillingDriftFields_(target, drift) {
  const d = drift || {};
  target.has_new_billing = !!d.has_new_billing;
  target.posted_billing_net_consignment = d.posted_billing_net_consignment;
  target.posted_billing_net_general = d.posted_billing_net_general;
  target.posted_billing_net = d.posted_billing_net;
  target.live_billing_net_consignment = d.live_billing_net_consignment;
  target.live_billing_net_general = d.live_billing_net_general;
  target.live_billing_net = d.live_billing_net;
  target.billing_net_consignment_diff = d.billing_net_consignment_diff;
  target.billing_net_general_diff = d.billing_net_general_diff;
  target.billing_net_diff = d.billing_net_diff;
  return target;
}

/** 月結統計預覽說明（v4.2.12：統計與等級分離） */
const MONTHLY_STAT_CUMULATIVE_NOTE_ =
  "請款淨額於月結統計過帳時定案；經銷等級累積請於確認經銷等級時寫入。";

const MONTHLY_STAT_BATCH_LIMIT_ = 20;

async function loadActiveMonthlyStatRow_(sb, customerId, periodYm) {
  const { data, error } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("*")
    .eq("customer_id", normId_(customerId))
    .eq("period_ym", String(periodYm || "").trim())
    .neq("status", "VOID")
    .maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data || null;
}

async function loadActiveLevelPostRow_(sb, customerId, periodYm) {
  const { data, error } = await sb
    .from("commercial_dealer_level_post")
    .select("*")
    .eq("customer_id", normId_(customerId))
    .eq("period_ym", String(periodYm || "").trim())
    .neq("status", "VOID")
    .maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data || null;
}

function isLegacyLevelBundledInStatRow_(statRow) {
  if (!statRow || normId_(statRow.status) !== "POSTED") return false;
  const add = roundMoney_(
    (statRow.cumulative_add_consignment || 0) + (statRow.cumulative_add_general || 0)
  );
  return add > 1e-9 || statRow.cumulative_before != null || statRow.cumulative_after != null;
}

function isLevelPostedForPeriod_(statRow, levelRow) {
  if (levelRow && normId_(levelRow.status) === "POSTED") return true;
  return isLegacyLevelBundledInStatRow_(statRow);
}

function billingPackFromStatRowForSource_(statRow, statSource) {
  const cons = roundMoney_(statRow?.billing_net_consignment || 0);
  const gen = roundMoney_(statRow?.billing_net_general || 0);
  const src = normId_(statSource) || "CONSIGNMENT";
  let billing_net = 0;
  if (src === "ALL") billing_net = roundMoney_(cons + gen);
  else if (src === "GENERAL") billing_net = gen;
  else billing_net = cons;
  return {
    billing_net,
    billing_net_consignment: src === "GENERAL" ? 0 : cons,
    billing_net_general: src === "CONSIGNMENT" ? 0 : gen,
    gross_settlement: roundMoney_(statRow?.gross_settlement || 0),
    gross_shipment: roundMoney_(statRow?.gross_shipment || 0)
  };
}

async function assertMonthlyStatPostedForRebate_(sb, customerId, periodYm) {
  const statRow = await loadActiveMonthlyStatRow_(sb, customerId, periodYm);
  if (!statRow || normId_(statRow.status) !== "POSTED") {
    return { err: "請先完成月結統計過帳" };
  }
  /** 與月結統計同一口徑（寄賣＋一般）比對，勿用回饋 stat_source 誤判一般差額 */
  const liveAll = await computeBillingNetForStatSource_(sb, customerId, periodYm, "ALL");
  if (liveAll.err) return { err: liveAll.err };
  const drift = buildMonthlyStatBillingDrift_(statRow, liveAll);
  if (drift.has_new_billing) {
    return {
      err: "本月月結統計已過帳，但過帳後又有新請款；請先作廢本月月結再重新過帳"
    };
  }
  return { statRow };
}

async function resolveMonthlyStatCumulativeAdds_(sb, cumSchemeId, billing) {
  const empty = {
    cumulative_add_consignment: 0,
    cumulative_add_general: 0,
    cumulative_add_total: 0
  };
  const schemeId = normId_(cumSchemeId);
  if (!schemeId) return empty;

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("stat_source")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme) return empty;

  let cons = 0;
  let gen = 0;
  if (
    schemeStatSourceAllows_(scheme.stat_source, "CONSIGNMENT") &&
    roundMoney_(billing?.billing_net_consignment) > 1e-9
  ) {
    cons = roundMoney_(billing.billing_net_consignment);
  }
  if (
    schemeStatSourceAllows_(scheme.stat_source, "GENERAL") &&
    roundMoney_(billing?.billing_net_general) > 1e-9
  ) {
    gen = roundMoney_(billing.billing_net_general);
  }
  return {
    cumulative_add_consignment: cons,
    cumulative_add_general: gen,
    cumulative_add_total: roundMoney_(cons + gen)
  };
}

async function resolveMonthlyStatBillingForCustomer_(sb, customerRow, periodYm) {
  const cust = normId_(customerRow?.customer_id);
  const range = monthRange_(periodYm);
  if (!cust || !range) return { err: "customer_id or period_ym invalid" };

  const cumSchemeId = normId_(customerRow.dealer_cumulative_scheme_id);
  const billing = await computeBillingNetForStatSource_(sb, cust, periodYm, "ALL");
  if (billing.err) return { err: billing.err };

  const adds = await resolveMonthlyStatCumulativeAdds_(sb, cumSchemeId, billing);

  return {
    customer_id: cust,
    billing_net_consignment: roundMoney_(billing.billing_net_consignment),
    billing_net_general: roundMoney_(billing.billing_net_general),
    cumulative_add_consignment: adds.cumulative_add_consignment,
    cumulative_add_general: adds.cumulative_add_general,
    cumulative_add_total: adds.cumulative_add_total,
    billing_net: roundMoney_(billing.billing_net)
  };
}

async function listCommercialDealerMonthlyStatPeriodSummary_(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;

  const periodYm = String(p.period_ym || "").trim();
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const customerIds = parseMonthlyStatCustomerIds_(p);
  if (!customerIds.length) return ok({ data: [], source: "supabase" });

  const uniqueIds = [...new Set(customerIds)].slice(0, 500);
  const sb = getSupabase();

  const { data: customers, error: custErr } = await sb
    .from("customer")
    .select(
      "customer_id, dealer_cumulative_scheme_id, dealer_rebate_scheme_id, dealer_scheme_id"
    )
    .in("customer_id", uniqueIds);
  if (custErr) return fail(custErr.message || String(custErr));

  const customerMap = {};
  (customers || []).forEach((c) => {
    customerMap[normId_(c.customer_id)] = c;
  });

  const { data: postedRows, error: statErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .select(
      "stat_id, customer_id, status, billing_net_consignment, billing_net_general, billing_net_total, cumulative_add_consignment, cumulative_add_general"
    )
    .eq("period_ym", periodYm)
    .in("customer_id", uniqueIds);
  if (statErr) return fail(statErr.message || String(statErr));

  const postedMap = {};
  (postedRows || []).forEach((row) => {
    const cid = normId_(row.customer_id);
    if (!cid) return;
    const st = normId_(row.status);
    const prev = postedMap[cid];
    if (!prev || st === "POSTED" || (prev.status !== "POSTED" && st !== "VOID")) {
      postedMap[cid] = row;
    }
  });

  const out = [];
  for (const cid of uniqueIds) {
    const posted = postedMap[cid];
    const postedStatus = normId_(posted?.status);
    const customerRow = customerMap[cid];
    let cumulativeAsOf = 0;
    try {
      cumulativeAsOf = await resolveCustomerCumulativeAsOfPeriodYm_(sb, cid, periodYm, customerRow);
    } catch (_eCum) {
      cumulativeAsOf = 0;
    }

    if (posted && postedStatus === "POSTED") {
      let drift = {
        has_new_billing: false,
        posted_billing_net_consignment: roundMoney_(posted.billing_net_consignment),
        posted_billing_net_general: roundMoney_(posted.billing_net_general),
        posted_billing_net: roundMoney_(posted.billing_net_total),
        live_billing_net_consignment: roundMoney_(posted.billing_net_consignment),
        live_billing_net_general: roundMoney_(posted.billing_net_general),
        live_billing_net: roundMoney_(posted.billing_net_total),
        billing_net_consignment_diff: 0,
        billing_net_general_diff: 0,
        billing_net_diff: 0
      };
      if (customerRow) {
        try {
          const preview = await resolveMonthlyStatBillingForCustomer_(sb, customerRow, periodYm);
          if (!preview.err) {
            drift = buildMonthlyStatBillingDrift_(posted, preview);
          }
        } catch (_eDrift) {}
      }
      const row = attachMonthlyStatBillingDriftFields_(
        {
          customer_id: cid,
          status: "POSTED",
          amount_source: drift.has_new_billing ? "posted_stale" : "posted",
          stat_id: String(posted.stat_id || "").trim(),
          billing_net_consignment: drift.has_new_billing
            ? drift.live_billing_net_consignment
            : drift.posted_billing_net_consignment,
          billing_net_general: drift.has_new_billing
            ? drift.live_billing_net_general
            : drift.posted_billing_net_general,
          billing_net: drift.has_new_billing ? drift.live_billing_net : drift.posted_billing_net,
          cumulative_add_consignment: roundMoney_(posted.cumulative_add_consignment),
          cumulative_add_general: roundMoney_(posted.cumulative_add_general),
          dealer_cumulative_amount_as_of: cumulativeAsOf
        },
        drift
      );
      out.push(row);
      continue;
    }

    const monthWorkStatus = postedStatus === "POSTED" ? "POSTED" : "PREVIEW";

    if (!customerRow) {
      out.push({
        customer_id: cid,
        status: monthWorkStatus,
        amount_source: "preview",
        cumulative_add_consignment: 0,
        cumulative_add_general: 0,
        dealer_cumulative_amount_as_of: 0,
        err: "Customer not found"
      });
      continue;
    }

    try {
      const preview = await resolveMonthlyStatBillingForCustomer_(sb, customerRow, periodYm);
      if (preview.err) {
        out.push({
          customer_id: cid,
          status: monthWorkStatus,
          amount_source: "preview",
          cumulative_add_consignment: 0,
          cumulative_add_general: 0,
          dealer_cumulative_amount_as_of: cumulativeAsOf,
          err: preview.err
        });
        continue;
      }
      out.push({
        customer_id: cid,
        status: monthWorkStatus,
        amount_source: "preview",
        billing_net_consignment: preview.billing_net_consignment,
        billing_net_general: preview.billing_net_general,
        cumulative_add_consignment: preview.cumulative_add_consignment,
        cumulative_add_general: preview.cumulative_add_general,
        billing_net: preview.billing_net,
        dealer_cumulative_amount_as_of: cumulativeAsOf
      });
    } catch (e) {
      out.push({
        customer_id: cid,
        status: monthWorkStatus,
        amount_source: "preview",
        cumulative_add_consignment: 0,
        cumulative_add_general: 0,
        dealer_cumulative_amount_as_of: cumulativeAsOf,
        err: e?.message || String(e)
      });
    }
  }

  return ok({ data: out, period_ym: periodYm, source: "supabase" });
}

async function resolveCustomerCumulativeAsOfPeriodYm_(sb, customerId, periodYm, customerRow) {
  const custId = normId_(customerId);
  const ym = String(periodYm || "").trim();
  if (!custId || !ym) return 0;
  const row = customerRow || (await reloadCustomer_(sb, custId));
  if (!row || !normId_(row.dealer_cumulative_scheme_id)) return 0;
  return await sumCustomerCumulativeFromSources_(sb, custId, { customer: row, asOfYm: ym });
}

async function listCommercialDealerMonthlyStatEnriched_(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const cust = normId_(p.customer_id);
  const period = String(p.period_ym || "").trim();
  let query = sb
    .from("commercial_dealer_monthly_stat")
    .select("*")
    .order("period_ym", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (cust) query = query.eq("customer_id", cust);
  if (period) query = query.eq("period_ym", period);
  const { data, error } = await query;
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function previewCommercialDealerMonthlyStatBundle(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const sb = getSupabase();
  try {
    const ctx = await resolveMonthlyStatContext_(sb, customerId, periodYm);
    if (ctx.err) return fail(ctx.err);

    const { data: existed } = await sb
      .from("commercial_dealer_monthly_stat")
      .select(
        "stat_id, status, billing_net_consignment, billing_net_general, billing_net_total, cumulative_before, cumulative_after, cumulative_add_consignment, cumulative_add_general, cumulative_pending_tier_label, cumulative_pending_price_rate, cumulative_scheme_id"
      )
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();

    const alreadyPosted = !!(existed && normId_(existed.status) === "POSTED");

    const drift =
      alreadyPosted && existed
        ? buildMonthlyStatBillingDrift_(existed, ctx.billing)
        : buildMonthlyStatBillingDrift_({}, ctx.billing);

    return ok(
      attachMonthlyStatBillingDriftFields_(
        {
          customer_id: customerId,
          period_ym: periodYm,
          billing_net: ctx.billing.billing_net,
          billing_net_consignment: ctx.billing.billing_net_consignment,
          billing_net_general: ctx.billing.billing_net_general,
          gross_settlement: ctx.billing.gross_settlement,
          gross_shipment: ctx.billing.gross_shipment,
          settlement_count: ctx.billing.settlement_count,
          shipment_count: ctx.billing.shipment_count,
          cumulative_note: MONTHLY_STAT_CUMULATIVE_NOTE_,
          already_posted: alreadyPosted,
          existing_stat_id: existed ? String(existed.stat_id || "") : ""
        },
        drift
      )
    );
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

async function postCommercialDealerMonthlyStatBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer monthly stat");

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();

  const { data: dup } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("stat_id")
    .eq("customer_id", customerId)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .maybeSingle();
  if (dup) return fail("此客戶該月份已有月結統計: " + dup.stat_id);

  let ctx;
  try {
    ctx = await resolveMonthlyStatContext_(sb, customerId, periodYm);
  } catch (e) {
    return fail(e?.message || String(e));
  }
  if (ctx.err) return fail(ctx.err);
  if (roundMoney_(ctx.billing.billing_net) <= 1e-9) return fail("本月無請款淨額");

  let ctxFinal;
  try {
    ctxFinal = await resolveMonthlyStatContext_(sb, customerId, periodYm);
  } catch (e) {
    return fail(e?.message || String(e));
  }
  if (ctxFinal.err) return fail(ctxFinal.err);
  if (roundMoney_(ctxFinal.billing.billing_net) <= 1e-9) return fail("本月無請款淨額");
  if (
    roundMoney_(ctxFinal.billing.billing_net) !== roundMoney_(ctx.billing.billing_net) ||
    roundMoney_(ctxFinal.billing.billing_net_consignment) !==
      roundMoney_(ctx.billing.billing_net_consignment) ||
    roundMoney_(ctxFinal.billing.billing_net_general) !== roundMoney_(ctx.billing.billing_net_general)
  ) {
    return fail("請款淨額已變動，請重新預覽後再過帳");
  }
  ctx = ctxFinal;

  const ts = nowIso();
  const statId = buildId_("CDMS");

  const row = {
    stat_id: statId,
    customer_id: customerId,
    period_ym: periodYm,
    cumulative_scheme_id: "",
    billing_net_consignment: roundMoney_(ctx.billing.billing_net_consignment),
    billing_net_general: roundMoney_(ctx.billing.billing_net_general),
    billing_net_total: roundMoney_(ctx.billing.billing_net),
    gross_settlement: roundMoney_(ctx.billing.gross_settlement),
    gross_shipment: roundMoney_(ctx.billing.gross_shipment),
    cumulative_add_consignment: 0,
    cumulative_add_general: 0,
    cumulative_before: null,
    cumulative_after: null,
    cumulative_pending_tier_label: "",
    cumulative_pending_price_rate: null,
    cumulative_pending_from_ym: "",
    status: "POSTED",
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null,
    system_remark: ""
  };

  const { error: insErr } = await sb.from("commercial_dealer_monthly_stat").insert(row);
  if (insErr) return fail(insErr.message || String(insErr));

  await writeAuditLog_(
    "commercial_dealer_monthly_stat",
    statId,
    "BUNDLE_POST_COMMERCIAL_DEALER_MONTHLY_STAT",
    actor,
    JSON.stringify({
      stat_id: statId,
      customer_id: customerId,
      period_ym: periodYm,
      billing_net_total: row.billing_net_total
    })
  );

  return ok({
    stat_id: statId,
    billing_net: row.billing_net_total
  });
}

async function voidCommercialDealerMonthlyStatBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer monthly stat");

  const statId = String(p.stat_id || "").trim();
  if (!statId) return fail("stat_id required");

  const voidReason = String(p.void_reason || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: stat, error: getErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("*")
    .eq("stat_id", statId)
    .maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!stat) return fail("月結統計不存在: " + statId);

  const st = normId_(stat.status);
  if (st === "VOID") return ok({ stat_id: statId, message: "ALREADY_VOID", idempotent: true });
  if (st !== "POSTED") return fail("僅可作廢已產生的月結統計（POSTED）");

  const customerId = normId_(stat.customer_id);
  const periodYm = String(stat.period_ym || "").trim();

  const levelRow = await loadActiveLevelPostRow_(sb, customerId, periodYm);
  if (levelRow && normId_(levelRow.status) === "POSTED") {
    return fail("此月已有經銷等級過帳，請使用「作廢本月月結」一併作廢");
  }
  if (isLegacyLevelBundledInStatRow_(stat)) {
    return fail("此筆為舊版合併過帳（含等級累積），請使用「作廢本月月結」");
  }

  const { data: rebateHit } = await sb
    .from("commercial_dealer_rebate")
    .select("rebate_id")
    .eq("customer_id", customerId)
    .eq("period_ym", periodYm)
    .eq("status", "POSTED")
    .maybeSingle();
  if (rebateHit) {
    return fail("此月已有月結回饋，請使用「作廢本月月結」一併作廢");
  }

  const ts = nowIso();
  const sysRemark = appendSystemRemark_(
    stat.system_remark,
    "[" + ts + "] " + actor + " 作廢月結統計：" + voidReason
  );

  const { error: updStatErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .update({
      status: "VOID",
      void_reason: voidReason,
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("stat_id", statId);
  if (updStatErr) return fail(updStatErr.message || String(updStatErr));

  await writeAuditLog_(
    "commercial_dealer_monthly_stat",
    statId,
    "BUNDLE_VOID_COMMERCIAL_DEALER_MONTHLY_STAT",
    actor,
    JSON.stringify({ stat_id: statId, void_reason: voidReason })
  );

  return ok({ stat_id: statId, message: "VOIDED" });
}

async function listCommercialDealerLevelPostEnriched_(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;
  const sb = getSupabase();
  const cust = normId_(p.customer_id);
  const period = String(p.period_ym || "").trim();
  let query = sb
    .from("commercial_dealer_level_post")
    .select("*")
    .order("period_ym", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (cust) query = query.eq("customer_id", cust);
  if (period) query = query.eq("period_ym", period);
  const { data, error } = await query;
  if (error) return fail(error.message || String(error));

  const rows = data || [];
  const tierCache = {};
  const enriched = [];
  for (const row of rows) {
    const schemeId = normId_(row.cumulative_scheme_id);
    let currentTierLabel = "";
    let currentTierPriceRate = null;
    if (schemeId && row.cumulative_before != null) {
      if (!tierCache[schemeId]) {
        tierCache[schemeId] = await loadCumulativeSchemeTiers_(sb, schemeId);
      }
      const tiers = tierCache[schemeId] || [];
      if (tiers.length) {
        const tier = pickCumulativeTier_(Number(row.cumulative_before), tiers);
        if (tier) {
          currentTierLabel = String(tier.tier_label || "").trim();
          currentTierPriceRate = tier.price_rate != null ? Number(tier.price_rate) : null;
        }
      }
    }
    enriched.push(
      Object.assign({}, row, {
        display_current_tier_label: currentTierLabel,
        display_current_tier_price_rate: currentTierPriceRate
      })
    );
  }
  return ok({ data: enriched, source: "supabase" });
}

async function previewCommercialDealerLevelBundle(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const sb = getSupabase();
  try {
    const ctx = await resolveMonthlyStatContext_(sb, customerId, periodYm);
    if (ctx.err) return fail(ctx.err);

    const cumSchemeId = normId_(ctx.cumulative_scheme_id);
    if (!cumSchemeId) return fail("客戶未綁定經銷等級方案");

    const statRow = await loadActiveMonthlyStatRow_(sb, customerId, periodYm);
    const statPosted = !!(statRow && normId_(statRow.status) === "POSTED");
    if (!statPosted) {
      const billingForAdds = {
        billing_net_consignment: ctx.billing.billing_net_consignment,
        billing_net_general: ctx.billing.billing_net_general,
        billing_net: ctx.billing.billing_net
      };
      const adds = await resolveMonthlyStatCumulativeAdds_(sb, cumSchemeId, billingForAdds);
      let cumulativePreview = { enabled: false };
      if (adds.cumulative_add_total > 1e-9) {
        cumulativePreview = await buildCumulativeClosePreview_(sb, ctx.customer, adds.cumulative_add_total);
      }
      return ok({
        customer_id: customerId,
        period_ym: periodYm,
        cumulative_scheme_id: cumSchemeId,
        stat_source: ctx.stat_source,
        monthly_stat_posted: false,
        already_posted: false,
        needs_stat_first: true,
        billing_net: ctx.billing.billing_net,
        billing_net_consignment: ctx.billing.billing_net_consignment,
        billing_net_general: ctx.billing.billing_net_general,
        cumulative_add_consignment: adds.cumulative_add_consignment,
        cumulative_add_general: adds.cumulative_add_general,
        cumulative_add_total: adds.cumulative_add_total,
        cumulative_preview: cumulativePreview
      });
    }

    const levelRow = await loadActiveLevelPostRow_(sb, customerId, periodYm);
    const legacyLevel = isLegacyLevelBundledInStatRow_(statRow);
    const alreadyPosted = !!(levelRow && normId_(levelRow.status) === "POSTED") || legacyLevel;

    const billingForAdds = {
      billing_net_consignment: statRow.billing_net_consignment,
      billing_net_general: statRow.billing_net_general,
      billing_net: statRow.billing_net_total
    };
    const adds = await resolveMonthlyStatCumulativeAdds_(sb, cumSchemeId, billingForAdds);
    let cumulativePreview = { enabled: false };

    if (alreadyPosted && levelRow) {
      cumulativePreview = await buildCumulativePreviewFromPostedStat_(sb, ctx.customer, {
        cumulative_scheme_id: levelRow.cumulative_scheme_id,
        cumulative_before: levelRow.cumulative_before,
        cumulative_after: levelRow.cumulative_after,
        cumulative_add_consignment: levelRow.cumulative_add_consignment,
        cumulative_add_general: levelRow.cumulative_add_general,
        cumulative_pending_tier_label: levelRow.cumulative_pending_tier_label,
        cumulative_pending_price_rate: levelRow.cumulative_pending_price_rate
      });
    } else if (alreadyPosted && legacyLevel) {
      cumulativePreview = await buildCumulativePreviewFromPostedStat_(sb, ctx.customer, statRow);
    } else if (adds.cumulative_add_total > 1e-9) {
      cumulativePreview = await buildCumulativeClosePreview_(sb, ctx.customer, adds.cumulative_add_total);
    }

    const drift = buildMonthlyStatBillingDrift_(statRow, ctx.billing);

    return ok(
      attachMonthlyStatBillingDriftFields_(
        {
          customer_id: customerId,
          period_ym: periodYm,
          cumulative_scheme_id: cumSchemeId,
          stat_source: ctx.stat_source,
          stat_id: String(statRow.stat_id || ""),
          monthly_stat_posted: true,
          already_posted: alreadyPosted,
          existing_level_post_id: levelRow ? String(levelRow.level_post_id || "") : "",
          legacy_bundled_in_stat: legacyLevel && !levelRow,
          cumulative_add_consignment: alreadyPosted && levelRow
            ? roundMoney_(levelRow.cumulative_add_consignment)
            : alreadyPosted && legacyLevel
              ? roundMoney_(statRow.cumulative_add_consignment)
              : adds.cumulative_add_consignment,
          cumulative_add_general: alreadyPosted && levelRow
            ? roundMoney_(levelRow.cumulative_add_general)
            : alreadyPosted && legacyLevel
              ? roundMoney_(statRow.cumulative_add_general)
              : adds.cumulative_add_general,
          cumulative_add_total: alreadyPosted && levelRow
            ? roundMoney_(
                (levelRow.cumulative_add_consignment || 0) + (levelRow.cumulative_add_general || 0)
              )
            : alreadyPosted && legacyLevel
              ? roundMoney_(
                  (statRow.cumulative_add_consignment || 0) + (statRow.cumulative_add_general || 0)
                )
              : adds.cumulative_add_total,
          cumulative_preview: cumulativePreview
        },
        drift
      )
    );
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

async function postCommercialDealerLevelBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer level");

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();

  const { data: dup } = await sb
    .from("commercial_dealer_level_post")
    .select("level_post_id")
    .eq("customer_id", customerId)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .maybeSingle();
  if (dup) return fail("此客戶該月份已有經銷等級過帳: " + dup.level_post_id);

  let ctx;
  try {
    ctx = await resolveMonthlyStatContext_(sb, customerId, periodYm);
  } catch (e) {
    return fail(e?.message || String(e));
  }
  if (ctx.err) return fail(ctx.err);

  const cumSchemeId = normId_(ctx.cumulative_scheme_id);
  if (!cumSchemeId) return fail("客戶未綁定經銷等級方案");

  const statRow = await loadActiveMonthlyStatRow_(sb, customerId, periodYm);
  if (!statRow || normId_(statRow.status) !== "POSTED") {
    return fail("請先完成月結統計過帳");
  }
  if (isLegacyLevelBundledInStatRow_(statRow)) {
    return fail("此月等級已於舊版月結統計一併過帳");
  }

  const drift = buildMonthlyStatBillingDrift_(statRow, ctx.billing);
  if (drift.has_new_billing) {
    return fail("本月月結統計已過帳，但過帳後又有新請款；請先作廢本月月結再重新過帳");
  }

  const billingForAdds = {
    billing_net_consignment: statRow.billing_net_consignment,
    billing_net_general: statRow.billing_net_general,
    billing_net: statRow.billing_net_total
  };
  const adds = await resolveMonthlyStatCumulativeAdds_(sb, cumSchemeId, billingForAdds);
  const cumulativeAddConsignment = adds.cumulative_add_consignment;
  const cumulativeAddGeneral = adds.cumulative_add_general;
  const cumulativeAddTotal = adds.cumulative_add_total;

  const ts = nowIso();
  const levelPostId = buildId_("CDML");

  const row = {
    level_post_id: levelPostId,
    stat_id: String(statRow.stat_id || ""),
    customer_id: customerId,
    period_ym: periodYm,
    cumulative_scheme_id: cumSchemeId,
    billing_net_consignment: roundMoney_(statRow.billing_net_consignment),
    billing_net_general: roundMoney_(statRow.billing_net_general),
    billing_net_total: roundMoney_(statRow.billing_net_total),
    cumulative_add_consignment: cumulativeAddConsignment,
    cumulative_add_general: cumulativeAddGeneral,
    cumulative_before: null,
    cumulative_after: null,
    cumulative_pending_tier_label: "",
    cumulative_pending_price_rate: null,
    cumulative_pending_from_ym: "",
    status: "POSTED",
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null,
    system_remark: ""
  };

  const { error: insErr } = await sb.from("commercial_dealer_level_post").insert(row);
  if (insErr) return fail(insErr.message || String(insErr));

  let cumulativeRes = { skipped: true };
  if (cumulativeAddTotal > 1e-9) {
    try {
      cumulativeRes = await applyCustomerCumulativeAmountAdd_(sb, {
        customerId,
        billingNet: cumulativeAddTotal,
        actor,
        ts,
        upgradeFromYm: periodYm
      });
    } catch (e) {
      await sb
        .from("commercial_dealer_level_post")
        .update({
          status: "VOID",
          void_reason: "SYSTEM_ROLLBACK",
          system_remark: appendSystemRemark_(row.system_remark, "[" + ts + "] insert rollback"),
          updated_by: actor,
          updated_at: ts
        })
        .eq("level_post_id", levelPostId);
      return fail("累積更新失敗：" + (e?.message || String(e)));
    }
    if (cumulativeRes.err) {
      await sb
        .from("commercial_dealer_level_post")
        .update({
          status: "VOID",
          void_reason: "SYSTEM_ROLLBACK",
          system_remark: appendSystemRemark_(row.system_remark, "[" + ts + "] insert rollback"),
          updated_by: actor,
          updated_at: ts
        })
        .eq("level_post_id", levelPostId);
      return fail(cumulativeRes.err);
    }
  }

  const { error: updRowErr } = await sb
    .from("commercial_dealer_level_post")
    .update({
      cumulative_before: cumulativeRes.cumulative_before != null ? cumulativeRes.cumulative_before : null,
      cumulative_after: cumulativeRes.cumulative_after != null ? cumulativeRes.cumulative_after : null,
      cumulative_pending_tier_label: cumulativeRes.pending_tier_label || "",
      cumulative_pending_price_rate: cumulativeRes.pending_price_rate,
      cumulative_pending_from_ym: cumulativeRes.pending_tier_label ? periodYm : "",
      updated_by: actor,
      updated_at: ts
    })
    .eq("level_post_id", levelPostId);
  if (updRowErr) {
    if (cumulativeAddTotal > 1e-9) {
      try {
        await rollbackCustomerCumulativeAdd_(sb, {
          customerId,
          amount: cumulativeAddTotal,
          actor,
          ts,
          cumulativeRes
        });
      } catch (_eRb) {}
    }
    await sb
      .from("commercial_dealer_level_post")
      .update({
        status: "VOID",
        void_reason: "SYSTEM_ROLLBACK",
        updated_by: actor,
        updated_at: ts
      })
      .eq("level_post_id", levelPostId);
    return fail(updRowErr.message || String(updRowErr));
  }

  row.cumulative_before = cumulativeRes.cumulative_before != null ? cumulativeRes.cumulative_before : null;
  row.cumulative_after = cumulativeRes.cumulative_after != null ? cumulativeRes.cumulative_after : null;
  row.cumulative_pending_tier_label = cumulativeRes.pending_tier_label || "";
  row.cumulative_pending_price_rate = cumulativeRes.pending_price_rate;
  row.cumulative_pending_from_ym = cumulativeRes.pending_tier_label ? periodYm : "";

  await writeAuditLog_(
    "commercial_dealer_level_post",
    levelPostId,
    "BUNDLE_POST_COMMERCIAL_DEALER_LEVEL",
    actor,
    JSON.stringify({
      level_post_id: levelPostId,
      stat_id: row.stat_id,
      customer_id: customerId,
      period_ym: periodYm,
      cumulative_add_total: cumulativeAddTotal
    })
  );

  return ok({
    level_post_id: levelPostId,
    stat_id: row.stat_id,
    cumulative_add_total: cumulativeAddTotal,
    cumulative: cumulativeRes.skipped ? null : cumulativeRes
  });
}

async function voidCommercialDealerLevelPostBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer level");

  const levelPostId = String(p.level_post_id || "").trim();
  if (!levelPostId) return fail("level_post_id required");

  const voidReason = String(p.void_reason || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: row, error: getErr } = await sb
    .from("commercial_dealer_level_post")
    .select("*")
    .eq("level_post_id", levelPostId)
    .maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!row) return fail("經銷等級過帳不存在: " + levelPostId);

  const st = normId_(row.status);
  if (st === "VOID") return ok({ level_post_id: levelPostId, message: "ALREADY_VOID", idempotent: true });
  if (st !== "POSTED") return fail("僅可作廢已產生的經銷等級過帳（POSTED）");

  const customerId = normId_(row.customer_id);
  const ts = nowIso();
  const removed = roundMoney_((row.cumulative_add_consignment || 0) + (row.cumulative_add_general || 0));

  if (removed > 1e-9) {
    const customer = await reloadCustomer_(sb, customerId);
    if (!customer) return fail("Customer not found: " + customerId);

    const before = roundMoney_(customer.dealer_cumulative_amount);
    const after = roundMoney_(Math.max(0, before - removed));
    const patch = {
      dealer_cumulative_amount: after,
      updated_by: actor,
      updated_at: ts
    };

    const snapPending = String(row.cumulative_pending_tier_label || "").trim();
    const custPending = String(customer.dealer_cumulative_pending_tier_label || "").trim();
    if (snapPending && snapPending === custPending) {
      patch.dealer_cumulative_pending_tier_label = "";
      patch.dealer_cumulative_pending_price_rate = null;
      patch.dealer_cumulative_pending_from_ym = "";
    }

    const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
    if (updErr) return fail(updErr.message || String(updErr));
  }

  const sysRemark = appendSystemRemark_(
    row.system_remark,
    "[" + ts + "] " + actor + " 作廢經銷等級過帳：" + voidReason
  );

  const { error: updRowErr } = await sb
    .from("commercial_dealer_level_post")
    .update({
      status: "VOID",
      void_reason: voidReason,
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("level_post_id", levelPostId);
  if (updRowErr) return fail(updRowErr.message || String(updRowErr));

  await writeAuditLog_(
    "commercial_dealer_level_post",
    levelPostId,
    "BUNDLE_VOID_COMMERCIAL_DEALER_LEVEL",
    actor,
    JSON.stringify({ level_post_id: levelPostId, void_reason: voidReason, cumulative_removed: removed })
  );

  return ok({ level_post_id: levelPostId, message: "VOIDED", cumulative_removed: removed });
}

async function voidLegacyLevelInStatRow_(sb, statRow, actor, voidReason, ts) {
  const removed = roundMoney_(
    (statRow.cumulative_add_consignment || 0) + (statRow.cumulative_add_general || 0)
  );
  const customerId = normId_(statRow.customer_id);
  if (removed > 1e-9 && customerId) {
    const customer = await reloadCustomer_(sb, customerId);
    if (!customer) return fail("Customer not found: " + customerId);
    const before = roundMoney_(customer.dealer_cumulative_amount);
    const after = roundMoney_(Math.max(0, before - removed));
    const patch = {
      dealer_cumulative_amount: after,
      updated_by: actor,
      updated_at: ts
    };
    const snapPending = String(statRow.cumulative_pending_tier_label || "").trim();
    const custPending = String(customer.dealer_cumulative_pending_tier_label || "").trim();
    if (snapPending && snapPending === custPending) {
      patch.dealer_cumulative_pending_tier_label = "";
      patch.dealer_cumulative_pending_price_rate = null;
      patch.dealer_cumulative_pending_from_ym = "";
    }
    const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
    if (updErr) return fail(updErr.message || String(updErr));
  }
  return { cumulative_removed: removed };
}

async function rollbackCustomerCumulativeAdd_(sb, opts) {
  const customerId = normId_(opts?.customerId);
  const removed = roundMoney_(opts?.amount);
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();
  const cumulativeRes = opts?.cumulativeRes || {};
  if (!customerId || removed <= 1e-9) return;

  const customer = await reloadCustomer_(sb, customerId);
  if (!customer) return;

  const before = roundMoney_(customer.dealer_cumulative_amount);
  const after = roundMoney_(Math.max(0, before - removed));
  const patch = {
    dealer_cumulative_amount: after,
    updated_by: actor,
    updated_at: ts
  };

  const snapPending = String(cumulativeRes.pending_tier_label || "").trim();
  const custPending = String(customer.dealer_cumulative_pending_tier_label || "").trim();
  if (snapPending && snapPending === custPending) {
    patch.dealer_cumulative_pending_tier_label = "";
    patch.dealer_cumulative_pending_price_rate = null;
    patch.dealer_cumulative_pending_from_ym = "";
  }

  const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
  if (updErr) throw new Error(updErr.message || String(updErr));
}

async function voidCommercialDealerMonthlyCloseBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer monthly close");

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const voidReason = String(p.void_reason || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const ts = nowIso();
  const steps = [];

  const { data: rebate } = await sb
    .from("commercial_dealer_rebate")
    .select("rebate_id")
    .eq("customer_id", customerId)
    .eq("period_ym", periodYm)
    .eq("status", "POSTED")
    .maybeSingle();
  if (rebate) {
    const voidRebate = await voidCommercialDealerRebateBundle({
      rebate_id: rebate.rebate_id,
      void_reason: voidReason,
      updated_by: actor,
      created_by: actor,
      _session: p._session,
      _skipCumulativeRecalc: true,
      _monthly_close_cascade: true
    });
    if (voidRebate && voidRebate.success === false) {
      return fail(
        (voidRebate.errors && voidRebate.errors[0]) ||
          "作廢月結回饋失敗（可重試「作廢本月月結」續作）"
      );
    }
    steps.push({ step: "rebate", rebate_id: rebate.rebate_id });
  }

  const levelRow = await loadActiveLevelPostRow_(sb, customerId, periodYm);
  if (levelRow && normId_(levelRow.status) === "POSTED") {
    const voidLevel = await voidCommercialDealerLevelPostBundle({
      level_post_id: levelRow.level_post_id,
      void_reason: voidReason,
      updated_by: actor,
      created_by: actor,
      _session: p._session,
      _monthly_close_cascade: true
    });
    if (voidLevel && voidLevel.success === false) {
      const done = steps.map(function (s) {
        return s.step;
      });
      return fail(
        (voidLevel.errors && voidLevel.errors[0]) ||
          "作廢經銷等級失敗（已完成：" +
            (done.length ? done.join("、") : "無") +
            "；可重試「作廢本月月結」續作）"
      );
    }
    steps.push({ step: "level", level_post_id: levelRow.level_post_id });
  }

  const statRow = await loadActiveMonthlyStatRow_(sb, customerId, periodYm);
  if (!statRow || normId_(statRow.status) !== "POSTED") {
    if (steps.length) {
      return fail(
        "此客戶該月統計已作廢或不存在；已完成步驟：" +
          steps.map(function (s) {
            return s.step;
          }).join("、")
      );
    }
    return fail("此客戶該月無可作廢的月結統計");
  }

  if (isLegacyLevelBundledInStatRow_(statRow)) {
    const legacyRes = await voidLegacyLevelInStatRow_(sb, statRow, actor, voidReason, ts);
    if (legacyRes.err) return fail(legacyRes.err);
    steps.push({ step: "legacy_level_in_stat", cumulative_removed: legacyRes.cumulative_removed });
  }

  const sysRemark = appendSystemRemark_(
    statRow.system_remark,
    "[" + ts + "] " + actor + " 作廢本月月結：" + voidReason
  );
  const { error: updStatErr } = await sb
    .from("commercial_dealer_monthly_stat")
    .update({
      status: "VOID",
      void_reason: voidReason,
      system_remark: sysRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("stat_id", statRow.stat_id);
  if (updStatErr) {
    return fail(
      (updStatErr.message || String(updStatErr)) +
        "（已完成：" +
        steps
          .map(function (s) {
            return s.step;
          })
          .join("、") +
        "；可重試「作廢本月月結」續作）"
    );
  }

  try {
    await recalculateCustomerCumulativeFromPostedRebates_(sb, customerId, actor, ts);
  } catch (e) {
    return fail(
      "累積重算失敗：" +
        (e?.message || String(e)) +
        "（單據已作廢，請聯絡管理員校正累積）"
    );
  }

  await writeAuditLog_(
    "commercial_dealer_monthly_stat",
    statRow.stat_id,
    "BUNDLE_VOID_COMMERCIAL_DEALER_MONTHLY_CLOSE",
    actor,
    JSON.stringify({ customer_id: customerId, period_ym: periodYm, void_reason: voidReason, steps })
  );

  return ok({
    message: "VOIDED",
    customer_id: customerId,
    period_ym: periodYm,
    stat_id: statRow.stat_id,
    steps
  });
}

async function batchPostCommercialDealerMonthlyStatBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer monthly stat batch");

  const periodYm = String(p.period_ym || "").trim();
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const customerIds = parseMonthlyStatCustomerIds_(p);
  if (!customerIds.length) return fail("customer_ids required");
  if (customerIds.length > MONTHLY_STAT_BATCH_LIMIT_) {
    return fail("單次最多 " + MONTHLY_STAT_BATCH_LIMIT_ + " 位客戶，請縮小篩選");
  }

  const succeeded = [];
  const skipped = [];
  const failed = [];

  for (const cid of customerIds) {
    const customerId = normId_(cid);
    if (!customerId) continue;
    try {
      const sb = getSupabase();
      const billing = await computeBillingNetForStatSource_(sb, customerId, periodYm, "ALL");
      if (billing.err) {
        skipped.push({ customer_id: customerId, reason: billing.err });
        continue;
      }
      if (roundMoney_(billing.billing_net) <= 1e-9) {
        skipped.push({ customer_id: customerId, reason: "本月無請款淨額" });
        continue;
      }
      const existing = await loadActiveMonthlyStatRow_(sb, customerId, periodYm);
      if (existing && normId_(existing.status) === "POSTED") {
        const drift = buildMonthlyStatBillingDrift_(existing, billing);
        if (drift.has_new_billing) {
          skipped.push({ customer_id: customerId, reason: "已過帳・有新單" });
        } else {
          skipped.push({ customer_id: customerId, reason: "本月統計已過帳" });
        }
        continue;
      }
      if (existing) {
        skipped.push({ customer_id: customerId, reason: "已有未過帳紀錄，請先處理" });
        continue;
      }

      const res = await postCommercialDealerMonthlyStatBundle({
        customer_id: customerId,
        period_ym: periodYm,
        remark: String(p.remark || ""),
        created_by: actor,
        updated_by: actor,
        _session: p._session
      });
      if (res && res.success === false) {
        failed.push({
          customer_id: customerId,
          reason: (res.errors && res.errors[0]) || "過帳失敗"
        });
      } else {
        succeeded.push({ customer_id: customerId, stat_id: res.stat_id });
      }
    } catch (e) {
      failed.push({ customer_id: customerId, reason: e?.message || String(e) });
    }
  }

  return ok({
    period_ym: periodYm,
    succeeded,
    skipped,
    failed,
    succeeded_count: succeeded.length,
    skipped_count: skipped.length,
    failed_count: failed.length
  });
}

async function previewCommercialDealerRebateBundle(p) {
  const gate = requireCommercialDealerSession_(p);
  if (gate) return gate;

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const sb = getSupabase();
  try {
    const ctx = await resolveCustomerDealerContext_(sb, customerId, periodYm);
    if (ctx.err) return fail(ctx.err);

    const { data: existed } = await sb
      .from("commercial_dealer_rebate")
      .select(
        "rebate_id, status, billing_net, billing_net_consignment, billing_net_general, rebate_amount, rebate_pct, tier_snapshot_json, scheme_id, scheme_name_snapshot, settle_mode"
      )
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();

    const { data: statRow } = await sb
      .from("commercial_dealer_monthly_stat")
      .select(
        "stat_id, status, billing_net_consignment, billing_net_general, billing_net_total"
      )
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();
    const monthlyStatPosted = normId_(statRow?.status) === "POSTED";

    let previewBilling = ctx.billing;
    let previewRebatePct = ctx.rebate_pct;
    let previewRebateAmount = ctx.rebate_amount;
    let previewTier = ctx.tier;
    if (!existed && monthlyStatPosted && statRow) {
      const snapBilling = billingPackFromStatRowForSource_(statRow, ctx.scheme.stat_source);
      previewTier = pickTierForBilling_(snapBilling.billing_net, ctx.tiers);
      previewRebatePct = previewTier ? Number(previewTier.rebate_pct || 0) : 0;
      previewRebateAmount = roundMoney_((snapBilling.billing_net * previewRebatePct) / 100);
      previewBilling = Object.assign({}, ctx.billing, snapBilling);
    }

    let cumulativePreview = { enabled: false };

    let drift;
    if (existed) {
      drift = buildMonthlyStatBillingDrift_(
        {
          billing_net_consignment: existed.billing_net_consignment,
          billing_net_general: existed.billing_net_general,
          billing_net_total: existed.billing_net
        },
        ctx.billing
      );
    } else if (monthlyStatPosted && statRow) {
      /** 與月結統計同一口徑（寄賣＋一般）比對，勿用回饋 stat_source 誤判一般差額 */
      const liveAll = await computeBillingNetForStatSource_(sb, customerId, periodYm, "ALL");
      drift = buildMonthlyStatBillingDrift_(statRow, liveAll);
    } else {
      drift = buildMonthlyStatBillingDrift_({}, ctx.billing);
    }

    let postedTierSnap = null;
    if (existed?.tier_snapshot_json) {
      try {
        postedTierSnap = JSON.parse(String(existed.tier_snapshot_json));
      } catch (_e) {
        postedTierSnap = null;
      }
    }

    return ok(
      attachMonthlyStatBillingDriftFields_(
        {
          customer_id: customerId,
          period_ym: periodYm,
          scheme_id: existed
            ? normId_(existed.scheme_id || ctx.scheme.scheme_id)
            : normId_(ctx.scheme.scheme_id),
          scheme_name: existed
            ? String(existed.scheme_name_snapshot || ctx.scheme.scheme_name || "")
            : String(ctx.scheme.scheme_name || ""),
          billing_net: previewBilling.billing_net,
          billing_net_consignment: previewBilling.billing_net_consignment,
          billing_net_general: previewBilling.billing_net_general,
          gross_settlement: previewBilling.gross_settlement,
          gross_shipment: previewBilling.gross_shipment,
          stat_source: normId_(ctx.scheme.stat_source) || "CONSIGNMENT",
          ar_discount_total: ctx.billing.ar_discount_total,
          settlement_count: ctx.billing.settlement_count,
          shipment_count: ctx.billing.shipment_count,
          settlements: ctx.billing.settlements,
          shipments: ctx.billing.shipments,
          rebate_pct: existed ? Number(existed.rebate_pct || 0) : previewRebatePct,
          rebate_amount: existed
            ? roundMoney_(existed.rebate_amount || 0)
            : previewRebateAmount,
          settle_mode_default: existed
            ? String(existed.settle_mode || ctx.settle_mode_default || "").trim()
            : ctx.settle_mode_default,
          tier_snapshot: existed && postedTierSnap ? postedTierSnap : previewTier || null,
          rebate_amount_source: existed ? "posted_snapshot" : monthlyStatPosted ? "stat_snapshot" : "live_preview",
          already_posted: !!existed,
          existing_rebate_id: existed ? String(existed.rebate_id || "") : "",
          monthly_stat_posted: monthlyStatPosted,
          needs_stat_first: !monthlyStatPosted && !existed,
          existing_stat_id: statRow ? String(statRow.stat_id || "") : "",
          cumulative_preview: cumulativePreview
        },
        drift
      )
    );
  } catch (e) {
    return fail(e?.message || String(e));
  }
}

async function postCommercialDealerRebateBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer rebate");

  const customerId = normId_(p.customer_id);
  const periodYm = String(p.period_ym || "").trim();
  if (!customerId) return fail("customer_id required");
  if (!parsePeriodYm_(periodYm)) return fail("period_ym must be YYYY-MM");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();

  const { data: dup } = await sb
    .from("commercial_dealer_rebate")
    .select("rebate_id")
    .eq("customer_id", customerId)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .maybeSingle();
  if (dup) return fail("此客戶該月份已有回饋紀錄: " + dup.rebate_id);

  let ctx;
  try {
    ctx = await resolveCustomerDealerContext_(sb, customerId, periodYm);
  } catch (e) {
    return fail(e?.message || String(e));
  }
  if (ctx.err) return fail(ctx.err);

  const billingNet = roundMoney_(ctx.billing.billing_net);
  if (billingNet <= 1e-9) return fail("本月無請款淨額");

  const statCheck = await assertMonthlyStatPostedForRebate_(sb, customerId, periodYm);
  if (statCheck.err) return fail(statCheck.err);
  const statRow = statCheck.statRow;

  const snapBilling = billingPackFromStatRowForSource_(statRow, ctx.scheme.stat_source);
  const tier = pickTierForBilling_(snapBilling.billing_net, ctx.tiers);
  const rebatePct = tier ? Number(tier.rebate_pct || 0) : 0;
  const rebateAmount = roundMoney_((snapBilling.billing_net * rebatePct) / 100);
  ctx.billing = Object.assign({}, ctx.billing, snapBilling);
  ctx.tier = tier;
  ctx.rebate_pct = rebatePct;
  ctx.rebate_amount = rebateAmount;

  const rebateAmountFinal = roundMoney_(rebateAmount);

  let settleMode = normId_(p.settle_mode) || ctx.settle_mode_default;
  if (!["CREDIT_NOTE", "CARRY_FORWARD"].includes(settleMode)) return fail("settle_mode invalid");

  const ts = nowIso();
  const rebateId = buildId_("CDR");
  let arId = "";
  let creditApplied = 0;
  let creditBalanceAfter = null;
  let balanceUpdated = false;

  const tierSnap = ctx.tier
    ? {
        tier_id: ctx.tier.tier_id,
        amount_from: Number(ctx.tier.amount_from || 0),
        amount_to: ctx.tier.amount_to != null ? Number(ctx.tier.amount_to) : null,
        rebate_pct: Number(ctx.tier.rebate_pct || 0)
      }
    : null;

  const row = {
    rebate_id: rebateId,
    customer_id: customerId,
    period_ym: periodYm,
    scheme_id: normId_(ctx.scheme.scheme_id),
    scheme_name_snapshot: String(ctx.scheme.scheme_name || ""),
    billing_net: ctx.billing.billing_net,
    billing_net_consignment: ctx.billing.billing_net_consignment,
    billing_net_general: ctx.billing.billing_net_general,
    gross_settlement: ctx.billing.gross_settlement,
    gross_shipment: ctx.billing.gross_shipment,
    rebate_pct: ctx.rebate_pct,
    rebate_amount: rebateAmountFinal,
    tier_snapshot_json: tierSnap ? JSON.stringify(tierSnap) : "",
    settle_mode: settleMode,
    status: "POSTED",
    ar_id: "",
    credit_applied: 0,
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null,
    system_remark: ""
  };

  const { error: insErr } = await sb.from("commercial_dealer_rebate").insert(row);
  if (insErr) return fail(insErr.message || String(insErr));

  try {
    if (rebateAmountFinal > 1e-9) {
      if (settleMode === "CREDIT_NOTE") {
        let applyRes;
        try {
          applyRes = await applyRebateCreditNote_(
            sb,
            ctx.billing.ar_ids,
            rebateAmountFinal,
            periodYm,
            actor,
            p._session
          );
        } catch (e) {
          throw new Error(e?.message || String(e));
        }
        if (applyRes.err) throw new Error(applyRes.err);
        arId = applyRes.ar_id || "";
        creditApplied = roundMoney_(applyRes.credit_applied || 0);
      } else {
        const bal = roundMoney_(Number(ctx.customer.dealer_rebate_credit_balance || 0) + rebateAmountFinal);
        const { error: custErr } = await sb
          .from("customer")
          .update({
            dealer_rebate_credit_balance: bal,
            updated_by: actor,
            updated_at: ts
          })
          .eq("customer_id", customerId);
        if (custErr) throw new Error(custErr.message || String(custErr));
        creditApplied = rebateAmountFinal;
        creditBalanceAfter = bal;
        balanceUpdated = true;
      }
    }

    const { error: updErr } = await sb
      .from("commercial_dealer_rebate")
      .update({
        ar_id: arId,
        credit_applied: creditApplied,
        updated_by: actor,
        updated_at: ts
      })
      .eq("rebate_id", rebateId);
    if (updErr) throw new Error(updErr.message || String(updErr));
  } catch (e) {
    await rollbackPostedRebateSettleFailure_(sb, {
      rebateId,
      customerId,
      periodYm,
      settleMode,
      arId,
      creditApplied,
      rebateAmount: rebateAmountFinal,
      balanceUpdated,
      actor,
      session: p._session,
      ts
    });
    return fail(e?.message || String(e));
  }

  await writeAuditLog_(
    "commercial_dealer_rebate",
    rebateId,
    "BUNDLE_POST_COMMERCIAL_DEALER_REBATE",
    actor,
    JSON.stringify({
      rebate_id: rebateId,
      customer_id: customerId,
      period_ym: periodYm,
      rebate_amount: rebateAmount,
      settle_mode: settleMode,
      ar_id: arId,
      credit_applied: creditApplied,
      credit_balance_after: creditBalanceAfter
    })
  );

  return ok({
    rebate_id: rebateId,
    rebate_amount: rebateAmount,
    settle_mode: settleMode,
    ar_id: arId,
    credit_applied: creditApplied,
    credit_balance_after: creditBalanceAfter,
    billing_net: billingNet,
    cumulative: null
  });
}

async function voidCommercialDealerRebateBundle(p) {
  if (!canOperateDealerRebate_(p._session)) return fail("Permission denied: commercial dealer rebate");

  const rebateId = String(p.rebate_id || "").trim();
  if (!rebateId) return fail("rebate_id required");

  const voidReason = String(p.void_reason || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: rebate, error: getErr } = await sb
    .from("commercial_dealer_rebate")
    .select("*")
    .eq("rebate_id", rebateId)
    .maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!rebate) return fail("回饋紀錄不存在: " + rebateId);

  const st = normId_(rebate.status);
  if (st === "VOID") {
    return ok({ rebate_id: rebateId, message: "ALREADY_VOID", idempotent: true });
  }
  if (st !== "POSTED") return fail("僅可作廢已產生的回饋（POSTED）");

  const customerId = normId_(rebate.customer_id);
  const periodYm = String(rebate.period_ym || "").trim();
  const settleMode = normId_(rebate.settle_mode);
  const rebateAmount = roundMoney_(rebate.rebate_amount || rebate.credit_applied);

  const skipCumulativeRecalc = !!(p._skipCumulativeRecalc || p._monthly_close_cascade);
  const ts = nowIso();

  if (rebateAmount > 1e-9) {
    if (settleMode === "CREDIT_NOTE") {
      let revRes;
      try {
        revRes = await reverseRebateCreditNote_(sb, customerId, periodYm, rebate, actor, p._session);
      } catch (e) {
        return fail(e?.message || String(e));
      }
      if (revRes.err) return fail(revRes.err);
    } else if (settleMode === "CARRY_FORWARD") {
      const { data: customer, error: custErr } = await sb
        .from("customer")
        .select("dealer_rebate_credit_balance")
        .eq("customer_id", customerId)
        .maybeSingle();
      if (custErr) return fail(custErr.message || String(custErr));
      if (!customer) return fail("Customer not found: " + customerId);
      const curBal = roundMoney_(customer.dealer_rebate_credit_balance || 0);
      if (curBal + 1e-9 < rebateAmount) {
        return fail("折抵餘額不足（目前 " + curBal + "，需扣回 " + rebateAmount + "）");
      }
      const newBal = roundMoney_(curBal - rebateAmount);
      const { error: updCustErr } = await sb
        .from("customer")
        .update({
          dealer_rebate_credit_balance: newBal,
          updated_by: actor,
          updated_at: ts
        })
        .eq("customer_id", customerId);
      if (updCustErr) return fail(updCustErr.message || String(updCustErr));
    } else {
      return fail("settle_mode invalid");
    }
  }

  let cumulativeReverse = {};
  try {
    cumulativeReverse = await reverseCumulativeOnRebateVoid_(sb, rebate, actor, ts);
  } catch (e) {
    return fail("累積扣回失敗：" + (e?.message || String(e)));
  }

  const sysRemark = appendSystemRemark_(
    rebate.system_remark,
    "[" + ts + "] " + actor + " 作廢月結回饋：" + voidReason
  );

  const { error: updErr } = await sb
    .from("commercial_dealer_rebate")
    .update({
      status: "VOID",
      updated_by: actor,
      updated_at: ts,
      system_remark: sysRemark
    })
    .eq("rebate_id", rebateId);
  if (updErr) return fail(updErr.message || String(updErr));

  let cumulativeRecalc = {};
  if (!skipCumulativeRecalc) {
    try {
      cumulativeRecalc = await recalculateCustomerCumulativeFromPostedRebates_(sb, customerId, actor, ts);
    } catch (e) {
      return fail("累積重算失敗：" + (e?.message || String(e)));
    }
  }

  await writeAuditLog_(
    "commercial_dealer_rebate",
    rebateId,
    "BUNDLE_VOID_COMMERCIAL_DEALER_REBATE",
    actor,
    JSON.stringify({
      rebate_id: rebateId,
      customer_id: customerId,
      period_ym: periodYm,
      void_reason: voidReason,
      settle_mode: settleMode,
      rebate_amount: rebateAmount
    })
  );

  return ok({
    rebate_id: rebateId,
    message: "VOIDED",
    customer_id: customerId,
    period_ym: periodYm,
    cumulative: cumulativeReverse.skipped ? null : cumulativeReverse,
    cumulative_recalc: cumulativeRecalc.skipped ? null : cumulativeRecalc
  });
}

module.exports = {
  listCommercialDealerSchemeEnriched_,
  listCommercialDealerCustomerEnriched_,
  listCommercialDealerRebateEnriched_,
  saveCommercialDealerSchemeBundle,
  previewCommercialDealerRebateBundle,
  postCommercialDealerRebateBundle,
  voidCommercialDealerRebateBundle,
  listCommercialDealerMonthlyStatEnriched_,
  listCommercialDealerMonthlyStatPeriodSummary_,
  previewCommercialDealerMonthlyStatBundle,
  postCommercialDealerMonthlyStatBundle,
  voidCommercialDealerMonthlyStatBundle,
  batchPostCommercialDealerMonthlyStatBundle,
  voidCommercialDealerMonthlyCloseBundle,
  listCommercialDealerLevelPostEnriched_,
  previewCommercialDealerLevelBundle,
  postCommercialDealerLevelBundle,
  voidCommercialDealerLevelPostBundle,
  previewCumulativeDealerForSettlementBundle,
  resolveCumulativeDealerPriceForSettlement_,
  applyCumulativeDealerPriceToLines_,
  computeEligibleDealerCreditForSettlement_,
  applyDealerCreditAtSettlement_,
  applyDealerCreditAtShipment_,
  processCumulativeOnGeneralShipment_,
  reverseCumulativeOnGeneralShipmentVoid_,
  syncCustomerCumulativeFromSources_,
  restoreDealerCreditOnSettlementVoid_,
  assertNoLockedDealerRebateForSettlementVoid_,
  assertNoLockedDealerRebateForShipmentVoid_,
  assertNoPostedMonthlyStatForNewBilling_,
  schemeStatSourceAllows_,
  resolveBillingNetForCumulativeOnRebate_,
  computeBillingNetForStatSource_,
  syncCustomerCumulativeTierIfNeeded_,
  syncCustomerCumulativeTierBundle,
  recalculateCustomerCumulativeFromPostedRebates_
};
