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
  calcImportDocumentStatusByItems_,
  insertLot_,
  insertMovement_,
  applyLotBalanceDelta_,
  findInMovement_,
  hasCancelMovement_
} = require("./shared");

async function sumReceivedByImportItem_(docId) {
  const sb = getSupabase();
  const id = String(docId || "").trim().toUpperCase();
  const out = {};

  const { data: receipts } = await sb
    .from("import_receipt")
    .select("import_receipt_id, status")
    .eq("import_doc_id", id);
  const activeIds = new Set();
  (receipts || []).forEach((r) => {
    const st = String(r.status || "").trim().toUpperCase();
    if (st !== "CANCELLED") activeIds.add(String(r.import_receipt_id || "").trim());
  });
  if (!activeIds.size) return out;

  const { data: items } = await sb.from("import_receipt_item").select("*");
  (items || []).forEach((r) => {
    const rid = String(r.import_receipt_id || "").trim();
    if (!activeIds.has(rid)) return;
    const itemId = String(r.import_item_id || "").trim();
    if (!itemId) return;
    out[itemId] = (out[itemId] || 0) + Number(r.received_qty || 0);
  });
  return out;
}

async function postImportReceiptBundle(p) {
  const rid = String(p.import_receipt_id || "").trim().toUpperCase();
  const docId = String(p.import_doc_id || "").trim().toUpperCase();
  const receiptDate = String(p.receipt_date || "").trim();
  const warehouse = String(p.warehouse || "").trim().toUpperCase();
  const remark = String(p.remark || "");
  const actor = String(p.created_by || p.updated_by || "").trim();
  if (!rid) return fail("import_receipt_id required");
  if (!docId) return fail("import_doc_id required");
  if (!receiptDate) return fail("receipt_date required");
  if (!warehouse) return fail("warehouse required");
  if (!actor) return fail("created_by required");

  const expectedItems = Number(p.expected_existed_import_receipt_item_count || 0);
  if (Number.isNaN(expectedItems)) return fail("expected_existed_import_receipt_item_count invalid");

  const linesPack = parseJsonArray(p.lines_json, "lines_json");
  if (linesPack.err) return fail(linesPack.err);
  const lines = linesPack.data;
  if (!lines.length) return fail("lines_json required");

  const expPack = parseJsonObject(p.expected_received_by_import_item_json, "expected_received_by_import_item_json");
  if (expPack.err) return fail(expPack.err);
  const expectedReceivedByImportItem = expPack.data;

  const sb = getSupabase();

  const { data: existed } = await sb.from("import_receipt").select("*").eq("import_receipt_id", rid).maybeSingle();
  if (existed) {
    const st = String(existed.status || "").trim().toUpperCase();
    if (st === "POSTED") return fail("Import receipt already POSTED");
    if (st === "CANCELLED") return fail("Import receipt already CANCELLED");
    return fail("Import receipt already exists");
  }

  const { count: existedItemCount } = await sb
    .from("import_receipt_item")
    .select("*", { count: "exact", head: true })
    .eq("import_receipt_id", rid);
  if ((existedItemCount || 0) !== expectedItems) {
    return fail("Import receipt items changed. Please reload and try again");
  }

  const { data: doc } = await sb.from("import_document").select("*").eq("import_doc_id", docId).maybeSingle();
  if (!doc) return fail("Import document not found: " + docId);
  if (String(doc.status || "").trim().toUpperCase() === "CANCELLED") return fail("Import document is CANCELLED");

  const { data: importItems } = await sb.from("import_item").select("*").eq("import_doc_id", docId);
  const itemMap = {};
  (importItems || []).forEach((row) => {
    const k = String(row.import_item_id || "").trim();
    if (k) itemMap[k] = row;
  });

  const actualReceivedByImportItem = await sumReceivedByImportItem_(docId);

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] || {};
    const itemId = String(ln.import_item_id || "").trim();
    const qty = Number(ln.received_qty || 0);
    if (!itemId) return fail("import_item_id required (lines[" + i + "])");
    if (!(qty > 0)) return fail("received_qty must be > 0 (lines[" + i + "])");
    const item = itemMap[itemId];
    if (!item) return fail("Import item not found: " + itemId);

    const expectedReceived = Number(
      expectedReceivedByImportItem[itemId] != null ? expectedReceivedByImportItem[itemId] : 0
    );
    if (Number.isNaN(expectedReceived)) return fail("expected_received_by_import_item_json invalid value: " + itemId);
    const actualReceived = Number(actualReceivedByImportItem[itemId] || 0);
    if (Math.abs(actualReceived - expectedReceived) > 1e-9) {
      return fail("Import source changed. Please reload and try again", "ERR_SOURCE_CHANGED");
    }

    const unit = String(ln.unit || item.declared_unit || "").trim();
    if (!unit) return fail("unit required (lines[" + i + "])");
    const mfg = String(ln.manufacture_date || "").trim();
    const exp = String(ln.expiry_date || "").trim();
    if (mfg && exp && exp < mfg) {
      return fail("expiry_date cannot be earlier than manufacture_date (lines[" + i + "])");
    }
  }

  const txId = buildTxId();
  const ts = nowIso();

  const { error: hdrErr } = await sb.from("import_receipt").insert({
    import_receipt_id: rid,
    import_doc_id: docId,
    transaction_id: txId,
    parent_ref_type: "IMPORT_DOCUMENT",
    parent_ref_id: docId,
    receipt_date: receiptDate,
    warehouse,
    status: "POSTED",
    remark,
    created_by: actor,
    created_at: timestamptzFromClient_(p.created_at || ts)
  });
  if (hdrErr) return fail(hdrErr.message || String(hdrErr));

  let created = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] || {};
    const itemId = String(ln.import_item_id || "").trim();
    const qty = Number(ln.received_qty || 0);
    const item = itemMap[itemId];
    const productId = String(item.product_id || "").trim();
    const unit = String(ln.unit || item.declared_unit || "").trim();
    const mfg = String(ln.manufacture_date || "").trim();
    const exp = String(ln.expiry_date || "").trim();
    const factoryLot = String(ln.factory_lot || "").trim().toUpperCase();
    const lotId = "LOT-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: lotErr } = await insertLot_({
      lot_id: lotId,
      product_id: productId,
      warehouse_id: warehouse,
      source_type: "IMPORT",
      source_id: rid,
      qty,
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
      system_remark: "Import: " + docId
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
      parent_ref_type: "IMPORT_RECEIPT",
      parent_ref_id: rid,
      qty: Math.abs(qty),
      unit,
      ref_type: "IMPORT_RECEIPT",
      ref_id: rid,
      issued_to: "",
      remark: "",
      created_by: actor,
      created_at: ts,
      system_remark: "Import IN: " + docId
    });
    if (mvErr) return fail(mvErr.message || String(mvErr));
    try {
      await applyLotBalanceDelta_(lotId, Math.abs(qty), movementId, actor);
    } catch (_eBal) {}

    const { error: itemErr } = await sb.from("import_receipt_item").insert({
      import_receipt_item_id: "IRI-" + rid + "-" + String(created + 1).padStart(3, "0"),
      import_receipt_id: rid,
      import_item_id: itemId,
      product_id: productId,
      transaction_id: txId,
      parent_ref_type: "IMPORT_RECEIPT",
      parent_ref_id: rid,
      received_qty: qty,
      unit,
      lot_id: lotId,
      remark: "",
      created_by: actor,
      created_at: ts
    });
    if (itemErr) return fail(itemErr.message || String(itemErr));
    created++;
  }

  if (created > 0) {
    const nextStatus = await calcImportDocumentStatusByItems_(docId);
    const { error: docErr } = await sb
      .from("import_document")
      .update({ status: nextStatus, updated_by: actor, updated_at: ts })
      .eq("import_doc_id", docId);
    if (docErr) return fail(docErr.message || String(docErr));
  }

  await writeAuditLog_("import_receipt", rid, "POST_IMPORT_RECEIPT", actor, JSON.stringify({ created_lots: created }));
  return ok({ message: "POSTED", import_receipt_id: rid, created_lots: created, source: "supabase" });
}

