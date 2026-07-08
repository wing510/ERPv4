const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { nowIso, normalizeTaipeiTimestamp_, appendSystemRemark_, parseJsonArray, writeAuditLog_ } = require("./shared");

const IMPORT_DOC_FIELDS = [
  "import_doc_id",
  "import_no",
  "import_date",
  "release_date",
  "supplier_id",
  "inspection_no",
  "status",
  "document_link",
  "remark",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "system_remark"
];

function pickImportHeader_(p, mode) {
  const row = {};
  const actor = String(p.updated_by || p.created_by || "").trim();
  IMPORT_DOC_FIELDS.forEach((f) => {
    if (p[f] !== undefined && p[f] !== null && p[f] !== "") row[f] = p[f];
  });
  if (mode === "create") {
    if (!row.status) row.status = "OPEN";
    if (row.created_at) {
      const norm = normalizeTaipeiTimestamp_(row.created_at);
      if (norm) row.created_at = norm;
    }
    if (!row.created_at) row.created_at = nowIso();
    if (!row.created_by && actor) row.created_by = actor;
  }
  if (actor) row.updated_by = actor;
  row.updated_at = nowIso();
  return row;
}

async function deleteImportItemsByDocId_(docId) {
  const sb = getSupabase();
  const { data, error } = await sb.from("import_item").select("import_item_id").eq("import_doc_id", docId);
  if (error) throw new Error(error.message || String(error));
  const ids = (data || []).map((r) => r.import_item_id).filter(Boolean);
  if (!ids.length) return 0;
  const { error: delErr } = await sb.from("import_item").delete().eq("import_doc_id", docId);
  if (delErr) throw new Error(delErr.message || String(delErr));
  return ids.length;
}

async function hasActiveImportReceiptByDocId_(docId) {
  const id = String(docId || "").trim().toUpperCase();
  if (!id) return false;
  const sb = getSupabase();
  const { data } = await sb.from("import_receipt").select("import_receipt_id, status").eq("import_doc_id", id);
  return (data || []).some((r) => {
    const st = String(r.status || "").trim().toUpperCase();
    return st && st !== "VOID" && st !== "CANCELLED";
  });
}

async function enforceNoActiveReceiptItems_(docId) {
  const sb = getSupabase();
  const id = String(docId || "").trim().toUpperCase();
  const { data: receipts } = await sb
    .from("import_receipt")
    .select("import_receipt_id, status")
    .eq("import_doc_id", id);
  const activeIds = new Set();
  (receipts || []).forEach((r) => {
    const st = String(r.status || "").trim().toUpperCase();
    if (st !== "CANCELLED") activeIds.add(String(r.import_receipt_id || "").trim());
  });
  if (!activeIds.size) return;

  const { data: items } = await sb.from("import_receipt_item").select("import_receipt_id");
  const hit = (items || []).some((r) => activeIds.has(String(r.import_receipt_id || "").trim()));
  if (hit) throw new Error("Import document already has receipt records. Reset items is not allowed.");
}

async function saveImportDocument(p) {
  const importDocId = String(p.import_doc_id || "").trim().toUpperCase();
  if (!importDocId) return fail("import_doc_id required");

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("Import items required");

  const sb = getSupabase();
  const { data: existed } = await sb
    .from("import_document")
    .select("import_doc_id")
    .eq("import_doc_id", importDocId)
    .maybeSingle();

  const header = pickImportHeader_(p, existed ? "update" : "create");
  header.import_doc_id = importDocId;

  try {
    if (existed) {
      const patch = Object.assign({}, header);
      delete patch.import_doc_id;
      delete patch.created_at;
      delete patch.created_by;
      const { error } = await sb.from("import_document").update(patch).eq("import_doc_id", importDocId);
      if (error) return fail(error.message || String(error));
    } else {
      const { error } = await sb.from("import_document").insert(header);
      if (error) return fail(error.message || String(error));
    }

    const deleted = await deleteImportItemsByDocId_(importDocId);
    const ts = nowIso();
    const actor = String(p.updated_by || p.created_by || "").trim();
    const rows = items.map((it, idx) => {
      const o = Object.assign({}, it);
      return {
        import_item_id: String(o.import_item_id || "IMPI-" + importDocId + "-" + String(idx + 1).padStart(3, "0")),
        import_doc_id: importDocId,
        item_no: String(o.item_no || idx + 1),
        product_id: String(o.product_id || "").trim(),
        hs_code: String(o.hs_code || ""),
        invoice_no: String(o.invoice_no || ""),
        origin_country: String(o.origin_country || ""),
        declared_qty: Number(o.declared_qty || 0),
        declared_unit: String(o.declared_unit || ""),
        remark: String(o.remark || ""),
        created_by: o.created_by || actor,
        created_at: o.created_at || ts,
        updated_by: o.updated_by || "",
        updated_at: o.updated_at || null
      };
    });

    const { error: insErr } = await sb.from("import_item").insert(rows);
    if (insErr) return fail(insErr.message || String(insErr));

    await writeAuditLog_(
      "import_document",
      importDocId,
      "SAVE_IMPORT_DOCUMENT",
      actor,
      JSON.stringify({
        import_doc_id: importDocId,
        header_mode: existed ? "update" : "create",
        items_deleted: deleted,
        items_created: rows.length
      })
    );
    return ok({
      message: "Saved",
      header_mode: existed ? "update" : "create",
      items_deleted: deleted,
      items_created: rows.length,
      source: "supabase"
    });
  } catch (e) {
    return fail(String(e.message || e || "Save import document failed"));
  }
}

