/**
 * Phase 3 slice2 - CREDIT_NOTE Rebate + Monthly Close Cascade (DEV only)
 *
 * Run: node tests/p3-monthly-cn-close.test.mjs
 * 前置 SQL：v4.3.7 + v4.3.8
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
  postCommercialDealerRebateBundle,
  voidCommercialDealerMonthlyCloseBundle
} = require("../server/src/bundles/commercial-dealer");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP3B-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };
const PERIOD_YM = "2099-07";
const BILLING_AMOUNT = 1000;
const REBATE_PCT = 5;

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
    rebate_pct: REBATE_PCT,
    remark: "TEST",
    created_by: ACTOR
  });

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P3B Customer",
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

  return { customerId, rebateSchemeId };
}

async function seedConsignmentBilling_(customerId) {
  const caseId = PREFIX + "-CASE";
  const settlementId = PREFIX + "-STL";
  const arId = "AR-STL-" + settlementId;

  const caseIns = await sb.from("consignment_case").insert({
    case_id: caseId,
    customer_id: customerId,
    status: "OPEN",
    allocation_policy: "FIFO",
    open_date: "2099-07-01",
    remark: "TEST P3B",
    created_by: ACTOR
  });
  if (caseIns.error) throw new Error(caseIns.error.message || "case seed failed");

  const arIns = await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "CONSIGNMENT_CASE_SETTLEMENT",
    source_id: settlementId,
    customer_id: customerId,
    settlement_id: settlementId,
    ar_date: "2099-07-15",
    currency: "USD",
    amount_system: BILLING_AMOUNT,
    amount_due: BILLING_AMOUNT,
    amount_received: 0,
    status: "OPEN",
    remark: "TEST P3B",
    created_by: ACTOR
  });
  if (arIns.error) throw new Error(arIns.error.message || "ar seed failed");

  const stlIns = await sb.from("consignment_case_settlement").insert({
    settlement_id: settlementId,
    case_id: caseId,
    customer_id: customerId,
    settlement_date: "2099-07-15",
    amount_system: BILLING_AMOUNT,
    ar_id: arId,
    status: "POSTED",
    remark: "TEST P3B",
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
    await sb.from("ar_amount_adjustment_log").delete().in("ar_id", ids.arIds || []);
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
    arIds: [],
    statIds: [],
    levelPostIds: [],
    rebateIds: []
  };

  try {
    const { customerId, rebateSchemeId } = await ensureCustomer();
    created.customerIds.push(customerId);
    created.schemeIds.push(rebateSchemeId, PREFIX + "-CUM");
    created.tierIds.push(PREFIX + "-CUM-T1", PREFIX + "-REB-T1");

    const billingSeed = await seedConsignmentBilling_(customerId);
    created.caseIds.push(billingSeed.caseId);
    created.settlementIds.push(billingSeed.settlementId);
    created.arIds.push(billingSeed.arId);

    const statRes = await postCommercialDealerMonthlyStatBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (statRes && statRes.success === false) {
      throw new Error((statRes.errors && statRes.errors[0]) || statRes.err || "monthly stat failed");
    }
    created.statIds.push(statRes.stat_id);

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
    created.levelPostIds.push(levelRes.level_post_id);

    const { data: arBefore } = await sb
      .from("ar_receivable")
      .select("amount_due")
      .eq("ar_id", billingSeed.arId)
      .maybeSingle();
    const dueBefore = Number(arBefore?.amount_due || 0);

    const rebateRes = await postCommercialDealerRebateBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      settle_mode: "CREDIT_NOTE",
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (rebateRes && rebateRes.success === false) {
      throw new Error((rebateRes.errors && rebateRes.errors[0]) || rebateRes.err || "rebate CN failed");
    }
    created.rebateIds.push(rebateRes.rebate_id);

    const expectedRebate = round2_((BILLING_AMOUNT * REBATE_PCT) / 100);
    const { data: arAfterRebate } = await sb
      .from("ar_receivable")
      .select("amount_due")
      .eq("ar_id", billingSeed.arId)
      .maybeSingle();
    const { data: rebateRow } = await sb
      .from("commercial_dealer_rebate")
      .select("*")
      .eq("rebate_id", rebateRes.rebate_id)
      .maybeSingle();

    const cnPass =
      rebateRes.rebate_rpc === true &&
      String(rebateRow?.settle_mode || "").toUpperCase() === "CREDIT_NOTE" &&
      Math.abs(Number(rebateRow?.credit_applied || 0) - expectedRebate) < 0.02 &&
      Math.abs(Number(arAfterRebate?.amount_due || 0) - (dueBefore - expectedRebate)) < 0.02;

    const closeRes = await voidCommercialDealerMonthlyCloseBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      void_reason: "TEST CLOSE",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (closeRes && closeRes.success === false) {
      throw new Error((closeRes.errors && closeRes.errors[0]) || closeRes.err || "monthly close void failed");
    }

    const { data: statAfter } = await sb
      .from("commercial_dealer_monthly_stat")
      .select("status")
      .eq("stat_id", statRes.stat_id)
      .maybeSingle();
    const { data: levelAfter } = await sb
      .from("commercial_dealer_level_post")
      .select("status")
      .eq("level_post_id", levelRes.level_post_id)
      .maybeSingle();
    const { data: rebateAfter } = await sb
      .from("commercial_dealer_rebate")
      .select("status")
      .eq("rebate_id", rebateRes.rebate_id)
      .maybeSingle();
    const { data: arAfterClose } = await sb
      .from("ar_receivable")
      .select("amount_due")
      .eq("ar_id", billingSeed.arId)
      .maybeSingle();
    const { data: custAfter } = await sb
      .from("customer")
      .select("dealer_cumulative_amount")
      .eq("customer_id", customerId)
      .maybeSingle();

    const closePass =
      closeRes.close_rpc === true &&
      String(statAfter?.status || "").toUpperCase() === "VOID" &&
      String(levelAfter?.status || "").toUpperCase() === "VOID" &&
      String(rebateAfter?.status || "").toUpperCase() === "VOID" &&
      Math.abs(Number(arAfterClose?.amount_due || 0) - dueBefore) < 0.02 &&
      Math.abs(Number(custAfter?.dealer_cumulative_amount || 0)) < 0.02;

    writeEvidence("SUMMARY", {
      cn_pass: cnPass,
      close_pass: closePass,
      rebateRes,
      closeRes,
      dueBefore,
      arAfterRebate,
      arAfterClose,
      custAfter
    });

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          cn_pass: cnPass,
          close_pass: closePass,
          rebate_rpc: rebateRes.rebate_rpc,
          close_rpc: closeRes.close_rpc
        },
        null,
        2
      )
    );
    process.exit(cnPass && closePass ? 0 : 1);
  } catch (e) {
    writeEvidence("ERROR", { message: e?.message || String(e), stack: e?.stack || "" });
    try {
      await cleanup(created);
    } catch (_e2) {}
    console.error("FAILED.", e?.message || String(e));
    process.exit(1);
  }
}

function round2_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

main();
