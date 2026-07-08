const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { readSessionValid } = require("../session");
const { nowIso, buildShortDocId_, buildShortMasterId_, parseJsonArray, writeAuditLog_, buildId_, insertLot_, appendSystemRemark_, applyLotBalanceDelta_, sumMovementsForLot_ } = require("./shared");
const { createArFromCaseSettlement_, voidArForCancelledCaseSettlement_, canOperateConsignmentAr_ } = require("./ar");
const { loadPromoSchemesForCase_, computeSettlementPromoLines_ } = require("./consignment-promo");
const {
  applyDealerCreditAtSettlement_,
  restoreDealerCreditOnSettlementVoid_,
  assertNoLockedDealerRebateForSettlementVoid_,
  resolveCumulativeDealerPriceForSettlement_,
  applyCumulativeDealerPriceToLines_,
  recalculateCustomerCumulativeFromPostedRebates_
} = require("./commercial-dealer");
const { ensureSalesOrderTx_ } = require("./sales-order");
const { createInventoryMovementUnlocked_ } = require("../inventory-movement-core");

const RETURN_REASONS_ = {
  UNSOLD: 1,
  CASE_CLOSE: 1,
  DAMAGED: 1,
  EXPIRED: 1,
  WRONG_GOODS: 1,
  OTHER: 1
};

function isUnsoldPoolReturnReason_(reason) {
  const r = normId_(reason);
  return (
    r === "UNSOLD" ||
    r === "CASE_CLOSE" ||
    r === "DAMAGED" ||
    r === "EXPIRED" ||
    r === "WRONG_GOODS" ||
    r === "OTHER"
  );
}

