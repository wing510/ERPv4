const { getSupabase } = require("../supabase");
const { ok, fail } = require("../response");
const { nowIso, parseJsonArray, writeAuditLog_, buildId_ } = require("./shared");

const PROFILE_ID = "DEFAULT";

async function getCompanyProfile(_p) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("erp_company_profile")
    .select("*")
    .eq("profile_id", PROFILE_ID)
    .maybeSingle();
  if (error) return fail(error.message || String(error));
  if (!data) {
    return ok({
      profile_id: PROFILE_ID,
      company_name_zh: "",
      company_name_en: "",
      address_zh: "",
      address_en: "",
      city_zh: "",
      city_en: "",
      country_zh: "台灣",
      country_en: "Taiwan",
      default_currency: "USD",
      default_country_of_origin: "Taiwan",
      source: "supabase"
    });
  }
  return ok({ ...data, source: "supabase" });
}

async function updateCompanyProfile(p) {
  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("updated_by required");

  const row = {
    profile_id: PROFILE_ID,
    company_name_zh: String(p.company_name_zh || "").trim(),
    company_name_en: String(p.company_name_en || "").trim(),
    address_zh: String(p.address_zh || "").trim(),
    address_en: String(p.address_en || "").trim(),
    city_zh: String(p.city_zh || "").trim(),
    city_en: String(p.city_en || "").trim(),
    country_zh: String(p.country_zh || "台灣").trim(),
    country_en: String(p.country_en || "Taiwan").trim(),
    postal_code: String(p.postal_code || "").trim(),
    phone: String(p.phone || "").trim(),
    email: String(p.email || "").trim(),
    tax_id: String(p.tax_id || "").trim(),
    default_currency: String(p.default_currency || "USD").trim().toUpperCase(),
    default_country_of_origin: String(p.default_country_of_origin || "Taiwan").trim(),
    default_incoterms: String(p.default_incoterms || "").trim(),
    declaration_text: String(
      p.declaration_text || "I declare that the information is true and correct."
    ).trim(),
    remark: String(p.remark || "").trim(),
    updated_by: actor,
    updated_at: nowIso()
  };

  const sb = getSupabase();
  const { error } = await sb.from("erp_company_profile").upsert(row, { onConflict: "profile_id" });
  if (error) return fail(error.message || String(error));

  await writeAuditLog_(
    "erp_company_profile",
    PROFILE_ID,
    "UPDATE_COMPANY_PROFILE",
    actor,
    JSON.stringify({
      profile_id: PROFILE_ID,
      company_name_zh: row.company_name_zh,
      company_name_en: row.company_name_en,
      phone: row.phone,
      email: row.email,
      tax_id: row.tax_id,
      default_currency: row.default_currency,
      default_incoterms: row.default_incoterms,
      default_country_of_origin: row.default_country_of_origin
    })
  );
  return ok({ profile_id: PROFILE_ID, source: "supabase" });
}

async function listCommercialInvoiceLines_(ciId) {
  const sb = getSupabase();
  const { data: lines, error: lineErr } = await sb
    .from("commercial_invoice_line")
    .select("*")
    .eq("ci_id", ciId)
    .order("line_no", { ascending: true });
  if (lineErr) return { err: lineErr.message || String(lineErr) };
  return { lines: lines || [] };
}

async function listCommercialInvoiceByShipment(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const sb = getSupabase();
  const { data: ci, error } = await sb
    .from("commercial_invoice")
    .select("*")
    .eq("shipment_id", shipmentId)
    .maybeSingle();
  if (error) return fail(error.message || String(error));
  if (!ci) return ok({ data: null, lines: [], source: "supabase" });

  const linePack = await listCommercialInvoiceLines_(ci.ci_id);
  if (linePack.err) return fail(linePack.err);

  return ok({ data: ci, lines: linePack.lines, source: "supabase" });
}

async function listCommercialInvoiceBlankLines_(ciId) {
  const sb = getSupabase();
  const { data: lines, error: lineErr } = await sb
    .from("commercial_invoice_blank_line")
    .select("*")
    .eq("ci_id", ciId)
    .order("line_no", { ascending: true });
  if (lineErr) return { err: lineErr.message || String(lineErr) };
  return { lines: lines || [] };
}

async function listCommercialInvoiceBlankByCi(p) {
  const ciId = String(p.ci_id || "").trim();
  if (!ciId) return fail("ci_id required");

  const sb = getSupabase();
  const { data: ci, error } = await sb
    .from("commercial_invoice_blank")
    .select("*")
    .eq("ci_id", ciId)
    .maybeSingle();
  if (error) return fail(error.message || String(error));
  if (!ci) return ok({ data: null, lines: [], source: "supabase" });

  const linePack = await listCommercialInvoiceBlankLines_(ci.ci_id);
  if (linePack.err) return fail(linePack.err);

  return ok({ data: ci, lines: linePack.lines, source: "supabase" });
}

