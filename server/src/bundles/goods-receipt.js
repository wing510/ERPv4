const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  timestamptzFromClient_,
  buildTxId,
  buildId_,
  parseJsonArray,
  parseJsonObject,
  writeAuditLog_,
  getLotAvailableQty_,
  calcPurchaseOrderStatusByItems_,
  insertLot_,
  insertMovement_,
  applyLotBalanceDelta_,
  findInMovement_,
  hasCancelMovement_
} = require("./shared");

async function postGoodsReceiptBundle(p) {
  const grId = String(p.gr_id || "").trim().toUpperCase();
  const poId = String(p.po_id || "").trim().toUpperCase();
  const receiptDate = String(p.receipt_date || "").trim();
  const warehouse = String(p.warehouse || "").trim().toUpperCase();
  const remark = String(p.remark || "");
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!grId) return fail("gr_id required");
  if (!poId) return fail("po_id required");
  if (!receiptDate) return fail("receipt_date required");
  if (!warehouse) return fail("warehouse required");
  if (!actor) return fail("created_by required");

  const expectedItems = Number(p.expected_existed_goods_receipt_item_count || 0);
  if (Number.isNaN(expectedItems)) return fail("expected_existed_goods_receipt_item_count invalid");

  const linesPack = parseJsonArray(p.lines_json, "lines_json");
  if (linesPack.err) return fail(linesPack.err);
  const lines = linesPack.data;
  if (!lines.length) return fail("lines_json required");

  const expPack = parseJsonObject(p.expected_received_by_po_item_json, "expected_received_by_po_item_json");
  if (expPack.err) return fail(expPack.err);
  const expectedReceivedByPoItem = expPack.data;

  const sb = getSupabase();

  const { data: existed } = await sb.from("goods_receipt").select("*").eq("gr_id", grId).maybeSingle();
  if (existed) {
    const st = String(existed.status || "").trim().toUpperCase();
    if (st === "POSTED") return fail("Goods receipt already POSTED");
    if (st === "CANCELLED") return fail("Goods receipt already CANCELLED");
    return fail("Goods receipt already exists");
  }

  const { count: existedItemCount } = await sb
    .from("goods_receipt_item")
    .select("*", { count: "exact", head: true })
    .eq("gr_id", grId);
  if ((existedItemCount || 0) !== expectedItems) {
    return fail("Goods receipt items changed. Please reload and try again");
  }

  const { data: po } = await sb.from("purchase_order").select("*").eq("po_id", poId).maybeSingle();
  if (!po) return fail("PO not found: " + poId);
  if (String(po.status || "").trim().toUpperCase() === "CANCELLED") return fail("PO is CANCELLED");

  const { data: poItems } = await sb.from("purchase_order_item").select("*").eq("po_id", poId);
  const map = {};
  (poItems || []).forEach((row) => {
    const k = String(row.po_item_id || "").trim();
    if (k) map[k] = row;
  });

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] || {};
    const poItemId = String(ln.po_item_id || "").trim();
    const qty = Number(ln.received_qty || 0);
    if (!poItemId) return fail("po_item_id required (lines[" + i + "])");
    if (!(qty > 0)) return fail("received_qty must be > 0 (lines[" + i + "])");
    const item = map[poItemId];
    if (!item) return fail("PO item not found: " + poItemId);

    const expectedReceived = Number(
      expectedReceivedByPoItem[poItemId] != null ? expectedReceivedByPoItem[poItemId] : 0
    );
    if (Number.isNaN(expectedReceived)) return fail("expected_received_by_po_item_json invalid value: " + poItemId);
    const actualReceived = Number(item.received_qty || 0);
    if (Math.abs(actualReceived - expectedReceived) > 1e-9) {
      return fail("PO source changed. Please reload and try again", "ERR_SOURCE_CHANGED");
    }

    const ordered = Number(item.order_qty || 0);
    const received = Number(item.received_qty || 0);
    const remain = Math.max(0, ordered - received);
    if (qty > remain) return fail("received_qty exceeds remaining: " + poItemId);

    const unit = String(ln.unit || item.unit || "").trim();
    if (!unit) return fail("unit required (lines[" + i + "])");
    const mfg = String(ln.manufacture_date || "").trim();
    const exp = String(ln.expiry_date || "").trim();
    if (mfg && exp && exp < mfg) {
      return fail("expiry_date cannot be earlier than manufacture_date (lines[" + i + "])");
    }
  }

  const txId = buildTxId();
  const ts = nowIso();

  const { error: hdrErr } = await sb.from("goods_receipt").insert({
    gr_id: grId,
    po_id: poId,
    transaction_id: txId,
    parent_ref_type: "PO",
    parent_ref_id: poId,
    receipt_date: receiptDate,
    warehouse,
    status: "POSTED",
    remark,
    created_by: actor,
    created_at: timestamptzFromClient_(p.created_at || ts),
    updated_by: "",
    updated_at: null
  });
  if (hdrErr) return fail(hdrErr.message || String(hdrErr));

  let created = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] || {};
    const poItemId = String(ln.po_item_id || "").trim();
    const qty = Number(ln.received_qty || 0);
    const item = map[poItemId];
    const productId = String(item.product_id || "").trim();
    const unit = String(ln.unit || item.unit || "").trim();
    const mfg = String(ln.manufacture_date || "").trim();
    const exp = String(ln.expiry_date || "").trim();
    const factoryLot = String(ln.factory_lot || "").trim().toUpperCase();
    const lotId = "LOT-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: lotErr } = await insertLot_({
      lot_id: lotId,
      product_id: productId,
      warehouse_id: warehouse,
      source_type: "PURCHASE",
      source_id: grId,
      qty: qty,
      unit,
      type: "",
      status: "PENDING",
      inventory_status: "ACTIVE",
      received_date: receiptDate,
      manufacture_date: mfg || null,
      expiry_date: exp || null,
      factory_lot: factoryLot || null,
      remark: "",
      created_by: actor,
      created_at: ts,
      system_remark: "PO:" + poId + " / ITEM:" + poItemId
    });
    if (lotErr) return fail(lotErr.message || String(lotErr));

    const movementId = "MV-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: mvErr } = await insertMovement_({
      movement_id: movementId,
      movement_type: "IN",
      lot_id: lotId,
      product_id: productId,
      warehouse_id: warehouse,
      transaction_id: txId,
      parent_ref_type: "GOODS_RECEIPT",
      parent_ref_id: grId,
      qty: Math.abs(qty),
      unit,
      ref_type: "GOODS_RECEIPT",
      ref_id: grId,
      issued_to: "",
      remark: "",
      created_by: actor,
      created_at: ts,
      system_remark: "PO IN: " + poId
    });
    if (mvErr) return fail(mvErr.message || String(mvErr));
    try {
      await applyLotBalanceDelta_(lotId, Math.abs(qty), movementId, actor);
    } catch (_eBal) {}

    const { error: itemErr } = await sb.from("goods_receipt_item").insert({
      gr_item_id: "GRI-" + grId + "-" + String(created + 1).padStart(3, "0"),
      gr_id: grId,
      po_id: poId,
      po_item_id: poItemId,
      product_id: productId,
      transaction_id: txId,
      parent_ref_type: "GOODS_RECEIPT",
      parent_ref_id: grId,
      received_qty: qty,
      unit,
      lot_id: lotId,
      remark: "",
      created_by: actor,
      created_at: ts
    });
    if (itemErr) return fail(itemErr.message || String(itemErr));

    const received = Number(item.received_qty || 0);
    const { error: poiErr } = await sb
      .from("purchase_order_item")
      .update({
        received_qty: received + qty,
        updated_by: actor,
        updated_at: ts
      })
      .eq("po_item_id", poItemId);
    if (poiErr) return fail(poiErr.message || String(poiErr));

    map[poItemId] = Object.assign({}, item, { received_qty: received + qty });
    created++;
  }

  if (created > 0) {
    const nextPoStatus = await calcPurchaseOrderStatusByItems_(poId);
    const { error: poErr } = await sb
      .from("purchase_order")
      .update({ status: nextPoStatus, updated_by: actor, updated_at: ts })
      .eq("po_id", poId);
    if (poErr) return fail(poErr.message || String(poErr));
  }

  await writeAuditLog_("goods_receipt", grId, "POST_GOODS_RECEIPT", actor, JSON.stringify({ created_lots: created }));
  return ok({ message: "POSTED", gr_id: grId, created_lots: created, source: "supabase" });
}

