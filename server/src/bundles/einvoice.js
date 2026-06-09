const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { nowIso, parseJsonArray, writeAuditLog_, buildId_ } = require("./shared");

function normEinvoiceType_(v) {
  const t = String(v || "").trim().toUpperCase();
  if (t === "B2B" || t === "B2C") return t;
  return "";
}

async function listEinvoiceLineByShipment(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const sb = getSupabase();
  const { data, error } = await sb
    .from("einvoice_line")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("line_no", { ascending: true });
  if (error) return fail(error.message || String(error));
  return ok({ data: data || [], source: "supabase" });
}

async function registerEinvoiceBundle(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const einvoiceNo = String(p.einvoice_no || "").trim().toUpperCase();
  if (!einvoiceNo) return fail("einvoice_no required");

  const einvoiceDate = String(p.einvoice_date || "").trim();
  if (!einvoiceDate) return fail("einvoice_date required");

  const einvoiceType = normEinvoiceType_(p.einvoice_type);
  if (!einvoiceType) return fail("einvoice_type must be B2B or B2C");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const taxId = String(p.einvoice_tax_id || "").trim();
  const buyerName = String(p.einvoice_buyer_name || "").trim();
  const buyerEmail = String(p.einvoice_buyer_email || "").trim();
  const randomCode = String(p.einvoice_random_code || "").trim();
  const carrierType = String(p.einvoice_carrier_type || "").trim().toUpperCase();
  const carrierId = String(p.einvoice_carrier_id || "").trim();
  const donateCode = String(p.einvoice_donate_code || "").trim();
  const remark = String(p.einvoice_remark || "").trim();

  if (einvoiceType === "B2B") {
    if (!taxId) return fail("B2B 發票需填買方統一編號（einvoice_tax_id）");
    if (!buyerName) return fail("B2B 發票需填發票抬頭（einvoice_buyer_name）");
  }

  if (einvoiceType === "B2C") {
    if (carrierType === "DONATE") {
      if (!donateCode) return fail("B2C 捐贈發票需填 einvoice_donate_code");
    } else if (carrierType && carrierType !== "PAPER" && carrierType !== "NONE") {
      if (!carrierId) return fail("B2C 載具需填 einvoice_carrier_id");
    }
  }

  const itemsPack = parseJsonArray(p.lines_json, "lines_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data || [];
  if (!items.length) return fail("lines_json required (at least 1 line)");

  const sb = getSupabase();
  const { data: sh, error: shErr } = await sb
    .from("shipment")
    .select("*")
    .eq("shipment_id", shipmentId)
    .maybeSingle();
  if (shErr) return fail(shErr.message || String(shErr));
  if (!sh) return fail("Shipment not found: " + shipmentId);

  const st = String(sh.status || "").trim().toUpperCase();
  if (st !== "POSTED") return fail("僅 POSTED 出貨單可登記發票（目前：" + st + "）");

  const { data: dup } = await sb
    .from("shipment")
    .select("shipment_id")
    .eq("einvoice_no", einvoiceNo)
    .neq("shipment_id", shipmentId)
    .maybeSingle();
  if (dup) return fail("發票號碼已被其他出貨單使用：" + einvoiceNo);

  let sumPretax = 0;
  let sumTax = 0;
  const lineRows = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = Number(it.qty != null ? it.qty : it.ship_qty || 0);
    if (!(qty > 0)) return fail("qty must be > 0 (lines[" + i + "])");

    const unitPrice = Number(it.unit_price || 0);
    const amount = Number(it.amount != null ? it.amount : qty * unitPrice);
    if (!(amount >= 0)) return fail("amount invalid (lines[" + i + "])");

    const taxType = String(it.tax_type || "TAXABLE").trim().toUpperCase();
    const taxRate = taxType === "TAXABLE" ? Number(it.tax_rate != null ? it.tax_rate : 0.05) : 0;
    const lineTax = Number(it.tax_amount != null ? it.tax_amount : amount * taxRate);

    sumPretax += amount;
    sumTax += lineTax;

    lineRows.push({
      einvoice_line_id: String(it.einvoice_line_id || buildId_("EIL")),
      shipment_id: shipmentId,
      einvoice_no: einvoiceNo,
      line_no: i + 1,
      shipment_item_id: String(it.shipment_item_id || "").trim(),
      so_item_id: String(it.so_item_id || "").trim(),
      product_id: String(it.product_id || "").trim().toUpperCase(),
      description: String(it.description || it.product_id || "").trim(),
      qty,
      unit: String(it.unit || "").trim(),
      unit_price: unitPrice,
      amount,
      tax_type: taxType,
      tax_rate: taxRate,
      tax_amount: lineTax,
      remark: String(it.remark || "").trim(),
      created_by: actor,
      created_at: nowIso(),
      updated_by: actor,
      updated_at: nowIso()
    });
  }

  let totalAmount = Number(p.einvoice_amount);
  let totalTax = Number(p.einvoice_tax_amount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    totalAmount = Math.round((sumPretax + sumTax) * 100) / 100;
  }
  if (!Number.isFinite(totalTax) || totalTax < 0) {
    totalTax = Math.round(sumTax * 100) / 100;
  }

  const ts = nowIso();
  const { error: updErr } = await sb
    .from("shipment")
    .update({
      einvoice_status: "ISSUED",
      einvoice_type: einvoiceType,
      einvoice_no: einvoiceNo,
      einvoice_date: einvoiceDate,
      einvoice_tax_id: taxId,
      einvoice_buyer_name: buyerName,
      einvoice_buyer_email: buyerEmail,
      einvoice_amount: totalAmount,
      einvoice_tax_amount: totalTax,
      einvoice_random_code: randomCode,
      einvoice_carrier_type: carrierType,
      einvoice_carrier_id: carrierId,
      einvoice_donate_code: donateCode,
      einvoice_remark: remark,
      einvoice_issued_by: actor,
      einvoice_issued_at: ts,
      updated_by: actor,
      updated_at: ts
    })
    .eq("shipment_id", shipmentId);
  if (updErr) return fail(updErr.message || String(updErr));

  const { error: delErr } = await sb.from("einvoice_line").delete().eq("shipment_id", shipmentId);
  if (delErr) return fail(delErr.message || String(delErr));

  const { error: insErr } = await sb.from("einvoice_line").insert(lineRows);
  if (insErr) return fail(insErr.message || String(insErr));

  await writeAuditLog_(
    "shipment",
    shipmentId,
    "REGISTER_EINVOICE",
    actor,
    einvoiceNo + " " + einvoiceType
  );

  return ok({
    shipment_id: shipmentId,
    einvoice_no: einvoiceNo,
    einvoice_status: "ISSUED",
    einvoice_type: einvoiceType,
    einvoice_amount: totalAmount,
    einvoice_tax_amount: totalTax,
    line_count: lineRows.length,
    source: "supabase"
  });
}

module.exports = {
  registerEinvoiceBundle,
  listEinvoiceLineByShipment
};
