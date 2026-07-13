/**
 * Phase 2 - Consignment Settlement & Return Integration Test (DEV only)
 *
 * Run: node tests/p2-consignment-settlement-return.test.mjs
 * 前置 SQL：v4.3.5（出貨）+ v4.3.6（結算／收回 POST）
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
const { postShipmentBundle } = require("../server/src/bundles/shipment");
const {
  createConsignmentCaseBundle,
  postConsignmentCaseSettlementBundle,
  postConsignmentCaseReturnBundle
} = require("../server/src/bundles/consignment-case");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP2SR-" + RUN_TS.slice(0, 19).replace(/T/g, "");
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

async function ensureLot(productId, warehouseId, qty = 20) {
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

  const mvRes = await inventoryCrudHandlers().create_inventory_movement({
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

async function resetSOItems(soId, productId, qty, unitPrice) {
  const res = await resetSalesOrderItemsCmd({
    so_id: soId,
    updated_by: ACTOR,
    items_json: JSON.stringify([
      { product_id: productId, order_qty: qty, unit: "Box", unit_price: unitPrice, amount: 0, remark: "TEST" }
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

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.settlementIds).length) {
    await sb.from("consignment_case_settlement_item").delete().in("settlement_id", ids.settlementIds);
    await sb.from("ar_amount_adjustment_log").delete().in("source_id", ids.settlementIds);
    await sb.from("ar_receivable").delete().in("settlement_id", ids.settlementIds);
    await sb.from("consignment_case_settlement").delete().in("settlement_id", ids.settlementIds);
  }
  if (list(ids.returnIds).length) {
    await sb.from("consignment_case_return_item").delete().in("return_id", ids.returnIds);
    await sb.from("inventory_movement").delete().in("ref_id", ids.returnIds);
    await sb.from("consignment_case_return").delete().in("return_id", ids.returnIds);
  }
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
  if (list(ids.createdLotIds).length) {
    for (const lid of ids.createdLotIds) {
      await sb.from("inventory_movement").delete().eq("lot_id", lid);
      await sb.from("lot_balance").delete().eq("lot_id", lid);
      await sb.from("lot").delete().eq("lot_id", lid);
    }
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
    shipmentIds: [],
    settlementIds: [],
    returnIds: [],
    createdLotIds: []
  };

  const shipQty = 6;
  const settleQty = 2;
  const returnQty = 2;
  const unitPrice = 100;

  try {
    const warehouseId = await ensureWarehouse();
    created.warehouseIds.push(warehouseId);
    const customerId = await ensureCustomer();
    created.customerIds.push(customerId);
    const recipientId = await ensureRecipient(customerId);
    created.recipientIds.push(recipientId);
    const productId = await ensureProduct();
    created.productIds.push(productId);
    const lotId = await ensureLot(productId, warehouseId, 20);
    created.lotIds.push(lotId);

    const availBefore = await lotAvailable_(lotId);
    const caseId = await createCase(customerId);
    created.caseIds.push(caseId);
    const soId = await createConsignmentSO(customerId);
    created.soIds.push(soId);
    await resetSOItems(soId, productId, 10, unitPrice);

    const shipmentId = PREFIX + "-SHIP";
    created.shipmentIds.push(shipmentId);
    const shipRes = await postConsignmentShipment({
      shipmentId,
      soId,
      customerId,
      caseId,
      recipientId,
      lotId,
      shipQty
    });
    if (shipRes && shipRes.success === false) {
      throw new Error((shipRes.errors && shipRes.errors[0]) || shipRes.err || "ship POST failed");
    }

    const pool = await fetchRow("consignment_case_pool_item", "shipment_id", shipmentId);
    if (!pool) throw new Error("pool item missing after ship");
    const poolItemId = pool.pool_item_id;

    const settlementId = PREFIX + "-STL";
    created.settlementIds.push(settlementId);
    const stlRes = await postConsignmentCaseSettlementBundle({
      case_id: caseId,
      settlement_id: settlementId,
      settlement_date: ymdToday(),
      items_json: JSON.stringify([{ pool_item_id: poolItemId, settle_qty: settleQty }]),
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (stlRes && stlRes.success === false) {
      throw new Error((stlRes.errors && stlRes.errors[0]) || stlRes.err || "settlement failed");
    }

    const stlRow = await fetchRow("consignment_case_settlement", "settlement_id", settlementId);
    const poolAfterStl = await fetchRow("consignment_case_pool_item", "pool_item_id", poolItemId);
    const arId = "AR-STL-" + settlementId;
    const ar = await fetchRow("ar_receivable", "ar_id", arId);
    const stlItems = await sb.from("consignment_case_settlement_item").select("*").eq("settlement_id", settlementId);

    const stlPass =
      stlRes.settlement_rpc === true &&
      String(stlRow?.status || "").toUpperCase() === "POSTED" &&
      Number(poolAfterStl?.settled_qty || 0) === settleQty &&
      ar &&
      Number(ar.amount_system || 0) === settleQty * unitPrice &&
      (stlItems.data || []).length === 1;

    writeEvidence("SETTLEMENT", { stlRes, stlRow, poolAfterStl, ar, stlItems: stlItems.data });

    const availBeforeReturn = await lotAvailable_(lotId);
    const returnId = PREFIX + "-RET";
    created.returnIds.push(returnId);
    const retRes = await postConsignmentCaseReturnBundle({
      case_id: caseId,
      return_id: returnId,
      return_reason: "UNSOLD",
      return_date: ymdToday(),
      return_warehouse_id: warehouseId,
      items_json: JSON.stringify([{ pool_item_id: poolItemId, return_qty: returnQty }]),
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (retRes && retRes.success === false) {
      throw new Error((retRes.errors && retRes.errors[0]) || retRes.err || "return failed");
    }

    const retRow = await fetchRow("consignment_case_return", "return_id", returnId);
    const poolAfterRet = await fetchRow("consignment_case_pool_item", "pool_item_id", poolItemId);
    const availAfterReturn = await lotAvailable_(lotId);
    const retMov = await sb
      .from("inventory_movement")
      .select("movement_id, qty, lot_id")
      .eq("ref_type", "CONSIGNMENT_CASE_RETURN")
      .eq("ref_id", returnId);

    const retPass =
      retRes.return_rpc === true &&
      String(retRow?.status || "").toUpperCase() === "POSTED" &&
      Number(poolAfterRet?.returned_qty || 0) === returnQty &&
      Math.abs(availAfterReturn - (availBeforeReturn + returnQty)) < 1e-6 &&
      (retMov.data || []).length >= 1;

    const unsoldLeft =
      Number(poolAfterRet?.ship_qty || 0) -
      Number(poolAfterRet?.settled_qty || 0) -
      Number(poolAfterRet?.returned_qty || 0);

    writeEvidence("RETURN", {
      retRes,
      retRow,
      poolAfterRet,
      unsold_left: unsoldLeft,
      lot_available: { before: availBeforeReturn, after: availAfterReturn },
      movements: retMov.data
    });

    const gateReport = {
      task_level: "A",
      risk_severity: stlPass && retPass ? "LOW" : "MEDIUM",
      gate_result: stlPass && retPass ? "GO FOR TESTING (DEV)" : "CONDITIONAL GO FOR TESTING (DEV)",
      settlement_rpc: stlRes.settlement_rpc === true ? "IN_RPC" : "NODE_FALLBACK",
      return_rpc: retRes.return_rpc === true ? "IN_RPC" : "NODE_FALLBACK",
      conditions: [],
      run_at: new Date().toISOString()
    };
    if (!stlRes.settlement_rpc) {
      gateReport.conditions.push("Deploy server/sql/v4.3.6_寄賣結算收回交易Phase2.sql on DEV");
    }
    if (!retRes.return_rpc) {
      gateReport.conditions.push("Deploy v4.3.6 for atomic consignment return POST");
    }

    const gatePath = writeEvidence("GATE_REPORT", gateReport);
    const summary = {
      prefix: PREFIX,
      ship_qty: shipQty,
      settle_qty: settleQty,
      return_qty: returnQty,
      stl_pass: stlPass,
      ret_pass: retPass,
      unsold_left: unsoldLeft,
      gate_report: gatePath
    };
    const summaryPath = writeEvidence("SUMMARY", summary);

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          summary: summaryPath,
          stl_pass: stlPass,
          ret_pass: retPass,
          stlRes,
          retRes,
          gate_report: gatePath
        },
        null,
        2
      )
    );
    process.exit(stlPass && retPass ? 0 : 1);
  } catch (e) {
    const errPath = writeEvidence("ERROR", { message: e?.message || String(e), stack: e?.stack || "" });
    try {
      await cleanup(created);
    } catch (_e2) {}
    console.error("FAILED. evidence=" + errPath);
    process.exit(1);
  }
}

main();
