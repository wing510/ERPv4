const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  buildTxId,
  buildId_,
  sumMovementsForLot_,
  isLotExpired_,
  insertLot_,
  writeAuditLog_
} = require("./shared");
const { createInventoryMovementUnlocked_ } = require("../inventory-movement-core");

async function postTransferBundle(p) {
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const fromLotId = String(p.from_lot_id || p.fromLotId || "").trim().toUpperCase();
  const toWh = String(p.to_warehouse_id || p.to_warehouse || "").trim().toUpperCase();
  const qtyNum = Number(p.qty || 0);
  const userRemark = String(p.remark || "").trim();

  if (!fromLotId) return fail("from_lot_id required");
  if (!toWh) return fail("to_warehouse_id required");
  if (!(qtyNum > 0)) return fail("qty must be > 0");
  if (!userRemark) return fail("remark required");

  const sb = getSupabase();
  const { data: lot, error: lotErr } = await sb.from("lot").select("*").eq("lot_id", fromLotId).maybeSingle();
  if (lotErr) return fail(lotErr.message || String(lotErr));
  if (!lot) return fail("Lot not found: " + fromLotId);

  const fromWh = String(lot.warehouse_id || "").trim().toUpperCase();
  if (fromWh && fromWh === toWh) return fail("to_warehouse_id must be different");

  const invSt = String(lot.inventory_status || "ACTIVE").trim().toUpperCase();
  if (invSt !== "ACTIVE") return fail("Only ACTIVE lot can be transferred");
  if (isLotExpired_(lot.expiry_date)) return fail("Expired lot (VOID) cannot be transferred");

  const available = await sumMovementsForLot_(fromLotId);
  if (available === null) return fail("Lot has no inventory movement records: " + fromLotId);
  if (available + 1e-9 < qtyNum) return fail("Transfer qty exceeds available qty");

  const qa = String(lot.status || "PENDING").trim().toUpperCase();
  if (qa !== "APPROVED") {
    const isAll = Math.abs(qtyNum - Number(available || 0)) <= 1e-9;
    if (!isAll) return fail("Pending QA lot can only be transferred all quantity");
  }

  const ts = nowIso();
  const txId = buildTxId();
  const newLotId = buildId_("LOT");

  const { error: lotInsErr } = await insertLot_({
    lot_id: newLotId,
    product_id: String(lot.product_id || ""),
    warehouse_id: toWh,
    source_type: String(lot.source_type || "").trim().toUpperCase() || "",
    source_id: String(lot.source_id || "").trim(),
    qty: qtyNum,
    unit: String(lot.unit || ""),
    type: String(lot.type || ""),
    status: String(lot.status || "PENDING"),
    inventory_status: "ACTIVE",
    received_date: String(lot.received_date || "").trim() || String(ts).slice(0, 10),
    manufacture_date: lot.manufacture_date || null,
    expiry_date: lot.expiry_date || null,
    factory_lot: String(lot.factory_lot || "").trim().toUpperCase() || null,
    remark: "",
    created_by: actor,
    created_at: ts,
    system_remark: "Transfer from " + fromLotId + " (" + String(fromWh || "—") + " -> " + toWh + ")"
  });
  if (lotInsErr) return fail(lotInsErr.message || String(lotInsErr));

  const outRes = await createInventoryMovementUnlocked_({
    movement_id: buildId_("MV"),
    movement_type: "OUT",
    lot_id: fromLotId,
    product_id: String(lot.product_id || ""),
    warehouse_id: fromWh,
    transaction_id: txId,
    parent_ref_type: "TRANSFER",
    parent_ref_id: newLotId,
    qty: -Math.abs(qtyNum),
    unit: String(lot.unit || ""),
    ref_type: "TRANSFER",
    ref_id: newLotId,
    issued_to: "",
    remark: userRemark,
    created_by: actor,
    created_at: ts,
    system_remark: "Transfer OUT: " + fromLotId + " -> " + newLotId
  });
  if (outRes && outRes.success === false) return outRes;

  const inRes = await createInventoryMovementUnlocked_({
    movement_id: buildId_("MV"),
    movement_type: "IN",
    lot_id: newLotId,
    product_id: String(lot.product_id || ""),
    warehouse_id: toWh,
    transaction_id: txId,
    parent_ref_type: "TRANSFER",
    parent_ref_id: newLotId,
    qty: Math.abs(qtyNum),
    unit: String(lot.unit || ""),
    ref_type: "TRANSFER",
    ref_id: fromLotId,
    issued_to: "",
    remark: "",
    created_by: actor,
    created_at: ts,
    system_remark: "Transfer IN: " + newLotId + " <- " + fromLotId
  });
  if (inRes && inRes.success === false) return inRes;

  await writeAuditLog_("lot", fromLotId, "POST_TRANSFER", actor, JSON.stringify({
    from_lot_id: fromLotId,
    new_lot_id: newLotId,
    qty: String(qtyNum),
    to_warehouse_id: toWh
  }));

  return ok({
    message: "TRANSFERRED",
    from_lot_id: fromLotId,
    new_lot_id: newLotId,
    qty: String(qtyNum),
    to_warehouse_id: toWh,
    source: "supabase"
  });
}

module.exports = { postTransferBundle };
