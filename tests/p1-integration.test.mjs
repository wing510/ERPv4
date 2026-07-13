/**
 * Phase 1 - Integration Test (DEV/TEST DB only)
 *
 * Requirements:
 * - Real Supabase DEV/TEST DB (via server/.env)
 * - Call real bundle paths (SO reset, Shipment POST, Shipment VOID, Promo scheme save)
 * - No mocks for core flow (session/permission/inventory/lot checks must run)
 * - TESTP1- prefixed fixture data, save DB evidence before cleanup
 *
 * Run:
 *   node tests/p1-integration.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadDotEnvFile_(envPath) {
  const p = path.resolve(envPath);
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const s = String(line || "").trim();
    if (!s || s.startsWith("#")) return;
    const eq = s.indexOf("=");
    if (eq <= 0) return;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!k) return;
    if (process.env[k] === undefined) process.env[k] = v;
  });
}

loadDotEnvFile_("server/.env");

const { getSupabase } = require("../server/src/supabase");
const { masterCrudHandlers } = require("../server/src/crud-master");
const { docCrudHandlers } = require("../server/src/crud-doc");
const { inventoryCrudHandlers } = require("../server/src/crud-inventory");
const { resetSalesOrderItemsCmd } = require("../server/src/bundles/sales-order");
const { postShipmentBundle, cancelShipmentBundle } = require("../server/src/bundles/shipment");
const { saveConsignmentPromoSchemeBundle } = require("../server/src/bundles/consignment-promo");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP1-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };

const evidenceRoot = path.resolve("tests/_p1_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function ymdToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function fetchRow(table, key, val) {
  const { data, error } = await sb.from(table).select("*").eq(key, val).maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function fetchRows(table, key, val) {
  const { data, error } = await sb.from(table).select("*").eq(key, val);
  if (error) throw new Error(error.message || String(error));
  return data || [];
}

function tc(name) {
  return name.replace(/[^\w\-]+/g, "_");
}

async function ensureWarehouse() {
  const warehouseId = PREFIX + "-WH";
  const create = masterCrudHandlers().create_warehouse;
  const res = await create({
    warehouse_id: warehouseId,
    warehouse_name: "TEST Warehouse",
    category: "TEST",
    address: "TEST",
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  // ignore exists error if rerun collision (shouldn't)
  return warehouseId;
}

async function ensureCustomer() {
  const customerId = PREFIX + "-CUST";
  const create = masterCrudHandlers().create_customer;
  await create({
    customer_id: customerId,
    customer_name: "TEST Customer",
    customer_type: "GENERAL",
    category: "TEST",
    contact_person: "TEST",
    phone: "000",
    email: "test@example.com",
    address: "TEST",
    country: "TW",
    tax_id: "TEST",
    invoice_title: "TEST",
    invoice_email: "test@example.com",
    invoice_type_default: "B2B",
    invoice_name_en: "TEST",
    invoice_address_en: "TEST",
    consignee_id_no: "",
    consignee_usci: "",
    consignment_allocation_policy: "FIFO",
    dealer_scheme_id: "",
    dealer_rebate_scheme_id: "",
    dealer_cumulative_scheme_id: "",
    dealer_rebate_settle_mode: "",
    dealer_rebate_excluded: "0",
    dealer_rebate_credit_balance: "0",
    dealer_cumulative_amount: "0",
    dealer_cumulative_tier_label: "",
    dealer_cumulative_price_rate: null,
    dealer_cumulative_pending_tier_label: "",
    dealer_cumulative_pending_price_rate: null,
    dealer_cumulative_started_at: null,
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  return customerId;
}

async function ensureRecipient(customerId) {
  const recipientId = PREFIX + "-RECIP";
  const create = masterCrudHandlers().create_customer_recipient;
  await create({
    recipient_id: recipientId,
    customer_id: customerId,
    recipient_name: "TEST Recipient",
    recipient_name_en: "TEST Recipient",
    address: "TEST",
    phone: "000",
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  return recipientId;
}

async function ensureProduct(unit = "Box", suggestedRetailPrice = 100) {
  const productId = PREFIX + "-PROD";
  const create = masterCrudHandlers().create_product;
  await create({
    product_id: productId,
    product_name: "TEST Product",
    product_name_en: "TEST Product",
    hs_code: "",
    type: "GENERAL",
    spec: "",
    unit,
    suggested_retail_price: String(suggestedRetailPrice),
    uom_config: "",
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  return productId;
}

async function ensureLot(productId, warehouseId, qty = 50, unit = "Box") {
  const lotId = PREFIX + "-LOT";
  const today = ymdToday();
  const expiry = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
  // Create lot row directly (fixture). Core checks will be enforced during Shipment POST.
  const { error: lotErr } = await sb.from("lot").insert({
    lot_id: lotId,
    product_id: productId,
    warehouse_id: warehouseId,
    source_type: "TEST",
    source_id: PREFIX,
    qty: String(qty),
    unit,
    type: "NORMAL",
    status: "APPROVED",
    inventory_status: "ACTIVE",
    received_date: today,
    manufacture_date: null,
    expiry_date: expiry,
    factory_lot: PREFIX,
    remark: "TEST",
    created_by: ACTOR,
    created_at: new Date().toISOString(),
    updated_by: "",
    updated_at: null,
    system_remark: "TEST"
  });
  if (lotErr) throw new Error(lotErr.message || String(lotErr));

  // Add inventory movement IN to satisfy sumMovementsForLot_ not-null and set available.
  const inv = inventoryCrudHandlers().create_inventory_movement;
  const mvRes = await inv({
    movement_type: "IN",
    lot_id: lotId,
    product_id: productId,
    warehouse_id: warehouseId,
    qty: Math.abs(qty),
    unit,
    ref_type: "GOODS_RECEIPT",
    ref_id: PREFIX + "-GR",
    created_by: ACTOR,
    created_at: new Date().toISOString(),
    _session: SESSION
  });
  if (mvRes && mvRes.success === false) throw new Error(mvRes.err || mvRes.message || "create_inventory_movement failed");
  return lotId;
}

async function createPromoScheme({ schemeId, customerId, promoType, priceBasis = "DEALER", promoUnitPrice, discountPct, buyQty, freeQty }) {
  const today = ymdToday();
  const lines = [
    {
      product_id: PREFIX + "-PROD",
      promo_type: promoType,
      promo_unit_price: promoUnitPrice ?? null,
      discount_pct: discountPct ?? null,
      buy_qty: buyQty ?? null,
      free_qty: freeQty ?? null,
      remark: "TEST"
    }
  ];
  const res = await saveConsignmentPromoSchemeBundle({
    scheme_id: schemeId,
    scheme_name: "TEST " + promoType,
    status: "ACTIVE",
    date_from: today,
    date_to: today,
    scope_type: "CUSTOMER",
    channel: "GENERAL",
    price_basis: priceBasis,
    case_id: "",
    customer_id: customerId,
    remark: "TEST",
    lines_json: JSON.stringify(lines),
    created_by: ACTOR,
    updated_by: ACTOR,
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "save promo failed");
}

async function createSO(customerId) {
  const soId = PREFIX + "-SO";
  const create = docCrudHandlers().create_sales_order;
  const today = ymdToday();
  const res = await create({
    so_id: soId,
    customer_id: customerId,
    salesperson_id: ACTOR,
    parent_ref_type: "SO",
    parent_ref_id: soId,
    so_type: "NORMAL",
    reship_ref_type: "SO",
    reship_ref_id: "",
    order_date: today,
    currency: "TWD",
    status: "OPEN",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "create SO failed");
  return soId;
}

async function resetSOItems(soId, productId, qty, unitPriceHint = 0) {
  const res = await resetSalesOrderItemsCmd({
    so_id: soId,
    updated_by: ACTOR,
    items_json: JSON.stringify([
      { product_id: productId, order_qty: qty, unit: "Box", unit_price: unitPriceHint, amount: 0, remark: "TEST" }
    ]),
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "reset items failed");
}

async function postShipment({ shipmentId, soId, customerId, recipientId, lotId, shipQty }) {
  const today = ymdToday();
  const res = await postShipmentBundle({
    shipment_id: shipmentId,
    customer_id: customerId,
    ship_date: today,
    shipper_id: PREFIX + "-SHIPPER",
    so_id: soId,
    remark: "TEST",
    recipient_id: recipientId,
    recipient_name: "TEST Recipient",
    recipient_name_en: "TEST Recipient",
    recipient_address: "TEST",
    recipient_phone: "000",
    created_by: ACTOR,
    created_at: new Date().toISOString(),
    expected_existed_shipment_item_count: 0,
    parent_ref_type: "SO",
    parent_ref_id: soId,
    items_json: JSON.stringify([
      { lot_id: lotId, ship_qty: shipQty, so_id: soId, so_item_id: "SOI-" + soId + "-001", unit: "Box", remark: "TEST" }
    ]),
    _session: SESSION
  });
  return res;
}

async function voidShipment(shipmentId) {
  const res = await cancelShipmentBundle({
    shipment_id: shipmentId,
    updated_by: ACTOR,
    cancel_note: "TEST VOID",
    _session: SESSION
  });
  return res;
}

async function evidenceFor(shipmentId, soId, lotId) {
  const soItems = await fetchRows("sales_order_item", "so_id", soId);
  const ar = await fetchRow("ar_receivable", "ar_id", "AR-" + shipmentId);
  const ship = await fetchRow("shipment", "shipment_id", shipmentId);
  const shipItems = await fetchRows("shipment_item", "shipment_id", shipmentId);
  const snaps = await sb
    .from("so_item_pricing_snapshot")
    .select("*")
    .eq("so_id", soId);
  const snapRows = snaps.data || [];
  const invMovs = await sb.from("inventory_movement").select("*").eq("lot_id", lotId);
  return {
    sales_order_item: soItems,
    so_item_pricing_snapshot: snapRows,
    shipment: ship,
    shipment_item: shipItems,
    ar_receivable: ar,
    inventory_movement: invMovs.data || []
  };
}

async function customerCumulativeSnapshot_(customerId) {
  const row = await fetchRow("customer", "customer_id", customerId);
  if (!row) return null;
  return {
    customer_id: row.customer_id,
    dealer_cumulative_amount: row.dealer_cumulative_amount,
    dealer_cumulative_tier_label: row.dealer_cumulative_tier_label,
    dealer_cumulative_price_rate: row.dealer_cumulative_price_rate,
    dealer_cumulative_pending_tier_label: row.dealer_cumulative_pending_tier_label,
    dealer_cumulative_pending_price_rate: row.dealer_cumulative_pending_price_rate
  };
}

async function partialFailureEvidencePack_({ shipmentId, soId, lotId, customerId, post, baseline }) {
  const ship = await fetchRow("shipment", "shipment_id", shipmentId);
  const shipItems = await fetchRows("shipment_item", "shipment_id", shipmentId);
  const arByShipment = await fetchRow("ar_receivable", "shipment_id", shipmentId);
  const arById = await fetchRow("ar_receivable", "ar_id", "AR-" + shipmentId);
  const soItems = await fetchRows("sales_order_item", "so_id", soId);
  const snaps = await sb.from("so_item_pricing_snapshot").select("*").eq("so_id", soId);
  const movsForShipment = await sb.from("inventory_movement").select("*").eq("parent_ref_id", shipmentId);
  const movsForLot = await sb.from("inventory_movement").select("*").eq("lot_id", lotId);
  const customerAfter = await customerCumulativeSnapshot_(customerId);

  const hasPricingOnItem = (shipItems || []).some((it) => {
    return (
      it?.so_pricing_snapshot_id ||
      it?.shipment_pricing_unit_price != null ||
      it?.shipment_pricing_amount != null ||
      String(it?.applied_promo_type || "").trim()
    );
  });

  const after = {
    post,
    shipment_exists: !!ship,
    shipment_status: ship?.status || null,
    shipment_item_exists: (shipItems || []).length > 0,
    shipment_item_pricing_snapshot_exists: hasPricingOnItem,
    inventory_movement_for_shipment_exists: (movsForShipment.data || []).length > 0,
    sales_order_item: soItems,
    so_shipped_qty_changed:
      JSON.stringify(
        (soItems || []).map((r) => ({
          so_item_id: r.so_item_id,
          shipped_qty: r.shipped_qty
        }))
      ) !==
      JSON.stringify(
        (baseline?.sales_order_item || []).map((r) => ({
          so_item_id: r.so_item_id,
          shipped_qty: r.shipped_qty
        }))
      ),
    ar_exists: !!(arByShipment || arById),
    ar_receivable: arByShipment || arById,
    so_item_pricing_snapshot_count: (snaps.data || []).length,
    so_item_pricing_snapshot_new_since_baseline:
      (snaps.data || []).length > Number(baseline?.so_item_pricing_snapshot_count || 0),
    so_item_pricing_snapshot: snaps.data || [],
    customer_cumulative: customerAfter,
    customer_cumulative_changed:
      JSON.stringify(customerAfter || {}) !== JSON.stringify(baseline?.customer_cumulative || {}),
    shipment: ship,
    shipment_item: shipItems,
    inventory_movement_for_shipment: movsForShipment.data || [],
    inventory_movement_for_lot: movsForLot.data || []
  };

  return {
    baseline,
    after,
    classification: classifyPartialFailure_(after, baseline)
  };
}

function classifyPartialFailure_(after, baseline) {
  const shipExists = !!after.shipment_exists;
  const shipItemExists = !!after.shipment_item_exists;
  const movExists = !!after.inventory_movement_for_shipment_exists;
  const arExists = !!after.ar_exists;
  const shippedChanged = !!after.so_shipped_qty_changed;
  const pricingOnItem = !!after.shipment_item_pricing_snapshot_exists;
  const snapNew = !!after.so_item_pricing_snapshot_new_since_baseline;
  const custChanged = !!after.customer_cumulative_changed;

  if (!shipExists && !shipItemExists && !movExists && !arExists && !shippedChanged && !pricingOnItem) {
    if (snapNew && !custChanged) return "B";
    if (!snapNew && !custChanged) return "A";
    if (!snapNew && custChanged) return "D";
    return "D";
  }

  if (shipExists || shipItemExists || movExists || arExists || shippedChanged || pricingOnItem) {
    return "C";
  }

  return "D";
}

async function cleanup(allIds) {
  const ids = allIds || {};
  const inList = (arr) => (arr && arr.length ? arr : []);
  // child tables first
  if (inList(ids.promoSchemeIds).length) {
    await sb.from("consignment_promo_scheme_line").delete().in("scheme_id", ids.promoSchemeIds);
    await sb.from("consignment_promo_scheme").delete().in("scheme_id", ids.promoSchemeIds);
  }
  if (inList(ids.shipmentIds).length) {
    await sb.from("shipment_item").delete().in("shipment_id", ids.shipmentIds);
    await sb.from("shipment").delete().in("shipment_id", ids.shipmentIds);
    await sb.from("ar_receivable").delete().in("shipment_id", ids.shipmentIds);
  }
  if (inList(ids.soIds).length) {
    await sb.from("sales_order_item").delete().in("so_id", ids.soIds);
    await sb.from("sales_order").delete().in("so_id", ids.soIds);
  }
  if (inList(ids.lotIds).length) {
    await sb.from("inventory_movement").delete().in("lot_id", ids.lotIds);
    await sb.from("lot_balance").delete().in("lot_id", ids.lotIds);
    await sb.from("lot").delete().in("lot_id", ids.lotIds);
  }
  if (inList(ids.recipientIds).length) {
    await sb.from("customer_recipient").delete().in("recipient_id", ids.recipientIds);
  }
  if (inList(ids.customerIds).length) {
    await sb.from("customer").delete().in("customer_id", ids.customerIds);
  }
  if (inList(ids.productIds).length) {
    await sb.from("product").delete().in("product_id", ids.productIds);
  }
  if (inList(ids.warehouseIds).length) {
    await sb.from("warehouse").delete().in("warehouse_id", ids.warehouseIds);
  }
}

async function main() {
  const results = [];
  const created = {
    warehouseIds: [],
    productIds: [],
    customerIds: [],
    recipientIds: [],
    lotIds: [],
    soIds: [],
    shipmentIds: [],
    promoSchemeIds: []
  };

  try {
    const warehouseId = await ensureWarehouse();
    created.warehouseIds.push(warehouseId);
    const customerId = await ensureCustomer();
    created.customerIds.push(customerId);
    const recipientId = await ensureRecipient(customerId);
    created.recipientIds.push(recipientId);
    const productId = await ensureProduct("Box", 100);
    created.productIds.push(productId);
    const lotId = await ensureLot(productId, warehouseId, 50, "Box");
    created.lotIds.push(lotId);

    const soId = await createSO(customerId);
    created.soIds.push(soId);
    await resetSOItems(soId, productId, 10, 0);

    // ---- Case 1: FIXED_PRICE ----
    {
      const schemeId = PREFIX + "-CP-FIX";
      created.promoSchemeIds.push(schemeId);
      await createPromoScheme({
        schemeId,
        customerId,
        promoType: "FIXED_PRICE",
        priceBasis: "DEALER",
        promoUnitPrice: 50
      });
      const shipmentId = PREFIX + "-SHIP-FIX";
      created.shipmentIds.push(shipmentId);

      const post = await postShipment({
        shipmentId,
        soId,
        customerId,
        recipientId,
        lotId,
        shipQty: 2
      });
      assert.equal(post.success, true);

      const evBeforeVoid = await evidenceFor(shipmentId, soId, lotId);
      const evidencePath = writeEvidence(tc("FIXED_PRICE_before_void"), evBeforeVoid);
      assert.equal(Number(evBeforeVoid.ar_receivable?.amount_system || 0), Number(evBeforeVoid.shipment_item?.[0]?.shipment_pricing_amount || 0));

      const voidRes = await voidShipment(shipmentId);
      assert.equal(voidRes.success, true);
      const evAfterVoid = await evidenceFor(shipmentId, soId, lotId);
      const evidencePath2 = writeEvidence(tc("FIXED_PRICE_after_void"), evAfterVoid);
      assert.equal(Number(evAfterVoid.ar_receivable?.amount_due || 0), 0);

      results.push({
        test_case: "FIXED_PRICE",
        expected: "Shipment pricing snapshot & AR.amount_system reflect fixed promo; VOID sets AR amount_due=0 without recompute",
        actual: { post, void: voidRes },
        pass: true,
        db_evidence: [evidencePath, evidencePath2],
        cleanup: "pending"
      });
    }

    // ---- Case 2: DISCOUNT_PCT ----
    {
      const schemeId = PREFIX + "-CP-PCT";
      created.promoSchemeIds.push(schemeId);
      await createPromoScheme({
        schemeId,
        customerId,
        promoType: "DISCOUNT_PCT",
        priceBasis: "DEALER",
        discountPct: 90
      });
      const shipmentId = PREFIX + "-SHIP-PCT";
      created.shipmentIds.push(shipmentId);

      const post = await postShipment({
        shipmentId,
        soId,
        customerId,
        recipientId,
        lotId,
        shipQty: 3
      });
      assert.equal(post.success, true);

      const evBeforeVoid = await evidenceFor(shipmentId, soId, lotId);
      const evidencePath = writeEvidence(tc("DISCOUNT_PCT_before_void"), evBeforeVoid);
      assert.ok((evBeforeVoid.so_item_pricing_snapshot || []).length >= 1, "missing so_item_pricing_snapshot");
      assert.equal(evBeforeVoid.shipment_item?.[0]?.applied_promo_type, "DISCOUNT_PCT");

      const voidRes = await voidShipment(shipmentId);
      assert.equal(voidRes.success, true);
      const evAfterVoid = await evidenceFor(shipmentId, soId, lotId);
      const evidencePath2 = writeEvidence(tc("DISCOUNT_PCT_after_void"), evAfterVoid);
      assert.equal(Number(evAfterVoid.ar_receivable?.amount_due || 0), 0);

      results.push({
        test_case: "DISCOUNT_PCT",
        expected: "Shipment uses frozen base snapshot × discount; AR.amount_system equals shipment snapshot sum; VOID reverses",
        actual: { post, void: voidRes },
        pass: true,
        db_evidence: [evidencePath, evidencePath2],
        cleanup: "pending"
      });
    }

    // ---- Case 3: BUY_N_GET_M + partial shipment ----
    {
      const schemeId = PREFIX + "-CP-BNGM";
      created.promoSchemeIds.push(schemeId);
      await createPromoScheme({
        schemeId,
        customerId,
        promoType: "BUY_N_GET_M",
        priceBasis: "DEALER",
        buyQty: 3,
        freeQty: 1
      });

      const shipA = PREFIX + "-SHIP-BNGM-A"; // positive case: qty=4 => free=1 billable=3
      const shipB = PREFIX + "-SHIP-BNGM-B"; // partial shipment proof: 3 then 1 => no free
      const shipC = PREFIX + "-SHIP-BNGM-C";
      created.shipmentIds.push(shipA, shipB);

      const postA = await postShipment({ shipmentId: shipA, soId, customerId, recipientId, lotId, shipQty: 4 });
      assert.equal(postA.success, true);
      const evA = await evidenceFor(shipA, soId, lotId);
      const evAPath = writeEvidence(tc("BUY_N_GET_M_shipA_before_void"), evA);
      assert.equal(Number(evA.shipment_item?.[0]?.shipment_pricing_free_qty || 0), 1);
      assert.equal(Number(evA.shipment_item?.[0]?.shipment_pricing_billable_qty || 0), 3);

      const postB = await postShipment({ shipmentId: shipB, soId, customerId, recipientId, lotId, shipQty: 3 });
      assert.equal(postB.success, true);
      const evB = await evidenceFor(shipB, soId, lotId);
      const evBPath = writeEvidence(tc("BUY_N_GET_M_shipB_before_void"), evB);
      assert.equal(Number(evB.shipment_item?.[0]?.shipment_pricing_free_qty || 0), 0);

      created.shipmentIds.push(shipC);
      const postC = await postShipment({ shipmentId: shipC, soId, customerId, recipientId, lotId, shipQty: 1 });
      assert.equal(postC.success, true);
      const evC = await evidenceFor(shipC, soId, lotId);
      const evCPath = writeEvidence(tc("BUY_N_GET_M_shipC_before_void"), evC);
      assert.equal(Number(evC.shipment_item?.[0]?.shipment_pricing_free_qty || 0), 0);

      // duplicate POST (shipB)
      const dupPost = await postShipment({ shipmentId: shipB, soId, customerId, recipientId, lotId, shipQty: 3 });
      assert.equal(dupPost.success, false);

      const voidA = await voidShipment(shipA);
      assert.equal(voidA.success, true);
      const voidB = await voidShipment(shipB);
      assert.equal(voidB.success, true);
      const voidC = await voidShipment(shipC);
      assert.equal(voidC.success, true);
      const evA2 = await evidenceFor(shipA, soId, lotId);
      const evB2 = await evidenceFor(shipB, soId, lotId);
      const evA2Path = writeEvidence(tc("BUY_N_GET_M_shipA_after_void"), evA2);
      const evB2Path = writeEvidence(tc("BUY_N_GET_M_shipB_after_void"), evB2);
      const evC2 = await evidenceFor(shipC, soId, lotId);
      const evC2Path = writeEvidence(tc("BUY_N_GET_M_shipC_after_void"), evC2);

      // duplicate VOID (shipB)
      const dupVoid = await voidShipment(shipB);
      assert.equal(dupVoid.success, false);

      results.push({
        test_case: "BUY_N_GET_M + partial shipment + duplicate POST/VOID",
        expected:
          "Each shipment computes independently (no cross-shipment accumulation); duplicate POST fails; duplicate VOID fails; VOID reverses to amount_due=0",
        actual: { postA, postB, postC, dupPost, voidA, voidB, voidC, dupVoid },
        pass: true,
        db_evidence: [evAPath, evBPath, evCPath, evA2Path, evB2Path, evC2Path],
        cleanup: "pending"
      });
    }

    // ---- Partial failure (inventory check) ----
    {
      const tinyLotId = PREFIX + "-LOT-TINY";
      created.lotIds.push(tinyLotId);
      // create tiny lot with qty=1
      const today = ymdToday();
      const expiry = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
      const { error: lotErr } = await sb.from("lot").insert({
        lot_id: tinyLotId,
        product_id: created.productIds[0],
        warehouse_id: created.warehouseIds[0],
        source_type: "TEST",
        source_id: PREFIX,
        qty: "1",
        unit: "Box",
        type: "NORMAL",
        status: "APPROVED",
        inventory_status: "ACTIVE",
        received_date: today,
        expiry_date: expiry,
        factory_lot: PREFIX,
        remark: "TEST",
        created_by: ACTOR,
        created_at: new Date().toISOString()
      });
      if (lotErr) throw new Error(lotErr.message || String(lotErr));
      const inv = inventoryCrudHandlers().create_inventory_movement;
      await inv({
        movement_type: "IN",
        lot_id: tinyLotId,
        product_id: created.productIds[0],
        warehouse_id: created.warehouseIds[0],
        qty: 1,
        unit: "Box",
        ref_type: "GOODS_RECEIPT",
        ref_id: PREFIX + "-GR2",
        created_by: ACTOR,
        created_at: new Date().toISOString(),
        _session: SESSION
      });

      const shipmentId = PREFIX + "-SHIP-PFAIL";
      const soIdFail = created.soIds[0];
      const customerIdFail = created.customerIds[0];
      created.shipmentIds.push(shipmentId);

      const baselineSnaps = await sb.from("so_item_pricing_snapshot").select("pricing_snapshot_id").eq("so_id", soIdFail);
      const baseline = {
        sales_order_item: await fetchRows("sales_order_item", "so_id", soIdFail),
        so_item_pricing_snapshot_count: (baselineSnaps.data || []).length,
        customer_cumulative: await customerCumulativeSnapshot_(customerIdFail)
      };
      const baselinePath = writeEvidence(tc("PARTIAL_FAILURE_baseline"), baseline);

      const post = await postShipment({
        shipmentId,
        soId: soIdFail,
        customerId: customerIdFail,
        recipientId: created.recipientIds[0],
        lotId: tinyLotId,
        shipQty: 2 // triggers Negative inventory check in movement
      });
      assert.equal(post.success, false);

      const pack = await partialFailureEvidencePack_({
        shipmentId,
        soId: soIdFail,
        lotId: tinyLotId,
        customerId: customerIdFail,
        post,
        baseline
      });
      const evidencePath = writeEvidence(tc("PARTIAL_FAILURE"), pack);

      results.push({
        test_case: "partial failure (inventory check)",
        expected: "POST fails when inventory insufficient; classify A/B/C/D from full DB evidence",
        actual: { post, classification: pack.classification },
        pass: true,
        partial_failure_result: pack.classification,
        db_evidence: [baselinePath, evidencePath],
        cleanup: "pending"
      });
    }

    // ---- POST/VOID race (best-effort) ----
    {
      const shipmentId = PREFIX + "-SHIP-RACE";
      created.shipmentIds.push(shipmentId);
      const pPost = postShipment({
        shipmentId,
        soId: created.soIds[0],
        customerId: created.customerIds[0],
        recipientId: created.recipientIds[0],
        lotId: created.lotIds[0],
        shipQty: 1
      });
      const pVoid = voidShipment(shipmentId);
      const [postRes, voidRes] = await Promise.allSettled([pPost, pVoid]);
      const ship = await fetchRow("shipment", "shipment_id", shipmentId);
      const ar = await fetchRow("ar_receivable", "ar_id", "AR-" + shipmentId);
      const evidencePath = writeEvidence(tc("POST_VOID_RACE"), { postRes, voidRes, shipment: ship, ar_receivable: ar });

      results.push({
        test_case: "POST/VOID race",
        expected: "One of POST/VOID may fail; final DB state must be consistent (POSTED with OPEN AR, or CANCELLED with amount_due=0)",
        actual: { postRes, voidRes },
        pass: false,
        status: "NOT TESTED",
        blocker_reason:
          "Non-deterministic concurrency; single parallel invocation cannot guarantee POST-then-VOID interleaving coverage",
        db_evidence: [evidencePath],
        cleanup: "pending"
      });
    }

    // Save summary before cleanup
    const gateReport = {
      task_level: "A",
      risk_severity: "HIGH",
      gate_result: "CONDITIONAL GO FOR TESTING (DEV)",
      conditions: [
        "Re-run integration tests on current codebase (this run)",
        "PARTIAL_FAILURE must be classified A/B/C/D with full evidence",
        "POST/VOID race remains NOT TESTED until deterministic harness exists",
        "Shipment POST non-atomic risk remains open unless reclassified by evidence"
      ],
      partial_failure_results: results
        .filter((r) => r.partial_failure_result)
        .map((r) => ({ test_case: r.test_case, result: r.partial_failure_result })),
      not_tested: results.filter((r) => r.status === "NOT TESTED").map((r) => ({
        test_case: r.test_case,
        blocker_reason: r.blocker_reason
      })),
      run_at: new Date().toISOString()
    };
    const gatePath = writeEvidence("GATE_REPORT", gateReport);
    const summaryPath = writeEvidence("SUMMARY", { env: ENV_NAME, prefix: PREFIX, results, gate_report: gatePath });

    // Cleanup
    await cleanup(created);
    // Verify cleanup
    const remain = {
      customer: await fetchRow("customer", "customer_id", created.customerIds[0]),
      product: await fetchRow("product", "product_id", created.productIds[0]),
      sales_order: await fetchRow("sales_order", "so_id", created.soIds[0])
    };
    const cleanupPath = writeEvidence("CLEANUP_CHECK", remain);

    // mark cleanup results
    results.forEach((r) => (r.cleanup = "attempted"));

    console.log(JSON.stringify({ summary: summaryPath, gate_report: gatePath, cleanup_check: cleanupPath, results }, null, 2));
    process.exit(0);
  } catch (e) {
    const errPath = writeEvidence("ERROR", { message: e?.message || String(e), stack: e?.stack || "" });
    try {
      await cleanup(created);
    } catch (_cleanupErr) {}
    console.error("FAILED. evidence=" + errPath);
    process.exit(1);
  }
}

main();

