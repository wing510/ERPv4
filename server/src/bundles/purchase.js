const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { buildId_, nowIso } = require("./shared");

function appendSystemRemark_(prev, line) {
  const a = String(prev || "").trim();
  const b = String(line || "").trim();
  if (!b) return a;
  return a ? a + "\n" + b : b;
}

async function hasActiveGoodsReceiptByPoId_(poId) {
  const id = String(poId || "").trim().toUpperCase();
  if (!id) return false;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("goods_receipt")
      .select("gr_id, status, po_id")
      .eq("po_id", id);
    if (error) return false;
    return (data || []).some((r) => {
      const st = String(r.status || "").trim().toUpperCase();
      return st && st !== "VOID" && st !== "CANCELLED";
    });
  } catch (_e) {
    return false;
  }
}

async function cancelPurchaseOrderBundle(p) {
  const poId = String(p.po_id || "").trim();
  if (!poId) return fail("po_id required");
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const sb = getSupabase();
  const { data: po, error: getErr } = await sb
    .from("purchase_order")
    .select("*")
    .eq("po_id", poId)
    .maybeSingle();
  if (getErr) return fail(getErr.message || String(getErr));
  if (!po) return fail("Purchase order not found");
  if (String(po.status || "").toUpperCase() === "CANCELLED") {
    return fail("Purchase order already CANCELLED");
  }
  if (await hasActiveGoodsReceiptByPoId_(poId)) {
    return fail("Cannot cancel: active goods receipts exist");
  }

  const note = String(p.cancel_note || "").trim();
  const line = "[作廢 " + nowIso() + " " + actor + "] " + (note || "");
  const { error } = await sb
    .from("purchase_order")
    .update({
      status: "CANCELLED",
      system_remark: appendSystemRemark_(po.system_remark, line.trim()),
      updated_by: actor,
      updated_at: nowIso()
    })
    .eq("po_id", poId);
  if (error) return fail(error.message || String(error));

  try {
    await sb.from("logs").insert({
      log_id: buildId_("LOG"),
      table_name: "purchase_order",
      reference_id: poId,
      action_type: "BUNDLE_CANCEL_PURCHASE_ORDER",
      old_value: "",
      new_value: note,
      created_by: actor,
      created_at: nowIso()
    });
  } catch (_e) {}

  return ok({ message: "CANCELLED", po_id: poId, source: "supabase" });
}

module.exports = { cancelPurchaseOrderBundle };
