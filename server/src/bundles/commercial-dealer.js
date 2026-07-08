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
    .select("rebate_id, period_ym, status")
    .eq("customer_id", cust)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .limit(1);
  if (error) throw new Error(error.message || String(error));
  const hit = Array.isArray(data) && data.length ? data[0] : null;
  if (hit) {
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
    .select("stat_id, period_ym, status")
    .eq("customer_id", cust)
    .eq("period_ym", periodYm)
    .neq("status", "VOID")
    .limit(1);
  if (statErr) throw new Error(statErr.message || String(statErr));
  const st = Array.isArray(statHit) && statHit.length ? statHit[0] : null;
  if (!st) return null;

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
    settlementDate: o.shipDate
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

  return {
    enabled: true,
    scheme_id: schemeId,
    scheme_name: String(scheme.scheme_name || "").trim(),
    cumulative_before: before,
    cumulative_add: add,
    cumulative_after: after,
    current_tier_label: String(sim.dealer_cumulative_tier_label || "").trim(),
    current_price_rate:
      sim.dealer_cumulative_price_rate != null && sim.dealer_cumulative_price_rate !== ""
        ? Number(sim.dealer_cumulative_price_rate)
        : null,
    upgrade,
    pending_tier_label: upgrade ? String(tierAfterAdd?.tier_label || "").trim() : "",
    pending_price_rate:
      upgrade && tierAfterAdd?.price_rate != null ? Number(tierAfterAdd.price_rate) : null
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

/** 一般出貨過帳：累積制方案 stat_source 含 GENERAL 時即時寫入累積採購 */
async function processCumulativeOnGeneralShipment_(sb, opts) {
  const customerId = normId_(opts?.customerId);
  const shipDate = String(opts?.shipDate || "").trim();
  const billingNet = roundMoney_(opts?.billingNet);
  const arId = String(opts?.arId || "").trim().toUpperCase();
  const shipmentId = normId_(opts?.shipmentId);
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();
  if (!customerId || billingNet <= 1e-9) return { skipped: true, reason: "no_billing" };

  let customer = await reloadCustomer_(sb, customerId);
  if (!customer) return { skipped: true, reason: "no_customer" };

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return { skipped: true, reason: "no_cumulative_scheme" };

  const startedAt = String(customer.dealer_cumulative_started_at || "").trim();
  if (startedAt && shipDate && shipDate < startedAt) return { skipped: true, reason: "before_start" };

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_type, status, stat_source, date_from, date_to")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") {
    return { skipped: true, reason: "not_cumulative_scheme" };
  }
  if (normId_(scheme.status) !== "ACTIVE") return { skipped: true, reason: "scheme_inactive" };
  if (!schemeStatSourceAllows_(scheme.stat_source, "GENERAL")) {
    return { skipped: true, reason: "stat_source_not_general" };
  }
  if (shipDate && !schemeOverlapsMonth_(scheme, shipDate, shipDate)) {
    return { skipped: true, reason: "scheme_period" };
  }

  const res = await applyCustomerCumulativeAmountAdd_(sb, {
    customerId,
    billingNet,
    actor,
    ts,
    upgradeFromYm: shipDate && shipDate.length >= 7 ? shipDate.slice(0, 7) : ""
  });
  if (res.skipped || res.err) return res;

  if (arId && roundMoney_(res.cumulative_added) > 1e-9) {
    const { error: arMarkErr } = await sb
      .from("ar_receivable")
      .update({
        dealer_cumulative_added: res.cumulative_added,
        updated_by: actor,
        updated_at: ts
      })
      .eq("ar_id", arId);
    if (arMarkErr && !/dealer_cumulative_added|column.*does not exist|could not find/i.test(arMarkErr.message || "")) {
      throw new Error(arMarkErr.message || String(arMarkErr));
    }
  }

  await writeAuditLog_(
    "customer",
    customerId,
    "BUNDLE_UPDATE_DEALER_CUMULATIVE_ON_GENERAL_SHIPMENT",
    actor,
    JSON.stringify({
      ar_id: arId,
      shipment_id: shipmentId,
      ship_date: shipDate,
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

async function reverseCumulativeOnGeneralShipmentVoid_(sb, opts) {
  const customerId = normId_(opts?.customerId);
  const arId = String(opts?.arId || "").trim().toUpperCase();
  const shipmentId = normId_(opts?.shipmentId);
  const actor = String(opts?.actor || "").trim();
  const ts = opts?.ts || nowIso();
  if (!customerId) return { skipped: true, reason: "no_customer" };

  let removed = roundMoney_(opts?.cumulativeAdded);
  if (removed <= 1e-9 && arId) {
    const { data: ar, error: arErr } = await sb
      .from("ar_receivable")
      .select("dealer_cumulative_added, amount_system")
      .eq("ar_id", arId)
      .maybeSingle();
    if (arErr) throw new Error(arErr.message || String(arErr));
    removed = roundMoney_(ar?.dealer_cumulative_added);
    if (removed <= 1e-9) removed = roundMoney_(ar?.amount_system);
  }
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

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (schemeId) {
    const tiers = await loadCumulativeSchemeTiers_(sb, schemeId);
    if (tiers.length) {
      const tier = pickCumulativeTier_(after, tiers);
      if (tier) {
        patch.dealer_cumulative_tier_label = String(tier.tier_label || "").trim();
        patch.dealer_cumulative_price_rate = tier.price_rate != null ? Number(tier.price_rate) : null;
      } else {
        patch.dealer_cumulative_tier_label = "";
        patch.dealer_cumulative_price_rate = null;
      }
      if (after < before - 1e-9) {
        patch.dealer_cumulative_pending_tier_label = "";
        patch.dealer_cumulative_pending_price_rate = null;
      }
    }
  }

  const { error: updErr } = await sb.from("customer").update(patch).eq("customer_id", customerId);
  if (updErr) throw new Error(updErr.message || String(updErr));

  if (arId) {
    const { error: arClrErr } = await sb
      .from("ar_receivable")
      .update({
        dealer_cumulative_added: 0,
        updated_by: actor,
        updated_at: ts
      })
      .eq("ar_id", arId);
    if (arClrErr && !/dealer_cumulative_added|column.*does not exist|could not find/i.test(arClrErr.message || "")) {
      throw new Error(arClrErr.message || String(arClrErr));
    }
  }

  await writeAuditLog_(
    "customer",
    customerId,
    "BUNDLE_REVERSE_DEALER_CUMULATIVE_ON_GENERAL_SHIPMENT_VOID",
    actor,
    JSON.stringify({
      ar_id: arId,
      shipment_id: shipmentId,
      cumulative_before: before,
      cumulative_after: after,
      cumulative_removed: removed
    })
  );

  return { cumulative_before: before, cumulative_after: after, cumulative_removed: removed };
}

async function reverseCumulativeOnRebateVoid_(sb, rebate, actor, ts) {
  const customerId = normId_(rebate?.customer_id);
  if (!customerId) return { skipped: true };

  let removed = roundMoney_(rebate?.cumulative_added);
  if (removed <= 1e-9) removed = roundMoney_(rebate?.billing_net);
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
async function sumPostedRebateCumulative_(sb, customerId) {
  const custId = normId_(customerId);
  if (!custId) return 0;
  const { data: rebates, error: rebErr } = await sb
    .from("commercial_dealer_rebate")
    .select("cumulative_added, billing_net")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  if (rebErr) throw new Error(rebErr.message || String(rebErr));
  let total = 0;
  (rebates || []).forEach((r) => {
    let add = roundMoney_(r.cumulative_added);
    if (add <= 1e-9) add = roundMoney_(r.billing_net);
    total += add;
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

/** 依仍有效（POSTED）月結回饋＋一般出貨 AR 重算累積採購 */
async function sumPostedGeneralShipmentCumulative_(sb, customerId, opts) {
  const custId = normId_(customerId);
  if (!custId) return 0;

  const customer = opts?.customer || (await reloadCustomer_(sb, custId));
  if (!customer) return 0;

  const schemeId = normId_(customer.dealer_cumulative_scheme_id);
  if (!schemeId) return 0;

  const { data: scheme, error: schErr } = await sb
    .from("commercial_dealer_scheme")
    .select("scheme_id, scheme_type, status, stat_source, date_from, date_to")
    .eq("scheme_id", schemeId)
    .maybeSingle();
  if (schErr) throw new Error(schErr.message || String(schErr));
  if (!scheme || normId_(scheme.scheme_type) !== "CUMULATIVE_AMOUNT") return 0;
  if (!schemeStatSourceAllows_(scheme.stat_source, "GENERAL")) return 0;

  const startedAt = String(customer.dealer_cumulative_started_at || "").trim();

  let ars = null;
  let arErr = null;
  ({ data: ars, error: arErr } = await sb
    .from("ar_receivable")
    .select("dealer_cumulative_added, amount_system, ar_date, status, close_mode")
    .eq("customer_id", custId)
    .eq("source_type", "SHIPMENT")
    .neq("status", "VOID"));
  if (arErr && /dealer_cumulative_added|column.*does not exist|could not find/i.test(arErr.message || "")) {
    ({ data: ars, error: arErr } = await sb
      .from("ar_receivable")
      .select("amount_system, ar_date, status, close_mode")
      .eq("customer_id", custId)
      .eq("source_type", "SHIPMENT")
      .neq("status", "VOID"));
  }
  if (arErr) throw new Error(arErr.message || String(arErr));

  const { data: rebates, error: rebErr } = await sb
    .from("commercial_dealer_rebate")
    .select("period_ym, billing_net_general, cumulative_added")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  if (rebErr) throw new Error(rebErr.message || String(rebErr));

  const rebateByYm = {};
  (rebates || []).forEach((r) => {
    const ym = String(r.period_ym || "").trim();
    if (ym) rebateByYm[ym] = r;
  });

  let total = 0;
  (ars || []).forEach((ar) => {
    if (!isArActiveForCumulative_(ar)) return;
    let add = roundMoney_(ar.dealer_cumulative_added);
    const shipDate = String(ar.ar_date || "").trim();
    if (startedAt && shipDate && shipDate < startedAt) return;
    if (shipDate && !schemeOverlapsMonth_(scheme, shipDate, shipDate)) return;

    if (add <= 1e-9) {
      add = roundMoney_(ar.amount_system);
      if (add <= 1e-9) return;
      const ym = shipDate.length >= 7 ? shipDate.slice(0, 7) : "";
      const reb = ym ? rebateByYm[ym] : null;
      if (
        reb &&
        roundMoney_(reb.billing_net_general) > 1e-9 &&
        roundMoney_(reb.cumulative_added) > 1e-9
      ) {
        return;
      }
    }
    total += add;
  });
  return roundMoney_(total);
}

async function sumPostedMonthlyStatCumulative_(sb, customerId) {
  const custId = normId_(customerId);
  if (!custId) return 0;
  const { data: rows, error } = await sb
    .from("commercial_dealer_monthly_stat")
    .select("cumulative_add_consignment")
    .eq("customer_id", custId)
    .eq("status", "POSTED");
  if (error) throw new Error(error.message || String(error));
  let total = 0;
  (rows || []).forEach((r) => {
    total += roundMoney_(r.cumulative_add_consignment);
  });
  return roundMoney_(total);
}

async function sumCustomerCumulativeFromSources_(sb, customerId, opts) {
  const customer = opts?.customer || (await reloadCustomer_(sb, normId_(customerId)));
  const rebateTotal = await sumPostedRebateCumulative_(sb, customerId);
  const statTotal = await sumPostedMonthlyStatCumulative_(sb, customerId);
  const shipTotal = await sumPostedGeneralShipmentCumulative_(sb, customerId, { customer });
  return roundMoney_(rebateTotal + statTotal + shipTotal);
}

/** 舊資料：出貨已過帳但尚未寫入累積時，同步時補登（不重複計入已月結月份） */
async function backfillGeneralShipmentCumulativeIfNeeded_(sb, customerId, actor, ts) {
  const custId = normId_(customerId);
  if (!custId) return { skipped: true, reason: "no_customer" };

  const customer = await reloadCustomer_(sb, custId);
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
  if (!schemeStatSourceAllows_(scheme.stat_source, "GENERAL")) {
    return { skipped: true, reason: "stat_source_not_general" };
  }

  const startedAt = String(customer.dealer_cumulative_started_at || "").trim();
  const { data: ars, error: arErr } = await sb
    .from("ar_receivable")
    .select("ar_id, amount_system, ar_date, dealer_cumulative_added, shipment_id, status, close_mode")
    .eq("customer_id", custId)
    .eq("source_type", "SHIPMENT")
    .neq("status", "VOID");
  if (arErr) throw new Error(arErr.message || String(arErr));

  let filled = 0;
  for (let i = 0; i < (ars || []).length; i++) {
    const ar = ars[i] || {};
    if (!isArActiveForCumulative_(ar)) continue;
    if (roundMoney_(ar.dealer_cumulative_added) > 1e-9) continue;
    const amount = roundMoney_(ar.amount_system);
    if (amount <= 1e-9) continue;
    const shipDate = String(ar.ar_date || "").trim();
    if (startedAt && shipDate && shipDate < startedAt) continue;
    const ym = shipDate.length >= 7 ? shipDate.slice(0, 7) : "";
    const arId = String(ar.ar_id || "").trim().toUpperCase();
    const shipmentId = normId_(ar.shipment_id);

    if (ym) {
      const { data: mstat, error: mstatErr } = await sb
        .from("commercial_dealer_monthly_stat")
        .select("stat_id, cumulative_add_consignment")
        .eq("customer_id", custId)
        .eq("period_ym", ym)
        .eq("status", "POSTED")
        .maybeSingle();
      if (mstatErr) throw new Error(mstatErr.message || String(mstatErr));
      if (mstat && roundMoney_(mstat.cumulative_add_consignment) > 1e-9) {
        const { error: markErr } = await sb
          .from("ar_receivable")
          .update({
            dealer_cumulative_added: amount,
            updated_by: actor,
            updated_at: ts
          })
          .eq("ar_id", arId);
        if (markErr) throw new Error(markErr.message || String(markErr));
        filled++;
        continue;
      }

      const { data: reb, error: rebErr } = await sb
        .from("commercial_dealer_rebate")
        .select("rebate_id, billing_net_general, cumulative_added")
        .eq("customer_id", custId)
        .eq("period_ym", ym)
        .eq("status", "POSTED")
        .maybeSingle();
      if (rebErr) throw new Error(rebErr.message || String(rebErr));
      if (
        reb &&
        roundMoney_(reb.billing_net_general) > 1e-9 &&
        roundMoney_(reb.cumulative_added) > 1e-9
      ) {
        const { error: markErr } = await sb
          .from("ar_receivable")
          .update({
            dealer_cumulative_added: amount,
            updated_by: actor,
            updated_at: ts
          })
          .eq("ar_id", arId);
        if (markErr) throw new Error(markErr.message || String(markErr));
        filled++;
        continue;
      }
    }

    const res = await processCumulativeOnGeneralShipment_(sb, {
      customerId: custId,
      shipDate,
      billingNet: amount,
      arId,
      shipmentId,
      actor,
      ts
    });
    if (!res.skipped && !res.err) filled++;
  }

  return filled > 0 ? { backfilled: filled } : { skipped: true, reason: "nothing_to_backfill" };
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

  if (customer.dealer_rebate_excluded === true || String(customer.dealer_rebate_excluded || "").toUpperCase() === "TRUE") {
    return { err: "此客戶已設定排除回饋" };
  }

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
  let statSource = "ALL";
  if (cumSchemeId) {
    const { data: scheme, error: schErr } = await sb
      .from("commercial_dealer_scheme")
      .select("scheme_id, scheme_type, status, stat_source")
      .eq("scheme_id", cumSchemeId)
      .maybeSingle();
    if (schErr) throw new Error(schErr.message || String(schErr));
    if (scheme && normId_(scheme.scheme_type) === "CUMULATIVE_AMOUNT") {
      statSource = normId_(scheme.stat_source) || "ALL";
    }
  }

  const billing = await computeBillingNetForStatSource_(sb, cust, periodYm, statSource);
  if (billing.err) return { err: billing.err };

  const billingTotal = roundMoney_(billing.billing_net);
  if (billingTotal <= 1e-9) return { err: "本月無請款淨額" };

  return {
    customer,
    billing,
    cumulative_scheme_id: cumSchemeId,
    stat_source: statSource
  };
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
      .select("stat_id, status")
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();

    let cumulativeAddConsignment = 0;
    const cumSchemeId = normId_(ctx.cumulative_scheme_id);
    if (cumSchemeId && roundMoney_(ctx.billing.billing_net_consignment) > 1e-9) {
      const { data: scheme } = await sb
        .from("commercial_dealer_scheme")
        .select("stat_source")
        .eq("scheme_id", cumSchemeId)
        .maybeSingle();
      if (scheme && schemeStatSourceAllows_(scheme.stat_source, "CONSIGNMENT")) {
        cumulativeAddConsignment = roundMoney_(ctx.billing.billing_net_consignment);
      }
    }

    let cumulativePreview = { enabled: false };
    if (cumulativeAddConsignment > 1e-9) {
      try {
        cumulativePreview = await buildCumulativeClosePreview_(sb, ctx.customer, cumulativeAddConsignment);
      } catch (e) {
        cumulativePreview = { enabled: false, err: e?.message || String(e) };
      }
    }

    return ok({
      customer_id: customerId,
      period_ym: periodYm,
      cumulative_scheme_id: cumSchemeId,
      stat_source: ctx.stat_source,
      billing_net: ctx.billing.billing_net,
      billing_net_consignment: ctx.billing.billing_net_consignment,
      billing_net_general: ctx.billing.billing_net_general,
      gross_settlement: ctx.billing.gross_settlement,
      gross_shipment: ctx.billing.gross_shipment,
      settlement_count: ctx.billing.settlement_count,
      shipment_count: ctx.billing.shipment_count,
      cumulative_add_consignment: cumulativeAddConsignment,
      cumulative_add_general: roundMoney_(ctx.billing.billing_net_general),
      cumulative_note:
        "一般出貨請款淨額已於出貨過帳時計入累積；本次月結統計僅追加寄賣部分。",
      already_posted: !!existed,
      existing_stat_id: existed ? String(existed.stat_id || "") : "",
      cumulative_preview: cumulativePreview
    });
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

  let cumulativeAddConsignment = 0;
  const cumSchemeId = normId_(ctx.cumulative_scheme_id);
  if (cumSchemeId && roundMoney_(ctx.billing.billing_net_consignment) > 1e-9) {
    const { data: scheme } = await sb
      .from("commercial_dealer_scheme")
      .select("stat_source")
      .eq("scheme_id", cumSchemeId)
      .maybeSingle();
    if (scheme && schemeStatSourceAllows_(scheme.stat_source, "CONSIGNMENT")) {
      cumulativeAddConsignment = roundMoney_(ctx.billing.billing_net_consignment);
    }
  }

  const ts = nowIso();
  const statId = buildId_("CDMS");
  let cumulativeRes = { skipped: true };

  if (cumulativeAddConsignment > 1e-9) {
    try {
      cumulativeRes = await applyCustomerCumulativeAmountAdd_(sb, {
        customerId,
        billingNet: cumulativeAddConsignment,
        actor,
        ts,
        upgradeFromYm: periodYm
      });
    } catch (e) {
      return fail("累積更新失敗：" + (e?.message || String(e)));
    }
    if (cumulativeRes.err) return fail(cumulativeRes.err);
  }

  const row = {
    stat_id: statId,
    customer_id: customerId,
    period_ym: periodYm,
    cumulative_scheme_id: cumSchemeId,
    billing_net_consignment: roundMoney_(ctx.billing.billing_net_consignment),
    billing_net_general: roundMoney_(ctx.billing.billing_net_general),
    billing_net_total: roundMoney_(ctx.billing.billing_net),
    gross_settlement: roundMoney_(ctx.billing.gross_settlement),
    gross_shipment: roundMoney_(ctx.billing.gross_shipment),
    cumulative_add_consignment: cumulativeAddConsignment,
    cumulative_add_general: roundMoney_(ctx.billing.billing_net_general),
    cumulative_before: cumulativeRes.cumulative_before != null ? cumulativeRes.cumulative_before : null,
    cumulative_after: cumulativeRes.cumulative_after != null ? cumulativeRes.cumulative_after : null,
    cumulative_pending_tier_label: cumulativeRes.pending_tier_label || "",
    cumulative_pending_price_rate: cumulativeRes.pending_price_rate,
    cumulative_pending_from_ym: cumulativeRes.pending_tier_label ? periodYm : "",
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
      cumulative_add_consignment: cumulativeAddConsignment
    })
  );

  return ok({
    stat_id: statId,
    billing_net: row.billing_net_total,
    cumulative_add_consignment: cumulativeAddConsignment,
    cumulative: cumulativeRes.skipped ? null : cumulativeRes
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
  const ts = nowIso();
  const removed = roundMoney_(stat.cumulative_add_consignment);

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

    const snapPending = String(stat.cumulative_pending_tier_label || "").trim();
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
    JSON.stringify({ stat_id: statId, void_reason: voidReason, cumulative_removed: removed })
  );

  return ok({ stat_id: statId, message: "VOIDED", cumulative_removed: removed });
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
      .select("rebate_id, status")
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();

    let cumulativePreview = {
      enabled: false,
      note: "月結累積（含寄賣）請先於上方「月結統計」過帳；一般出貨已於出貨過帳時累加。"
    };

    return ok({
      customer_id: customerId,
      period_ym: periodYm,
      scheme_id: normId_(ctx.scheme.scheme_id),
      scheme_name: String(ctx.scheme.scheme_name || ""),
      billing_net: ctx.billing.billing_net,
      billing_net_consignment: ctx.billing.billing_net_consignment,
      billing_net_general: ctx.billing.billing_net_general,
      gross_settlement: ctx.billing.gross_settlement,
      gross_shipment: ctx.billing.gross_shipment,
      stat_source: normId_(ctx.scheme.stat_source) || "CONSIGNMENT",
      ar_discount_total: ctx.billing.ar_discount_total,
      settlement_count: ctx.billing.settlement_count,
      shipment_count: ctx.billing.shipment_count,
      settlements: ctx.billing.settlements,
      shipments: ctx.billing.shipments,
      rebate_pct: ctx.rebate_pct,
      rebate_amount: ctx.rebate_amount,
      settle_mode_default: ctx.settle_mode_default,
      tier_snapshot: ctx.tier || null,
      already_posted: !!existed,
      existing_rebate_id: existed ? String(existed.rebate_id || "") : "",
      cumulative_preview: cumulativePreview
    });
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

  if (roundMoney_(ctx.billing.billing_net_consignment) > 1e-9) {
    const { data: statRow } = await sb
      .from("commercial_dealer_monthly_stat")
      .select("stat_id")
      .eq("customer_id", customerId)
      .eq("period_ym", periodYm)
      .neq("status", "VOID")
      .maybeSingle();
    if (!statRow) return fail("本月有寄賣請款淨額，請先產生「月結統計」");
  }

  const rebateAmount = roundMoney_(ctx.rebate_amount);

  let settleMode = normId_(p.settle_mode) || ctx.settle_mode_default;
  if (!["CREDIT_NOTE", "CARRY_FORWARD"].includes(settleMode)) return fail("settle_mode invalid");

  const ts = nowIso();
  const rebateId = buildId_("CDR");
  let arId = "";
  let creditApplied = 0;
  let creditBalanceAfter = null;

  if (rebateAmount > 1e-9) {
    if (settleMode === "CREDIT_NOTE") {
      let applyRes;
      try {
        applyRes = await applyRebateCreditNote_(
          sb,
          ctx.billing.ar_ids,
          rebateAmount,
          periodYm,
          actor,
          p._session
        );
      } catch (e) {
        return fail(e?.message || String(e));
      }
      if (applyRes.err) return fail(applyRes.err);
      arId = applyRes.ar_id || "";
      creditApplied = roundMoney_(applyRes.credit_applied || 0);
    } else {
      const bal = roundMoney_(Number(ctx.customer.dealer_rebate_credit_balance || 0) + rebateAmount);
      const { error: custErr } = await sb
        .from("customer")
        .update({
          dealer_rebate_credit_balance: bal,
          updated_by: actor,
          updated_at: ts
        })
        .eq("customer_id", customerId);
      if (custErr) return fail(custErr.message || String(custErr));
      creditApplied = rebateAmount;
      creditBalanceAfter = bal;
    }
  }

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
    rebate_amount: rebateAmount,
    tier_snapshot_json: tierSnap ? JSON.stringify(tierSnap) : "",
    settle_mode: settleMode,
    status: "POSTED",
    ar_id: arId,
    credit_applied: creditApplied,
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null,
    system_remark: ""
  };

  const { error: insErr } = await sb.from("commercial_dealer_rebate").insert(row);
  if (insErr) return fail(insErr.message || String(insErr));

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
  try {
    cumulativeRecalc = await recalculateCustomerCumulativeFromPostedRebates_(sb, customerId, actor, ts);
  } catch (e) {
    return fail("累積重算失敗：" + (e?.message || String(e)));
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
  previewCommercialDealerMonthlyStatBundle,
  postCommercialDealerMonthlyStatBundle,
  voidCommercialDealerMonthlyStatBundle,
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
  schemeStatSourceAllows_,
  resolveBillingNetForCumulativeOnRebate_,
  computeBillingNetForStatSource_,
  syncCustomerCumulativeTierIfNeeded_,
  syncCustomerCumulativeTierBundle,
  recalculateCustomerCumulativeFromPostedRebates_
};
