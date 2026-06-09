const { getSupabase } = require("./supabase");
const { ok, fail } = require("./response");
const { writeAuditLog_, buildLogDiff_ } = require("./bundles/shared");
const { createInventoryMovementUnlocked_ } = require("./inventory-movement-core");

const LOT_FIELDS = [
  "lot_id",
  "product_id",
  "warehouse_id",
  "source_type",
  "source_id",
  "qty",
  "unit",
  "type",
  "status",
  "inventory_status",
  "received_date",
  "manufacture_date",
  "expiry_date",
  "remark",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "system_remark"
];

const LOT_NULLABLE_ON_EMPTY = new Set([
  "manufacture_date",
  "expiry_date",
  "received_date",
  "remark",
  "system_remark",
  "type"
]);

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

function pickLotPatch_(p) {
  const patch = {};
  const actor = String(p.updated_by || p.created_by || "").trim();
  LOT_FIELDS.forEach((f) => {
    if (f === "lot_id" || f === "created_at" || f === "created_by") return;
    if (p[f] === undefined || p[f] === null) return;
    const v = String(p[f]);
    if (v === "" && LOT_NULLABLE_ON_EMPTY.has(f)) {
      patch[f] = null;
      return;
    }
    if (v !== "") patch[f] = v;
  });
  if (actor) patch.updated_by = actor;
  patch.updated_at = nowIso();
  return patch;
}

async function updateLot(p) {
  const lotId = String(p.lot_id || "").trim();
  if (!lotId) return fail("lot_id required");

  const sb = getSupabase();
  const { data: old, error: getErr } = await sb.from("lot").select("*").eq("lot_id", lotId).maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!old) return fail("Record not found");

  const patch = pickLotPatch_(p);
  if (!Object.keys(patch).length) return fail("No fields to update");

  const { error } = await sb.from("lot").update(patch).eq("lot_id", lotId);
  if (error) return fail(error.message || String(error));

  const actor = String(p.updated_by || p.created_by || "").trim();
  const { oldOut, newOut } = buildLogDiff_(old, patch, LOT_FIELDS);
  await writeAuditLog_("lot", lotId, "UPDATE", actor, newOut, oldOut);
  return ok({ message: "Updated", source: "supabase" });
}

async function rebuildLotBalance_(p) {
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const sb = getSupabase();
  const { data: movs, error: movErr } = await sb.from("inventory_movement").select("lot_id, qty, movement_id");
  if (movErr) return fail(movErr.message || String(movErr));

  const map = {};
  const counts = {};
  let lastMv = {};
  (movs || []).forEach((r) => {
    const id = String(r.lot_id || "").trim();
    if (!id) return;
    const q = Number(r.qty || 0);
    if (Number.isNaN(q)) return;
    map[id] = (map[id] || 0) + q;
    counts[id] = (counts[id] || 0) + 1;
    const mid = String(r.movement_id || "");
    if (mid) lastMv[id] = mid;
  });

  const { error: delErr } = await sb.from("lot_balance").delete().neq("lot_id", "");
  if (delErr) return fail(delErr.message || String(delErr));

  const lotIds = Object.keys(map).sort();
  if (lotIds.length > 0) {
    const rows = lotIds.map((lotId) => ({
      lot_id: lotId,
      available_qty: map[lotId],
      movement_count: counts[lotId] || 1,
      last_movement_id: lastMv[lotId] || null,
      updated_at: new Date().toISOString(),
      updated_by: actor
    }));
    const { error: insErr } = await sb.from("lot_balance").insert(rows);
    if (insErr) return fail(insErr.message || String(insErr));
  }

  await writeAuditLog_(
    "lot_balance",
    "ALL",
    "REBUILD_LOT_BALANCE",
    actor,
    JSON.stringify({ rebuilt: lotIds.length })
  );
  return ok({
    rebuilt: lotIds.length,
    balance_source: "lot_balance",
    source: "supabase"
  });
}

async function createInventoryMovement(p) {
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");
  const result = await createInventoryMovementUnlocked_(p);
  if (!result || result.success === false) return result;
  await writeAuditLog_(
    "inventory_movement",
    result.movement_id,
    "CREATE",
    actor,
    JSON.stringify({
      movement_id: result.movement_id,
      lot_id: String(p.lot_id || ""),
      qty: String(p.qty != null ? p.qty : ""),
      movement_type: String(p.movement_type || p.type || "")
    })
  );
  return ok({ message: "Created", movement_id: result.movement_id, source: "supabase" });
}

function inventoryCrudHandlers() {
  return {
    update_lot: updateLot,
    create_inventory_movement: createInventoryMovement,
    admin_rebuild_lot_balance: rebuildLotBalance_,
    dev_rebuild_lot_balance: rebuildLotBalance_
  };
}

module.exports = {
  inventoryCrudHandlers,
  updateLot,
  rebuildLotBalance_,
  createInventoryMovement
};