/** @deprecated 相容舊 action 名稱 */
async function listCommercialInvoiceByCi(p) {
  return listCommercialInvoiceBlankByCi(p);
}

async function ciNoTakenGlobally_(sb, ciNo, excludeCiId) {
  const id = String(excludeCiId || "").trim();
  let q1 = sb.from("commercial_invoice").select("ci_id").eq("ci_no", ciNo);
  if (id) q1 = q1.neq("ci_id", id);
  const { data: dupShip } = await q1.maybeSingle();
  if (dupShip) return true;

  let q2 = sb.from("commercial_invoice_blank").select("ci_id").eq("ci_no", ciNo);
  if (id) q2 = q2.neq("ci_id", id);
  const { data: dupBlank } = await q2.maybeSingle();
  return !!dupBlank;
}

function buildCommercialInvoiceLineRows_(ciId, items, actor) {
  let subtotal = 0;
  const lineRows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = Number(it.qty != null ? it.qty : it.ship_qty || 0);
    if (!(qty > 0)) return { err: "qty must be > 0 (lines[" + i + "])" };

    const unitPrice = Number(it.unit_price || 0);
    const amount = Number(it.amount != null ? it.amount : qty * unitPrice);
    subtotal += amount;

    lineRows.push({
      ci_line_id: String(it.ci_line_id || buildId_("CIL")),
      ci_id: ciId,
      line_no: i + 1,
      shipment_item_id: String(it.shipment_item_id || "").trim(),
      so_item_id: String(it.so_item_id || "").trim(),
      product_id: String(it.product_id || "").trim().toUpperCase(),
      description_en: String(it.description_en || it.description || it.product_id || "").trim(),
      hs_code: String(it.hs_code || "").trim(),
      qty,
      unit: String(it.unit || "").trim(),
      unit_price: unitPrice,
      amount,
      remark: String(it.remark || "").trim(),
      created_by: actor,
      created_at: nowIso(),
      updated_by: actor,
      updated_at: nowIso()
    });
  }
  return { lineRows, subtotal };
}

function buildCommercialInvoiceHeader_(ciId, p, existed, actor, ts, opts) {
  const shipmentId = String(opts.shipmentId || "").trim().toUpperCase();
  const soId = String(p.so_id || opts.soId || "").trim().toUpperCase();
  const ciNo = String(p.ci_no || "").trim();
  const ciDate = String(p.ci_date || "").trim();
  const subtotal = opts.subtotal;
  let totalAmount = Number(p.total_amount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    totalAmount = Math.round(subtotal * 100) / 100;
  }

  const header = {
    ci_id: ciId,
    shipment_id: shipmentId,
    so_id: soId,
    ci_no: ciNo,
    ci_date: ciDate,
    status: "ISSUED",
    currency: String(p.currency || "USD").trim().toUpperCase(),
    incoterms: String(p.incoterms || "").trim(),
    waybill_no: String(p.waybill_no || "").trim(),
    country_of_origin: String(p.country_of_origin || "Taiwan").trim(),
    seller_company_name_en: String(p.seller_company_name_en || "").trim(),
    seller_address_en: String(p.seller_address_en || "").trim(),
    seller_phone: String(p.seller_phone || "").trim(),
    seller_email: String(p.seller_email || "").trim(),
    seller_tax_id: String(p.seller_tax_id || "").trim(),
    buyer_name_en: String(p.buyer_name_en || "").trim(),
    buyer_address_en: String(p.buyer_address_en || "").trim(),
    buyer_phone: String(p.buyer_phone || "").trim(),
    buyer_country: String(p.buyer_country || "").trim(),
    buyer_id_no: String(p.buyer_id_no || "").trim(),
    buyer_usci: String(p.buyer_usci || "").trim(),
    subtotal: Math.round(subtotal * 100) / 100,
    total_amount: totalAmount,
    payment_terms: String(p.payment_terms || "").trim(),
    remark: String(p.remark || "").trim(),
    signature_name: String(p.signature_name || "").trim(),
    signature_date: String(p.signature_date || ciDate).trim(),
    declaration_text: String(
      p.declaration_text || "I declare that the information on this invoice is true and correct."
    ).trim(),
    issued_by: actor,
    issued_at: ts,
    updated_by: actor,
    updated_at: ts
  };

  if (existed) {
    header.created_by = existed.created_by || actor;
    header.created_at = existed.created_at || ts;
  } else {
    header.created_by = actor;
    header.created_at = ts;
  }
  return { header, totalAmount };
}

function buildBlankCommercialInvoiceHeader_(ciId, p, existed, actor, ts, subtotal) {
  const built = buildCommercialInvoiceHeader_(ciId, p, existed, actor, ts, {
    shipmentId: "",
    soId: "",
    subtotal
  });
  delete built.header.shipment_id;
  delete built.header.so_id;
  return built;
}

