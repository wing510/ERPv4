/**
 * Phase 4 slice3 - AR adjustment log source_type/source_id (DEV only)
 *
 * Run: node tests/p4-ar-adjustment-source.test.mjs
 * 前置 SQL：v4.3.12_AR調整來源鍵Phase4Slice3.sql
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
const { adjustArAmountBundle } = require("../server/src/bundles/ar");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP4C-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };
const AR_AMOUNT = 1000;
const SRC_TYPE = "TEST_P4_ADJ";
const SRC_ID = PREFIX + "-SRC";

const evidenceRoot = path.resolve("tests/_p4c_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function sourceColumnsReady_() {
  const { error } = await sb.from("ar_amount_adjustment_log").select("source_type, source_id").limit(1);
  return !error;
}

async function ensureCustomerAndAr() {
  const customerId = PREFIX + "-CUST";
  const arId = PREFIX + "-AR";

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P4C Customer",
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
    remark: "TEST P4C",
    created_by: ACTOR
  });
  if (arIns.error) throw new Error(arIns.error.message || "ar insert failed");

  return { customerId, arId };
}

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.adjustIds).length) {
    await sb.from("ar_amount_adjustment_log").delete().in("adjust_id", ids.adjustIds);
  }
  if (list(ids.sourceIds).length) {
    await sb
      .from("ar_amount_adjustment_log")
      .delete()
      .eq("source_type", SRC_TYPE)
      .in("source_id", ids.sourceIds);
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
  if (!(await sourceColumnsReady_())) {
    console.error("SKIP: ar_amount_adjustment_log.source_type not deployed. Run v4.3.12 first.");
    process.exit(2);
  }

  const created = { customerIds: [], arIds: [], adjustIds: [], sourceIds: [SRC_ID] };

  try {
    const { customerId, arId } = await ensureCustomerAndAr();
    created.customerIds.push(customerId);
    created.arIds.push(arId);

    const newDue = 850;
    const adjRes = await adjustArAmountBundle({
      ar_id: arId,
      amount_due: newDue,
      reason: "TEST source key adjust",
      reason_code: "DISCOUNT",
      source_type: SRC_TYPE,
      source_id: SRC_ID,
      updated_by: ACTOR,
      created_by: ACTOR,
      _session: SESSION
    });
    if (adjRes && adjRes.success === false) {
      throw new Error((adjRes.errors && adjRes.errors[0]) || adjRes.err || "adjust failed");
    }

    const { data: logRow } = await sb
      .from("ar_amount_adjustment_log")
      .select("*")
      .eq("source_type", SRC_TYPE)
      .eq("source_id", SRC_ID)
      .maybeSingle();

    if (logRow?.adjust_id) created.adjustIds.push(logRow.adjust_id);

    const sourcePass =
      String(logRow?.source_type || "").toUpperCase() === SRC_TYPE &&
      String(logRow?.source_id || "").toUpperCase() === SRC_ID &&
      Math.abs(Number(logRow?.amount_after || 0) - newDue) < 0.02;

    const dupRes = await adjustArAmountBundle({
      ar_id: arId,
      amount_due: 700,
      reason: "TEST duplicate source should fail",
      reason_code: "DISCOUNT",
      source_type: SRC_TYPE,
      source_id: SRC_ID,
      updated_by: ACTOR,
      created_by: ACTOR,
      _session: SESSION
    });
    const idempotentPass = dupRes && dupRes.success === false;

    writeEvidence("SUMMARY", {
      source_pass: sourcePass,
      idempotent_pass: idempotentPass,
      adjRes,
      dupRes,
      logRow
    });

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          source_pass: sourcePass,
          idempotent_pass: idempotentPass,
          source_type: logRow?.source_type,
          source_id: logRow?.source_id
        },
        null,
        2
      )
    );
    process.exit(sourcePass && idempotentPass ? 0 : 1);
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
