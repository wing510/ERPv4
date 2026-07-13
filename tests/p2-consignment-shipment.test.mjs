/**
 * Phase 2 - Consignment Shipment Integration Test (DEV only)
 *
 * Run: node tests/p2-consignment-shipment.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
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
const { createConsignmentCaseBundle } = require("../server/src/bundles/consignment-case");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP2-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };

const evidenceRoot = path.resolve("tests/_p2_evidence", PREFIX);
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

async function lotAvailable_(lotId) {
  const { data: lb } = await sb.from("lot_balance").select("available_qty").eq("lot_id", lotId).maybeSingle();
  if (lb && lb.available_qty != null) return Number(lb.available_qty);
  const { data: movs } = await sb.from("inventory_movement").select("qty").eq("lot_id", lotId);
  return (movs || []).reduce((s, m) => s + Number(m.qty || 0), 0);
}

async function ensureWarehouse() {
  const warehouseId = PREFIX + "-WH";
  await masterCrudHandlers().create_warehouse({
    warehouse_id: warehouseId,
    warehouse_name: "TEST Warehouse",
    category: "TEST",
    address: "TEST",
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  return warehouseId;
}

async function ensureCustomer() {
  const customerId = PREFIX + "-CUST";
  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST Consignment Customer",
    customer_type: "CONSIGNMENT",
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
  await masterCrudHandlers().create_customer_recipient({
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

async function ensureProduct() {
  const productId = PREFIX + "-PROD";
  await masterCrudHandlers().create_product({
    product_id: productId,
    product_name: "TEST Product",
    product_name_en: "TEST Product",
    hs_code: "",
    type: "GENERAL",
    spec: "",
    unit: "Box",
    suggested_retail_price: "100",
    uom_config: "",
    status: "ACTIVE",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  return productId;
}

async function ensureLot(productId, warehouseId, qty = 30) {
  const lotId = PREFIX + "-LOT";
  const today = ymdToday();
  const expiry = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
  const { error: lotErr } = await sb.from("lot").insert({
    lot_id: lotId,
    product_id: productId,
    warehouse_id: warehouseId,
    source_type: "TEST",
    source_id: PREFIX,
    qty: String(qty),
    unit: "Box",
    type: "NORMAL",
    status: "APPROVED",
    inventory_status: "ACTIVE",
    received_date: today,
    expiry_date: expiry,
    factory_lot: PREFIX + "-FL",
    remark: "TEST",
    created_by: ACTOR,
    created_at: new Date().toISOString()
  });
  if (lotErr) throw new Error(lotErr.message || String(lotErr));

  const inv = inventoryCrudHandlers().create_inventory_movement;
  const mvRes = await inv({
    movement_type: "IN",
    lot_id: lotId,
    product_id: productId,
    warehouse_id: warehouseId,
    qty: qty,
    unit: "Box",
    ref_type: "GOODS_RECEIPT",
    ref_id: PREFIX + "-GR",
    created_by: ACTOR,
    created_at: new Date().toISOString(),
    _session: SESSION
  });
  if (mvRes && mvRes.success === false) throw new Error(mvRes.err || "inventory IN failed");
  return lotId;
}

async function createCase(customerId) {
  const caseId = PREFIX + "-CC";
  const res = await createConsignmentCaseBundle({
    case_id: caseId,
    customer_id: customerId,
    open_date: ymdToday(),
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "create case failed");
  return caseId;
}

async function createConsignmentSO(customerId) {
  const soId = PREFIX + "-SO";
  const res = await docCrudHandlers().create_sales_order({
    so_id: soId,
    customer_id: customerId,
    salesperson_id: ACTOR,
    parent_ref_type: "SO",
    parent_ref_id: soId,
    so_type: "CONSIGNMENT",
    reship_ref_type: "SO",
    reship_ref_id: "",
    order_date: ymdToday(),
    currency: "TWD",
    status: "OPEN",
    remark: "TEST",
    created_by: ACTOR,
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "create SO failed");
  return soId;
}

async function resetSOItems(soId, productId, qty) {
  const res = await resetSalesOrderItemsCmd({
    so_id: soId,
    updated_by: ACTOR,
    items_json: JSON.stringify([
      { product_id: productId, order_qty: qty, unit: "Box", unit_price: 100, amount: 0, remark: "TEST" }
    ]),
    _session: SESSION
  });
  if (res && res.success === false) throw new Error(res.err || res.message || "reset items failed");
}

async function postConsignmentShipment({ shipmentId, soId, customerId, caseId, recipientId, lotId, shipQty }) {
  return postShipmentBundle({
    shipment_id: shipmentId,
    customer_id: customerId,
    ship_date: ymdToday(),
    shipper_id: PREFIX + "-SHIPPER",
    so_id: soId,
    consignment_case_id: caseId,
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
      {
        lot_id: lotId,
        ship_qty: shipQty,
        so_id: soId,
        so_item_id: "SOI-" + soId + "-001",
        unit: "Box",
        remark: "TEST"
      }
    ]),
    _session: SESSION
  });
}

async function voidShipment(shipmentId) {
  return cancelShipmentBundle({
    shipment_id: shipmentId,
    updated_by: ACTOR,
    cancel_note: "TEST VOID",
    _session: SESSION
  });
}

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.shipmentIds).length) {
    await sb.from("consignment_case_pool_item").delete().in("shipment_id", ids.shipmentIds);
    await sb.from("shipment_item").delete().in("shipment_id", ids.shipmentIds);
    await sb.from("shipment").delete().in("shipment_id", ids.shipmentIds);
  }
  if (list(ids.caseIds).length) {
    await sb.from("consignment_case_pool_item").delete().in("case_id", ids.caseIds);
    await sb.from("consignment_case").delete().in("case_id", ids.caseIds);
  }
  if (list(ids.soIds).length) {
    await sb.from("sales_order_item").delete().in("so_id", ids.soIds);
    await sb.from("sales_order").delete().in("so_id", ids.soIds);
  }
  if (list(ids.lotIds).length) {
    await sb.from("inventory_movement").delete().in("lot_id", ids.lotIds);
    await sb.from("lot_balance").delete().in("lot_id", ids.lotIds);
    await sb.from("lot").delete().in("lot_id", ids.lotIds);
  }
  if (list(ids.recipientIds).length) {
    await sb.from("customer_recipient").delete().in("recipient_id", ids.recipientIds);
  }
  if (list(ids.customerIds).length) {
    await sb.from("customer").delete().in("customer_id", ids.customerIds);
  }
  if (list(ids.productIds).length) {
    await sb.from("product").delete().in("product_id", ids.productIds);
  }
  if (list(ids.warehouseIds).length) {
    await sb.from("warehouse").delete().in("warehouse_id", ids.warehouseIds);
  }
}

async function main() {
  const created = {
    warehouseIds: [],
    productIds: [],
    customerIds: [],
    recipientIds: [],
    lotIds: [],
    soIds: [],
    caseIds: [],
    shipmentIds: []
  };

  try {
    const warehouseId = await ensureWarehouse();
    created.warehouseIds.push(warehouseId);
    const customerId = await ensureCustomer();
    created.customerIds.push(customerId);
    const recipientId = await ensureRecipient(customerId);
    created.recipientIds.push(recipientId);
    const productId = await ensureProduct();
    created.productIds.push(productId);
    const lotId = await ensureLot(productId, warehouseId, 30);
    created.lotIds.push(lotId);

    const availBefore = await lotAvailable_(lotId);
    const caseId = await createCase(customerId);
    created.caseIds.push(caseId);
    const soId = await createConsignmentSO(customerId);
    created.soIds.push(soId);
    await resetSOItems(soId, productId, 10);

    const shipmentId = PREFIX + "-SHIP";
    created.shipmentIds.push(shipmentId);
    const shipQty = 3;

    const postRes = await postConsignmentShipment({
      shipmentId,
      soId,
      customerId,
      caseId,
      recipientId,
      lotId,
      shipQty
    });
    if (postRes && postRes.success === false) {
      throw new Error((postRes.errors && postRes.errors[0]) || postRes.err || "POST failed");
    }

    const rpcUsed = !!(postRes && postRes.consignment_rpc === true);
    const ship = await fetchRow("shipment", "shipment_id", shipmentId);
    const pool = await fetchRows("consignment_case_pool_item", "shipment_id", shipmentId);
    const ar = await fetchRow("ar_receivable", "ar_id", "AR-" + shipmentId);
    const availAfterPost = await lotAvailable_(lotId);
    const soItem = await fetchRow("sales_order_item", "so_item_id", "SOI-" + soId + "-001");

    const postEvidence = {
      postRes,
      shipment: ship,
      pool_items: pool,
      ar_receivable: ar,
      lot_available: { before: availBefore, after_post: availAfterPost, delta: availAfterPost - availBefore },
      so_item_shipped_qty: soItem?.shipped_qty
    };
    const postPath = writeEvidence("CONSIGNMENT_POST", postEvidence);

    const postPass =
      rpcUsed &&
      String(ship?.status || "").toUpperCase() === "POSTED" &&
      erpNorm_(ship?.consignment_case_id) === caseId &&
      pool.length === 1 &&
      Number(pool[0]?.ship_qty || 0) === shipQty &&
      Number(pool[0]?.settled_qty || 0) === 0 &&
      !ar &&
      Math.abs(availAfterPost - (availBefore - shipQty)) < 1e-6 &&
      Number(soItem?.shipped_qty || 0) === shipQty;

    const voidRes = await voidShipment(shipmentId);
    if (voidRes && voidRes.success === false) {
      throw new Error((voidRes.errors && voidRes.errors[0]) || voidRes.err || "VOID failed");
    }

    const voidRpcUsed = !!(voidRes && voidRes.consignment_rpc === true);
    const shipAfter = await fetchRow("shipment", "shipment_id", shipmentId);
    const poolAfter = await fetchRows("consignment_case_pool_item", "shipment_id", shipmentId);
    const availAfterVoid = await lotAvailable_(lotId);
    const soItemAfter = await fetchRow("sales_order_item", "so_item_id", "SOI-" + soId + "-001");
    const cancelMov = await sb
      .from("inventory_movement")
      .select("movement_id")
      .eq("ref_type", "SHIPMENT_CANCEL")
      .eq("ref_id", shipmentId);

    const voidEvidence = {
      voidRes,
      shipment: shipAfter,
      pool_items: poolAfter,
      lot_available: { after_void: availAfterVoid, restored: Math.abs(availAfterVoid - availBefore) < 1e-6 },
      so_item_shipped_qty: soItemAfter?.shipped_qty,
      cancel_movements: cancelMov.data || []
    };
    const voidPath = writeEvidence("CONSIGNMENT_VOID", voidEvidence);

    const voidPass =
      voidRpcUsed &&
      String(shipAfter?.status || "").toUpperCase() === "CANCELLED" &&
      poolAfter.length === 0 &&
      Math.abs(availAfterVoid - availBefore) < 1e-6 &&
      Number(soItemAfter?.shipped_qty || 0) === 0 &&
      (cancelMov.data || []).length >= 1;

    const dupVoid = await voidShipment(shipmentId);
    const dupVoidFails = dupVoid && dupVoid.success === false;

    const gateReport = {
      task_level: "A",
      risk_severity: postPass && voidPass && dupVoidFails ? "LOW" : "MEDIUM",
      gate_result: postPass && voidPass && dupVoidFails ? "GO FOR TESTING (DEV)" : "CONDITIONAL GO FOR TESTING (DEV)",
      consignment_rpc: rpcUsed && voidRpcUsed ? "IN_RPC" : rpcUsed || voidRpcUsed ? "PARTIAL_RPC" : "NODE_FALLBACK",
      conditions: [],
      run_at: new Date().toISOString()
    };
    if (!rpcUsed || !voidRpcUsed) {
      gateReport.conditions.push("Deploy server/sql/v4.3.5_寄賣出貨交易Phase2.sql on DEV");
    }
    if (!dupVoidFails) {
      gateReport.conditions.push("Duplicate VOID should fail with already CANCELLED");
    }

    const gatePath = writeEvidence("GATE_REPORT", gateReport);
    const summary = {
      env: ENV_NAME,
      prefix: PREFIX,
      post_pass: postPass,
      void_pass: voidPass,
      dup_void_fails: dupVoidFails,
      gate_report: gatePath,
      evidence: [postPath, voidPath]
    };
    const summaryPath = writeEvidence("SUMMARY", summary);

    await cleanup(created);

    console.log(JSON.stringify({ summary: summaryPath, gate_report: gatePath, post_pass: postPass, void_pass: voidPass, postRes, voidRes }, null, 2));
    process.exit(postPass && voidPass && dupVoidFails ? 0 : 1);
  } catch (e) {
    const errPath = writeEvidence("ERROR", { message: e?.message || String(e), stack: e?.stack || "" });
    try {
      await cleanup(created);
    } catch (_e2) {}
    console.error("FAILED. evidence=" + errPath);
    process.exit(1);
  }
}

function erpNorm_(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

main();
