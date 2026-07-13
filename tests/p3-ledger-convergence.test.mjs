/**
 * Phase 3 slice3 - Dealer cumulative ledger convergence (DEV only)
 *
 * Run: node tests/p3-ledger-convergence.test.mjs
 * 前置 SQL：v4.3.7 + v4.3.9
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
  postCommercialDealerMonthlyStatBundle,
  postCommercialDealerLevelBundle,
  voidCommercialDealerLevelPostBundle,
  syncCustomerCumulativeFromSources_
} = require("../server/src/bundles/commercial-dealer");

const sb = getSupabase();

const ENV_NAME = String(process.env.ERP_ENV_NAME || "").trim().toUpperCase();
if (ENV_NAME === "PROD" || ENV_NAME === "PRODUCTION") {
  console.error("NO-GO: ERP_ENV_NAME indicates PROD");
  process.exit(2);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const PREFIX = "TESTP3L-" + RUN_TS.slice(0, 19).replace(/T/g, "");
const ACTOR = "test-runner";
const SESSION = { role: "CEO", allowed_modules: "*" };
const PERIOD_YM = "2099-08";
const BILLING_AMOUNT = 800;

const evidenceRoot = path.resolve("tests/_p3_evidence", PREFIX);
fs.mkdirSync(evidenceRoot, { recursive: true });

function writeEvidence(name, obj) {
  const p = path.join(evidenceRoot, name + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

async function ledgerTableReady_() {
  const { error } = await sb.from("dealer_cumulative_ledger").select("ledger_id").limit(1);
  return !error;
}

async function sumLedgerForCustomer_(customerId) {
  const { data, error } = await sb
    .from("dealer_cumulative_ledger")
    .select("amount")
    .eq("customer_id", customerId);
  if (error) throw new Error(error.message || String(error));
  return (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
}

async function ensureCustomer() {
  const customerId = PREFIX + "-CUST";
  const cumSchemeId = PREFIX + "-CUM";

  await sb.from("commercial_dealer_scheme").upsert({
    scheme_id: cumSchemeId,
    scheme_name: "TEST Ledger",
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

  await masterCrudHandlers().create_customer({
    customer_id: customerId,
    customer_name: "TEST P3L Customer",
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

  return { customerId, cumSchemeId };
}

async function seedBilling_(customerId) {
  const caseId = PREFIX + "-CASE";
  const settlementId = PREFIX + "-STL";
  const arId = "AR-STL-" + settlementId;

  await sb.from("consignment_case").insert({
    case_id: caseId,
    customer_id: customerId,
    status: "OPEN",
    allocation_policy: "FIFO",
    open_date: "2099-08-01",
    remark: "TEST",
    created_by: ACTOR
  });
  await sb.from("ar_receivable").insert({
    ar_id: arId,
    source_type: "CONSIGNMENT_CASE_SETTLEMENT",
    source_id: settlementId,
    customer_id: customerId,
    settlement_id: settlementId,
    ar_date: "2099-08-15",
    currency: "USD",
    amount_system: BILLING_AMOUNT,
    amount_due: BILLING_AMOUNT,
    amount_received: 0,
    status: "OPEN",
    remark: "TEST",
    created_by: ACTOR
  });
  await sb.from("consignment_case_settlement").insert({
    settlement_id: settlementId,
    case_id: caseId,
    customer_id: customerId,
    settlement_date: "2099-08-15",
    amount_system: BILLING_AMOUNT,
    ar_id: arId,
    status: "POSTED",
    remark: "TEST",
    created_by: ACTOR
  });

  return { caseId, settlementId, arId };
}

async function cleanup(created) {
  const ids = created || {};
  const list = (a) => (a && a.length ? a : []);

  if (list(ids.ledgerCustomerIds).length) {
    await sb.from("dealer_cumulative_ledger").delete().in("customer_id", ids.ledgerCustomerIds);
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
  if (!(await ledgerTableReady_())) {
    console.error("SKIP: dealer_cumulative_ledger not deployed. Run v4.3.9 first.");
    process.exit(2);
  }

  const created = {
    customerIds: [],
    ledgerCustomerIds: [],
    schemeIds: [],
    tierIds: [],
    caseIds: [],
    settlementIds: [],
    statIds: [],
    levelPostIds: []
  };

  try {
    const { customerId, cumSchemeId } = await ensureCustomer();
    created.customerIds.push(customerId);
    created.ledgerCustomerIds.push(customerId);
    created.schemeIds.push(cumSchemeId);
    created.tierIds.push(PREFIX + "-CUM-T1");

    const billing = await seedBilling_(customerId);
    created.caseIds.push(billing.caseId);
    created.settlementIds.push(billing.settlementId);

    const statRes = await postCommercialDealerMonthlyStatBundle({
      customer_id: customerId,
      period_ym: PERIOD_YM,
      remark: "TEST",
      created_by: ACTOR,
      _session: SESSION
    });
    if (statRes && statRes.success === false) {
      throw new Error((statRes.errors && statRes.errors[0]) || statRes.err || "stat failed");
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
      throw new Error((levelRes.errors && levelRes.errors[0]) || levelRes.err || "level failed");
    }
    created.levelPostIds.push(levelRes.level_post_id);

    const ledgerSum = await sumLedgerForCustomer_(customerId);
    const { data: custAfterPost } = await sb
      .from("customer")
      .select("dealer_cumulative_amount")
      .eq("customer_id", customerId)
      .maybeSingle();
    const { data: ledgerPosts } = await sb
      .from("dealer_cumulative_ledger")
      .select("*")
      .eq("customer_id", customerId)
      .eq("source_type", "MONTHLY_LEVEL_POST")
      .eq("entry_type", "POST");

    const postPass =
      levelRes.level_rpc === true &&
      (ledgerPosts || []).length === 1 &&
      Math.abs(ledgerSum - BILLING_AMOUNT) < 0.02 &&
      Math.abs(Number(custAfterPost?.dealer_cumulative_amount || 0) - ledgerSum) < 0.02;

    const voidRes = await voidCommercialDealerLevelPostBundle({
      level_post_id: levelRes.level_post_id,
      void_reason: "TEST VOID",
      updated_by: ACTOR,
      _session: SESSION
    });
    if (voidRes && voidRes.success === false) {
      throw new Error((voidRes.errors && voidRes.errors[0]) || voidRes.err || "void failed");
    }

    const ledgerSumAfterVoid = await sumLedgerForCustomer_(customerId);
    const { data: custAfterVoid } = await sb
      .from("customer")
      .select("dealer_cumulative_amount")
      .eq("customer_id", customerId)
      .maybeSingle();
    const syncRes = await syncCustomerCumulativeFromSources_(sb, customerId, ACTOR, new Date().toISOString());

    const voidPass =
      voidRes.level_rpc === true &&
      Math.abs(ledgerSumAfterVoid) < 0.02 &&
      Math.abs(Number(custAfterVoid?.dealer_cumulative_amount || 0)) < 0.02 &&
      syncRes.source === "dealer_cumulative_ledger";

    writeEvidence("SUMMARY", {
      post_pass: postPass,
      void_pass: voidPass,
      levelRes,
      voidRes,
      syncRes,
      ledgerSum,
      ledgerSumAfterVoid,
      ledgerPosts
    });

    await cleanup(created);

    console.log(
      JSON.stringify(
        {
          post_pass: postPass,
          void_pass: voidPass,
          ledger_sum_after_post: ledgerSum,
          ledger_sum_after_void: ledgerSumAfterVoid
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
