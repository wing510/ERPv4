/**
 * Phase 4 slice1 - AR payment status (DEV only)
 *
 * Run: node tests/p4-ar-payment-status.test.mjs
 * 前置 SQL：v4.3.10_AR收款狀態Phase4.sql
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
const { registerArPaymentBundle, voidArPaymentBundle } = require("../server/src/bundles/ar");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP4-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };
const AR_AMOUNT = 1000;
const PAY_AMOUNT = 300;

const evidenceRoot = path.resolve("tests/_p4_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function paymentStatusColumnReady_() {
  const { error } = await sb.from("ar_payment").select("status").limit(1);
  return !error;
}

async function ensureCustomerAndAr() {
  const customerId = PREFIX + "-CUST";
  const arId = PREFIX + "-AR";

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P4 Customer",
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

  const arIns = await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "MANUAL_TEST",
    source_id: arId,
    customer_id: customerId,
    ar_date: "2099-09-15",
    currency: "USD",
    amount_system: AR_AMOUNT,
    amount_due: AR_AMOUNT,
    amount_received: 0,
    status: "OPEN",
    remark: "TEST P4",
    created_by: ACTOR
  });
  if (arIns.error) throw new Error(arIns.error.message || "ar insert failed");

  return { customerId, arId };
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
  if (!(await paymentStatusColumnReady_())) {
    console.error("SKIP: ar_payment.status not deployed. Run v4.3.10 first.");
    process.exit(2);
  }

  const created = { customerIds: [], arIds: [], paymentIds: [] };

  try {
    const { customerId, arId } = await ensureCustomerAndAr();
    created.customerIds.push(customerId);
    created.arIds.push(arId);

    const paymentId = PREFIX + "-PAY";
    const regRes = await registerArPaymentBundle({
      ar_id: arId,
      payment_id: paymentId,
      payment_date: "2099-09-20",
      amount: PAY_AMOUNT,
      remark: "TEST payment",
      created_by: ACTOR,
      _session: SESSION
    });
    if (regRes && regRes.success === false) {
      throw new Error((regRes.errors && regRes.errors[0]) || regRes.err || "register payment failed");
    }
    created.paymentIds.push(paymentId);

    const { data: payPosted } = await sb.from("ar_payment").select("*").eq("payment_id", paymentId).maybeSingle();
    const { data: arAfterPost } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();

    const postPass =
      String(payPosted?.status || "").toUpperCase() === "POSTED" &&
      Math.abs(Number(payPosted?.amount || 0) - PAY_AMOUNT) < 0.02 &&
      Math.abs(Number(arAfterPost?.amount_received || 0) - PAY_AMOUNT) < 0.02;

    const voidRes = await voidArPaymentBundle({
      payment_id: paymentId,
      void_reason: "TEST VOID",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (voidRes && voidRes.success === false) {
      throw new Error((voidRes.errors && voidRes.errors[0]) || voidRes.err || "void payment failed");
    }

    const { data: payVoid } = await sb.from("ar_payment").select("*").eq("payment_id", paymentId).maybeSingle();
    const { data: arAfterVoid } = await sb.from("ar_receivable").select("*").eq("ar_id", arId).maybeSingle();

    const voidPass =
      String(payVoid?.status || "").toUpperCase() === "VOID" &&
      Math.abs(Number(payVoid?.amount || 0) - PAY_AMOUNT) < 0.02 &&
      Math.abs(Number(arAfterVoid?.amount_received || 0)) < 0.02 &&
      String(voidRes.payment_status || "").toUpperCase() === "VOID";

    writeEvidence("SUMMARY", {
      post_pass: postPass,
      void_pass: voidPass,
      regRes,
      voidRes,
      payPosted,
      payVoid,
      arAfterPost,
      arAfterVoid
    });

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          post_pass: postPass,
          void_pass: voidPass,
          payment_status_after_void: payVoid?.status,
          amount_preserved: Number(payVoid?.amount || 0)
        },
        null,
        2
      )
    );
    process.exit(postPass && voidPass ? 0 : 1);
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