async function cancelImportReceiptBundle(p) {
  const rid = String(p.import_receipt_id || "").trim().toUpperCase();
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!rid) return fail("import_receipt_id required");
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: ir } = await sb.from("import_receipt").select("*").eq("import_receipt_id", rid).maybeSingle();
  if (!ir) return fail("Import receipt not found: " + rid);
  const st = String(ir.status || "").trim().toUpperCase();
  if (st === "CANCELLED") return fail("Import receipt already CANCELLED");

  if (await hasCancelMovement_("IMPORT_RECEIPT_CANCEL", rid)) {
    return fail("Import receipt already has cancel reversal movements");
  }

  const { data: items } = await sb.from("import_receipt_item").select("*").eq("import_receipt_id", rid);
  if (!items || !items.length) return fail("Import receipt items not found");

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
  const txId = String(ir.transaction_id || "").trim() || buildTxId();

  const plan = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const lotId = String(it.lot_id || "").trim();
    if (!lotId) return fail("lot_id missing in import_receipt_item");
    const inMv = await findInMovement_(lotId, "IMPORT_RECEIPT", rid);
    if (!inMv) return fail("IN movement not found for lot " + lotId);
    const inQty = Math.abs(Number(inMv.qty || 0));
    const avail = await getLotAvailableQty_(lotId);
    if (avail + 1e-9 < inQty) {
      return fail("Insufficient available qty for lot " + lotId + " (Cancel import)");
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
      warehouse_id: String(ir.warehouse || inMv.warehouse_id || "MAIN").trim().toUpperCase() || "MAIN",
      transaction_id: txId,
      parent_ref_type: "IMPORT_RECEIPT",
      parent_ref_id: rid,
      qty: -Math.abs(x.inQty),
      unit: String(inMv.unit || ""),
      ref_type: "IMPORT_RECEIPT_CANCEL",
      ref_id: rid,
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

  const prevRemark = String(ir.remark || "").trim();
  const nextRemark = voidLine
    ? prevRemark
      ? prevRemark + "\n[作廢 " + ts + "] " + voidLine
      : "[作廢 " + ts + "] " + voidLine
    : prevRemark;

  const { error: hdrErr } = await sb
    .from("import_receipt")
    .update({
      transaction_id: txId,
      parent_ref_type: ir.import_doc_id ? "IMPORT_DOCUMENT" : "",
      parent_ref_id: String(ir.import_doc_id || "").trim().toUpperCase(),
      status: "CANCELLED",
      remark: nextRemark,
      updated_by: actor,
      updated_at: ts
    })
    .eq("import_receipt_id", rid);
  if (hdrErr) return fail(hdrErr.message || String(hdrErr));

  const docId = String(ir.import_doc_id || "").trim().toUpperCase();
  if (docId) {
    const { data: doc } = await sb.from("import_document").select("status").eq("import_doc_id", docId).maybeSingle();
    if (doc && String(doc.status || "").toUpperCase() !== "CANCELLED") {
      const nextStatus = await calcImportDocumentStatusByItems_(docId);
      await sb
        .from("import_document")
        .update({ status: nextStatus, updated_by: actor, updated_at: ts })
        .eq("import_doc_id", docId);
    }
  }

  await writeAuditLog_(
    "import_receipt",
    rid,
    "CANCEL_IMPORT_RECEIPT",
    actor,
    JSON.stringify({ import_receipt_id: rid, status: "CANCELLED" })
  );
  return ok({ message: "CANCELLED", import_receipt_id: rid, source: "supabase" });
}

module.exports = { postImportReceiptBundle, cancelImportReceiptBundle };
