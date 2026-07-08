/**
 * DEV：清除 2026-07 月結回饋、寄賣結算、相關 AR（先作廢還原池／餘額，再硬刪）
 * 用法：cd server && node scripts/clear-july2026-finance.mjs
 * 可選：node scripts/clear-july2026-finance.mjs --customer C260605-9W
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

const { getSupabase } = require("../src/supabase");
const { envName } = require("../src/response");
const {
  voidCommercialDealerRebateBundle,
  recalculateCustomerCumulativeFromPostedRebates_
} = require("../src/bundles/commercial-dealer");
const { cancelConsignmentCaseSettlementBundle } = require("../src/bundles/consignment-case");

const PERIOD_YM = "2026-07";
const DATE_FROM = "2026-07-01";
const DATE_TO = "2026-07-31";
const ACTOR = "admin";
const VOID_REASON = "DEV 清除 2026-07 測試資料";

const customerArg = process.argv.find((a) => a.startsWith("--customer="));
const CUSTOMER_FILTER = customerArg ? String(customerArg.split("=")[1] || "").trim().toUpperCase() : "";

const DEV_SESSION = {
  user_id: ACTOR,
  role: "ADMIN",
  allowed_modules: "*"
};

function normId(v) {
  return String(v || "").trim().toUpperCase();
}

async function main() {
  const env = String(envName() || "DEV").trim().toUpperCase();
  if (env === "PROD") {
    console.error("拒絕在 PROD 執行");
    process.exit(1);
  }

  const sb = getSupabase();
  console.log("環境:", env);
  console.log("範圍:", PERIOD_YM, CUSTOMER_FILTER ? "客戶 " + CUSTOMER_FILTER : "全部客戶");

  let rebateQuery = sb
    .from("commercial_dealer_rebate")
    .select("rebate_id, customer_id, status, period_ym, settle_mode, rebate_amount")
    .eq("period_ym", PERIOD_YM);
  if (CUSTOMER_FILTER) rebateQuery = rebateQuery.eq("customer_id", CUSTOMER_FILTER);
  const { data: rebates, error: rebListErr } = await rebateQuery;
  if (rebListErr) throw new Error(rebListErr.message);

  const postedRebates = (rebates || []).filter((r) => normId(r.status) === "POSTED");
  console.log("月結回饋 POSTED:", postedRebates.length);

  const carryByCustomer = {};
  postedRebates.forEach((r) => {
    if (normId(r.settle_mode) !== "CARRY_FORWARD") return;
    const cid = normId(r.customer_id);
    carryByCustomer[cid] = (carryByCustomer[cid] || 0) + Number(r.rebate_amount || 0);
  });
  for (const [cid, need] of Object.entries(carryByCustomer)) {
    if (!(need > 1e-9)) continue;
    const { data: cust } = await sb
      .from("customer")
      .select("dealer_rebate_credit_balance")
      .eq("customer_id", cid)
      .maybeSingle();
    const cur = Number(cust?.dealer_rebate_credit_balance || 0);
    if (cur + 1e-9 < need) {
      const { error: balErr } = await sb
        .from("customer")
        .update({
          dealer_rebate_credit_balance: need,
          updated_by: ACTOR,
          updated_at: new Date().toISOString()
        })
        .eq("customer_id", cid);
      if (balErr) throw new Error("補回折抵餘額失敗 " + cid + ": " + balErr.message);
      console.log("  補回折抵餘額", cid, "→", need, "（結算已扣過，作廢回饋前先還原）");
    }
  }

  for (const r of postedRebates) {
    const res = await voidCommercialDealerRebateBundle({
      rebate_id: r.rebate_id,
      void_reason: VOID_REASON,
      updated_by: ACTOR,
      _session: DEV_SESSION
    });
    if (res && res.success === false) {
      throw new Error("作廢回饋失敗 " + r.rebate_id + ": " + (res.errors && res.errors[0]));
    }
    console.log("  作廢回饋:", r.rebate_id);
  }

  let stlQuery = sb
    .from("consignment_case_settlement")
    .select("settlement_id, customer_id, status, settlement_date, ar_id")
    .gte("settlement_date", DATE_FROM)
    .lte("settlement_date", DATE_TO);
  if (CUSTOMER_FILTER) stlQuery = stlQuery.eq("customer_id", CUSTOMER_FILTER);
  const { data: settlements, error: stlListErr } = await stlQuery;
  if (stlListErr) throw new Error(stlListErr.message);

  const postedStl = (settlements || []).filter((s) => normId(s.status) === "POSTED");
  console.log("7 月結算 POSTED:", postedStl.length);
  for (const s of postedStl) {
    const res = await cancelConsignmentCaseSettlementBundle({
      settlement_id: s.settlement_id,
      void_reason: VOID_REASON,
      updated_by: ACTOR,
      _session: DEV_SESSION
    });
    if (res && res.success === false) {
      throw new Error("作廢結算失敗 " + s.settlement_id + ": " + (res.errors && res.errors[0]));
    }
    console.log("  作廢結算:", s.settlement_id);
  }

  const stlIds = (settlements || []).map((s) => normId(s.settlement_id)).filter(Boolean);
  const arIds = [
    ...new Set(
      (settlements || [])
        .map((s) => normId(s.ar_id || "AR-STL-" + s.settlement_id))
        .filter(Boolean)
    )
  ];

  if (arIds.length) {
    await sb.from("ar_amount_adjustment_log").delete().in("ar_id", arIds);
    await sb.from("ar_payment").delete().in("ar_id", arIds);
    const { error: arDelErr } = await sb.from("ar_receivable").delete().in("ar_id", arIds);
    if (arDelErr) throw new Error("刪除 AR 失敗: " + arDelErr.message);
    console.log("已刪除 AR:", arIds.length, "筆");
  }

  if (stlIds.length) {
    await sb.from("consignment_case_settlement_item").delete().in("settlement_id", stlIds);
    const { error: stlDelErr } = await sb.from("consignment_case_settlement").delete().in("settlement_id", stlIds);
    if (stlDelErr) throw new Error("刪除結算失敗: " + stlDelErr.message);
    console.log("已刪除結算:", stlIds.length, "筆");
  }

  let rebDelQuery = sb.from("commercial_dealer_rebate").delete().eq("period_ym", PERIOD_YM);
  if (CUSTOMER_FILTER) rebDelQuery = rebDelQuery.eq("customer_id", CUSTOMER_FILTER);
  const { error: rebDelErr } = await rebDelQuery;
  if (rebDelErr) throw new Error("刪除月結回饋失敗: " + rebDelErr.message);
  console.log("已刪除月結回饋紀錄（", PERIOD_YM, "）");

  const customerIds = [
    ...new Set(
      [...(rebates || []), ...(settlements || [])].map((x) => normId(x.customer_id)).filter(Boolean)
    )
  ];
  for (const cid of customerIds) {
    try {
      await recalculateCustomerCumulativeFromPostedRebates_(sb, cid, ACTOR, new Date().toISOString());
      console.log("重算累積:", cid);
    } catch (e) {
      console.warn("重算累積略過", cid, e?.message || e);
    }
    const { data: carryRows } = await sb
      .from("commercial_dealer_rebate")
      .select("rebate_amount")
      .eq("customer_id", cid)
      .eq("status", "POSTED")
      .eq("settle_mode", "CARRY_FORWARD");
    const expectedBal = (carryRows || []).reduce(function (s, r) {
      return s + Number(r.rebate_amount || 0);
    }, 0);
    const { error: syncBalErr } = await sb
      .from("customer")
      .update({
        dealer_rebate_credit_balance: Math.round(expectedBal * 100) / 100,
        updated_by: ACTOR,
        updated_at: new Date().toISOString()
      })
      .eq("customer_id", cid);
    if (syncBalErr) console.warn("同步折抵餘額略過", cid, syncBalErr.message);
    else console.log("同步折抵餘額:", cid, "→", expectedBal);
  }

  console.log("\n完成。請 Ctrl+F5 重新整理前端。");
}

main().catch((e) => {
  console.error("\n失敗:", e?.message || e);
  process.exit(1);
});