function buildBlankCommercialInvoiceLineRows_(ciId, items, actor) {
  const pack = buildCommercialInvoiceLineRows_(ciId, items, actor);
  if (pack.err) return pack;
  const lineRows = (pack.lineRows || []).map((row) => {
    const out = { ...row };
    delete out.shipment_item_id;
    delete out.so_item_id;
    return out;
  });
  return { lineRows, subtotal: pack.subtotal };
}

async function persistCommercialInvoice_(ciId, header, lineRows, actor, auditExtra) {
  const sb = getSupabase();
  const { data: existed } = await sb.from("commercial_invoice").select("ci_id").eq("ci_id", ciId).maybeSingle();

  if (existed) {
    const { error: updErr } = await sb.from("commercial_invoice").update(header).eq("ci_id", ciId);
    if (updErr) return fail(updErr.message || String(updErr));
  } else {
    const { error: insErr } = await sb.from("commercial_invoice").insert(header);
    if (insErr) return fail(insErr.message || String(insErr));
  }

  const { error: delErr } = await sb.from("commercial_invoice_line").delete().eq("ci_id", ciId);
  if (delErr) return fail(delErr.message || String(delErr));

  const { error: lineInsErr } = await sb.from("commercial_invoice_line").insert(lineRows);
  if (lineInsErr) return fail(lineInsErr.message || String(lineInsErr));

  await writeAuditLog_("commercial_invoice", ciId, "SAVE_COMMERCIAL_INVOICE", actor, JSON.stringify(auditExtra));
  return ok({
    ci_id: ciId,
    shipment_id: header.shipment_id,
    ci_no: header.ci_no,
    status: header.status,
    total_amount: header.total_amount,
    line_count: lineRows.length,
    source: "supabase"
  });
}

async function persistBlankCommercialInvoice_(ciId, header, lineRows, actor, auditExtra) {
  const sb = getSupabase();
  const { data: existed } = await sb
    .from("commercial_invoice_blank")
    .select("ci_id")
    .eq("ci_id", ciId)
    .maybeSingle();

  if (existed) {
    const { error: updErr } = await sb.from("commercial_invoice_blank").update(header).eq("ci_id", ciId);
    if (updErr) return fail(updErr.message || String(updErr));
  } else {
    const { error: insErr } = await sb.from("commercial_invoice_blank").insert(header);
    if (insErr) return fail(insErr.message || String(insErr));
  }

  const { error: delErr } = await sb.from("commercial_invoice_blank_line").delete().eq("ci_id", ciId);
  if (delErr) return fail(delErr.message || String(delErr));

  const { error: lineInsErr } = await sb.from("commercial_invoice_blank_line").insert(lineRows);
  if (lineInsErr) return fail(lineInsErr.message || String(lineInsErr));

  await writeAuditLog_(
    "commercial_invoice_blank",
    ciId,
    "SAVE_COMMERCIAL_INVOICE_BLANK",
    actor,
    JSON.stringify(auditExtra)
  );
  return ok({
    ci_id: ciId,
    ci_no: header.ci_no,
    status: header.status,
    table: "commercial_invoice_blank",
    total_amount: header.total_amount,
    line_count: lineRows.length,
    source: "supabase"
  });
}

