const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const {
  nowIso,
  buildTxId,
  buildId_,
  parseJsonArray,
  appendSystemRemark_,
  writeAuditLog_
} = require("./shared");
const { computeSalesOrderPromoLine_ } = require("./consignment-promo");

const SO_PRICING_ENGINE_VERSION = "SO_PRICING_ENGINE_V1";

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

async function nextPricingVersionForSoItem_(sb, soItemId) {
  const sid = String(soItemId || "").trim().toUpperCase();
  if (!sid) return 1;
  const { data, error } = await sb
    .from("so_item_pricing_snapshot")
    .select("pricing_version")
    .eq("so_item_id", sid)
    .order("pricing_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && !/does not exist|Could not find|relation .* does not exist/i.test(error.message || "")) {
    throw new Error(error.message || String(error));
  }
  const cur = Number(data?.pricing_version || 0);
  return cur > 0 ? cur + 1 : 1;
}

/** Phase1：建立 immutable SO Pricing Snapshot（dealer/base）；已被 Shipment 引用之 version 永不覆寫 */
async function insertSoItemPricingSnapshot_(sb, opts) {
  const o = opts || {};
  const soItemId = String(o.soItemId || "").trim().toUpperCase();
  const soId = String(o.soId || "").trim().toUpperCase();
  if (!soItemId || !soId) throw new Error("soItemId and soId required for pricing snapshot");

  const pricingVersion = o.pricingVersion != null ? Number(o.pricingVersion) : 1;
  const snapId = buildId_("SOPS");
  const ts = o.ts || nowIso();
  const row = {
    pricing_snapshot_id: snapId,
    so_item_id: soItemId,
    so_id: soId,
    pricing_version: pricingVersion,
    dealer_tier_label: String(o.dealerTierLabel || "").trim(),
    dealer_price_rate: o.dealerPriceRate != null && o.dealerPriceRate !== "" ? Number(o.dealerPriceRate) : null,
    dealer_price_source: String(o.dealerPriceSource || "").trim(),
    base_price_basis: String(o.basePriceBasis || "DEALER").trim().toUpperCase() || "DEALER",
    list_unit_price: Math.round(Number(o.listUnitPrice || 0) * 100) / 100,
    base_unit_price: Math.round(Number(o.baseUnitPrice || 0) * 100) / 100,
    pricing_engine_version: String(o.pricingEngineVersion || SO_PRICING_ENGINE_VERSION),
    snapshot_ts: ts,
    created_by: String(o.actor || "").trim(),
    created_at: ts
  };
  const { error } = await sb.from("so_item_pricing_snapshot").insert(row);
  if (error) throw new Error(error.message || String(error));
  return row;
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
  const { data: soHeader, error: soHeaderErr } = await sb
    .from("sales_order")
    .select("customer_id, order_date, so_type")
    .eq("so_id", soId)
    .maybeSingle();
  if (soHeaderErr) return fail(soHeaderErr.message || String(soHeaderErr));
  const soType = String(soHeader?.so_type || "NORMAL").trim().toUpperCase();
  const customerId = String(soHeader?.customer_id || "").trim().toUpperCase();
  const orderDate = String(soHeader?.order_date || "").trim().slice(0, 10);

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

    const soItemId = "SOI-" + soId + "-" + String(i + 1).padStart(3, "0");
    const insertRow = {
      so_item_id: soItemId,
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
    };

    let computed = null;
    if (soType === "NORMAL" && customerId && orderDate) {
      try {
        computed = await computeSalesOrderPromoLine_(sb, {
          customerId,
          orderDate,
          productId: pid,
          orderQty: oq,
          unitPriceHint: Number.isNaN(up) ? 0 : up,
          authoritative: true
        });
        // SO 層：權威底價來自 Server；促銷欄位僅 preview/相容顯示（財務促銷在 Shipment 層）
        if (computed && computed.base_unit_price != null) insertRow.base_unit_price = computed.base_unit_price;
        if (computed && computed.unit_price != null) insertRow.unit_price = computed.unit_price;
        if (computed && computed.amount != null) insertRow.amount = computed.amount;
        if (computed && computed.billable_qty != null) insertRow.billable_qty = computed.billable_qty;
        if (computed && computed.free_qty != null) insertRow.free_qty = computed.free_qty;
        if (computed && String(computed.promo_scheme_id || "").trim()) {
          insertRow.promo_scheme_id = computed.promo_scheme_id;
          insertRow.promo_scheme_name = computed.promo_scheme_name;
          insertRow.promo_type = computed.promo_type;
          insertRow.promo_price_basis = computed.promo_price_basis;
          if (computed.promo_buy_qty != null) insertRow.promo_buy_qty = computed.promo_buy_qty;
          if (computed.promo_scheme_free_qty != null) insertRow.promo_scheme_free_qty = computed.promo_scheme_free_qty;
        }
      } catch (promoErr) {
        return fail("促銷計價失敗：" + (promoErr?.message || String(promoErr)));
      }
    }

    // Phase1：SO Pricing Snapshot（dealer/base）identity + version
    if (soType === "NORMAL" && customerId && orderDate && computed) {
      try {
        const snap = await insertSoItemPricingSnapshot_(sb, {
          soItemId,
          soId,
          pricingVersion: 1,
          dealerTierLabel: computed.dealer_tier_label,
          dealerPriceRate: computed.dealer_price_rate,
          dealerPriceSource: computed.dealer_price_source,
          basePriceBasis: computed.base_price_basis || computed.promo_price_basis || "DEALER",
          listUnitPrice: computed.list_unit_price,
          baseUnitPrice: computed.base_unit_price,
          actor
        });
        insertRow.pricing_snapshot_id = snap.pricing_snapshot_id;
        insertRow.pricing_version = snap.pricing_version;
      } catch (snapErr) {
        if (/does not exist|relation .* does not exist|Could not find/i.test(snapErr?.message || "")) {
          return fail(
            "計價快照表尚未建置，請先執行 server/sql/v4.2.15.00_銷售與出貨計價快照.sql：" +
              (snapErr?.message || String(snapErr))
          );
        }
        return fail("建立計價快照失敗：" + (snapErr?.message || String(snapErr)));
      }
    }

    const { error: insErr } = await sb.from("sales_order_item").insert(insertRow);
    if (insErr) return fail(insErr.message || String(insErr));
  }

  return ok({ message: "RESET", so_id: soId, count: items.length, pricing_engine: SO_PRICING_ENGINE_VERSION });
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
  cancelSalesOrderBundle,
  insertSoItemPricingSnapshot_,
  nextPricingVersionForSoItem_,
  SO_PRICING_ENGINE_VERSION
};