async function cancelGoodsReceiptBundle(p) {
  const grId = String(p.gr_id || "").trim().toUpperCase();
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!grId) return fail("gr_id required");
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: gr } = await sb.from("goods_receipt").select("*").eq("gr_id", grId).maybeSingle();
  if (!gr) return fail("Goods receipt not found: " + grId);
  const st = String(gr.status || "").trim().toUpperCase();
  if (st === "CANCELLED") return fail("Goods receipt already CANCELLED");

  if (await hasCancelMovement_("GOODS_RECEIPT_CANCEL", grId)) {
    return fail("Goods receipt already has cancel reversal movements");
  }

  const { data: items } = await sb.from("goods_receipt_item").select("*").eq("gr_id", grId);
  if (!items || !items.length) return fail("Goods receipt items not found");

  const code = String(p.void_reason_code || "").trim().toUpperCase();
  const label = String(p.void_reason_label || "").trim();
  const note = String(p.void_reason_note || "").trim();
  let voidLine = "";
  if (code || label || note) {
    voidLine = "原因：" + (label || code || "");
    if (note) voidLine += " / " + note;
  }
  const adjRemark = voidLine || "作廢沖銷";
  const voidTag = code ? " | VOID:" + code : "";
  const ts = nowIso();
  const txId = String(gr.transaction_id || "").trim() || buildTxId();

  const plan = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const lotId = String(it.lot_id || "").trim();
    if (!lotId) return fail("lot_id missing in goods_receipt_item");
    const inMv = await findInMovement_(lotId, "GOODS_RECEIPT", grId);
    if (!inMv) return fail("IN movement not found for lot " + lotId);
    const inQty = Math.abs(Number(inMv.qty || 0));
    const avail = await getLotAvailableQty_(lotId);
    if (avail + 1e-9 < inQty) {
      return fail("Insufficient available qty for lot " + lotId + " (Cancel goods receipt)");
    }
    plan.push({ it, inMv, lotId, inQty });
  }

  for (let i = 0; i < plan.length; i++) {
    const x = plan[i];
    const inMv = x.inMv;
    const movementId = buildId_("MV");
    const { error: mvErr } = await insertMovement_({
      movement_id: movementId,
      movement_type: "ADJUST",
      lot_id: x.lotId,
      product_id: String(inMv.product_id || ""),
      warehouse_id: String(gr.warehouse || inMv.warehouse_id || "MAIN").trim().toUpperCase() || "MAIN",
      transaction_id: txId,
      parent_ref_type: "GOODS_RECEIPT",
      parent_ref_id: grId,
      qty: -Math.abs(x.inQty),
      unit: String(inMv.unit || ""),
      ref_type: "GOODS_RECEIPT_CANCEL",
      ref_id: grId,
      issued_to: "",
      remark: adjRemark,
      created_by: actor,
      created_at: ts,
      system_remark: "REVERSAL(IN) of " + String(inMv.movement_id || "") + voidTag
    });
    if (mvErr) return fail(mvErr.message || String(mvErr));
    try {
      await applyLotBalanceDelta_(x.lotId, -Math.abs(x.inQty), movementId, actor);
    } catch (_eBal) {}
  }

  for (let i = 0; i < plan.length; i++) {
    const { error: lotErr } = await sb
      .from("lot")
      .update({
        inventory_status: "VOID",
        status: "REJECTED",
        updated_by: actor,
        updated_at: ts
      })
      .eq("lot_id", plan[i].lotId);
    if (lotErr) return fail(lotErr.message || String(lotErr));
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const poItemId = String(it.po_item_id || "").trim();
    if (!poItemId) continue;
    const { data: poi } = await sb.from("purchase_order_item").select("*").eq("po_item_id", poItemId).maybeSingle();
    if (!poi) continue;
    const dec = Number(it.received_qty || 0);
    const next = Math.max(0, Number(poi.received_qty || 0) - dec);
    const { error: poiErr } = await sb
      .from("purchase_order_item")
      .update({ received_qty: next, updated_by: actor, updated_at: ts })
      .eq("po_item_id", poItemId);
    if (poiErr) return fail(poiErr.message || String(poiErr));
  }

  const prevRemark = String(gr.remark || "").trim();
  const nextRemark = voidLine
    ? prevRemark
      ? prevRemark + "\n[作廢 " + ts + "] " + voidLine
      : "[作廢 " + ts + "] " + voidLine
    : prevRemark;

  const { error: hdrErr } = await sb
    .from("goods_receipt")
    .update({
      transaction_id: txId,
      parent_ref_type: gr.po_id ? "PO" : "",
      parent_ref_id: String(gr.po_id || "").trim().toUpperCase(),
      status: "CANCELLED",
      remark: nextRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("gr_id", grId);
  if (hdrErr) return fail(hdrErr.message || String(hdrErr));

  const poId = String(gr.po_id || "").trim().toUpperCase();
  if (poId) {
    const { data: po } = await sb.from("purchase_order").select("status").eq("po_id", poId).maybeSingle();
    if (po && String(po.status || "").toUpperCase() !== "CANCELLED") {
      const nextPoStatus = await calcPurchaseOrderStatusByItems_(poId);
      await sb
        .from("purchase_order")
        .update({ status: nextPoStatus, updated_by: actor, updated_at: ts })
        .eq("po_id", poId);
    }
  }

  await writeAuditLog_(
    "goods_receipt",
    grId,
    "CANCEL_GOODS_RECEIPT",
    actor,
    JSON.stringify({ gr_id: grId, status: "CANCELLED" })
  );
  return ok({ message: "CANCELLED", gr_id: grId, source: "supabase" });
}

module.exports = { postGoodsReceiptBundle, cancelGoodsReceiptBundle };
