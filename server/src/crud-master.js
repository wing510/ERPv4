const { getSupabase } = require("./supabase");
const { ok, fail } = require("./response");
const { writeAuditLog_, buildLogSnapshot_, buildLogDiff_, nowIso, normalizeTaipeiTimestamp_ } = require("./bundles/shared");
const { syncCustomerCumulativeTierIfNeeded_ } = require("./bundles/commercial-dealer");

const { isSuperAdminUserId_ } = require("./auth-config");

function assertUserIdMutable_(idVal, mode) {
  const id = String(idVal || "").trim().toLowerCase();
  if (isSuperAdminUserId_(idVal)) {
    throw new Error("Reserved user_id");
  }
  if (mode === "delete" && id === "admin") {
    throw new Error("Builtin admin account cannot be deleted");
  }
}

const MASTER = {
  product: {
    table: "product",
    id: "product_id",
    fields: [
      "product_id", "product_name", "product_name_en", "hs_code", "type", "spec", "unit", "suggested_retail_price", "uom_config",
      "status", "remark", "created_by", "created_at", "updated_by", "updated_at"
    ]
  },
  supplier: {
    table: "supplier",
    id: "supplier_id",
    fields: [
      "supplier_id", "supplier_name", "contact_person", "phone", "email", "address",
      "country", "supplier_type", "supplier_flow", "status", "remark",
      "created_by", "created_at", "updated_by", "updated_at"
    ]
  },
  customer: {
    table: "customer",
    id: "customer_id",
    nullableFields: [
      "dealer_cumulative_price_rate",
      "dealer_cumulative_pending_price_rate",
      "dealer_cumulative_started_at"
    ],
    fields: [
      "customer_id", "customer_name", "customer_type", "category", "contact_person", "phone", "email",
      "address", "country", "tax_id", "invoice_title", "invoice_email", "invoice_type_default",
      "invoice_name_en", "invoice_address_en",       "consignee_id_no", "consignee_usci", "consignment_allocation_policy",
      "dealer_scheme_id", "dealer_rebate_scheme_id", "dealer_cumulative_scheme_id",
      "dealer_rebate_settle_mode", "dealer_rebate_excluded", "dealer_rebate_credit_balance",
      "dealer_cumulative_amount", "dealer_cumulative_tier_label", "dealer_cumulative_price_rate",
      "dealer_cumulative_pending_tier_label", "dealer_cumulative_pending_price_rate",
      "dealer_cumulative_started_at",
      "status", "remark",
      "created_by", "created_at", "updated_by", "updated_at"
    ]
  },
  customer_recipient: {
    table: "customer_recipient",
    id: "recipient_id",
    fields: [
      "recipient_id", "customer_id", "recipient_name", "recipient_name_en", "address", "phone",
      "status", "remark",
      "created_by", "created_at", "updated_by", "updated_at"
    ]
  },
  warehouse: {
    table: "warehouse",
    id: "warehouse_id",
    fields: [
      "warehouse_id", "warehouse_name", "category", "address", "status", "remark",
      "created_by", "created_at", "updated_by", "updated_at"
    ]
  },
  user: {
    table: "erp_user",
    id: "user_id",
    fields: [
      "user_id", "user_name", "email", "role", "status", "allowed_modules", "remark",
      "created_by", "created_at", "updated_by", "updated_at"
    ]
  }
};

function pickRow(meta, params, mode) {
  const row = {};
  const actor = String(params.updated_by || params.created_by || "").trim();
  const nullable = new Set(meta.nullableFields || []);
  meta.fields.forEach((f) => {
    if (params[f] === undefined) return;
    const raw = params[f];
    const s = raw === null || raw === undefined ? "" : String(raw).trim();
    if (nullable.has(f) && (raw === null || s === "" || s.toLowerCase() === "null")) {
      row[f] = null;
      return;
    }
    row[f] = String(raw);
  });
  if (mode === "create") {
    if (!row.status) row.status = "ACTIVE";
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

async function createMaster(sheetKey, p) {
  const meta = MASTER[sheetKey];
  if (!meta) return fail("Unknown master: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");
  if (sheetKey === "user") {
    try {
      assertUserIdMutable_(idVal, "create");
    } catch (e) {
      return fail(e.message || String(e));
    }
    if (idVal.toLowerCase() === "admin") {
      return fail("Builtin admin already exists");
    }
  }

  const sb = getSupabase();
  const { data: exists } = await sb.from(meta.table).select(meta.id).eq(meta.id, idVal).maybeSingle();
  if (exists) {
    return fail("同一主鍵已存在，請勿重複建立（" + meta.id + ": " + idVal + "）");
  }

  const row = pickRow(meta, p, "create");
  row[meta.id] = idVal;
  const { error } = await sb.from(meta.table).insert(row);
  if (error) return fail(error.message || String(error));

  const actor = String(p.updated_by || p.created_by || "").trim();
  const newSnap = buildLogSnapshot_(row, meta.fields);
  await writeAuditLog_(meta.table, idVal, "CREATE", actor, newSnap, {});
  if (sheetKey === "customer") {
    try {
      await syncCustomerCumulativeTierIfNeeded_(sb, idVal, actor);
    } catch (_eCustTier) {}
  }
  return ok({ message: "Created", source: "supabase" });
}

async function updateMaster(sheetKey, p) {
  const meta = MASTER[sheetKey];
  if (!meta) return fail("Unknown master: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");
  if (sheetKey === "user") {
    try {
      assertUserIdMutable_(idVal, "update");
    } catch (e) {
      return fail(e.message || String(e));
    }
    if (idVal.toLowerCase() === "admin") {
      p.role = "GA";
      p.allowed_modules = "company_settings";
    }
  }

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
  if (sheetKey === "customer") {
    try {
      await syncCustomerCumulativeTierIfNeeded_(sb, idVal, actor);
    } catch (_eCustTier) {}
  }
  return ok({ message: "Updated", source: "supabase" });
}

async function deleteMaster(sheetKey, p) {
  const meta = MASTER[sheetKey];
  if (!meta) return fail("Unknown master: " + sheetKey);
  const idVal = String(p[meta.id] || "").trim();
  if (!idVal) return fail(meta.id + " required");
  if (sheetKey === "user") {
    try {
      assertUserIdMutable_(idVal, "delete");
    } catch (e) {
      return fail(e.message || String(e));
    }
  }

  const sb = getSupabase();
  const { data: old, error: getErr } = await sb.from(meta.table).select("*").eq(meta.id, idVal).maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!old) return fail("Record not found");

  if (String(old.status || "").trim().toUpperCase() === "VOID") {
    return ok({ message: "Deleted", source: "supabase" });
  }

  const actor = String(p.updated_by || p.created_by || "").trim();
  const { error } = await sb
    .from(meta.table)
    .update({
      status: "VOID",
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq(meta.id, idVal);
  if (error) return fail(error.message || String(error));

  const oldSnap = buildLogSnapshot_(old, meta.fields);
  await writeAuditLog_(meta.table, idVal, "DELETE", actor, { status: "VOID" }, oldSnap);
  return ok({ message: "Deleted", source: "supabase" });
}

function masterCrudHandlers() {
  const routes = {};
  Object.keys(MASTER).forEach((key) => {
    routes["create_" + key] = (p) => createMaster(key, p);
    routes["update_" + key] = (p) => updateMaster(key, p);
    routes["delete_" + key] = (p) => deleteMaster(key, p);
  });
  return routes;
}

module.exports = { MASTER, masterCrudHandlers, createMaster, updateMaster, deleteMaster };