async function saveCommercialInvoiceBundle(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  if (!shipmentId) return fail("shipment_id required");

  const ciNo = String(p.ci_no || "").trim();
  if (!ciNo) return fail("ci_no required");

  const ciDate = String(p.ci_date || "").trim();
  if (!ciDate) return fail("ci_date required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

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
  if (st !== "POSTED") return fail("僅 POSTED 出貨單可開立 Commercial Invoice（目前：" + st + "）");

  let ciId = String(p.ci_id || "").trim();
  const { data: existed } = await sb
    .from("commercial_invoice")
    .select("*")
    .eq("shipment_id", shipmentId)
    .maybeSingle();

  if (existed) {
    ciId = existed.ci_id;
  }
  if (!ciId) ciId = buildId_("CI");

  if (await ciNoTakenGlobally_(sb, ciNo, ciId)) {
    return fail("Invoice No. already used: " + ciNo);
  }

  const linePack = buildCommercialInvoiceLineRows_(ciId, items, actor);
  if (linePack.err) return fail(linePack.err);

  const ts = nowIso();
  const built = buildCommercialInvoiceHeader_(ciId, p, existed, actor, ts, {
    shipmentId,
    soId: String(p.so_id || sh.so_id || "").trim().toUpperCase(),
    subtotal: linePack.subtotal
  });

  return persistCommercialInvoice_(ciId, built.header, linePack.lineRows, actor, {
    ci_id: ciId,
    ci_no: ciNo,
    shipment_id: shipmentId,
    so_id: built.header.so_id,
    status: "ISSUED",
    currency: built.header.currency,
    total_amount: built.totalAmount,
    line_count: linePack.lineRows.length
  });
}

async function saveStandaloneCommercialInvoiceBundle(p) {
  const ciNo = String(p.ci_no || "").trim();
  if (!ciNo) return fail("ci_no required");

  const ciDate = String(p.ci_date || "").trim();
  if (!ciDate) return fail("ci_date required");

  const actor = String(p.updated_by || p.created_by || "").trim();
  if (!actor) return fail("created_by required");

  const itemsPack = parseJsonArray(p.lines_json, "lines_json");
  if (itemsPack.err) return fail(itemsPack.err);
  const items = itemsPack.data || [];
  if (!items.length) return fail("lines_json required (at least 1 line)");

  const sb = getSupabase();
  let ciId = String(p.ci_id || "").trim();
  let existed = null;

  if (ciId) {
    const { data, error } = await sb
      .from("commercial_invoice_blank")
      .select("*")
      .eq("ci_id", ciId)
      .maybeSingle();
    if (error) return fail(error.message || String(error));
    if (!data) return fail("Commercial Invoice (blank) not found: " + ciId);
    existed = data;
  }

  if (await ciNoTakenGlobally_(sb, ciNo, ciId)) {
    return fail("Invoice No. already used: " + ciNo);
  }

  if (!ciId) ciId = buildId_("CI");

  const linePack = buildBlankCommercialInvoiceLineRows_(ciId, items, actor);
  if (linePack.err) return fail(linePack.err);

  const ts = nowIso();
  const built = buildBlankCommercialInvoiceHeader_(ciId, p, existed, actor, ts, linePack.subtotal);

  return persistBlankCommercialInvoice_(ciId, built.header, linePack.lineRows, actor, {
    ci_id: ciId,
    ci_no: ciNo,
    table: "commercial_invoice_blank",
    status: "ISSUED",
    currency: built.header.currency,
    total_amount: built.totalAmount,
    line_count: linePack.lineRows.length
  });
}

async function voidCommercialInvoiceBundle(p) {
  const shipmentId = String(p.shipment_id || "").trim().toUpperCase();
  const ciIdIn = String(p.ci_id || "").trim();
  const actor = String(p.updated_by || "").trim();
  if (!actor) return fail("updated_by required");
  if (!shipmentId && !ciIdIn) return fail("shipment_id or ci_id required");

  const sb = getSupabase();
  let ci = null;
  let blankTable = false;
  if (ciIdIn) {
    const { data: blank, error: blankErr } = await sb
      .from("commercial_invoice_blank")
      .select("*")
      .eq("ci_id", ciIdIn)
      .maybeSingle();
    if (blankErr) return fail(blankErr.message || String(blankErr));
    if (blank) {
      ci = blank;
      blankTable = true;
    } else {
      const { data, error } = await sb
        .from("commercial_invoice")
        .select("*")
        .eq("ci_id", ciIdIn)
        .maybeSingle();
      if (error) return fail(error.message || String(error));
      ci = data;
    }
  } else {
    const { data, error } = await sb
      .from("commercial_invoice")
      .select("*")
      .eq("shipment_id", shipmentId)
      .maybeSingle();
    if (error) return fail(error.message || String(error));
    ci = data;
  }
  if (!ci) return fail("Commercial Invoice not found");
  if (String(ci.status || "").toUpperCase() === "VOID") {
    return ok({ ci_id: ci.ci_id, shipment_id: ci.shipment_id, status: "VOID", source: "supabase" });
  }

  const ts = nowIso();
  const table = blankTable ? "commercial_invoice_blank" : "commercial_invoice";
  const { error: updErr } = await sb
    .from(table)
    .update({ status: "VOID", updated_by: actor, updated_at: ts })
    .eq("ci_id", ci.ci_id);
  if (updErr) return fail(updErr.message || String(updErr));

  await writeAuditLog_(
    table,
    ci.ci_id,
    blankTable ? "VOID_COMMERCIAL_INVOICE_BLANK" : "VOID_COMMERCIAL_INVOICE",
    actor,
    JSON.stringify({
      ci_id: ci.ci_id,
      ci_no: ci.ci_no,
      shipment_id: ci.shipment_id || null,
      status: "VOID"
    })
  );
  return ok({
    ci_id: ci.ci_id,
    shipment_id: ci.shipment_id || null,
    table,
    status: "VOID",
    source: "supabase"
  });
}

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  listCommercialInvoiceByShipment,
  listCommercialInvoiceBlankByCi,
  listCommercialInvoiceByCi,
  saveCommercialInvoiceBundle,
  saveStandaloneCommercialInvoiceBundle,
  voidCommercialInvoiceBundle
};
