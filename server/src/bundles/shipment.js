const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  timestamptzFromClient_,
  buildTxId,
  buildId_,
  parseJsonArray,
  appendSystemRemark_,
  writeAuditLog_,
  hasCancelMovement_
} = require("./shared");
const { createInventoryMovementUnlocked_ } = require("../inventory-movement-core");
const { ensureSalesOrderTx_, calcSalesOrderStatus_ } = require("./sales-order");
const { assertNoArForShipmentCancel_, voidArForCancelledShipment_ } = require("./ar");
const { createGeneralShipmentArWithCommercial_ } = require("./consignment-promo");
const {
  assertNoLockedDealerRebateForShipmentVoid_,
  assertNoPostedMonthlyStatForNewBilling_,
  reverseCumulativeOnGeneralShipmentVoid_,
  syncCustomerCumulativeFromSources_
} = require("./commercial-dealer");
const {
  addConsignmentCasePoolFromShipment_,
  assertNoConsignmentForShipmentCancel_,
  removeConsignmentCasePoolFromShipmentCancel_
} = require("./consignment-case");

async function postShipmentBundle(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const customerId = String(p.customer_id || "").trim().toUpperCase();
  if (!customerId) return fail("customer_id required");

  const shipDate = String(p.ship_date || "").trim();
  if (!shipDate) return fail("ship_date required");

  const shipperId = String(p.shipper_id || "").trim();
  if (!shipperId) return fail("shipper_id required");

  const soId = String(p.so_id || "").trim().toUpperCase();
  if (!soId) return fail("so_id required");

  const remark = String(p.remark || "");
  const recipientId = String(p.recipient_id || "").trim().toUpperCase();
  if (!recipientId) return fail("recipient_id required");

  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!actor) return fail("created_by required");

  const expectedItems = Number(p.expected_existed_shipment_item_count || 0);
  if (Number.isNaN(expectedItems)) return fail("expected_existed_shipment_item_count invalid");

  const parentRefType = String(p.parent_ref_type || "SO").trim().toUpperCase() || "SO";
  let parentRefId = String(p.parent_ref_id || "").trim().toUpperCase();
  if (parentRefType !== "SO" && parentRefType !== "SHIPMENT") {
    return fail("parent_ref_type must be SO or SHIPMENT");
  }

  const sb = getSupabase();

  if (parentRefType === "SO") {
    parentRefId = soId;
  } else {
    if (!parentRefId) return fail("parent_ref_id required when parent_ref_type=SHIPMENT");
    const { data: parentSh } = await sb.from("shipment").select("*").eq("shipment_id", parentRefId).maybeSingle();
    if (!parentSh) return fail("Parent shipment not found: " + parentRefId);
    const pst = String(parentSh.status || "").trim().toUpperCase();
    if (pst === "CANCELLED") return fail("Parent shipment is CANCELLED: " + parentRefId);
    if (String(parentSh.so_id || "").trim().toUpperCase() !== soId) {
      return fail("parent shipment so_id mismatch");
    }
  }

  const { data: existed } = await sb.from("shipment").select("*").eq("shipment_id", shipmentId).maybeSingle();
  if (existed) {
    const st = String(existed.status || "").toUpperCase();
    if (st === "POSTED") return fail("Shipment already POSTED");
    if (st === "CANCELLED") return fail("Shipment already CANCELLED");
    return fail("Shipment already exists");
  }

  const { count: existedItemCount } = await sb
    .from("shipment_item")
    .select("*", { count: "exact", head: true })
    .eq("shipment_id", shipmentId);
  if ((existedItemCount || 0) !== expectedItems) {
    return fail("Shipment items changed. Please reload and try again");
  }

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("Shipment items required");

  const plannedBySoItem = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const lotId = String(it.lot_id || "").trim().toUpperCase();
    if (!lotId) return fail("lot_id required (items[" + i + "])");
    const q = Number(it.ship_qty || 0);
    if (!(q > 0)) return fail("ship_qty must be > 0 (items[" + i + "])");
    const itemSoId = String(it.so_id || soId || "").trim().toUpperCase();
    const soItemId = String(it.so_item_id || "").trim().toUpperCase();
    if (!itemSoId) return fail("so_id required (items[" + i + "])");
    if (!soItemId) return fail("so_item_id required (items[" + i + "])");
    if (itemSoId !== soId) return fail("items[" + i + "].so_id must match shipment so_id");
    plannedBySoItem[soItemId] = (plannedBySoItem[soItemId] || 0) + q;
  }

  const plannedIds = Object.keys(plannedBySoItem);
  for (let k = 0; k < plannedIds.length; k++) {
    const soItemId = plannedIds[k];
    const { data: soItemRow, error: soItemErr } = await sb
      .from("sales_order_item")
      .select("*")
      .eq("so_item_id", soItemId)
      .maybeSingle();
    if (soItemErr) return fail(soItemErr.message || String(soItemErr));
    if (!soItemRow) return fail("Sales order item not found: " + soItemId);
    if (String(soItemRow.so_id || "").trim().toUpperCase() !== soId) {
      return fail("so_item_id does not belong to sales order: " + soItemId);
    }
    const orderQty = Number(soItemRow.order_qty || 0);
    const shippedQty = Number(soItemRow.shipped_qty || 0);
    const planned = Number(plannedBySoItem[soItemId] || 0);
    if (shippedQty + planned > orderQty + 1e-9) {
      return fail(
        "Ship qty exceeds sales order remaining (so_item_id=" +
          soItemId +
          ", order=" +
          orderQty +
          ", shipped=" +
          shippedQty +
          ", this_shipment=" +
          planned +
          ")"
      );
    }
  }

  const { data: recipient, error: recipErr } = await sb
    .from("customer_recipient")
    .select("*")
    .eq("recipient_id", recipientId)
    .maybeSingle();
  if (recipErr) return fail(recipErr.message || String(recipErr));
  if (!recipient) return fail("Recipient not found: " + recipientId);
  const recipSt = String(recipient.status || "").trim().toUpperCase();
  if (recipSt === "VOID") return fail("Recipient is VOID: " + recipientId);
  const recipCust = String(recipient.customer_id || "").trim().toUpperCase();
  if (recipCust !== customerId) return fail("Recipient does not belong to customer");

  const recipientName = String(p.recipient_name || recipient.recipient_name || "").trim();
  const recipientNameEn = String(p.recipient_name_en || recipient.recipient_name_en || "").trim();
  const recipientAddress = String(p.recipient_address || recipient.address || "").trim();
  const recipientPhone = String(p.recipient_phone || recipient.phone || "").trim();
  if (!recipientName && !recipientNameEn) return fail("recipient_name or recipient_name_en required");

  const { data: soTypeRow, error: soTypeErr } = await sb
    .from("sales_order")
    .select("so_type")
    .eq("so_id", soId)
    .maybeSingle();
  if (soTypeErr) return fail(soTypeErr.message || String(soTypeErr));
  const soTypePre = String(soTypeRow?.so_type || "NORMAL").trim().toUpperCase();
  if (soTypePre === "NORMAL") {
    const monthlyBlock = await assertNoPostedMonthlyStatForNewBilling_(sb, {
      customerId,
      shipDate
    });
    if (monthlyBlock?.err) return fail(monthlyBlock.err);
  }

  const txId = await ensureSalesOrderTx_(soId, actor);
  const ts = timestamptzFromClient_(p.created_at);
  const consignmentCaseId = String(p.consignment_case_id || "").trim().toUpperCase();

  const { error: shInsErr } = await sb.from("shipment").insert({
    shipment_id: shipmentId,
    so_id: soId,
    customer_id: customerId,
    shipper_id: shipperId,
    transaction_id: txId,
    parent_ref_type: parentRefType,
    parent_ref_id: parentRefId,
    ship_date: shipDate,
    status: "POSTED",
    remark: remark,
    recipient_id: recipientId,
    recipient_name: recipientName,
    recipient_name_en: recipientNameEn,
    recipient_address: recipientAddress,
    recipient_phone: recipientPhone,
    consignment_case_id: consignmentCaseId,
    created_by: actor,
    created_at: ts,
    updated_by: "",
    updated_at: null
  });
  if (shInsErr) return fail(shInsErr.message || String(shInsErr));

  const shippedDeltaBySoItem = {};
  const itemsWithShipmentItemId = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const lotId = String(it.lot_id || "").trim().toUpperCase();
    if (!lotId) return fail("lot_id required (items[" + i + "])");

    const q = Number(it.ship_qty || 0);
    if (!(q > 0)) return fail("ship_qty must be > 0 (items[" + i + "])");

    const itemSoId = String(it.so_id || soId || "").trim().toUpperCase();
    const soItemId = String(it.so_item_id || "").trim().toUpperCase();
    if (!itemSoId) return fail("so_id required (items[" + i + "])");
    if (!soItemId) return fail("so_item_id required (items[" + i + "])");
    if (itemSoId !== soId) return fail("items[" + i + "].so_id must match shipment so_id");

    const { data: lot, error: lotErr } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
    if (lotErr) return fail(lotErr.message || String(lotErr));
    if (!lot) return fail("Lot not found: " + lotId);

    const unit = String(it.unit || lot.unit || "").trim();
    const productId = String(it.product_id || lot.product_id || "").trim().toUpperCase();
    const shiId = "SHI-" + shipmentId + "-" + String(i + 1).padStart(3, "0");

    const { error: siErr } = await sb.from("shipment_item").insert({
      shipment_item_id: shiId,
      shipment_id: shipmentId,
      so_id: itemSoId,
      so_item_id: soItemId,
      lot_id: lotId,
      product_id: productId,
      transaction_id: txId,
      parent_ref_type: "SHIPMENT",
      parent_ref_id: shipmentId,
      ship_qty: q,
      unit: unit,
      remark: String(it.remark || ""),
      created_by: actor,
      created_at: nowIso(),
      updated_by: "",
      updated_at: null
    });
    if (siErr) return fail(siErr.message || String(siErr));
    itemsWithShipmentItemId.push(Object.assign({}, it, { shipment_item_id: shiId, so_item_id: soItemId, ship_qty: q }));

    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: String(it.movement_id || "").trim() || buildId_("MV"),
      movement_type: "SHIP_OUT",
      lot_id: lotId,
      product_id: productId,
      warehouse_id: String(lot.warehouse_id || "MAIN").trim().toUpperCase() || "MAIN",
      transaction_id: txId,
      parent_ref_type: "SHIPMENT",
      parent_ref_id: shipmentId,
      qty: -Math.abs(q),
      unit: unit,
      ref_type: "SHIPMENT",
      ref_id: shipmentId,
      issued_to: "",
      remark: "",
      created_by: actor,
      created_at: nowIso(),
      system_remark: "Ship OUT: " + shipmentId
    });
    if (mvRes && mvRes.success === false) return mvRes;

    shippedDeltaBySoItem[soItemId] = (shippedDeltaBySoItem[soItemId] || 0) + q;
  }

  const soItemIds = Object.keys(shippedDeltaBySoItem);
  for (let j = 0; j < soItemIds.length; j++) {
    const soItemId = soItemIds[j];
    const { data: row } = await sb.from("sales_order_item").select("*").eq("so_item_id", soItemId).maybeSingle();
    if (!row) continue;
    const next = Number(row.shipped_qty || 0) + Number(shippedDeltaBySoItem[soItemId] || 0);
    const { error: updErr } = await sb
      .from("sales_order_item")
      .update({
        shipped_qty: next,
        updated_by: actor,
        updated_at: nowIso()
      })
      .eq("so_item_id", soItemId);
    if (updErr) return fail(updErr.message || String(updErr));
  }

  const { data: soItems } = await sb.from("sales_order_item").select("*").eq("so_id", soId);
  const nextStatus = calcSalesOrderStatus_(soItems || []);
  const { error: soErr } = await sb
    .from("sales_order")
    .update({
      status: nextStatus,
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("so_id", soId);
  if (soErr) return fail(soErr.message || String(soErr));

  const { data: soRow, error: soLoadErr } = await sb
    .from("sales_order")
    .select("so_type, currency")
    .eq("so_id", soId)
    .maybeSingle();
  if (soLoadErr) return fail(soLoadErr.message || String(soLoadErr));
  const soType = String(soRow?.so_type || "NORMAL").trim().toUpperCase();

  if (soType === "NORMAL") {
    const arRes = await createGeneralShipmentArWithCommercial_({
      sb,
      shipmentId,
      soId,
      customerId,
      txId,
      shipDate,
      items: itemsWithShipmentItemId,
      currency: soRow?.currency,
      actor,
      ts,
      session: p._session
    });
    if (arRes && arRes.success === false) return arRes;
  } else if (soType === "CONSIGNMENT") {
    if (!consignmentCaseId) {
      return fail("consignment_case_id required for CONSIGNMENT shipment");
    }
    const poolRes = await addConsignmentCasePoolFromShipment_({
      sb,
      caseId: consignmentCaseId,
      shipmentId,
      soId,
      customerId,
      txId,
      shipDate,
      actor,
      ts
    });
    if (poolRes && poolRes.success === false) return poolRes;
  }

  await writeAuditLog_(
    "shipment",
    shipmentId,
    "BUNDLE_POST_SHIPMENT",
    actor,
    JSON.stringify({ shipment_id: shipmentId, so_id: soId, item_count: items.length })
  );

  return ok({ message: "POSTED", shipment_id: shipmentId });
}

async function cancelShipmentBundle(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: sh, error: shErr } = await sb.from("shipment").select("*").eq("shipment_id", shipmentId).maybeSingle();
  if (shErr) return fail(shErr.message || String(shErr));
  if (!sh) return fail("Shipment not found");

  const soId = String(sh.so_id || "").trim().toUpperCase();
  const txId = String(sh.transaction_id || "").trim() || (await ensureSalesOrderTx_(soId, actor)) || buildTxId();

  const st = String(sh.status || "").toUpperCase();
  if (st === "CANCELLED") return fail("Shipment already CANCELLED");
  if (st !== "POSTED") return fail("Only POSTED shipment can be cancelled");

  const { data: ciRow, error: ciErr } = await sb
    .from("commercial_invoice")
    .select("ci_id, ci_no, status")
    .eq("shipment_id", shipmentId)
    .maybeSingle();
  if (ciErr) return fail(ciErr.message || String(ciErr));
  if (ciRow) {
    const ciSt = String(ciRow.status || "").trim().toUpperCase();
    if (ciSt !== "VOID") {
      const ciNo = String(ciRow.ci_no || "").trim();
      return fail(
        ciNo
          ? "ERR_CI_NOT_VOID: Commercial Invoice " + ciNo + " must be voided first"
          : "ERR_CI_NOT_VOID: Commercial Invoice must be voided first"
      );
    }
  }

  if (await hasCancelMovement_("SHIPMENT_CANCEL", shipmentId)) {
    return fail("Shipment cancel movement already exists");
  }

  const { data: soRowCancel, error: soCancelErr } = await sb
    .from("sales_order")
    .select("so_type")
    .eq("so_id", soId)
    .maybeSingle();
  if (soCancelErr) return fail(soCancelErr.message || String(soCancelErr));
  const cancelSoType = String(soRowCancel?.so_type || "NORMAL").trim().toUpperCase();
  if (cancelSoType === "NORMAL") {
    const rebateBlock = await assertNoLockedDealerRebateForShipmentVoid_(sb, {
      customerId: String(sh.customer_id || "").trim().toUpperCase(),
      shipDate: sh.ship_date
    });
    if (rebateBlock && rebateBlock.err) return fail(rebateBlock.err);
  }

  const arBlock = await assertNoArForShipmentCancel_(sb, shipmentId);
  if (arBlock && arBlock.success === false) return arBlock;

  if (cancelSoType === "NORMAL") {
    const arId = typeof arBlock === "string" ? arBlock : "AR-" + shipmentId;
    let cumulativeAdded = 0;
    if (arId) {
      const { data: arRow, error: arLoadErr } = await sb
        .from("ar_receivable")
        .select("dealer_cumulative_added, amount_system")
        .eq("ar_id", arId)
        .maybeSingle();
      if (arLoadErr) return fail(arLoadErr.message || String(arLoadErr));
      cumulativeAdded = Math.round(Number(arRow?.dealer_cumulative_added || 0) * 100) / 100;
      if (cumulativeAdded <= 1e-9) cumulativeAdded = Math.round(Number(arRow?.amount_system || 0) * 100) / 100;
    }
    try {
      await reverseCumulativeOnGeneralShipmentVoid_(sb, {
        customerId: String(sh.customer_id || "").trim().toUpperCase(),
        arId,
        shipmentId,
        cumulativeAdded,
        actor,
        ts: nowIso()
      });
    } catch (cumRevErr) {
      return fail("累積採購扣回失敗：" + (cumRevErr?.message || String(cumRevErr)));
    }
  }

  // 一般出貨：取消出貨時同步作廢該筆 AR（避免重出貨後 AR 殘留）
  if (cancelSoType === "NORMAL") {
    const voidRes = await voidArForCancelledShipment_(
      sb,
      shipmentId,
      "作廢出貨",
      actor,
      nowIso()
    );
    if (voidRes && voidRes.success === false) return voidRes;

    const custId = String(sh.customer_id || "").trim().toUpperCase();
    if (custId) {
      const recalc = await syncCustomerCumulativeFromSources_(sb, custId, actor, nowIso());
      if (recalc && recalc.err) {
        return fail("月結累積重算失敗：" + recalc.err);
      }
    }
  }

  const consBlock = await assertNoConsignmentForShipmentCancel_(sb, shipmentId);
  if (consBlock && consBlock.success === false) return consBlock;

  const { data: items, error: itemsErr } = await sb
    .from("shipment_item")
    .select("*")
    .eq("shipment_id", shipmentId);
  if (itemsErr) return fail(itemsErr.message || String(itemsErr));
  if (!items || !items.length) return fail("Shipment items not found");

  const shippedDeltaBySoItem = {};
  const touchedSoIds = {};

  for (let j = 0; j < items.length; j++) {
    const it = items[j] || {};
    const lotId = String(it.lot_id || "").trim().toUpperCase();
    const q = Number(it.ship_qty || 0);
    if (!lotId || !(q > 0)) continue;

    const { data: lot, error: lotErr } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
    if (lotErr) return fail(lotErr.message || String(lotErr));
    if (!lot) return fail("Lot not found: " + lotId);

    const unit = String(it.unit || lot.unit || "").trim();
    const productId = String(it.product_id || lot.product_id || "").trim().toUpperCase();

    const mvRes = await createInventoryMovementUnlocked_({
      movement_id: buildId_("MV"),
      movement_type: "ADJUST",
      lot_id: lotId,
      product_id: productId,
      warehouse_id: String(lot.warehouse_id || "MAIN").trim().toUpperCase() || "MAIN",
      transaction_id: txId,
      parent_ref_type: "SHIPMENT",
      parent_ref_id: shipmentId,
      qty: Math.abs(q),
      unit: unit,
      ref_type: "SHIPMENT_CANCEL",
      ref_id: shipmentId,
      issued_to: "",
      remark: "",
      created_by: actor,
      created_at: nowIso(),
      system_remark: "Cancel Shipment: " + shipmentId
    });
    if (mvRes && mvRes.success === false) return mvRes;

    const soItemId = String(it.so_item_id || "").trim().toUpperCase();
    const itemSoId = String(it.so_id || "").trim().toUpperCase();
    if (itemSoId) touchedSoIds[itemSoId] = true;
    if (soItemId) shippedDeltaBySoItem[soItemId] = (shippedDeltaBySoItem[soItemId] || 0) + q;
  }

  const prevRemark = String(sh.remark || "").trim();
  const nextRemark = prevRemark ? prevRemark + " | CANCELLED" : "CANCELLED";
  const { error: updShErr } = await sb
    .from("shipment")
    .update({
      status: "CANCELLED",
      remark: nextRemark,
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("shipment_id", shipmentId);
  if (updShErr) return fail(updShErr.message || String(updShErr));

  const poolRemoveRes = await removeConsignmentCasePoolFromShipmentCancel_(sb, shipmentId, actor);
  if (poolRemoveRes && poolRemoveRes.success === false) return poolRemoveRes;

  const soItemIds = Object.keys(shippedDeltaBySoItem);
  for (let k = 0; k < soItemIds.length; k++) {
    const soItemId = soItemIds[k];
    const { data: row } = await sb.from("sales_order_item").select("*").eq("so_item_id", soItemId).maybeSingle();
    if (!row) continue;
    const next = Math.max(0, Number(row.shipped_qty || 0) - Number(shippedDeltaBySoItem[soItemId] || 0));
    const { error: updErr } = await sb
      .from("sales_order_item")
      .update({
        shipped_qty: next,
        updated_by: actor,
        updated_at: nowIso()
      })
      .eq("so_item_id", soItemId);
    if (updErr) return fail(updErr.message || String(updErr));
  }

  const soIds = Object.keys(touchedSoIds);
  for (let m = 0; m < soIds.length; m++) {
    const sid = soIds[m];
    const { data: soItems } = await sb.from("sales_order_item").select("*").eq("so_id", sid);
    const nextStatus = calcSalesOrderStatus_(soItems || []);
    const { error: soErr } = await sb
      .from("sales_order")
      .update({
        status: nextStatus,
        updated_by: actor,
        updated_at: nowIso()
      })
      .eq("so_id", sid);
    if (soErr) return fail(soErr.message || String(soErr));
  }

  await writeAuditLog_(
    "shipment",
    shipmentId,
    "BUNDLE_CANCEL_SHIPMENT",
    actor,
    JSON.stringify({ shipment_id: shipmentId })
  );

  return ok({ message: "CANCELLED", shipment_id: shipmentId });
}

module.exports = { postShipmentBundle, cancelShipmentBundle };
