const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  buildTxId,
  parseJsonArray,
  appendSystemRemark_,
  writeAuditLog_
} = require("./shared");

function calcSalesOrderStatus_(items) {
  const rows = items || [];
  if (!rows.length) return "OPEN";
  const allShipped = rows.every((x) => Number(x.shipped_qty || 0) >= Number(x.order_qty || 0));
  const anyShipped = rows.some((x) => Number(x.shipped_qty || 0) > 0);
  if (allShipped) return "SHIPPED";
  if (anyShipped) return "PARTIAL";
  return "OPEN";
}

async function ensureSalesOrderTx_(soId, actor) {
  const sid = String(soId || "").trim().toUpperCase();
  if (!sid) return "";
  const sb = getSupabase();
  const { data: so } = await sb.from("sales_order").select("transaction_id").eq("so_id", sid).maybeSingle();
  if (!so) return buildTxId();
  const existed = String(so.transaction_id || "").trim();
  if (existed) return existed;
  const next = buildTxId();
  await sb
    .from("sales_order")
    .update({
      transaction_id: next,
      updated_by: actor || "",
      updated_at: nowIso()
    })
    .eq("so_id", sid);
  return next;
}

async function hasShipmentBySoId_(soId) {
  const sid = String(soId || "").trim().toUpperCase();
  if (!sid) return false;
  const sb = getSupabase();
  const { count } = await sb
    .from("shipment_item")
    .select("*", { count: "exact", head: true })
    .eq("so_id", sid);
  return (count || 0) > 0;
}

async function hasActiveShipmentBySoId_(soId) {
  const sid = String(soId || "").trim().toUpperCase();
  if (!sid) return false;
  const sb = getSupabase();
  const { data } = await sb.from("shipment").select("shipment_id, status").eq("so_id", sid);
  return (data || []).some((s) => String(s.status || "").trim().toUpperCase() !== "CANCELLED");
}

async function resetSalesOrderItemsCmd(p) {
  const soId = String(p.so_id || "").trim().toUpperCase();
  if (!soId) return fail("so_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  if (await hasShipmentBySoId_(soId)) {
    return fail("Sales order already has shipment records. Reset items is not allowed.");
  }

  const itemsPack = parseJsonArray(p.items_json, "items_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data;
  if (!items.length) return fail("items_json required");

  const sb = getSupabase();
  const { error: delErr } = await sb.from("sales_order_item").delete().eq("so_id", soId);
  if (delErr) return fail(delErr.message || String(delErr));

  const txId = (await ensureSalesOrderTx_(soId, actor)) || buildTxId();

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const pid = String(it.product_id || "").trim().toUpperCase();
    const oq = Number(it.order_qty || 0);
    const unit = String(it.unit || "").trim();
    const up = Number(it.unit_price || 0);
    const amt = Number(it.amount || 0);
    if (!pid) return fail("product_id required (items[" + i + "])");
    if (!(oq > 0)) return fail("order_qty must be > 0 (items[" + i + "])");
    if (!unit) return fail("unit required (items[" + i + "])");

    const { error: insErr } = await sb.from("sales_order_item").insert({
      so_item_id: "SOI-" + soId + "-" + String(i + 1).padStart(3, "0"),
      so_id: soId,
      product_id: pid,
      transaction_id: txId,
      parent_ref_type: "SO",
      parent_ref_id: soId,
      order_qty: oq,
      shipped_qty: 0,
      unit: unit,
      unit_price: Number.isNaN(up) ? 0 : up,
      amount: Number.isNaN(amt) ? 0 : amt,
      remark: String(it.remark || ""),
      created_by: actor,
      created_at: nowIso(),
      updated_by: "",
      updated_at: null
    });
    if (insErr) return fail(insErr.message || String(insErr));
  }

  return ok({ message: "RESET", so_id: soId, count: items.length });
}

async function cancelSalesOrderBundle(p) {
  const soId = String(p.so_id || "").trim().toUpperCase();
  if (!soId) return fail("so_id required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: so, error: soErr } = await sb.from("sales_order").select("*").eq("so_id", soId).maybeSingle();
  if (soErr) return fail(soErr.message || String(soErr));
  if (!so) return fail("Sales order not found");
  if (String(so.status || "").toUpperCase() === "CANCELLED") return fail("Sales order already CANCELLED");
  if (await hasActiveShipmentBySoId_(soId)) {
    return fail("Cannot cancel: active shipments exist");
  }

  const note = String(p.cancel_note || "").trim();
  const line = "[作廢 " + nowIso() + " " + actor + "] " + (note || "");
  const { error: updErr } = await sb
    .from("sales_order")
    .update({
      status: "CANCELLED",
      system_remark: appendSystemRemark_(so.system_remark, line.trim()),
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("so_id", soId);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_("sales_order", soId, "BUNDLE_CANCEL_SALES_ORDER", actor, JSON.stringify({ so_id: soId }));

  return ok({ message: "CANCELLED", so_id: soId });
}

module.exports = {
  calcSalesOrderStatus_,
  ensureSalesOrderTx_,
  resetSalesOrderItemsCmd,
  cancelSalesOrderBundle
};
