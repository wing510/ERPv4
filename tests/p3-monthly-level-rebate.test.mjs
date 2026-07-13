/**
 * Phase 3 - Monthly Level Post + Rebate CF Integration Test (DEV only)
 *
 * Run: node tests/p3-monthly-level-rebate.test.mjs
 * 前置 SQL：v4.3.7_月結帳本交易Phase3.sql
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
const {
  postCommercialDealerMonthlyStatBundle,
  postCommercialDealerLevelBundle,
  voidCommercialDealerLevelPostBundle,
  postCommercialDealerRebateBundle,
  voidCommercialDealerRebateBundle
} = require("../server/src/bundles/commercial-dealer");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP3-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };
const PERIOD_YM = "2099-06";

const evidenceRoot = path.resolve("tests/_p3_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function ensureCustomer() {
  const customerId = PREFIX + "-CUST";
  const cumSchemeId = PREFIX + "-CUM";
  const rebateSchemeId = PREFIX + "-REB";

  await sb.from("commercial_dealer_scheme").upsert({
    scheme_id: cumSchemeId,
    scheme_name: "TEST Cumulative",
    status: "ACTIVE",
    date_from: "2099-01-01",
    date_to: "2099-12-31",
    scheme_type: "CUMULATIVE_AMOUNT",
    stat_source: "ALL",
    mutex_group: "CUMULATIVE",
    remark: "TEST",
    created_by: ACTOR
  });

  await sb.from("commercial_dealer_scheme_tier").upsert({
    tier_id: PREFIX + "-CUM-T1",
    scheme_id: cumSchemeId,
    line_no: 1,
    amount_from: 0,
    amount_to: null,
    rebate_pct: 0,
    price_rate: 0.9,
    tier_label: "TEST",
    remark: "TEST",
    created_by: ACTOR
  });

  await sb.from("commercial_dealer_scheme").upsert({
    scheme_id: rebateSchemeId,
    scheme_name: "TEST Rebate",
    status: "ACTIVE",
    date_from: "2099-01-01",
    date_to: "2099-12-31",
    scheme_type: "MONTHLY_REBATE",
    stat_source: "CONSIGNMENT",
    mutex_group: "MONTHLY_REBATE",
    remark: "TEST",
    created_by: ACTOR
  });

  await sb.from("commercial_dealer_scheme_tier").upsert({
    tier_id: PREFIX + "-REB-T1",
    scheme_id: rebateSchemeId,
    line_no: 1,
    amount_from: 0,
    amount_to: null,
    rebate_pct: 5,
    remark: "TEST",
    created_by: ACTOR
  });

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P3 Customer",
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
    dealer_rebate_scheme_id: rebateSchemeId,
    dealer_cumulative_scheme_id: cumSchemeId,
    dealer_rebate_settle_mode: "CARRY_FORWARD",
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

  return { customerId, cumSchemeId, rebateSchemeId };
}

const BILLING_AMOUNT = 1000;

async function seedConsignmentBilling_(customerId) {
  const caseId = PREFIX + "-CASE";
  const settlementId = PREFIX + "-STL";
  const arId = "AR-STL-" + settlementId;

  const caseIns = await sb.from("consignment_case").insert({
    case_id: caseId,
    customer_id: customerId,
    status: "OPEN",
    allocation_policy: "FIFO",
    open_date: "2099-06-01",
    remark: "TEST P3 billing seed",
    created_by: ACTOR
  });
  if (caseIns.error) throw new Error(caseIns.error.message || "case seed failed");

  const arIns = await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "CONSIGNMENT_CASE_SETTLEMENT",
    source_id: settlementId,
    customer_id: customerId,
    settlement_id: settlementId,
    ar_date: "2099-06-15",
    currency: "USD",
    amount_system: BILLING_AMOUNT,
    amount_due: BILLING_AMOUNT,
    amount_received: 0,
    status: "OPEN",
    remark: "TEST P3",
    created_by: ACTOR
  });
  if (arIns.error) throw new Error(arIns.error.message || "ar seed failed");

  const stlIns = await sb.from("consignment_case_settlement").insert({
    settlement_id: settlementId,
    case_id: caseId,
    customer_id: customerId,
    settlement_date: "2099-06-15",
    amount_system: BILLING_AMOUNT,
    ar_id: arId,
    status: "POSTED",
    remark: "TEST P3",
    created_by: ACTOR
  });
  if (stlIns.error) throw new Error(stlIns.error.message || "settlement seed failed");

  return { caseId, settlementId, arId };
}

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.rebateIds).length) {
    await sb.from("commercial_dealer_rebate").delete().in("rebate_id", ids.rebateIds);
  }
  if (list(ids.levelPostIds).length) {
    await sb.from("commercial_dealer_level_post").delete().in("level_post_id", ids.levelPostIds);
  }
  if (list(ids.statIds).length) {
    await sb.from("commercial_dealer_monthly_stat").delete().in("stat_id", ids.statIds);
  }
  if (list(ids.settlementIds).length) {
    await sb.from("ar_receivable").delete().in("settlement_id", ids.settlementIds);
    await sb.from("consignment_case_settlement").delete().in("settlement_id", ids.settlementIds);
  }
  if (list(ids.caseIds).length) {
    await sb.from("consignment_case").delete().in("case_id", ids.caseIds);
  }
  if (list(ids.customerIds).length) {
    await sb.from("customer").delete().in("customer_id", ids.customerIds);
  }
  if (list(ids.schemeIds).length) {
    await sb.from("commercial_dealer_scheme_tier").delete().in("scheme_id", ids.schemeIds);
    await sb.from("commercial_dealer_scheme").delete().in("scheme_id", ids.schemeIds);
  }
  if (list(ids.tierIds).length) {
    await sb.from("commercial_dealer_scheme_tier").delete().in("tier_id", ids.tierIds);
  }
}

async function main() {
  const created = {
    customerIds: [],
    schemeIds: [],
    tierIds: [],
    caseIds: [],
    settlementIds: [],
    statIds: [],
    levelPostIds: [],
    rebateIds: []
  };

  try {
    const { customerId, cumSchemeId, rebateSchemeId } = await ensureCustomer();
    created.customerIds.push(customerId);
    created.schemeIds.push(cumSchemeId, rebateSchemeId);
    created.tierIds.push(PREFIX + "-CUM-T1", PREFIX + "-REB-T1");

    const billingSeed = await seedConsignmentBilling_(customerId);
    created.caseIds.push(billingSeed.caseId);
    created.settlementIds.push(billingSeed.settlementId);

    const statRes = await postCommercialDealerMonthlyStatBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (statRes && statRes.success === false) {
      throw new Error((statRes.errors && statRes.errors[0]) || statRes.err || "monthly stat post failed");
    }
    created.statIds.push(statRes.stat_id);

    const { data: custBefore } = await sb
      .from("customer")
      .select("dealer_cumulative_amount, dealer_rebate_credit_balance")
      .eq("customer_id", customerId)
      .maybeSingle();
    const cumBefore = Number(custBefore?.dealer_cumulative_amount || 0);
    const creditBefore = Number(custBefore?.dealer_rebate_credit_balance || 0);

    const levelRes = await postCommercialDealerLevelBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (levelRes && levelRes.success === false) {
      throw new Error((levelRes.errors && levelRes.errors[0]) || levelRes.err || "level post failed");
    }
    const levelPostId = levelRes.level_post_id;
    created.levelPostIds.push(levelPostId);

    const { data: custAfterLevel } = await sb
      .from("customer")
      .select("dealer_cumulative_amount")
      .eq("customer_id", customerId)
      .maybeSingle();
    const { data: levelRow } = await sb
      .from("commercial_dealer_level_post")
      .select("*")
      .eq("level_post_id", levelPostId)
      .maybeSingle();

    const levelPass =
      levelRes.level_rpc === true &&
      String(levelRow?.status || "").toUpperCase() === "POSTED" &&
      Number(custAfterLevel?.dealer_cumulative_amount || 0) > cumBefore + BILLING_AMOUNT - 1;

    const voidLevelRes = await voidCommercialDealerLevelPostBundle({
      level_post_id: levelPostId,
      void_reason: "TEST VOID",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (voidLevelRes && voidLevelRes.success === false) {
      throw new Error((voidLevelRes.errors && voidLevelRes.errors[0]) || voidLevelRes.err || "level void failed");
    }

    const { data: custAfterVoidLevel } = await sb
      .from("customer")
      .select("dealer_cumulative_amount")
      .eq("customer_id", customerId)
      .maybeSingle();
    const voidLevelPass =
      voidLevelRes.level_rpc === true &&
      Math.abs(Number(custAfterVoidLevel?.dealer_cumulative_amount || 0) - cumBefore) < 1e-6;

    const rebateRes = await postCommercialDealerRebateBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      settle_mode: "CARRY_FORWARD",
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (rebateRes && rebateRes.success === false) {
      throw new Error((rebateRes.errors && rebateRes.errors[0]) || rebateRes.err || "rebate post failed");
    }
    const rebateId = rebateRes.rebate_id;
    created.rebateIds.push(rebateId);

    const { data: custAfterRebate } = await sb
      .from("customer")
      .select("dealer_rebate_credit_balance")
      .eq("customer_id", customerId)
      .maybeSingle();
    const rebatePass =
      rebateRes.rebate_rpc === true &&
      Number(custAfterRebate?.dealer_rebate_credit_balance || 0) > creditBefore + 1e-6 &&
      Number(rebateRes.rebate_amount || 0) > 0;

    const voidRebateRes = await voidCommercialDealerRebateBundle({
      rebate_id: rebateId,
      void_reason: "TEST VOID",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (voidRebateRes && voidRebateRes.success === false) {
      throw new Error((voidRebateRes.errors && voidRebateRes.errors[0]) || voidRebateRes.err || "rebate void failed");
    }

    const { data: custAfterVoidRebate } = await sb
      .from("customer")
      .select("dealer_rebate_credit_balance")
      .eq("customer_id", customerId)
      .maybeSingle();
    const voidRebatePass =
      voidRebateRes.rebate_rpc === true &&
      Math.abs(Number(custAfterVoidRebate?.dealer_rebate_credit_balance || 0) - creditBefore) < 1e-6;

    const gateReport = {
      task_level: "A",
      risk_severity: levelPass && voidLevelPass && rebatePass && voidRebatePass ? "LOW" : "MEDIUM",
      gate_result:
        levelPass && voidLevelPass && rebatePass && voidRebatePass
          ? "GO FOR TESTING (DEV)"
          : "CONDITIONAL GO FOR TESTING (DEV)",
      level_rpc: levelRes.level_rpc === true ? "IN_RPC" : "NODE_FALLBACK",
      rebate_rpc: rebateRes.rebate_rpc === true ? "IN_RPC" : "NODE_FALLBACK",
      conditions: [],
      run_at: new Date().toISOString()
    };
    if (!levelRes.level_rpc) gateReport.conditions.push("Deploy server/sql/v4.3.7_月結帳本交易Phase3.sql");
    if (!rebateRes.rebate_rpc) gateReport.conditions.push("Deploy v4.3.7 for rebate CARRY_FORWARD RPC");

    const summaryPath = writeEvidence("SUMMARY", {
      level_pass: levelPass,
      void_level_pass: voidLevelPass,
      rebate_pass: rebatePass,
      void_rebate_pass: voidRebatePass,
      levelRes,
      voidLevelRes,
      rebateRes,
      voidRebateRes,
      gate_report: writeEvidence("GATE_REPORT", gateReport)
    });

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          summary: summaryPath,
          level_pass: levelPass,
          void_level_pass: voidLevelPass,
          rebate_pass: rebatePass,
          void_rebate_pass: voidRebatePass
        },
        null,
        2
      )
    );
    process.exit(levelPass && voidLevelPass && rebatePass && voidRebatePass ? 0 : 1);
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
