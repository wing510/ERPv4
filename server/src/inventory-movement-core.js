const { getSupabase } = require("./supabase");
const { fail } = require("./response");
const {
  nowIso,
  normalizeTaipeiTimestamp_,
  timestamptzFromClient_,
  buildTxId,
  buildId_,
  sumMovementsForLot_,
  isLotExpired_,
  desiredInventoryStatusForLot_,
  applyLotBalanceDelta_,
  insertMovement_
} = require("./bundles/shared");

async function createInventoryMovementUnlocked_(p) {
  const movementType = String(p.movement_type || "").trim().toUpperCase();
  const refType = String(p.ref_type || "").trim().toUpperCase();
  const lotId = String(p.lot_id || "").trim();
  const qtyNum = Number(p.qty || 0);
  const issuedTo = String(p.issued_to || "").trim();
  const remark = String(p.remark || "").trim();
  const refId = String(p.ref_id || "").trim();
  const actor = String(p.updated_by || p.created_by || "").trim();

  if (!movementType) return fail("movement_type required");
  if (!lotId) return fail("lot_id required");
  if (!qtyNum || Number.isNaN(qtyNum)) return fail("qty required");
  if (!refType) return fail("ref_type required");
  if (!refId) return fail("ref_id required");

  const manualOutPurposes = ["INTERNAL_USE", "SAMPLE", "SCRAP", "OTHER"];
  if (movementType === "OUT" && manualOutPurposes.includes(refType)) {
    if (!issuedTo) return fail("手動扣庫：請選擇「給誰（領用／交付）」");
    if (!remark) return fail("手動扣庫：請填寫原因");
  }
  if (refType === "TRANSFER") {
    if (movementType === "OUT") {
      if (!refId) return fail("轉倉：缺少對應的新 Lot（ref_id）");
      if (!remark) return fail("轉倉：請填寫原因");
    }
    if (issuedTo) return fail("轉倉：不可填寫「給誰（領用／交付）」");
  }

  const sb = getSupabase();
  const { data: lot, error: lotErr } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
  if (lotErr) return fail(lotErr.message || String(lotErr));
  if (!lot) return fail("Lot not found: " + lotId);

  const available = await sumMovementsForLot_(lotId);
  const availableNum = available === null ? 0 : Number(available);
  const desiredBefore = desiredInventoryStatusForLot_(lot, availableNum);

  const outTypes = ["OUT", "PROCESS_OUT", "SHIP_OUT"];
  if (outTypes.includes(movementType)) {
    if (available === null) return fail("Lot has no inventory movement records: " + lotId);
    const isTransfer = refType === "TRANSFER";
    const isAllTransfer = isTransfer && Math.abs(qtyNum) >= availableNum - 1e-9;
    if (!(isTransfer && isAllTransfer) && String(lot.status || "") !== "APPROVED") {
      return fail("Only APPROVED lot can be used for OUT/PROCESS_OUT/SHIP_OUT");
    }
    if (desiredBefore !== "ACTIVE") {
      if (desiredBefore === "VOID") {
        return fail("Expired lot (VOID) cannot be used for OUT/PROCESS_OUT/SHIP_OUT");
      }
      if (desiredBefore === "CLOSED") {
        return fail("Lot is closed (CLOSED / no available inventory) cannot be used for OUT/PROCESS_OUT/SHIP_OUT");
      }
      return fail("Lot inventory_status is not ACTIVE");
    }
  }

  const nextAvailable = availableNum + qtyNum;
  if (nextAvailable < 0) return fail("Negative inventory is not allowed");

  const movementId = String(p.movement_id || "").trim() || buildId_("MV");
  const { data: mvExists } = await sb
    .from("inventory_movement")
    .select("movement_id")
    .eq("movement_id", movementId)
    .maybeSingle();
  if (mvExists) return fail("movement_id already exists: " + movementId);

  let transactionId = String(p.transaction_id || "").trim();
  if (!transactionId) {
    transactionId = buildTxId();
  }

  const row = {
    movement_id: movementId,
    movement_type: movementType,
    lot_id: lotId,
    product_id: String(p.product_id || lot.product_id || "").trim(),
    warehouse_id: String(p.warehouse_id || lot.warehouse_id || "MAIN").trim().toUpperCase() || "MAIN",
    transaction_id: transactionId,
    parent_ref_type: String(p.parent_ref_type || refType || "INVENTORY_MOVEMENT").trim(),
    parent_ref_id: String(p.parent_ref_id || refId || movementId).trim(),
    qty: qtyNum,
    unit: String(p.unit || lot.unit || "").trim(),
    ref_type: refType,
    ref_id: refId,
    issued_to: issuedTo,
    remark: remark,
    system_remark: String(p.system_remark || "").trim(),
    created_by: String(p.created_by || actor || "").trim(),
    created_at: timestamptzFromClient_(p.created_at),
    updated_by: String(p.updated_by || "").trim(),
    updated_at: p.updated_at || null
  };

  const { error: insErr } = await insertMovement_(row);
  if (insErr) return fail(insErr.message || String(insErr));

  try {
    await applyLotBalanceDelta_(lotId, qtyNum, movementId, actor || row.created_by);
  } catch (_eBal) {}

  const desiredAfter = desiredInventoryStatusForLot_(lot, nextAvailable);
  const currentInv = String(lot.inventory_status || "ACTIVE").trim().toUpperCase();
  if (desiredAfter !== currentInv) {
    await sb
      .from("lot")
      .update({
        inventory_status: desiredAfter,
        updated_by: actor || row.created_by,
        updated_at: nowIso()
      })
      .eq("lot_id", lotId);
  }

  return { ok: true, movement_id: movementId };
}

module.exports = { createInventoryMovementUnlocked_ };
