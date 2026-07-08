const { getSupabase } = require("./supabase");
const { ok, fail } = require("./response");
const { buildTxId, writeAuditLog_, buildLogSnapshot_, buildLogDiff_, nowIso, normalizeTaipeiTimestamp_ } = require("./bundles/shared");

const DOCS = {
  purchase_order: {
    table: "purchase_order",
    id: "po_id",
    fields: [
      "po_id", "supplier_id", "order_date", "expected_arrival_date", "status",
      "document_link", "remark", "created_by", "created_at", "updated_by", "updated_at",
      "system_remark"
    ],
    allowHardDelete: false
  },
  purchase_order_item: {
    table: "purchase_order_item",
    id: "po_item_id",
    fields: [
      "po_item_id", "po_id", "product_id", "order_qty", "received_qty", "unit", "remark",
      "created_by", "created_at", "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: true
  },
  import_document: {
    table: "import_document",
    id: "import_doc_id",
    fields: [
      "import_doc_id", "import_no", "import_date", "release_date", "supplier_id", "inspection_no",
      "status", "document_link", "remark", "created_by", "created_at", "updated_by", "updated_at",
      "system_remark"
    ],
    allowHardDelete: false
  },
  import_item: {
    table: "import_item",
    id: "import_item_id",
    fields: [
      "import_item_id", "import_doc_id", "item_no", "product_id", "hs_code", "invoice_no",
      "origin_country", "declared_qty", "declared_unit", "remark", "created_by", "created_at",
      "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: true
  },
  import_receipt: {
    table: "import_receipt",
    id: "import_receipt_id",
    fields: [
      "import_receipt_id", "import_doc_id", "transaction_id", "parent_ref_type", "parent_ref_id",
      "receipt_date", "warehouse", "status", "remark", "created_by", "created_at", "updated_by",
      "updated_at", "system_remark"
    ],
    allowHardDelete: false
  },
  import_receipt_item: {
    table: "import_receipt_item",
    id: "import_receipt_item_id",
    fields: [
      "import_receipt_item_id", "import_receipt_id", "import_item_id", "product_id", "transaction_id",
      "parent_ref_type", "parent_ref_id", "received_qty", "unit", "lot_id", "remark", "created_by",
      "created_at", "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: false
  },
  goods_receipt: {
    table: "goods_receipt",
    id: "gr_id",
    fields: [
      "gr_id", "po_id", "transaction_id", "parent_ref_type", "parent_ref_id", "receipt_date",
      "warehouse", "status", "remark", "created_by", "created_at", "updated_by", "updated_at",
      "system_remark"
    ],
    allowHardDelete: false
  },
  goods_receipt_item: {
    table: "goods_receipt_item",
    id: "gr_item_id",
    fields: [
      "gr_item_id", "gr_id", "po_id", "po_item_id", "product_id", "transaction_id",
      "parent_ref_type", "parent_ref_id", "received_qty", "unit", "lot_id", "remark",
      "created_by", "created_at", "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: false
  },
  sales_order: {
    table: "sales_order",
    id: "so_id",
    fields: [
      "so_id", "customer_id", "salesperson_id", "transaction_id", "parent_ref_type", "parent_ref_id",
      "so_type", "reship_ref_type", "reship_ref_id", "order_date", "currency", "status", "remark",
      "created_by", "created_at", "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: false
  },
  sales_order_item: {
    table: "sales_order_item",
    id: "so_item_id",
    fields: [
      "so_item_id", "so_id", "product_id", "transaction_id", "parent_ref_type", "parent_ref_id",
      "order_qty", "shipped_qty", "unit", "unit_price", "amount", "remark",
      "created_by", "created_at", "updated_by", "updated_at", "system_remark"
    ],
    allowHardDelete: true
  }
};

function pickRow(meta, params, mode) {
  const row = {};
  const actor = String(params.updated_by || params.created_by || "").trim();
  meta.fields.forEach((f) => {
    if (params[f] !== undefined && params[f] !== null && params[f] !== "") {
      row[f] = String(params[f]);
    }
  });
  if (mode === "create") {
    if (meta.fields.includes("status") && !row.status) row.status = "OPEN";
    if (meta.fields.includes("received_qty") && row.received_qty === undefined) {
      row.received_qty = "0";
    }
    if (meta.fields.includes("shipped_qty") && row.shipped_qty === undefined) {
      row.shipped_qty = "0";
    }
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

async function createDoc(sheetKey, p) {
  const meta = DOCS[sheetKey];
  if (!meta) return fail("Unknown doc: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");

  const sb = getSupabase();
  const { data: exists } = await sb.from(meta.table).select(meta.id).eq(meta.id, idVal).maybeSingle();
  if (exists) {
    return fail("同一主鍵已存在，請勿重複建立（" + meta.id + ": " + idVal + "）");
  }

  const row = pickRow(meta, p, "create");
  row[meta.id] = idVal;
  if (sheetKey === "sales_order" && !row.transaction_id) {
    row.transaction_id = buildTxId();
  }
  if (sheetKey === "sales_order_item") {
    if (!row.transaction_id && row.so_id) {
      const { data: so } = await sb.from("sales_order").select("transaction_id").eq("so_id", row.so_id).maybeSingle();
      if (so && so.transaction_id) row.transaction_id = String(so.transaction_id);
    }
    if (!row.parent_ref_type) row.parent_ref_type = "SO";
    if (!row.parent_ref_id && row.so_id) row.parent_ref_id = String(row.so_id);
  }
  const { error } = await sb.from(meta.table).insert(row);
  if (error) return fail(error.message || String(error));

  const actor = String(p.updated_by || p.created_by || "").trim();
  const newSnap = buildLogSnapshot_(row, meta.fields);
  await writeAuditLog_(meta.table, idVal, "CREATE", actor, newSnap, {});
  return ok({ message: "Created", source: "supabase" });
}

async function updateDoc(sheetKey, p) {
  const meta = DOCS[sheetKey];
  if (!meta) return fail("Unknown doc: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");

  const sb = getSupabase();
  const { data: old, error: getErr } = await sb.from(meta.table).select("*").eq(meta.id, idVal).maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!old) return fail("Record not found");

  const patch = pickRow(meta, p, "update");
  delete patch[meta.id];
  delete patch.created_at;
  delete patch.created_by;

  const { error } = await sb.from(meta.table).update(patch).eq(meta.id, idVal);
  if (error) return fail(error.message || String(error));

  const actor = String(p.updated_by || p.created_by || "").trim();
  const { oldOut, newOut } = buildLogDiff_(old, patch, meta.fields);
  await writeAuditLog_(meta.table, idVal, "UPDATE", actor, newOut, oldOut);
  return ok({ message: "Updated", source: "supabase" });
}

async function deleteDoc(sheetKey, p) {
  const meta = DOCS[sheetKey];
  if (!meta) return fail("Unknown doc: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");

  if (!meta.allowHardDelete) {
    return fail("Deletion is not allowed. Use status flow (CANCELLED/VOID) instead");
  }

  const sb = getSupabase();
  const { data: old, error: getErr } = await sb.from(meta.table).select("*").eq(meta.id, idVal).maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!old) return fail("Record not found");

  const actor = String(p.updated_by || p.created_by || "").trim();
  const { error } = await sb.from(meta.table).delete().eq(meta.id, idVal);
  if (error) return fail(error.message || String(error));

  const oldSnap = buildLogSnapshot_(old, meta.fields);
  await writeAuditLog_(meta.table, idVal, "DELETE", actor, {}, oldSnap);
  return ok({ message: "Deleted", source: "supabase" });
}

function docCrudHandlers() {
  const routes = {};
  Object.keys(DOCS).forEach((key) => {
    routes["create_" + key] = (p) => createDoc(key, p);
    routes["update_" + key] = (p) => updateDoc(key, p);
    routes["delete_" + key] = (p) => deleteDoc(key, p);
  });
  return routes;
}

module.exports = { DOCS, docCrudHandlers };
