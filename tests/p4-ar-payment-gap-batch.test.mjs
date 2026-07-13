/**
 * Phase 4 slice4 - gap writeoff + batch payment RPC (DEV only)
 *
 * Run: node tests/p4-ar-payment-gap-batch.test.mjs
 * 前置 SQL：v4.3.13_AR收款進階Phase4Slice4.sql
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadDotEnvFile_(envPath) {
  const p = path.resolve(envPath);
  if (!fs.existsSync(p)) return;
  fs.readFileSync(p, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
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
const {
  registerArPaymentBundle,
  voidArPaymentBundle,
  registerArPaymentBatchBundle,
  voidArPaymentBatchBundle
} = require("../server/src/bundles/ar");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP4D-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };

const evidenceRoot = path.resolve("tests/_p4d_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function batchRpcReady_() {
  const { error } = await sb.rpc("erp_ar_post_payment_batch_phase4_tx", {
    p_batch_id: "__probe__",
    p_payment_date: "2099-01-01",
    p_allocations_json: []
  });
  const msg = String(error?.message || "");
  if (/could not find the function|schema cache|42883|function .* does not exist/i.test(msg)) {
    return false;
  }
  return true;
}

async function ensureCustomerAndArs() {
  const customerId = PREFIX + "-CUST";
  const arId1 = PREFIX + "-AR1";
  const arId2 = PREFIX + "-AR2";

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P4D Customer",
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
    dealer_rebate_settle_mode: "CREDIT_NOTE",
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

  const rows = [
    { ar_id: arId1, ar_date: "2099-09-10", amount_due: 300 },
    { ar_id: arId2, ar_date: "2099-09-12", amount_due: 500 }
  ];
  for (const row of rows) {
    const arIns = await sb.from("ar_receivable").insert({
      ar_id: row.ar_id,
      source_type: "MANUAL_TEST",
      source_id: row.ar_id,
      customer_id: customerId,
      ar_date: row.ar_date,
      currency: "USD",
      amount_system: row.amount_due,
      amount_due: row.amount_due,
      amount_received: 0,
      status: "OPEN",
      remark: "TEST P4D",
      created_by: ACTOR
    });
    if (arIns.error) throw new Error(arIns.error.message || "ar insert failed");
  }

  return { customerId, arId1, arId2 };
}

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.paymentIds).length) {
    await sb.from("ar_payment").delete().in("payment_id", ids.paymentIds);
  }
  if (list(ids.arIds).length) {
    await sb.from("ar_amount_adjustment_log").delete().in("ar_id", ids.arIds);
    await sb.from("ar_receivable").delete().in("ar_id", ids.arIds);
  }
  if (list(ids.customerIds).length) {
    await sb.from("customer").delete().in("customer_id", ids.customerIds);
  }
}

async function main() {
  if (!(await batchRpcReady_())) {
    console.error("SKIP: batch payment RPC not deployed. Run v4.3.13 first.");
    process.exit(2);
  }

  const created = { customerIds: [], arIds: [], paymentIds: [] };

  try {
    const { customerId, arId1, arId2 } = await ensureCustomerAndArs();
    created.customerIds.push(customerId);
    created.arIds.push(arId1, arId2);

    // ── gap writeoff POST + VOID ──────────────────────────────────
    const gapArId = arId1;
    const gapPayId = PREFIX + "-GAP-PAY";
    const gapPayAmount = 298;
    const regGap = await registerArPaymentBundle({
      ar_id: gapArId,
      payment_id: gapPayId,
      payment_date: "2099-09-20",
      amount: gapPayAmount,
      gap_writeoff_code: "ROUNDING",
      remark: "TEST gap",
      created_by: ACTOR,
      _session: SESSION
    });
    if (regGap && regGap.success === false) {
      throw new Error((regGap.errors && regGap.errors[0]) || regGap.err || "gap register failed");
    }
    created.paymentIds.push(gapPayId);

    const { data: arAfterGap } = await sb.from("ar_receivable").select("*").eq("ar_id", gapArId).maybeSingle();
    const { data: gapAdj } = await sb
      .from("ar_amount_adjustment_log")
      .select("*")
      .eq("source_type", "PAYMENT_GAP_WRITEOFF")
      .eq("source_id", gapPayId)
      .maybeSingle();

    const gapPostPass =
      regGap.payment_rpc === true &&
      String(arAfterGap?.status || "").toUpperCase() === "SETTLED" &&
      Math.abs(Number(arAfterGap?.amount_due || 0) - gapPayAmount) < 0.02 &&
      !!gapAdj;

    const voidGap = await voidArPaymentBundle({
      payment_id: gapPayId,
      void_reason: "TEST gap void",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (voidGap && voidGap.success === false) {
      throw new Error((voidGap.errors && voidGap.errors[0]) || voidGap.err || "gap void failed");
    }

    const { data: arAfterGapVoid } = await sb.from("ar_receivable").select("*").eq("ar_id", gapArId).maybeSingle();
    const { data: gapVoidAdj } = await sb
      .from("ar_amount_adjustment_log")
      .select("*")
      .eq("source_type", "PAYMENT_GAP_WRITEOFF_VOID")
      .eq("source_id", gapPayId)
      .maybeSingle();

    const gapVoidPass =
      voidGap.void_rpc === true &&
      voidGap.gap_restored === true &&
      Math.abs(Number(arAfterGapVoid?.amount_received || 0)) < 0.02 &&
      Math.abs(Number(arAfterGapVoid?.amount_due || 0) - 300) < 0.02 &&
      !!gapVoidAdj;

    // reset AR1 for batch test
    await sb
      .from("ar_receivable")
      .update({ amount_due: 300, amount_received: 0, status: "OPEN", close_mode: "", closed_by: "", closed_at: null })
      .eq("ar_id", arId1);
    await sb.from("ar_payment").delete().eq("payment_id", gapPayId);
    await sb.from("ar_amount_adjustment_log").delete().eq("ar_id", arId1);

    // ── batch POST + VOID ─────────────────────────────────────────
    const batchId = PREFIX + "-BATCH";
    const batchReg = await registerArPaymentBatchBundle({
      batch_id: batchId,
      ar_ids_json: JSON.stringify([arId1, arId2]),
      total_amount: 400,
      payment_date: "2099-09-25",
      remark: "TEST batch",
      created_by: ACTOR,
      _session: SESSION
    });
    if (batchReg && batchReg.success === false) {
      throw new Error((batchReg.errors && batchReg.errors[0]) || batchReg.err || "batch register failed");
    }

    const batchPays = (batchReg.allocations || []).map((a) => a.payment_id).filter(Boolean);
    created.paymentIds.push(...batchPays);

    const { data: ar1AfterBatch } = await sb.from("ar_receivable").select("*").eq("ar_id", arId1).maybeSingle();
    const { data: ar2AfterBatch } = await sb.from("ar_receivable").select("*").eq("ar_id", arId2).maybeSingle();

    const batchPostPass =
      batchReg.batch_rpc === true &&
      batchPays.length === 2 &&
      Math.abs(Number(ar1AfterBatch?.amount_received || 0) - 300) < 0.02 &&
      Math.abs(Number(ar2AfterBatch?.amount_received || 0) - 100) < 0.02;

    const batchVoid = await voidArPaymentBatchBundle({
      batch_id: batchId,
      void_reason: "TEST batch void",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (batchVoid && batchVoid.success === false) {
      throw new Error((batchVoid.errors && batchVoid.errors[0]) || batchVoid.err || "batch void failed");
    }

    const { data: ar1AfterVoid } = await sb.from("ar_receivable").select("*").eq("ar_id", arId1).maybeSingle();
    const { data: ar2AfterVoid } = await sb.from("ar_receivable").select("*").eq("ar_id", arId2).maybeSingle();

    const batchVoidPass =
      batchVoid.batch_void_rpc === true &&
      Number(batchVoid.voided_count || 0) === 2 &&
      Math.abs(Number(ar1AfterVoid?.amount_received || 0)) < 0.02 &&
      Math.abs(Number(ar2AfterVoid?.amount_received || 0)) < 0.02;

    writeEvidence("SUMMARY", {
      gap_post_pass: gapPostPass,
      gap_void_pass: gapVoidPass,
      batch_post_pass: batchPostPass,
      batch_void_pass: batchVoidPass,
      regGap,
      voidGap,
      batchReg,
      batchVoid
    });

    await cleanup(created);

    const allPass = gapPostPass && gapVoidPass && batchPostPass && batchVoidPass;
    console.log(
      JSON.stringify(
        {
          gap_post_pass: gapPostPass,
          gap_void_pass: gapVoidPass,
          batch_post_pass: batchPostPass,
          batch_void_pass: batchVoidPass
        },
        null,
        2
      )
    );
    process.exit(allPass ? 0 : 1);
  } catch (e) {
    writeEvidence("ERROR", { message: e?.message || String(e), stack: e?.stack || "" });
    try {
      await cleanup(created);
    } catch (_e2) {}
    console.error("FAILED.", e?.message || String(e));
    process.exit(1);
  }
}

main();