async function resetImportItemsCmd(p) {
  const docId = String(p.import_doc_id || "").trim().toUpperCase();
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!docId) return fail("import_doc_id required");
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: doc } = await sb.from("import_document").select("*").eq("import_doc_id", docId).maybeSingle();
  if (!doc) return fail("Import document not found: " + docId);
  const st = String(doc.status || "").trim().toUpperCase();
  if (st !== "OPEN") return fail("Only OPEN import document can reset items");

  try {
    await enforceNoActiveReceiptItems_(docId);
  } catch (e) {
    return fail(String(e.message || e));
  }

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("items_json required");

  const normalized = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const pid = String(it.product_id || "").trim().toUpperCase();
    const inv = String(it.invoice_no || it.lot_id || "").trim();
    const hs = String(it.hs_code || "").trim();
    const oc = String(it.origin_country || "").trim();
    const q = Number(it.declared_qty || 0);
    const u = String(it.declared_unit || "").trim();
    if (!pid) return fail("product_id required (items[" + i + "])");
    if (!inv) return fail("invoice_no required (items[" + i + "])");
    if (!(q > 0)) return fail("declared_qty must be > 0 (items[" + i + "])");
    if (!u) return fail("declared_unit required (items[" + i + "])");
    normalized.push({
      import_item_id: "IMPI-" + docId + "-" + String(i + 1).padStart(3, "0"),
      import_doc_id: docId,
      item_no: String(i + 1),
      product_id: pid,
      hs_code: hs,
      invoice_no: inv,
      origin_country: oc,
      declared_qty: q,
      declared_unit: u,
      remark: String(it.remark || ""),
      created_by: actor,
      created_at: nowIso()
    });
  }

  try {
    await deleteImportItemsByDocId_(docId);
    const { error } = await sb.from("import_item").insert(normalized);
    if (error) return fail(error.message || String(error));
    return ok({ message: "RESET", import_doc_id: docId, count: normalized.length, source: "supabase" });
  } catch (e) {
    return fail(String(e.message || e || "Error"));
  }
}

async function cancelImportDocumentBundle(p) {
  const docId = String(p.import_doc_id || "").trim().toUpperCase();
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!docId) return fail("import_doc_id required");
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: doc } = await sb.from("import_document").select("*").eq("import_doc_id", docId).maybeSingle();
  if (!doc) return fail("Import document not found");
  if (String(doc.status || "").toUpperCase() === "CANCELLED") return fail("Import document already CANCELLED");
  if (await hasActiveImportReceiptByDocId_(docId)) {
    return fail("Cannot cancel: active import receipts exist");
  }

  const note = String(p.cancel_note || "").trim();
  const line = "[作廢 " + nowIso() + " " + actor + "] " + (note || "");
  const { error } = await sb
    .from("import_document")
    .update({
      status: "CANCELLED",
      system_remark: appendSystemRemark_(doc.system_remark, line.trim()),
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("import_doc_id", docId);
  if (error) return fail(error.message || String(error));

  await writeAuditLog_("import_document", docId, "CANCEL_IMPORT_DOCUMENT", actor, note);
  return ok({ message: "CANCELLED", import_doc_id: docId, source: "supabase" });
}

module.exports = {
  saveImportDocument,
  resetImportItemsCmd,
  cancelImportDocumentBundle
};