function poolItemSettledAvailQty_(row) {
  return Math.max(0, Number(row?.settled_qty || 0));
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function sumCaseReceivedAmount_(sb, caseId) {
  const cid = normId_(caseId);
  if (!cid) return 0;
  const { data: stls } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, ar_id, status")
    .eq("case_id", cid);
  const arIds = [];
  (stls || []).forEach((s) => {
    if (normId_(s.status) !== "POSTED") return;
    let aid = String(s.ar_id || "").trim().toUpperCase();
    if (!aid) aid = "AR-STL-" + normId_(s.settlement_id);
    if (aid) arIds.push(aid);
  });
  const uniq = [...new Set(arIds)];
  if (!uniq.length) return 0;
  const { data: ars, error } = await sb.from("ar_receivable").select("amount_received").in("ar_id", uniq);
  if (error) return 0;
  let sum = 0;
  (ars || []).forEach((a) => {
    sum += Number(a.amount_received || 0);
  });
  return roundMoney_(sum);
}

async function sumCaseSettledAmount_(sb, caseId) {
  const pack = await sumCaseSettledAmountAndPromo_(sb, caseId);
  return pack.settledAmount;
}

/** 已結算 AR、經銷價結算額、促銷折讓（經銷價結算額 − 實際 AR，僅 POSTED） */
async function sumCaseSettledAmountAndPromo_(sb, caseId) {
  const empty = { settledAmount: 0, listAmount: 0, promoAllowance: 0 };
  const cid = normId_(caseId);
  if (!cid) return empty;

  const { data: stls, error: stlErr } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, status")
    .eq("case_id", cid);
  if (stlErr) return empty;

  const postedIds = (stls || [])
    .filter((s) => normId_(s.status) === "POSTED")
    .map((s) => normId_(s.settlement_id))
    .filter(Boolean);
  if (!postedIds.length) return empty;

  const { data: items, error: itemErr } = await sb
    .from("consignment_case_settlement_item")
    .select("settle_qty, list_unit_price, unit_price, amount")
    .in("settlement_id", postedIds);
  if (itemErr) return empty;

  let listAmount = 0;
  let settledAmount = 0;
  (items || []).forEach((it) => {
    const settleQty = Number(it.settle_qty || 0);
    const listPrice = Number(it.list_unit_price != null ? it.list_unit_price : it.unit_price || 0);
    listAmount += settleQty * listPrice;
    settledAmount += Number(it.amount || 0);
  });
  listAmount = roundMoney_(listAmount);
  settledAmount = roundMoney_(settledAmount);
  const promoAllowance = roundMoney_(Math.max(0, listAmount - settledAmount));
  return { settledAmount, listAmount, promoAllowance };
}

function aggPoolStatsFromItems_(items) {
  let totalShip = 0;
  let totalSettled = 0;
  let totalReturned = 0;
  let totalShipAmount = 0;
  let totalReturnedAmount = 0;
  (items || []).forEach((it) => {
    const shipQty = Number(it.ship_qty || 0);
    const settledQty = Number(it.settled_qty || 0);
    const returnedQty = Number(it.returned_qty || 0);
    const unitPrice = Number(it.unit_price || 0);
    totalShip += shipQty;
    totalSettled += settledQty;
    totalReturned += returnedQty;
    totalShipAmount += shipQty * unitPrice;
    totalReturnedAmount += returnedQty * unitPrice;
  });
  totalShipAmount = roundMoney_(totalShipAmount);
  totalReturnedAmount = roundMoney_(totalReturnedAmount);
  const totalNetAmount = roundMoney_(Math.max(0, totalShipAmount - totalReturnedAmount));
  return {
    item_count: (items || []).length,
    total_ship_qty: totalShip,
    total_settled_qty: totalSettled,
    total_returned_qty: totalReturned,
    remaining_qty: Math.max(0, totalShip - totalSettled - totalReturned),
    total_ship_amount: totalShipAmount,
    total_returned_amount: totalReturnedAmount,
    total_net_amount: totalNetAmount
  };
}

function emptySettledPack_() {
  return { settledAmount: 0, listAmount: 0, promoAllowance: 0 };
}

function emptyOpenArPack_() {
  return { open_ar_count: 0, ar_outstanding_amount: 0 };
}

/** 批次彙總多案結算金額與 AR 已收（固定次數查詢，勿 per-case N+1） */
async function batchAggSettledAndReceivedByCase_(sb, caseIds) {
  const settledByCase = {};
  const receivedByCase = {};
  const openArByCase = {};
  (caseIds || []).forEach((cid) => {
    settledByCase[cid] = emptySettledPack_();
    receivedByCase[cid] = 0;
    openArByCase[cid] = emptyOpenArPack_();
  });
  if (!caseIds || !caseIds.length) return { settledByCase, receivedByCase, openArByCase };

  const { data: stls, error: stlErr } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, case_id, ar_id, status")
    .in("case_id", caseIds);
  if (stlErr) return { settledByCase, receivedByCase, openArByCase };

  const posted = (stls || []).filter((s) => normId_(s.status) === "POSTED");
  const postedIds = posted.map((s) => normId_(s.settlement_id)).filter(Boolean);
  const stlToCase = {};
  posted.forEach((s) => {
    stlToCase[normId_(s.settlement_id)] = normId_(s.case_id);
  });

  if (postedIds.length) {
    const { data: stlItems, error: itemErr } = await sb
      .from("consignment_case_settlement_item")
      .select("settlement_id, settle_qty, list_unit_price, unit_price, amount")
      .in("settlement_id", postedIds);
    if (!itemErr && stlItems) {
      stlItems.forEach((it) => {
        const cid = stlToCase[normId_(it.settlement_id)];
        if (!cid || !settledByCase[cid]) return;
        const pack = settledByCase[cid];
        const settleQty = Number(it.settle_qty || 0);
        const listPrice = Number(it.list_unit_price != null ? it.list_unit_price : it.unit_price || 0);
        pack.listAmount += settleQty * listPrice;
        pack.settledAmount += Number(it.amount || 0);
      });
      caseIds.forEach((cid) => {
        const pack = settledByCase[cid];
        pack.listAmount = roundMoney_(pack.listAmount);
        pack.settledAmount = roundMoney_(pack.settledAmount);
        pack.promoAllowance = roundMoney_(Math.max(0, pack.listAmount - pack.settledAmount));
      });
    }
  }

  const arIdsPerCase = {};
  caseIds.forEach((cid) => {
    arIdsPerCase[cid] = new Set();
  });
  const arToCase = {};
  posted.forEach((s) => {
    const cid = normId_(s.case_id);
    if (!arIdsPerCase[cid]) return;
    let aid = String(s.ar_id || "").trim().toUpperCase();
    if (!aid) aid = "AR-STL-" + normId_(s.settlement_id);
    if (aid) {
      arIdsPerCase[cid].add(aid);
      arToCase[aid] = cid;
    }
  });

  const allArIds = [];
  caseIds.forEach((cid) => {
    (arIdsPerCase[cid] || new Set()).forEach((aid) => allArIds.push(aid));
  });
  const uniqArIds = [...new Set(allArIds)];
  if (uniqArIds.length) {
    const { data: ars } = await sb
      .from("ar_receivable")
      .select("ar_id, amount_received, amount_due, status")
      .in("ar_id", uniqArIds);
    const arAmount = {};
    (ars || []).forEach((a) => {
      arAmount[normId_(a.ar_id)] = Number(a.amount_received || 0);
    });
    caseIds.forEach((cid) => {
      let sum = 0;
      (arIdsPerCase[cid] || new Set()).forEach((aid) => {
        sum += arAmount[aid] || 0;
      });
      receivedByCase[cid] = roundMoney_(sum);
    });
    (ars || []).forEach((a) => {
      const aid = normId_(a.ar_id);
      const cid = arToCase[aid];
      if (!cid || !openArByCase[cid]) return;
      const st = normId_(a.status);
      if (st !== "OPEN" && st !== "PARTIAL") return;
      openArByCase[cid].open_ar_count += 1;
      openArByCase[cid].ar_outstanding_amount += Math.max(
        0,
        Number(a.amount_due || 0) - Number(a.amount_received || 0)
      );
    });
    caseIds.forEach((cid) => {
      openArByCase[cid].ar_outstanding_amount = roundMoney_(openArByCase[cid].ar_outstanding_amount);
    });
  }

  return { settledByCase, receivedByCase, openArByCase };
}

function buildEnrichedCaseRow_(caseRow, customerNameById, poolStats, settledPack, totalReceivedAmount, openArPack) {
  const c = caseRow;
  const arPack = openArPack || emptyOpenArPack_();
  const totalSettledListAmount = settledPack.listAmount;
  const totalNetAmount = poolStats.total_net_amount;
  const totalShipAmount = poolStats.total_ship_amount;
  let settleProgressPct = 0;
  if (totalNetAmount > 1e-9) {
    settleProgressPct = Math.round((totalSettledListAmount / totalNetAmount) * 1000) / 10;
  } else if (totalShipAmount > 1e-9) {
    settleProgressPct = Math.round((totalSettledListAmount / totalShipAmount) * 1000) / 10;
  }

  return Object.assign({}, c, {
    customer_name: customerNameById[normId_(c.customer_id)] || "",
    item_count: poolStats.item_count,
    total_ship_qty: poolStats.total_ship_qty,
    total_settled_qty: poolStats.total_settled_qty,
    total_returned_qty: poolStats.total_returned_qty,
    remaining_qty: poolStats.remaining_qty,
    total_ship_amount: poolStats.total_ship_amount,
    total_settled_amount: settledPack.settledAmount,
    total_settled_list_amount: totalSettledListAmount,
    total_promo_allowance: settledPack.promoAllowance,
    total_returned_amount: poolStats.total_returned_amount,
    total_net_amount: totalNetAmount,
    total_received_amount: totalReceivedAmount,
    settle_progress_pct: settleProgressPct,
    open_ar_count: Number(arPack.open_ar_count || 0),
    ar_outstanding_amount: Number(arPack.ar_outstanding_amount || 0)
  });
}

function normId_(v) {
  return String(v || "").trim().toUpperCase();
}

function normLot_(v) {
  return String(v || "").trim().toUpperCase();
}

function poolItemUnsoldQty_(row) {
  const ship = Number(row?.ship_qty || 0);
  const settled = Number(row?.settled_qty || 0);
  const returned = Number(row?.returned_qty || 0);
  return Math.max(0, ship - settled - returned);
}

const POOL_CONFLICT_MSG_ = "ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.";

async function updatePoolItemSettledQtyOptimistic_(sb, poolItem, addQty, actor, ts) {
  const pid = normId_(poolItem?.pool_item_id);
  const oldSettled = Number(poolItem?.settled_qty || 0);
  const oldReturned = Number(poolItem?.returned_qty || 0);
  const ship = Number(poolItem?.ship_qty || 0);
  const add = Number(addQty || 0);
  if (!pid) return fail("pool_item_id required");
  if (!(add > 0)) return fail("settle_qty must be > 0");
  const nextSettled = oldSettled + add;
  if (nextSettled + oldReturned - 1e-9 > ship) {
    return fail(
      "settle_qty exceeds unsold remaining for " + pid + " (remaining " + poolItemUnsoldQty_(poolItem) + ")"
    );
  }
  const { data, error } = await sb
    .from("consignment_case_pool_item")
    .update({ settled_qty: nextSettled, updated_by: actor, updated_at: ts })
    .eq("pool_item_id", pid)
    .eq("settled_qty", oldSettled)
    .eq("returned_qty", oldReturned)
    .select("pool_item_id");
  if (error) return fail(error.message || String(error));
  if (!data || data.length !== 1) return fail(POOL_CONFLICT_MSG_);
  return ok({ pool_item_id: pid });
}

async function updatePoolItemReturnedQtyOptimistic_(sb, poolItem, addQty, actor, ts) {
  const pid = normId_(poolItem?.pool_item_id);
  const oldSettled = Number(poolItem?.settled_qty || 0);
  const oldReturned = Number(poolItem?.returned_qty || 0);
  const ship = Number(poolItem?.ship_qty || 0);
  const add = Number(addQty || 0);
  if (!pid) return fail("pool_item_id required");
  if (!(add > 0)) return fail("return_qty must be > 0");
  const nextReturned = oldReturned + add;
  if (oldSettled + nextReturned - 1e-9 > ship) {
    return fail(
      "return_qty exceeds unsold remaining for " + pid + " (remaining " + poolItemUnsoldQty_(poolItem) + ")"
    );
  }
  const { data, error } = await sb
    .from("consignment_case_pool_item")
    .update({ returned_qty: nextReturned, updated_by: actor, updated_at: ts })
    .eq("pool_item_id", pid)
    .eq("settled_qty", oldSettled)
    .eq("returned_qty", oldReturned)
    .select("pool_item_id");
  if (error) return fail(error.message || String(error));
  if (!data || data.length !== 1) return fail(POOL_CONFLICT_MSG_);
  return ok({ pool_item_id: pid });
}

async function revertPoolItemSettledQtyOptimistic_(sb, poolItem, subtractQty, actor, ts) {
  const pid = normId_(poolItem?.pool_item_id);
  const oldSettled = Number(poolItem?.settled_qty || 0);
  const oldReturned = Number(poolItem?.returned_qty || 0);
  const ship = Number(poolItem?.ship_qty || 0);
  const sub = Number(subtractQty || 0);
  if (!pid) return fail("pool_item_id required");
  if (!(sub > 0)) return fail("settle_qty must be > 0");
  const nextSettled = oldSettled - sub;
  if (nextSettled < -1e-9) {
    return fail("Cannot revert more settled qty than recorded for " + pid);
  }
  if (nextSettled + oldReturned - 1e-9 > ship) {
    return fail("Revert would exceed ship qty for " + pid);
  }
  const { data, error } = await sb
    .from("consignment_case_pool_item")
    .update({ settled_qty: nextSettled, updated_by: actor, updated_at: ts })
    .eq("pool_item_id", pid)
    .eq("settled_qty", oldSettled)
    .eq("returned_qty", oldReturned)
    .select("pool_item_id");
  if (error) return fail(error.message || String(error));
  if (!data || data.length !== 1) return fail(POOL_CONFLICT_MSG_);
  return ok({ pool_item_id: pid });
}

async function callCcVoidRpc_(sb, rpcName, params) {
  const { data, error } = await sb.rpc(rpcName, params);
  if (error) {
    const msg = String(error.message || error);
    if (/could not find the function|schema cache|42883|function .* does not exist/i.test(msg)) {
      return { success: false, rpcMissing: true, errors: [msg] };
    }
    return fail(msg);
  }
  if (data && data.ok === false) return fail(String(data.error || "RPC failed"));
  return ok(data || {});
}

async function rollbackCancelSettlementDraft_(sb, settlementId, poolReverts, actor, ts) {
  for (let i = 0; i < (poolReverts || []).length; i++) {
    const rev = poolReverts[i] || {};
    const pid = normId_(rev.pool_item_id);
    const qty = Number(rev.settle_qty || 0);
    if (!pid || !(qty > 0)) continue;
    const { data: fresh } = await sb.from("consignment_case_pool_item").select("*").eq("pool_item_id", pid).maybeSingle();
    if (!fresh) continue;
    await updatePoolItemSettledQtyOptimistic_(sb, fresh, qty, actor, ts || nowIso());
  }
  const sid = normId_(settlementId);
  if (sid) {
    await sb
      .from("consignment_case_settlement")
      .update({ status: "POSTED", updated_by: actor || "", updated_at: ts || nowIso() })
      .eq("settlement_id", sid)
      .eq("status", "VOID");
  }
}

function sessionHasModule_(session, modKey) {
  const mods = String(session?.allowed_modules || "").trim();
  if (!mods || mods === "*") return true;
  const key = String(modKey || "").trim().toLowerCase();
  return mods
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(key);
}

function requireConsignmentListSession_(p) {
  const tok = String(p.session_token || "").trim();
  if (!tok) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  const sess = readSessionValid(tok);
  if (!sess) return fail("Permission denied", "ERR_PERMISSION_DENIED");
  if (!sessionHasModule_(sess, "consignment")) {
    return fail("Permission denied: consignment module", "ERR_PERMISSION_DENIED");
  }
  return null;
}

async function rollbackArDraftFromFailedCaseSettlement_(sb, settlementId, arId, actor, ts) {
  const sid = normId_(settlementId);
  const aid = normId_(arId || (sid ? "AR-STL-" + sid : ""));
  if (!aid) return;

  const voidRes = await voidArForCancelledCaseSettlement_(
    sb,
    aid,
    "結算過帳失敗自動回滾",
    actor || "",
    ts || nowIso()
  );
  if (!(voidRes && voidRes.success === false)) return;

  const { data: ar } = await sb.from("ar_receivable").select("ar_id, amount_received").eq("ar_id", aid).maybeSingle();
  if (!ar) return;
  if (Number(ar.amount_received || 0) > 1e-9) return;

  await sb.from("ar_amount_adjustment_log").delete().eq("ar_id", aid);
  await sb.from("ar_receivable").delete().eq("ar_id", aid);
}

async function rollbackCaseSettlementDraft_(sb, settlementId, poolReverts, actor, ts, arId) {
  try {
    const sid = normId_(settlementId);
    if (!sid) return;

    await rollbackArDraftFromFailedCaseSettlement_(sb, sid, arId, actor, ts);

    for (let i = 0; i < (poolReverts || []).length; i++) {
      const rev = poolReverts[i] || {};
      const pid = normId_(rev.pool_item_id);
      if (!pid) continue;
      await sb
        .from("consignment_case_pool_item")
        .update({
          settled_qty: Number(rev.settled_qty || 0),
          updated_by: actor || "",
          updated_at: ts || nowIso()
        })
        .eq("pool_item_id", pid);
    }
    await sb.from("consignment_case_settlement_item").delete().eq("settlement_id", sid);
    await sb.from("consignment_case_settlement").delete().eq("settlement_id", sid);
  } catch (rbErr) {
    console.error("[rollbackCaseSettlementDraft_]", rbErr);
  }
}

function bundleErrMessage_(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (Array.isArray(err.errors) && err.errors.length) return String(err.errors[0]);
  if (err.message) return String(err.message);
  if (err.code && err.details) return String(err.code) + ": " + String(err.details);
  return String(err);
}

function isMissingDealerSettlementColumnErr_(err) {
  const msg = bundleErrMessage_(err);
  return /dealer_cumulative|could not find the .*column|column.*does not exist/i.test(msg);
}

async function insertCaseSettlementHeader_(sb, payload) {
  const { error } = await sb.from("consignment_case_settlement").insert(payload);
  if (!error) return { ok: true };
  if (!isMissingDealerSettlementColumnErr_(error)) return { ok: false, error };

  const stripped = Object.assign({}, payload);
  delete stripped.dealer_cumulative_tier_label;
  delete stripped.dealer_cumulative_price_rate;
  delete stripped.dealer_cumulative_price_source;
  const { error: err2 } = await sb.from("consignment_case_settlement").insert(stripped);
  if (err2) return { ok: false, error: err2 };
  return { ok: true, dealer_snapshot_omitted: true };
}

async function revertReturnMovementBalances_(sb, returnId, actor, ts) {
  const rid = normId_(returnId);
  if (!rid) return;
  const { data: mvs } = await sb
    .from("inventory_movement")
    .select("movement_id, lot_id, qty")
    .eq("ref_type", "CONSIGNMENT_CASE_RETURN")
    .eq("ref_id", rid);
  for (let i = 0; i < (mvs || []).length; i++) {
    const mv = mvs[i] || {};
    const lotId = normId_(mv.lot_id);
    const qty = Number(mv.qty || 0);
    if (!lotId || !qty) continue;
    try {
      await applyLotBalanceDelta_(lotId, -qty, String(mv.movement_id || ""), actor || "");
    } catch (_eBal) {}
  }
}

async function deleteReturnCreatedLots_(sb, returnId, createdLotIds) {
  const rid = normId_(returnId);
  const ids = [...new Set((createdLotIds || []).map(normId_).filter(Boolean))];
  for (let i = 0; i < ids.length; i++) {
    const lotId = ids[i];
    const { data: lot } = await sb.from("lot").select("lot_id, source_type, source_id").eq("lot_id", lotId).maybeSingle();
    if (!lot) continue;
    if (normId_(lot.source_type) !== "CONSIGNMENT_CASE_RETURN" || normId_(lot.source_id) !== rid) continue;
    await sb.from("lot_balance").delete().eq("lot_id", lotId);
    await sb.from("lot").delete().eq("lot_id", lotId);
  }
}

async function rollbackCaseReturnDraft_(sb, returnId, draftReverts, actor, ts) {
  const rid = normId_(returnId);
  if (!rid) return;

  const poolReverts = Array.isArray(draftReverts) ? draftReverts : draftReverts?.poolReverts || [];
  const createdLotIds = Array.isArray(draftReverts) ? [] : draftReverts?.createdLotIds || [];

  await revertReturnMovementBalances_(sb, rid, actor, ts);
  await sb.from("inventory_movement").delete().eq("ref_type", "CONSIGNMENT_CASE_RETURN").eq("ref_id", rid);
  await deleteReturnCreatedLots_(sb, rid, createdLotIds);
  await sb.from("consignment_case_return_item").delete().eq("return_id", rid);
  await sb.from("consignment_case_return").delete().eq("return_id", rid);
  for (let i = 0; i < (poolReverts || []).length; i++) {
    const rev = poolReverts[i] || {};
    const pid = normId_(rev.pool_item_id);
    if (!pid) continue;
    const patch = {
      updated_by: actor || "",
      updated_at: ts || nowIso()
    };
    patch.returned_qty = Number(rev.returned_qty != null ? rev.returned_qty : 0);
    await sb.from("consignment_case_pool_item").update(patch).eq("pool_item_id", pid);
  }
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

function sortPoolRowsForReturn_(rows) {
  const list = (rows || []).slice();
  list.sort((a, b) => {
    const da = String(a.ship_date || "");
    const db = String(b.ship_date || "");
    if (da !== db) return da.localeCompare(db);
    return String(a.pool_item_id || "").localeCompare(String(b.pool_item_id || ""));
  });
  return list;
}

function allocateReturnByPoolItem_(lineReq, poolAll, pendingGlobal) {
  const poolItemId = normId_(lineReq.pool_item_id);
  const qtyLeft = Number(lineReq.return_qty || 0);
  if (!poolItemId) return fail("pool_item_id required");
  if (!(qtyLeft > 0)) return fail("return_qty must be > 0");

  const row = (poolAll || []).find((r) => normId_(r.pool_item_id) === poolItemId);
  if (!row) return fail("Pool item not found: " + poolItemId);

  const unsold = poolItemUnsoldQty_(row);
  const pending = Number(pendingGlobal[poolItemId] || 0);
  const avail = Math.max(0, unsold - pending);
  if (qtyLeft - 1e-9 > avail) {
    return fail("return_qty exceeds unsold remaining for " + poolItemId + " (remaining " + avail + ")");
  }

  pendingGlobal[poolItemId] = pending + qtyLeft;
  const displayLot = normLot_(row.factory_lot) || normId_(row.lot_id) || poolItemId;
  return ok({
    factory_lot: displayLot,
    product_id: normId_(row.product_id),
    return_qty: qtyLeft,
    allocations: [
      {
        alloc_mode: "unsold",
        pool_item_id: poolItemId,
        shipment_id: normId_(row.shipment_id),
        shipment_item_id: normId_(row.shipment_item_id),
        so_item_id: normId_(row.so_item_id),
        product_id: normId_(row.product_id),
        lot_id: normId_(row.lot_id),
        warehouse_id: normId_(row.warehouse_id || "MAIN") || "MAIN",
        ship_date: String(row.ship_date || ""),
        unit_price: Number(row.unit_price || 0),
        unit: String(row.unit || "").trim(),
        qty: qtyLeft
      }
    ]
  });
}

function allocateReturnLine_(lineReq, poolAll, caseRow, pendingGlobal, filterUnitPrice, returnReason) {
  const reason = normId_(returnReason);
  if (!isUnsoldPoolReturnReason_(reason)) {
    return fail("return_reason not supported: " + reason);
  }

  const poolItemId = normId_(lineReq.pool_item_id || "");
  if (poolItemId) {
    return allocateReturnByPoolItem_(lineReq, poolAll, pendingGlobal);
  }

  const factoryLot = normLot_(lineReq.factory_lot);
  const productId = normId_(lineReq.product_id || "");
  let qtyLeft = Number(lineReq.return_qty || 0);
  if (!factoryLot) return fail("factory_lot or pool_item_id required");
  if (!(qtyLeft > 0)) return fail("return_qty must be > 0");

  let poolRows = (poolAll || []).filter((row) => normLot_(row.factory_lot) === factoryLot);
  if (productId) {
    poolRows = poolRows.filter((row) => normId_(row.product_id) === productId);
  }
  if (!poolRows.length) {
    return fail("No pool item matches factory LOT: " + factoryLot);
  }

  poolRows = sortPoolRowsForReturn_(poolRows);

  const lineAlloc = [];
  for (let i = 0; i < poolRows.length && qtyLeft > 1e-9; i++) {
    const row = poolRows[i];
    const pid = normId_(row.pool_item_id);
    const unsold = poolItemUnsoldQty_(row);
    const pending = Number(pendingGlobal[pid] || 0);
    const avail = Math.max(0, unsold - pending);
    if (avail <= 1e-9) continue;
    const take = Math.min(avail, qtyLeft);
    pendingGlobal[pid] = pending + take;
    qtyLeft = roundMoney_(qtyLeft - take);
    lineAlloc.push({
      alloc_mode: "unsold",
      pool_item_id: pid,
      shipment_id: normId_(row.shipment_id),
      shipment_item_id: normId_(row.shipment_item_id),
      so_item_id: normId_(row.so_item_id),
      product_id: normId_(row.product_id),
      lot_id: normId_(row.lot_id),
      warehouse_id: normId_(row.warehouse_id || "MAIN") || "MAIN",
      ship_date: String(row.ship_date || ""),
      unit_price: Number(row.unit_price || 0),
      unit: String(row.unit || "").trim(),
      qty: take
    });
  }

  if (qtyLeft > 1e-9) {
    return fail(
      "return_qty exceeds unsold remaining for factory LOT " + factoryLot + " (short " + roundMoney_(qtyLeft) + ")"
    );
  }

  return ok({
    factory_lot: factoryLot,
    product_id: productId,
    return_qty: Number(lineReq.return_qty || 0),
    allocations: lineAlloc
  });
}

/** 收回倉 ≠ Lot 主檔倉別時，在新倉建立 Lot（比照轉倉），避免庫存異動與倉庫庫存對不上 */
async function resolveReturnLotAtWarehouse_(sb, sourceLot, returnWarehouseId, qty, actor, ts, returnId, caseId) {
  const srcLotId = normId_(sourceLot.lot_id);
  const retWh = normId_(returnWarehouseId);
  const srcWh = normId_(sourceLot.warehouse_id || "MAIN") || "MAIN";
  if (!retWh || retWh === srcWh) {
    return ok({ lot_id: srcLotId, lot: sourceLot, created: false });
  }

  const newLotId = buildId_("LOT");
  const { error: lotInsErr } = await insertLot_({
    lot_id: newLotId,
    product_id: String(sourceLot.product_id || ""),
    warehouse_id: retWh,
    source_type: "CONSIGNMENT_CASE_RETURN",
    source_id: returnId,
    qty: Number(qty || 0),
    unit: String(sourceLot.unit || ""),
    type: String(sourceLot.type || ""),
    status: String(sourceLot.status || "APPROVED"),
    inventory_status: "ACTIVE",
    received_date: String(ts || nowIso()).slice(0, 10),
    manufacture_date: sourceLot.manufacture_date || null,
    expiry_date: sourceLot.expiry_date || null,
    factory_lot: normLot_(sourceLot.factory_lot || "") || null,
    remark: "",
    created_by: actor,
    created_at: ts || nowIso(),
    system_remark:
      "Consignment return " +
      returnId +
      " from " +
      srcLotId +
      " (" +
      srcWh +
      " -> " +
      retWh +
      ", case " +
      normId_(caseId) +
      ")"
  });
  if (lotInsErr) return fail(lotInsErr.message || String(lotInsErr));

  const { data: newLot, error: loadErr } = await sb.from("lot").select("*").eq("lot_id", newLotId).maybeSingle();
  if (loadErr) return fail(loadErr.message || String(loadErr));
  if (!newLot) return fail("Failed to load return lot: " + newLotId);

  return ok({ lot_id: newLotId, lot: newLot, created: true, from_lot_id: srcLotId });
}

async function computeCaseReturnPlan_(sb, caseRow, header, items) {
  const { data: poolRaw, error: poolErr } = await sb
    .from("consignment_case_pool_item")
    .select("*")
    .eq("case_id", caseRow.case_id);
  if (poolErr) return fail(poolErr.message || String(poolErr));

  let poolAll;
  try {
    poolAll = await enrichPoolItemsWithLotMeta_(sb, poolRaw || []);
  } catch (lotErr) {
    return fail(lotErr.message || String(lotErr));
  }

  const pendingGlobal = {};
  const lines = [];
  const flatAlloc = [];

  for (let i = 0; i < items.length; i++) {
    const lineRes = allocateReturnLine_(items[i], poolAll, caseRow, pendingGlobal, header.filter_unit_price, header.return_reason);
    if (lineRes.success === false) return lineRes;
    const line = {
      factory_lot: lineRes.factory_lot,
      product_id: lineRes.product_id,
      return_qty: lineRes.return_qty,
      allocations: lineRes.allocations || []
    };
    lines.push(line);
    line.allocations.forEach((a) => flatAlloc.push(a));
  }

  const returnWh = normId_(header.return_warehouse_id);
  let requiresRemark = false;
  for (let j = 0; j < flatAlloc.length; j++) {
    const a = flatAlloc[j];
    if (returnWh && a.warehouse_id && returnWh !== a.warehouse_id) {
      requiresRemark = true;
      break;
    }
  }

  return ok({
    case_id: normId_(caseRow.case_id),
    return_reason: normId_(header.return_reason),
    alloc_mode: "unsold",
    return_date: String(header.return_date || "").trim(),
    return_warehouse_id: returnWh,
    filter_unit_price: header.filter_unit_price != null ? roundMoney_(header.filter_unit_price) : null,
    lines,
    allocations: flatAlloc,
    requires_remark: requiresRemark
  });
}

async function refreshConsignmentCaseStatus_(sb, caseId, actor) {
  const cid = normId_(caseId);
  const { data: poolItems, error } = await sb.from("consignment_case_pool_item").select("*").eq("case_id", cid);
  if (error) return fail(error.message || String(error));

  let allDone = true;
  (poolItems || []).forEach((row) => {
    if (poolItemUnsoldQty_(row) > 1e-9) allDone = false;
  });

  const { data: ccase } = await sb.from("consignment_case").select("status").eq("case_id", cid).maybeSingle();
  const curStatus = normId_(ccase?.status);

  if (allDone && (poolItems || []).length > 0) {
    if (curStatus !== "CLOSED") {
      await sb
        .from("consignment_case")
        .update({
          status: "CLOSED",
          close_date: String(new Date().toISOString().slice(0, 10)),
          updated_by: actor || "",
          updated_at: nowIso()
        })
        .eq("case_id", cid);
    }
  } else if (curStatus === "CLOSED" && (poolItems || []).length > 0) {
    await sb
      .from("consignment_case")
      .update({
        status: "OPEN",
        close_date: null,
        updated_by: actor || "",
        updated_at: nowIso()
      })
      .eq("case_id", cid);
  }
  return ok({ case_id: cid, all_done: allDone });
}

async function createConsignmentCaseBundle(p) {
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: consignment case");

  const caseId = normId_(p.case_id) || buildShortMasterId_("CC");
  const customerId = normId_(p.customer_id);
  if (!customerId) return fail("customer_id required");

  const openDate = String(p.open_date || "").trim() || String(new Date().toISOString().slice(0, 10));
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const { data: cust, error: custErr } = await sb.from("customer").select("*").eq("customer_id", customerId).maybeSingle();
  if (custErr) return fail(custErr.message || String(custErr));
  if (!cust) return fail("Customer not found: " + customerId);

  const { data: existed } = await sb.from("consignment_case").select("case_id").eq("case_id", caseId).maybeSingle();
  if (existed) return fail("Consignment case already exists: " + caseId);

  const policy = "FIFO";
  const ts = nowIso();

  const { error: insErr } = await sb.from("consignment_case").insert({
    case_id: caseId,
    customer_id: customerId,
    status: "OPEN",
    allocation_policy: policy,
    open_date: openDate,
    close_date: null,
    remark: String(p.remark || ""),
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null
  });
  if (insErr) return fail(insErr.message || String(insErr));

  await writeAuditLog_(
    "consignment_case",
    caseId,
    "BUNDLE_CREATE_CONSIGNMENT_CASE",
    actor,
    JSON.stringify({ case_id: caseId, customer_id: customerId, allocation_policy: policy })
  );

  return ok({ message: "CREATED", case_id: caseId, allocation_policy: policy });
}

async function listConsignmentCaseEnriched_(p) {
  const gate = requireConsignmentListSession_(p);
  if (gate) return gate;

  const sb = getSupabase();
  const statusFilter = normId_(p.status || "");
  const caseIdFilter = normId_(p.case_id || "");
  let q = sb.from("consignment_case").select("*").order("open_date", { ascending: false }).order("created_at", { ascending: false }).limit(Number(p.limit || 500));
  if (caseIdFilter) q = q.eq("case_id", caseIdFilter);
  else if (statusFilter && statusFilter !== "ALL") q = q.eq("status", statusFilter);
  const customerFilter = normId_(p.customer_id || "");
  if (customerFilter) q = q.eq("customer_id", customerFilter);

  const { data: cases, error } = await q;
  if (error) return fail(error.message || String(error));

  const caseList = cases || [];
  const caseIds = caseList.map((c) => normId_(c.case_id)).filter(Boolean);
  if (!caseIds.length) return ok({ data: [], source: "supabase" });

  const customerIds = [...new Set(caseList.map((c) => normId_(c.customer_id)).filter(Boolean))];
  const customerNameById = {};
  if (customerIds.length) {
    const { data: custRows, error: custErr } = await sb
      .from("customer")
      .select("customer_id, customer_name")
      .in("customer_id", customerIds);
    if (custErr) return fail(custErr.message || String(custErr));
    (custRows || []).forEach((row) => {
      const k = normId_(row.customer_id);
      if (k) customerNameById[k] = String(row.customer_name || "").trim();
    });
  }

  const poolByCase = {};
  caseIds.forEach((cid) => {
    poolByCase[cid] = [];
  });

  const [poolRes, aggPack] = await Promise.all([
    sb.from("consignment_case_pool_item").select("*").in("case_id", caseIds),
    batchAggSettledAndReceivedByCase_(sb, caseIds)
  ]);
  if (poolRes.error) return fail(poolRes.error.message || String(poolRes.error));

  (poolRes.data || []).forEach((it) => {
    const cid = normId_(it.case_id);
    if (!poolByCase[cid]) poolByCase[cid] = [];
    poolByCase[cid].push(it);
  });

  const { settledByCase, receivedByCase, openArByCase } = aggPack;

  const out = caseList.map((c) => {
    const cid = normId_(c.case_id);
    const poolStats = aggPoolStatsFromItems_(poolByCase[cid] || []);
    const settledPack = settledByCase[cid] || emptySettledPack_();
    const totalReceivedAmount = receivedByCase[cid] || 0;
    const openArPack = openArByCase[cid] || emptyOpenArPack_();
    return buildEnrichedCaseRow_(c, customerNameById, poolStats, settledPack, totalReceivedAmount, openArPack);
  });
  return ok({ data: out, source: "supabase" });
}

/** 下拉／選案用：僅案件主檔 + 客戶名稱（不含 pool／結算／AR 彙總） */
async function listConsignmentCaseLite_(p) {
  const gate = requireConsignmentListSession_(p);
  if (gate) return gate;

  const sb = getSupabase();
  const statusFilter = normId_(p.status || "");
  const caseIdFilter = normId_(p.case_id || "");
  let q = sb.from("consignment_case").select("*").order("open_date", { ascending: false }).order("created_at", { ascending: false }).limit(Number(p.limit || 500));
  if (caseIdFilter) q = q.eq("case_id", caseIdFilter);
  else if (statusFilter && statusFilter !== "ALL") q = q.eq("status", statusFilter);
  const customerFilter = normId_(p.customer_id || "");
  if (customerFilter) q = q.eq("customer_id", customerFilter);

  const { data: cases, error } = await q;
  if (error) return fail(error.message || String(error));

  const caseList = cases || [];
  const customerIds = [...new Set(caseList.map((c) => normId_(c.customer_id)).filter(Boolean))];
  const customerNameById = {};
  if (customerIds.length) {
    const { data: custRows, error: custErr } = await sb
      .from("customer")
      .select("customer_id, customer_name")
      .in("customer_id", customerIds);
    if (custErr) return fail(custErr.message || String(custErr));
    (custRows || []).forEach((row) => {
      const k = normId_(row.customer_id);
      if (k) customerNameById[k] = String(row.customer_name || "").trim();
    });
  }

  const out = caseList.map((c) =>
    Object.assign({}, c, {
      customer_name: customerNameById[normId_(c.customer_id)] || ""
    })
  );
  return ok({ data: out, source: "supabase" });
}

async function enrichPoolItemsWithLotMeta_(sb, items) {
  const lotIds = [...new Set((items || []).map((r) => String(r.lot_id || "").trim()).filter(Boolean))];
  const lotMetaById = {};
  if (lotIds.length) {
    const { data: lots, error } = await sb.from("lot").select("lot_id, factory_lot, expiry_date").in("lot_id", lotIds);
    if (error) throw error;
    (lots || []).forEach((lot) => {
      const lid = String(lot.lot_id || "").trim();
      if (lid) {
        lotMetaById[lid] = {
          factory_lot: normLot_(lot.factory_lot),
          expiry_date: String(lot.expiry_date || "").trim() || null
        };
      }
    });
  }
  return (items || []).map((row) => {
    const poolFl = normLot_(row.factory_lot);
    const lotMeta = lotMetaById[String(row.lot_id || "").trim()] || {};
    const lotFl = lotMeta.factory_lot || "";
    return Object.assign({}, row, {
      factory_lot: poolFl || lotFl,
      expiry_date: lotMeta.expiry_date || null
    });
  });
}

async function listConsignmentCasePoolByCase_(p) {
  const gate = requireConsignmentListSession_(p);
  if (gate) return gate;
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");

  const sb = getSupabase();
  const { data: items, error } = await sb
    .from("consignment_case_pool_item")
    .select("*")
    .eq("case_id", caseId)
    .order("ship_date", { ascending: true })
    .order("pool_item_id", { ascending: true });
  if (error) return fail(error.message || String(error));

  let withLot;
  try {
    withLot = await enrichPoolItemsWithLotMeta_(sb, items || []);
  } catch (lotErr) {
    return fail(lotErr.message || String(lotErr));
  }

  const enriched = withLot.map((row) => {
    const unsold = poolItemUnsoldQty_(row);
    return Object.assign({}, row, {
      returned_qty: Number(row.returned_qty || 0),
      remaining_qty: unsold,
      unsold_qty: unsold,
      settled_avail_qty: poolItemSettledAvailQty_(row)
    });
  });
  return ok({ data: enriched, source: "supabase" });
}

async function listConsignmentCaseSettlementByCase_(p) {
  const gate = requireConsignmentListSession_(p);
  if (gate) return gate;
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");
  const sb = getSupabase();
  const { data, error } = await sb
    .from("consignment_case_settlement")
    .select("*")
    .eq("case_id", caseId)
    .order("settlement_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return fail(error.message || String(error));

  const settlements = data || [];
  const stlIds = settlements.map((s) => normId_(s.settlement_id)).filter(Boolean);
  if (!stlIds.length) return ok({ data: [], source: "supabase" });

  const { data: items, error: itemErr } = await sb
    .from("consignment_case_settlement_item")
    .select("*")
    .in("settlement_id", stlIds)
    .order("settlement_item_id", { ascending: true });
  if (itemErr) return fail(itemErr.message || String(itemErr));

  const poolIds = [...new Set((items || []).map((r) => String(r.pool_item_id || "").trim()).filter(Boolean))];
  const legacySchemeIds = [
    ...new Set(
      (items || [])
        .filter((r) => normId_(r.promo_scheme_id) && !String(r.promo_scheme_name || "").trim())
        .map((r) => normId_(r.promo_scheme_id))
    )
  ];
  const legacySchemeNameById = {};
  if (legacySchemeIds.length) {
    const { data: legacySchemes } = await sb
      .from("consignment_promo_scheme")
      .select("scheme_id, scheme_name")
      .in("scheme_id", legacySchemeIds);
    (legacySchemes || []).forEach((s) => {
      const sid = normId_(s.scheme_id);
      if (sid) legacySchemeNameById[sid] = String(s.scheme_name || sid);
    });
  }
  const poolMap = {};
  const lotMetaById = {};
  if (poolIds.length) {
    const { data: pools } = await sb
      .from("consignment_case_pool_item")
      .select("pool_item_id, factory_lot, ship_date, lot_id")
      .in("pool_item_id", poolIds);
    const lotIds = [...new Set((pools || []).map((p) => String(p.lot_id || "").trim()).filter(Boolean))];
    if (lotIds.length) {
      const { data: lots } = await sb.from("lot").select("lot_id, factory_lot").in("lot_id", lotIds);
      (lots || []).forEach((lot) => {
        const lid = String(lot.lot_id || "").trim();
        if (lid) lotMetaById[lid] = { factory_lot: normLot_(lot.factory_lot) };
      });
    }
    (pools || []).forEach((pool) => {
      const pid = normId_(pool.pool_item_id);
      if (!pid) return;
      const poolFl = normLot_(pool.factory_lot || "");
      const lotFl = lotMetaById[String(pool.lot_id || "").trim()]?.factory_lot || "";
      poolMap[pid] = Object.assign({}, pool, {
        factory_lot: poolFl || lotFl
      });
    });
  }

  const itemsByStl = {};
  (items || []).forEach((row) => {
    const sid = normId_(row.settlement_id);
    if (!sid) return;
    if (!itemsByStl[sid]) itemsByStl[sid] = [];
    const pool = poolMap[normId_(row.pool_item_id)] || {};
    const legacyName = legacySchemeNameById[normId_(row.promo_scheme_id)] || "";
    itemsByStl[sid].push(
      Object.assign({}, row, {
        factory_lot: normLot_(pool.factory_lot || ""),
        ship_date: pool.ship_date || null,
        promo_scheme_name: String(row.promo_scheme_name || "").trim() || legacyName
      })
    );
  });

  const enriched = settlements.map((s) =>
    Object.assign({}, s, {
      items: itemsByStl[normId_(s.settlement_id)] || []
    })
  );
  return ok({ data: enriched, source: "supabase" });
}

async function listConsignmentCaseReturnByCase_(p) {
  const gate = requireConsignmentListSession_(p);
  if (gate) return gate;
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");
  const sb = getSupabase();
  const { data, error } = await sb
    .from("consignment_case_return")
    .select("*")
    .eq("case_id", caseId)
    .order("return_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return fail(error.message || String(error));

  const returns = data || [];
  const retIds = returns.map((r) => normId_(r.return_id)).filter(Boolean);
  if (!retIds.length) return ok({ data: [], source: "supabase" });

  const { data: items, error: itemErr } = await sb
    .from("consignment_case_return_item")
    .select("*")
    .in("return_id", retIds)
    .order("return_item_id", { ascending: true });
  if (itemErr) return fail(itemErr.message || String(itemErr));

  const poolIds = [...new Set((items || []).map((r) => String(r.pool_item_id || "").trim()).filter(Boolean))];
  const poolMap = {};
  if (poolIds.length) {
    const { data: pools } = await sb
      .from("consignment_case_pool_item")
      .select("pool_item_id, factory_lot, lot_id, ship_date, warehouse_id")
      .in("pool_item_id", poolIds);
    let enrichedPools = [];
    try {
      enrichedPools = await enrichPoolItemsWithLotMeta_(sb, pools || []);
    } catch (_e) {
      enrichedPools = pools || [];
    }
    enrichedPools.forEach((pool) => {
      const pid = normId_(pool.pool_item_id);
      if (pid) poolMap[pid] = pool;
    });
  }

  const itemsByRet = {};
  (items || []).forEach((row) => {
    const rid = normId_(row.return_id);
    if (!rid) return;
    if (!itemsByRet[rid]) itemsByRet[rid] = [];
    const pool = poolMap[normId_(row.pool_item_id)] || {};
    const poolFl = normLot_(pool.factory_lot || "");
    const rowFl = normLot_(row.factory_lot || "");
    itemsByRet[rid].push(
      Object.assign({}, row, {
        factory_lot: rowFl || poolFl,
        ship_date: pool.ship_date || null,
        ship_warehouse_id: String(pool.warehouse_id || "").trim(),
        unit_price: Number(row.recognized_unit_price != null ? row.recognized_unit_price : 0)
      })
    );
  });

  const enriched = returns.map((r) =>
    Object.assign({}, r, {
      items: itemsByRet[normId_(r.return_id)] || []
    })
  );
  return ok({ data: enriched, source: "supabase" });
}

async function addConsignmentCasePoolFromShipment_(ctx) {
  const { sb, caseId, shipmentId, soId, customerId, txId, shipDate, actor, ts } = ctx;
  const cid = normId_(caseId);
  if (!cid) return fail("consignment_case_id required for consignment shipment");

  const { data: ccase, error: caseErr } = await sb.from("consignment_case").select("*").eq("case_id", cid).maybeSingle();
  if (caseErr) return fail(caseErr.message || String(caseErr));
  if (!ccase) return fail("Consignment case not found: " + cid);
  if (normId_(ccase.status) === "CLOSED") return fail("Consignment case is CLOSED");
  if (normId_(ccase.customer_id) !== normId_(customerId)) {
    return fail("Shipment customer does not match consignment case customer");
  }

  const { data: shipItems, error: siLoadErr } = await sb
    .from("shipment_item")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("shipment_item_id", { ascending: true });
  if (siLoadErr) return fail(siLoadErr.message || String(siLoadErr));
  if (!shipItems || !shipItems.length) return fail("Shipment items not found for consignment case pool");

  const { count: existedCount } = await sb
    .from("consignment_case_pool_item")
    .select("*", { count: "exact", head: true })
    .eq("shipment_id", shipmentId);
  if ((existedCount || 0) > 0) {
    return ok({ case_id: cid, shipment_id: shipmentId, skipped: true });
  }

  const soItemIds = shipItems.map((it) => normId_(it.so_item_id)).filter(Boolean);
  const soItemMap = await loadSoItemsMap_(sb, soItemIds);

  for (let i = 0; i < shipItems.length; i++) {
    const it = shipItems[i] || {};
    const shipmentItemId = normId_(it.shipment_item_id);
    const soItemId = normId_(it.so_item_id);
    const soItem = soItemMap[soItemId] || {};
    const lotId = normId_(it.lot_id);
    let factoryLot = "";
    let warehouseId = "MAIN";
    if (lotId) {
      const { data: lot } = await sb.from("lot").select("factory_lot, warehouse_id").eq("lot_id", lotId).maybeSingle();
      factoryLot = normLot_(lot?.factory_lot || "");
      warehouseId = normId_(lot?.warehouse_id || "MAIN") || "MAIN";
    }
    const poolItemId = cid + "-PL-" + shipmentId + "-" + String(i + 1).padStart(3, "0");

    const { error: piErr } = await sb.from("consignment_case_pool_item").insert({
      pool_item_id: poolItemId,
      case_id: cid,
      shipment_id: shipmentId,
      shipment_item_id: shipmentItemId,
      so_id: normId_(it.so_id || soId),
      so_item_id: soItemId,
      product_id: normId_(it.product_id || soItem.product_id),
      lot_id: lotId,
      factory_lot: factoryLot,
      warehouse_id: warehouseId,
      ship_qty: Number(it.ship_qty || 0),
      settled_qty: 0,
      returned_qty: 0,
      unit: String(it.unit || soItem.unit || "").trim(),
      unit_price: Number(soItem.unit_price || 0),
      ship_date: shipDate,
      transaction_id: txId,
      remark: "",
      created_by: actor,
      created_at: ts || nowIso(),
      updated_by: "",
      updated_at: null
    });
    if (piErr) return fail(piErr.message || String(piErr));
  }

  await sb
    .from("shipment")
    .update({ consignment_case_id: cid, updated_by: actor, updated_at: nowIso() })
    .eq("shipment_id", shipmentId);

  await writeAuditLog_(
    "consignment_case_pool_item",
    cid,
    "BUNDLE_ADD_CASE_POOL_FROM_SHIPMENT",
    actor,
    JSON.stringify({ case_id: cid, shipment_id: shipmentId, item_count: shipItems.length })
  );

  return ok({ case_id: cid, shipment_id: shipmentId, item_count: shipItems.length });
}

async function postConsignmentCaseSettlementBundle(p) {
  try {
    return await postConsignmentCaseSettlementBundleCore_(p);
  } catch (outerErr) {
    console.error("[post_consignment_case_settlement_bundle]", outerErr);
    return fail(bundleErrMessage_(outerErr));
  }
}

async function postConsignmentCaseSettlementBundleCore_(p) {
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");

  const settlementId = normId_(p.settlement_id) || buildShortDocId_("CS");
  const settlementDate = String(p.settlement_date || "").trim();
  if (!settlementDate) return fail("settlement_date required");

  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: consignment settlement");

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("Settlement items required");

  const sb = getSupabase();
  const { data: ccase, error: caseErr } = await sb.from("consignment_case").select("*").eq("case_id", caseId).maybeSingle();
  if (caseErr) return fail(caseErr.message || String(caseErr));
  if (!ccase) return fail("Consignment case not found: " + caseId);
  if (normId_(ccase.status) === "CLOSED") return fail("Consignment case is CLOSED");

  const { data: existedStl } = await sb
    .from("consignment_case_settlement")
    .select("*")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (existedStl) {
    if (normId_(existedStl.status) === "POSTED" && normId_(existedStl.case_id) === caseId) {
      return ok({
        message: "SETTLED",
        settlement_id: settlementId,
        case_id: caseId,
        ar_id: String(existedStl.ar_id || "").trim(),
        amount_system: Number(existedStl.amount_system || 0),
        idempotent: true
      });
    }
    return fail("Settlement already exists: " + settlementId);
  }

  const customerId = normId_(ccase.customer_id);
  const txId = String(p.transaction_id || "").trim() || buildId_("TX");

  const { data: poolItems } = await sb.from("consignment_case_pool_item").select("*").eq("case_id", caseId);
  const poolMap = {};
  (poolItems || []).forEach((row) => {
    poolMap[normId_(row.pool_item_id)] = row;
  });

  const settledDelta = {};
  let firstSoId = "";
  let firstShipmentId = "";
  let currency = "USD";

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const poolItemId = normId_(it.pool_item_id);
    if (!poolItemId) return fail("pool_item_id required (items[" + i + "])");

    const poolItem = poolMap[poolItemId];
    if (!poolItem) return fail("Pool item not found: " + poolItemId);

    const qty = Number(it.settle_qty || 0);
    if (!(qty > 0)) return fail("settle_qty must be > 0 (items[" + i + "])");

    const unsold = poolItemUnsoldQty_(poolItem);
    const pending = settledDelta[poolItemId] || 0;
    if (qty + pending - 1e-9 > unsold) {
      return fail("settle_qty exceeds unsold remaining for " + poolItemId + " (remaining " + unsold + ")");
    }

    if (!firstSoId) firstSoId = normId_(poolItem.so_id);
    if (!firstShipmentId) firstShipmentId = normId_(poolItem.shipment_id);

    settledDelta[poolItemId] = pending + qty;
  }

  let promoOverrides = {};
  if (p.promo_overrides_json) {
    try {
      const raw = typeof p.promo_overrides_json === "string" ? JSON.parse(p.promo_overrides_json) : p.promo_overrides_json;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        Object.keys(raw).forEach((k) => {
          promoOverrides[normId_(k)] = normId_(raw[k]);
        });
      }
    } catch (_e) {
      return fail("promo_overrides_json invalid");
    }
  }

  let schemePacks = [];
  try {
    schemePacks = await loadPromoSchemesForCase_(sb, caseId, customerId, settlementDate);
  } catch (promoErr) {
    return fail(promoErr?.message || String(promoErr));
  }

  const computedItems = computeSettlementPromoLines_(items, poolMap, schemePacks, promoOverrides);
  let dealerCtx = { enabled: false };
  try {
    dealerCtx = await resolveCumulativeDealerPriceForSettlement_(sb, customerId, settlementDate);
  } catch (dealerErr) {
    return fail(dealerErr?.message || String(dealerErr));
  }
  const pricedItems = applyCumulativeDealerPriceToLines_(computedItems, dealerCtx);
  const computedMap = {};
  pricedItems.forEach((row) => {
    computedMap[normId_(row.pool_item_id)] = row;
  });

  let amountSystem = 0;
  for (let i = 0; i < items.length; i++) {
    const poolItemId = normId_(items[i]?.pool_item_id);
    const comp = computedMap[poolItemId];
    if (!comp) return fail("Promo compute failed for " + poolItemId);
    amountSystem += roundMoney_(Number(comp.amount || 0));
  }
  amountSystem = roundMoney_(amountSystem);

  if (firstSoId) {
    const { data: soRow } = await sb.from("sales_order").select("currency").eq("so_id", firstSoId).maybeSingle();
    currency = String(soRow?.currency || "USD").trim().toUpperCase() || "USD";
  }

  const ts = nowIso();
  const poolReverts = [];
  let arIdDraft = "";

  try {
    const stlIns = await insertCaseSettlementHeader_(sb, {
      settlement_id: settlementId,
      case_id: caseId,
      customer_id: customerId,
      transaction_id: txId,
      settlement_date: settlementDate,
      amount_system: amountSystem,
      ar_id: "",
      status: "POSTED",
      remark: String(p.remark || ""),
      dealer_cumulative_tier_label: dealerCtx.enabled ? String(dealerCtx.tier_label || "") : "",
      dealer_cumulative_price_rate: dealerCtx.enabled ? Number(dealerCtx.price_rate) : null,
      dealer_cumulative_price_source: dealerCtx.enabled ? String(dealerCtx.price_source || "CURRENT") : "",
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null
    });
    if (!stlIns.ok) throw stlIns.error;

    for (let j = 0; j < items.length; j++) {
      const it = items[j] || {};
      const poolItemId = normId_(it.pool_item_id);
      const poolItem = poolMap[poolItemId];
      const comp = computedMap[poolItemId] || {};
      const qty = Number(comp.settle_qty != null ? comp.settle_qty : it.settle_qty || 0);
      const unitPrice = Number(comp.settle_unit_price != null ? comp.settle_unit_price : poolItem.unit_price || 0);
      const stlItemId = settlementId + "-IT-" + String(j + 1).padStart(3, "0");

      const { error: siErr } = await sb.from("consignment_case_settlement_item").insert({
        settlement_item_id: stlItemId,
        settlement_id: settlementId,
        pool_item_id: poolItemId,
        shipment_item_id: normId_(poolItem.shipment_item_id),
        so_item_id: normId_(poolItem.so_item_id),
        product_id: normId_(poolItem.product_id),
        settle_qty: qty,
        billable_qty: Number(comp.billable_qty != null ? comp.billable_qty : qty),
        free_qty: Number(comp.free_qty || 0),
        unit: String(poolItem.unit || ""),
        list_unit_price: Number(comp.list_unit_price != null ? comp.list_unit_price : poolItem.unit_price || 0),
        settle_unit_price: unitPrice,
        unit_price: unitPrice,
        amount: roundMoney_(Number(comp.amount != null ? comp.amount : unitPrice * qty)),
        promo_scheme_id: String(comp.promo_scheme_id || ""),
        promo_type: String(comp.promo_type || ""),
        promo_scheme_name: String(comp.promo_scheme_name || ""),
        promo_discount_pct: comp.promo_discount_pct != null ? Number(comp.promo_discount_pct) : null,
        promo_buy_qty: comp.promo_buy_qty != null ? Number(comp.promo_buy_qty) : null,
        promo_scheme_free_qty: comp.promo_scheme_free_qty != null ? Number(comp.promo_scheme_free_qty) : null,
        remark: String(it.remark || ""),
        created_by: actor,
        created_at: ts,
        updated_by: "",
        updated_at: null
      });
      if (siErr) throw siErr;
    }

    const poolItemIds = Object.keys(settledDelta);
    for (let k = 0; k < poolItemIds.length; k++) {
      const pid = poolItemIds[k];
      const { data: freshPool, error: loadErr } = await sb
        .from("consignment_case_pool_item")
        .select("*")
        .eq("pool_item_id", pid)
        .maybeSingle();
      if (loadErr) throw loadErr;
      if (!freshPool) throw new Error("Pool item not found: " + pid);
      poolReverts.push({ pool_item_id: pid, settled_qty: Number(freshPool.settled_qty || 0) });
      const updRes = await updatePoolItemSettledQtyOptimistic_(sb, freshPool, settledDelta[pid], actor, ts);
      if (updRes.success === false) throw updRes;
    }

    const arRes = await createArFromCaseSettlement_({
      sb,
      settlementId,
      caseId,
      customerId,
      txId,
      settlementDate,
      amountSystem,
      currency,
      soId: firstSoId,
      shipmentId: firstShipmentId,
      actor,
      ts
    });
    if (arRes && arRes.success === false) throw arRes;

    arIdDraft = String(arRes?.ar_id || "AR-STL-" + settlementId).trim().toUpperCase();
    const arId = arIdDraft;
    const { error: arLinkErr } = await sb
      .from("consignment_case_settlement")
      .update({ ar_id: arId, updated_by: actor, updated_at: ts })
      .eq("settlement_id", settlementId);
    if (arLinkErr) throw arLinkErr;

    let dealerCreditApplied = 0;
    const creditRes = await applyDealerCreditAtSettlement_({
      sb,
      settlementId,
      arId,
      customerId,
      settlementDate,
      actor,
      session: p._session,
      ts
    });
    if (creditRes && creditRes.err) {
      await refreshConsignmentCaseStatus_(sb, caseId, actor);
      await writeAuditLog_(
        "consignment_case_settlement",
        settlementId,
        "BUNDLE_POST_CONSIGNMENT_CASE_SETTLEMENT",
        actor,
        JSON.stringify({
          settlement_id: settlementId,
          case_id: caseId,
          ar_id: arId,
          amount_system: amountSystem,
          dealer_credit_applied: 0,
          dealer_credit_warning: String(creditRes.err)
        })
      );
      return ok({
        message: "SETTLED",
        settlement_id: settlementId,
        case_id: caseId,
        ar_id: arId,
        amount_system: amountSystem,
        dealer_credit_applied: 0,
        dealer_credit_warning: String(creditRes.err)
      });
    }
    dealerCreditApplied = roundMoney_(Number(creditRes && creditRes.credit_applied) || 0);
    const dealerCreditInfo =
      creditRes && creditRes.credit_deferred && creditRes.defer_reason
        ? String(creditRes.defer_reason).trim()
        : "";

    await refreshConsignmentCaseStatus_(sb, caseId, actor);

    await writeAuditLog_(
      "consignment_case_settlement",
      settlementId,
      "BUNDLE_POST_CONSIGNMENT_CASE_SETTLEMENT",
      actor,
      JSON.stringify({
        settlement_id: settlementId,
        case_id: caseId,
        ar_id: arId,
        amount_system: amountSystem,
        dealer_credit_applied: dealerCreditApplied,
        dealer_credit_info: dealerCreditInfo
      })
    );

    return ok({
      message: "SETTLED",
      settlement_id: settlementId,
      case_id: caseId,
      ar_id: arId,
      amount_system: amountSystem,
      dealer_credit_applied: dealerCreditApplied,
      dealer_credit_info: dealerCreditInfo
    });
  } catch (err) {
    try {
      await rollbackCaseSettlementDraft_(sb, settlementId, poolReverts, actor, ts, arIdDraft);
    } catch (_rbOuter) {}
    if (err && err.success === false) return err;
    return fail(bundleErrMessage_(err));
  }
}

async function previewConsignmentCaseReturnBundle(p) {
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: consignment return preview");

  const returnReason = normId_(p.return_reason);
  if (!RETURN_REASONS_[returnReason]) {
    return fail("return_reason not supported: " + returnReason);
  }

  const returnDate = String(p.return_date || "").trim();
  if (!returnDate) return fail("return_date required");

  const returnWarehouseId = normId_(p.return_warehouse_id);
  if (!returnWarehouseId) return fail("return_warehouse_id required");

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("Return items required");

  const sb = getSupabase();
  const { data: ccase, error: caseErr } = await sb.from("consignment_case").select("*").eq("case_id", caseId).maybeSingle();
  if (caseErr) return fail(caseErr.message || String(caseErr));
  if (!ccase) return fail("Consignment case not found: " + caseId);
  if (normId_(ccase.status) === "CLOSED") return fail("Consignment case is CLOSED");

  const planRes = await computeCaseReturnPlan_(sb, ccase, {
    return_reason: returnReason,
    return_date: returnDate,
    return_warehouse_id: returnWarehouseId,
    filter_unit_price: p.filter_unit_price
  }, items);
  if (planRes.success === false) return planRes;

  return ok(Object.assign({ preview: true, message: "PREVIEW" }, planRes));
}

async function postConsignmentCaseReturnBundle(p) {
  const caseId = normId_(p.case_id);
  if (!caseId) return fail("case_id required");

  const returnId = normId_(p.return_id) || buildShortDocId_("CR");
  const returnReason = normId_(p.return_reason);
  if (!RETURN_REASONS_[returnReason]) {
    return fail("return_reason not supported: " + returnReason);
  }

  const returnDate = String(p.return_date || "").trim();
  if (!returnDate) return fail("return_date required");

  const returnWarehouseId = normId_(p.return_warehouse_id);
  if (!returnWarehouseId) return fail("return_warehouse_id required");

  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: consignment return");

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("Return items required");

  const sb = getSupabase();
  const { data: ccase, error: caseErr } = await sb.from("consignment_case").select("*").eq("case_id", caseId).maybeSingle();
  if (caseErr) return fail(caseErr.message || String(caseErr));
  if (!ccase) return fail("Consignment case not found: " + caseId);
  if (normId_(ccase.status) === "CLOSED") return fail("Consignment case is CLOSED");

  const planRes = await computeCaseReturnPlan_(sb, ccase, {
    return_reason: returnReason,
    return_date: returnDate,
    return_warehouse_id: returnWarehouseId,
    filter_unit_price: p.filter_unit_price
  }, items);
  if (planRes.success === false) return planRes;

  const remark = String(p.remark || "").trim();
  if (returnReason === "OTHER" && !remark) {
    return fail("remark required when return reason is OTHER");
  }
  if (planRes.requires_remark && !remark) {
    return fail("remark required when return warehouse differs from original ship warehouse");
  }

  const { data: existedRet } = await sb.from("consignment_case_return").select("*").eq("return_id", returnId).maybeSingle();
  if (existedRet) {
    if (normId_(existedRet.status) === "POSTED" && normId_(existedRet.case_id) === caseId) {
      return ok({
        message: "RETURNED",
        return_id: returnId,
        case_id: caseId,
        idempotent: true
      });
    }
    return fail("Return already exists: " + returnId);
  }

  const customerId = normId_(ccase.customer_id);
  const txId = String(p.transaction_id || "").trim() || buildId_("TX");
  const ts = nowIso();
  const filterPrice =
    p.filter_unit_price != null && String(p.filter_unit_price).trim() !== ""
      ? roundMoney_(p.filter_unit_price)
      : null;

  const poolReverts = [];
  const returnDraftReverts_ = { poolReverts: poolReverts, createdLotIds: [] };
  let lineIdx = 0;

  try {
    const { error: retInsErr } = await sb.from("consignment_case_return").insert({
      return_id: returnId,
      case_id: caseId,
      customer_id: customerId,
      transaction_id: txId,
      return_reason: returnReason,
      return_date: returnDate,
      return_warehouse_id: returnWarehouseId,
      filter_unit_price: filterPrice,
      status: "POSTED",
      remark: remark,
      created_by: actor,
      created_at: ts,
      updated_by: "",
      updated_at: null
    });
    if (retInsErr) throw retInsErr;

    const poolDelta = {};

    for (let li = 0; li < (planRes.lines || []).length; li++) {
      const line = planRes.lines[li];
      for (let ai = 0; ai < (line.allocations || []).length; ai++) {
        const alloc = line.allocations[ai];
        lineIdx += 1;
        const retItemId = returnId + "-IT-" + String(lineIdx).padStart(3, "0");
        const poolItemId = normId_(alloc.pool_item_id);
        const qty = Number(alloc.qty || 0);
        const lotId = normId_(alloc.lot_id);
        if (!lotId) throw new Error("Lot not found for pool item: " + poolItemId);

        const { data: lot, error: lotErr } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
        if (lotErr) throw lotErr;
        if (!lot) throw new Error("Lot not found: " + lotId);

        const lotRes = await resolveReturnLotAtWarehouse_(sb, lot, returnWarehouseId, qty, actor, ts, returnId, caseId);
        if (lotRes.success === false) throw lotRes;
        const targetLotId = normId_(lotRes.lot_id);
        const targetLot = lotRes.lot || lot;
        if (lotRes.created) returnDraftReverts_.createdLotIds.push(targetLotId);

        const productId = normId_(alloc.product_id || targetLot.product_id);
        const unit = String(alloc.unit || targetLot.unit || "").trim();

        const { error: riErr } = await sb.from("consignment_case_return_item").insert({
          return_item_id: retItemId,
          return_id: returnId,
          factory_lot: normLot_(line.factory_lot),
          product_id: productId,
          return_qty: qty,
          pool_item_id: poolItemId,
          shipment_item_id: normId_(alloc.shipment_item_id),
          so_item_id: normId_(alloc.so_item_id),
          lot_id: targetLotId,
          recognized_unit_price: Number(alloc.unit_price || 0),
          unit: unit,
          remark: String(items[li]?.remark || ""),
          created_by: actor,
          created_at: ts,
          updated_by: "",
          updated_at: null
        });
        if (riErr) throw riErr;

        const mvId = buildId_("MV");
        const mvRes = await createInventoryMovementUnlocked_({
          movement_id: mvId,
          movement_type: "IN",
          lot_id: targetLotId,
          product_id: productId,
          warehouse_id: returnWarehouseId,
          transaction_id: txId,
          parent_ref_type: "CONSIGNMENT_CASE_RETURN",
          parent_ref_id: returnId,
          qty: Math.abs(qty),
          unit: unit,
          ref_type: "CONSIGNMENT_CASE_RETURN",
          ref_id: returnId,
          issued_to: "",
          remark: remark,
          created_by: actor,
          created_at: ts,
          system_remark:
            "Consignment case return IN: " +
            returnId +
            " (" +
            caseId +
            ")" +
            (lotRes.created ? " new lot from " + lotId : "")
        });
        if (mvRes && mvRes.success === false) throw mvRes;

        poolDelta[poolItemId] = (poolDelta[poolItemId] || 0) + qty;
      }
    }

    const { data: poolItems } = await sb.from("consignment_case_pool_item").select("*").eq("case_id", caseId);
    const poolMap = {};
    (poolItems || []).forEach((row) => {
      poolMap[normId_(row.pool_item_id)] = row;
    });

    const poolIds = Object.keys(poolDelta);
    for (let k = 0; k < poolIds.length; k++) {
      const pid = poolIds[k];
      const poolItem = poolMap[pid];
      if (!poolItem) throw new Error("Pool item not found: " + pid);
      poolReverts.push({ pool_item_id: pid, returned_qty: Number(poolItem.returned_qty || 0) });
      const updRes = await updatePoolItemReturnedQtyOptimistic_(sb, poolItem, poolDelta[pid], actor, ts);
      if (updRes.success === false) throw updRes;
    }

    await refreshConsignmentCaseStatus_(sb, caseId, actor);

    await writeAuditLog_(
      "consignment_case_return",
      returnId,
      "BUNDLE_POST_CONSIGNMENT_CASE_RETURN",
      actor,
      JSON.stringify({ return_id: returnId, case_id: caseId, item_count: lineIdx })
    );

    return ok({
      message: "RETURNED",
      return_id: returnId,
      case_id: caseId
    });
  } catch (err) {
    await rollbackCaseReturnDraft_(sb, returnId, returnDraftReverts_, actor, ts);
    if (err && err.success === false) return err;
    return fail(err?.message || String(err));
  }
}

async function cancelConsignmentCaseSettlementBundle(p) {
  const settlementId = normId_(p.settlement_id);
  if (!settlementId) return fail("settlement_id required");

  const voidReason = String(p.void_reason || p.reason || p.remark || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: cancel consignment settlement");

  const sb = getSupabase();
  const ts = nowIso();

  const { data: stlPre, error: stlPreErr } = await sb
    .from("consignment_case_settlement")
    .select("settlement_id, status, customer_id, settlement_date, case_id")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (stlPreErr) return fail(stlPreErr.message || String(stlPreErr));
  if (!stlPre) return fail("Settlement not found: " + settlementId);
  if (normId_(stlPre.status) === "VOID") {
    return ok({
      message: "ALREADY_VOID",
      settlement_id: settlementId,
      case_id: normId_(stlPre.case_id),
      idempotent: true
    });
  }
  if (normId_(stlPre.status) !== "POSTED") return fail("Settlement cannot be voided: " + settlementId);

  try {
    const rebateBlock = await assertNoLockedDealerRebateForSettlementVoid_(sb, {
      customerId: stlPre.customer_id,
      settlementDate: stlPre.settlement_date,
      caseId: stlPre.case_id
    });
    if (rebateBlock && rebateBlock.err) return fail(rebateBlock.err);
  } catch (e) {
    return fail(e?.message || String(e));
  }

  const rpcRes = await callCcVoidRpc_(sb, "erp_cc_void_settlement_tx", {
    p_settlement_id: settlementId,
    p_void_reason: voidReason,
    p_actor: actor,
    p_ts: ts
  });
  if (rpcRes.rpcMissing) {
    return cancelConsignmentCaseSettlementBundleLegacy_(p, sb, ts, settlementId, voidReason, actor);
  }
  if (rpcRes.success === false) return rpcRes;

  const caseId = normId_(rpcRes.case_id || "");
  const arId = String(rpcRes.ar_id || "").trim().toUpperCase();

  if (!rpcRes.idempotent) {
    const { data: stlRow } = await sb
      .from("consignment_case_settlement")
      .select("customer_id, ar_id")
      .eq("settlement_id", settlementId)
      .maybeSingle();
    if (stlRow) {
      const restoreRes = await restoreDealerCreditOnSettlementVoid_({
        sb,
        settlementId,
        arId: String(stlRow.ar_id || arId || "").trim().toUpperCase(),
        customerId: normId_(stlRow.customer_id),
        actor,
        ts
      });
      if (restoreRes && restoreRes.err) return fail(restoreRes.err);
    }

    const custId = normId_(stlPre.customer_id);
    if (custId) {
      try {
        await recalculateCustomerCumulativeFromPostedRebates_(sb, custId, actor, ts);
      } catch (recalcErr) {
        console.error("[cancel_consignment_settlement] cumulative recalc", recalcErr);
      }
    }

    await writeAuditLog_(
      "consignment_case_settlement",
      settlementId,
      "BUNDLE_CANCEL_CONSIGNMENT_CASE_SETTLEMENT",
      actor,
      JSON.stringify({
        settlement_id: settlementId,
        case_id: caseId,
        ar_id: arId,
        void_reason: voidReason,
        rpc: "erp_cc_void_settlement_tx"
      })
    );
  }

  return ok({
    message: rpcRes.message || "VOIDED",
    settlement_id: settlementId,
    case_id: caseId,
    ar_id: arId,
    idempotent: !!rpcRes.idempotent,
    rpc: true
  });
}

async function cancelConsignmentCaseSettlementBundleLegacy_(p, sb, ts, settlementId, voidReason, actor) {
  const { data: stl, error: stlErr } = await sb
    .from("consignment_case_settlement")
    .select("*")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (stlErr) return fail(stlErr.message || String(stlErr));
  if (!stl) return fail("Settlement not found: " + settlementId);

  const stlStatus = normId_(stl.status);
  if (stlStatus === "VOID") {
    return ok({ message: "ALREADY_VOID", settlement_id: settlementId, case_id: normId_(stl.case_id), idempotent: true });
  }
  if (stlStatus !== "POSTED") return fail("Settlement cannot be voided: " + settlementId);

  const caseId = normId_(stl.case_id);
  const arId = String(stl.ar_id || "AR-STL-" + settlementId).trim().toUpperCase();

  const { data: items, error: itemErr } = await sb
    .from("consignment_case_settlement_item")
    .select("*")
    .eq("settlement_id", settlementId);
  if (itemErr) return fail(itemErr.message || String(itemErr));

  const poolReverts = [];

  try {
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i] || {};
      const pid = normId_(it.pool_item_id);
      const qty = Number(it.settle_qty || 0);
      if (!pid || !(qty > 0)) continue;
      const { data: fresh, error: loadErr } = await sb
        .from("consignment_case_pool_item")
        .select("*")
        .eq("pool_item_id", pid)
        .maybeSingle();
      if (loadErr) throw loadErr;
      if (!fresh) throw new Error("Pool item not found: " + pid);
      poolReverts.push({ pool_item_id: pid, settle_qty: qty });
      const revRes = await revertPoolItemSettledQtyOptimistic_(sb, fresh, qty, actor, ts);
      if (revRes.success === false) throw revRes;
    }

    const { data: voidRows, error: voidStlErr } = await sb
      .from("consignment_case_settlement")
      .update({
        status: "VOID",
        system_remark: appendSystemRemark_(stl.system_remark, "[作廢 " + ts + "] " + voidReason),
        updated_by: actor,
        updated_at: ts
      })
      .eq("settlement_id", settlementId)
      .eq("status", "POSTED")
      .select("settlement_id");
    if (voidStlErr) throw voidStlErr;
    if (!voidRows || !voidRows.length) throw new Error("Settlement void update failed");

    const customerId = normId_(stl.customer_id);
    const restoreRes = await restoreDealerCreditOnSettlementVoid_({
      sb,
      settlementId,
      arId,
      customerId,
      actor,
      ts
    });
    if (restoreRes && restoreRes.err) throw new Error(restoreRes.err);

    const arRes = await voidArForCancelledCaseSettlement_(sb, arId, voidReason, actor, ts);
    if (arRes && arRes.success === false) throw arRes;

    await refreshConsignmentCaseStatus_(sb, caseId, actor);

    await writeAuditLog_(
      "consignment_case_settlement",
      settlementId,
      "BUNDLE_CANCEL_CONSIGNMENT_CASE_SETTLEMENT",
      actor,
      JSON.stringify({ settlement_id: settlementId, case_id: caseId, ar_id: arId, void_reason: voidReason, rpc: false })
    );

    return ok({
      message: "VOIDED",
      settlement_id: settlementId,
      case_id: caseId,
      ar_id: arId
    });
  } catch (err) {
    await rollbackCancelSettlementDraft_(sb, settlementId, poolReverts, actor, ts);
    if (err && err.success === false) return err;
    return fail(err?.message || String(err));
  }
}

async function cancelConsignmentCaseReturnBundleLegacy_(sb, ts, returnId, voidReason, actor) {
  const rid = normId_(returnId);
  const { data: ret, error: retErr } = await sb.from("consignment_case_return").select("*").eq("return_id", rid).maybeSingle();
  if (retErr) return fail(retErr.message || String(retErr));
  if (!ret) return fail("Return not found: " + rid);

  const st = normId_(ret.status);
  if (st === "VOID") {
    return ok({
      message: "ALREADY_VOID",
      return_id: rid,
      case_id: normId_(ret.case_id),
      idempotent: true,
      rpc: false
    });
  }
  if (st !== "POSTED") return fail("Return cannot be voided: " + rid);

  const { count: cancelCnt } = await sb
    .from("inventory_movement")
    .select("*", { count: "exact", head: true })
    .eq("ref_type", "CONSIGNMENT_CASE_RETURN_CANCEL")
    .eq("ref_id", rid);
  if ((cancelCnt || 0) > 0) return fail("Return already has cancel reversal movements");

  const caseId = normId_(ret.case_id);
  const adjRemark = String(voidReason || "").trim() || "作廢沖銷";

  const { data: retItems, error: itemErr } = await sb
    .from("consignment_case_return_item")
    .select("*")
    .eq("return_id", rid);
  if (itemErr) return fail(itemErr.message || String(itemErr));

  const poolDelta = {};

  try {
    for (let i = 0; i < (retItems || []).length; i++) {
      const item = retItems[i] || {};
      const qty = Math.abs(Number(item.return_qty || 0));
      if (qty <= 1e-9) continue;

      const lotId = normId_(item.lot_id);
      const pid = normId_(item.pool_item_id);

      const { data: inRows } = await sb
        .from("inventory_movement")
        .select("*")
        .eq("lot_id", lotId)
        .eq("movement_type", "IN")
        .eq("ref_type", "CONSIGNMENT_CASE_RETURN")
        .eq("ref_id", rid)
        .order("created_at", { ascending: true })
        .limit(1);
      const inMv = (inRows || [])[0];
      if (!inMv) throw new Error("IN movement not found for lot " + lotId + " (return " + rid + ")");

      const avail = Number((await sumMovementsForLot_(lotId)) || 0);
      if (avail + 1e-9 < qty) {
        return fail("Insufficient available qty for lot " + lotId + " (Cancel consignment return)");
      }

      const mvRes = await createInventoryMovementUnlocked_({
        movement_type: "ADJUST",
        lot_id: lotId,
        product_id: normId_(inMv.product_id || item.product_id),
        warehouse_id: normId_(inMv.warehouse_id || ret.return_warehouse_id),
        transaction_id: String(ret.transaction_id || inMv.transaction_id || "").trim(),
        parent_ref_type: "CONSIGNMENT_CASE_RETURN",
        parent_ref_id: rid,
        qty: -qty,
        unit: String(inMv.unit || item.unit || "").trim(),
        ref_type: "CONSIGNMENT_CASE_RETURN_CANCEL",
        ref_id: rid,
        issued_to: "",
        remark: adjRemark,
        created_by: actor,
        created_at: ts,
        system_remark: "REVERSAL(IN) of " + String(inMv.movement_id || "")
      });
      if (mvRes && mvRes.success === false) throw mvRes;

      if (pid) poolDelta[pid] = (poolDelta[pid] || 0) + qty;
    }

    const poolIds = Object.keys(poolDelta);
    for (let k = 0; k < poolIds.length; k++) {
      const pid = poolIds[k];
      const delta = poolDelta[pid];
      const { data: pool, error: poolErr } = await sb
        .from("consignment_case_pool_item")
        .select("*")
        .eq("pool_item_id", pid)
        .maybeSingle();
      if (poolErr) throw poolErr;
      if (!pool) throw new Error("Pool item not found: " + pid);

      const oldSettled = Number(pool.settled_qty || 0);
      const oldReturned = Number(pool.returned_qty || 0);

      if (oldReturned + 1e-9 < delta) {
        throw new Error("Cannot revert more returned qty than recorded for " + pid);
      }
      const { data: upd, error: updErr } = await sb
        .from("consignment_case_pool_item")
        .update({ returned_qty: oldReturned - delta, updated_by: actor, updated_at: ts })
        .eq("pool_item_id", pid)
        .eq("settled_qty", oldSettled)
        .eq("returned_qty", oldReturned)
        .select("pool_item_id");
      if (updErr) throw updErr;
      if (!upd || upd.length !== 1) throw new Error(POOL_CONFLICT_MSG_);
    }

    const sysRemark = appendSystemRemark_(ret.system_remark, "[作廢 " + ts + "] " + adjRemark);
    const { data: voidRows, error: voidErr } = await sb
      .from("consignment_case_return")
      .update({
        status: "VOID",
        system_remark: sysRemark,
        updated_by: actor,
        updated_at: ts
      })
      .eq("return_id", rid)
      .eq("status", "POSTED")
      .select("return_id");
    if (voidErr) throw voidErr;
    if (!voidRows || voidRows.length !== 1) throw new Error("Return void update failed");

    await refreshConsignmentCaseStatus_(sb, caseId, actor);

    await writeAuditLog_(
      "consignment_case_return",
      rid,
      "BUNDLE_CANCEL_CONSIGNMENT_CASE_RETURN",
      actor,
      JSON.stringify({
        return_id: rid,
        case_id: caseId,
        void_reason: adjRemark,
        rpc: false
      })
    );

    return ok({
      message: "VOIDED",
      return_id: rid,
      case_id: caseId,
      rpc: false
    });
  } catch (err) {
    if (err && err.success === false) return err;
    return fail(err?.message || String(err));
  }
}

async function cancelConsignmentCaseReturnBundle(p) {
  const returnId = normId_(p.return_id);
  if (!returnId) return fail("return_id required");

  const voidReason = String(p.void_reason || p.reason || p.remark || "").trim();
  if (!voidReason) return fail("void_reason required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");
  if (!canOperateConsignmentAr_(p._session)) return fail("Permission denied: cancel consignment return");

  const sb = getSupabase();
  const ts = nowIso();

  const rpcRes = await callCcVoidRpc_(sb, "erp_cc_void_return_tx", {
    p_return_id: returnId,
    p_void_reason: voidReason,
    p_actor: actor,
    p_ts: ts
  });
  if (rpcRes.rpcMissing) {
    return cancelConsignmentCaseReturnBundleLegacy_(sb, ts, returnId, voidReason, actor);
  }
  if (rpcRes.success === false) {
    return rpcRes;
  }

  const caseId = normId_(rpcRes.case_id || "");

  if (!rpcRes.idempotent) {
    await writeAuditLog_(
      "consignment_case_return",
      returnId,
      "BUNDLE_CANCEL_CONSIGNMENT_CASE_RETURN",
      actor,
      JSON.stringify({
        return_id: returnId,
        case_id: caseId,
        void_reason: voidReason,
        rpc: "erp_cc_void_return_tx"
      })
    );
  }

  return ok({
    message: rpcRes.message || "VOIDED",
    return_id: returnId,
    case_id: caseId,
    idempotent: !!rpcRes.idempotent,
    rpc: true
  });
}

/** v4.2 舊 CT 追蹤：出貨作廢前仍須檢查（表已 DROP 則略過） */
async function assertNoLegacyConsignmentTrackForShipmentCancel_(sb, shipmentId) {
  const trackId = "CT-" + normId_(shipmentId);
  const { data: track, error: trackErr } = await sb
    .from("consignment_track")
    .select("track_id, status")
    .eq("track_id", trackId)
    .maybeSingle();
  if (trackErr) {
    const em = String(trackErr.message || trackErr);
    if (/does not exist|42P01|schema cache/i.test(em)) return null;
    return fail(em);
  }
  if (!track) return null;

  const { count, error: stlErr } = await sb
    .from("consignment_settlement")
    .select("*", { count: "exact", head: true })
    .eq("track_id", trackId);
  if (stlErr) {
    const em = String(stlErr.message || stlErr);
    if (/does not exist|42P01|schema cache/i.test(em)) return null;
    return fail(em);
  }
  if ((count || 0) > 0) {
    return fail("ERR_CONSIGNMENT_SETTLED: Shipment has consignment settlements. Cannot cancel shipment.");
  }

  const { count: retCount, error: retErr } = await sb
    .from("consignment_return")
    .select("*", { count: "exact", head: true })
    .eq("track_id", trackId);
  if (retErr) {
    const em = String(retErr.message || retErr);
    if (/does not exist|42P01|schema cache/i.test(em)) return null;
    return fail(em);
  }
  if ((retCount || 0) > 0) {
    return fail("ERR_CONSIGNMENT_RETURNED: Shipment has consignment returns. Cannot cancel shipment.");
  }
  return trackId;
}

async function assertNoConsignmentForShipmentCancel_(sb, shipmentId) {
  const legacy = await assertNoLegacyConsignmentTrackForShipmentCancel_(sb, shipmentId);
  if (legacy && legacy.success === false) return legacy;
  return assertNoConsignmentCaseForShipmentCancel_(sb, shipmentId);
}

async function assertNoConsignmentCaseForShipmentCancel_(sb, shipmentId) {
  const sid = normId_(shipmentId);
  const { data: poolItems } = await sb.from("consignment_case_pool_item").select("*").eq("shipment_id", sid);
  if (!poolItems || !poolItems.length) return null;

  for (let i = 0; i < poolItems.length; i++) {
    const row = poolItems[i];
    if (Number(row.settled_qty || 0) > 1e-9) {
      return fail("ERR_CONSIGNMENT_CASE_SETTLED: Shipment has consignment case settlements. Cannot cancel shipment.");
    }
    if (Number(row.returned_qty || 0) > 1e-9) {
      return fail("ERR_CONSIGNMENT_CASE_RETURNED: Shipment has consignment case returns. Cannot cancel shipment.");
    }
  }

  const poolIds = poolItems.map((r) => normId_(r.pool_item_id)).filter(Boolean);
  if (poolIds.length) {
    const { data: stlItems } = await sb
      .from("consignment_case_settlement_item")
      .select("settlement_id, pool_item_id")
      .in("pool_item_id", poolIds);
    const stlIds = [...new Set((stlItems || []).map((r) => normId_(r.settlement_id)).filter(Boolean))];
    if (stlIds.length) {
      const { data: stls } = await sb.from("consignment_case_settlement").select("settlement_id, status").in("settlement_id", stlIds);
      const hasPosted = (stls || []).some((s) => normId_(s.status) === "POSTED");
      if (hasPosted) {
        return fail("ERR_CONSIGNMENT_CASE_SETTLED: Shipment has consignment case settlements. Cannot cancel shipment.");
      }
    }

    const { data: retItems } = await sb
      .from("consignment_case_return_item")
      .select("return_id, pool_item_id")
      .in("pool_item_id", poolIds);
    const retIds = [...new Set((retItems || []).map((r) => normId_(r.return_id)).filter(Boolean))];
    if (retIds.length) {
      const { data: rets } = await sb.from("consignment_case_return").select("return_id, status").in("return_id", retIds);
      const hasPostedRet = (rets || []).some((r) => normId_(r.status) === "POSTED");
      if (hasPostedRet) {
        return fail("ERR_CONSIGNMENT_CASE_RETURNED: Shipment has consignment case returns. Cannot cancel shipment.");
      }
    }
  }

  return poolItems[0]?.case_id || true;
}

/** 出貨作廢且無結算／收回時，自案件品項池移除該出貨單累加之列 */
async function removeConsignmentCasePoolFromShipmentCancel_(sb, shipmentId, actor) {
  const sid = normId_(shipmentId);
  if (!sid) return ok({ removed: 0 });

  const { data: poolItems, error: loadErr } = await sb
    .from("consignment_case_pool_item")
    .select("pool_item_id, case_id")
    .eq("shipment_id", sid);
  if (loadErr) return fail(loadErr.message || String(loadErr));
  if (!poolItems || !poolItems.length) return ok({ removed: 0 });

  const caseId = normId_(poolItems[0]?.case_id);
  const { error: delErr } = await sb.from("consignment_case_pool_item").delete().eq("shipment_id", sid);
  if (delErr) return fail(delErr.message || String(delErr));

  await writeAuditLog_(
    "consignment_case_pool_item",
    caseId || sid,
    "BUNDLE_REMOVE_CASE_POOL_FROM_SHIPMENT_CANCEL",
    actor,
    JSON.stringify({ case_id: caseId, shipment_id: sid, item_count: poolItems.length })
  );

  if (caseId) await refreshConsignmentCaseStatus_(sb, caseId, actor);

  return ok({ case_id: caseId, shipment_id: sid, removed: poolItems.length });
}

module.exports = {
  createConsignmentCaseBundle,
  listConsignmentCaseEnriched_,
  listConsignmentCaseLite_,
  listConsignmentCasePoolByCase_,
  listConsignmentCaseSettlementByCase_,
  listConsignmentCaseReturnByCase_,
  addConsignmentCasePoolFromShipment_,
  postConsignmentCaseSettlementBundle,
  cancelConsignmentCaseSettlementBundle,
  cancelConsignmentCaseReturnBundle,
  previewConsignmentCaseReturnBundle,
  postConsignmentCaseReturnBundle,
  assertNoConsignmentForShipmentCancel_,
  assertNoConsignmentCaseForShipmentCancel_,
  removeConsignmentCasePoolFromShipmentCancel_,
  poolItemUnsoldQty_
};
