/**
 * 依有效「次月結算折抵」回饋，同步客戶 dealer_rebate_credit_balance（修正幽靈餘額）
 * 用法：node scripts/sync-dealer-credit-balance.mjs [CUSTOMER_ID]
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

const ACTOR = "admin";
const custFilter = String(process.argv[2] || "").trim().toUpperCase();

async function main() {
  if (String(envName() || "").toUpperCase() === "PROD") {
    console.error("拒絕在 PROD 執行");
    process.exit(1);
  }
  const sb = getSupabase();
  let custQuery = sb.from("customer").select("customer_id, dealer_rebate_credit_balance");
  if (custFilter) custQuery = custQuery.eq("customer_id", custFilter);
  const { data: customers, error } = await custQuery;
  if (error) throw new Error(error.message);

  for (const c of customers || []) {
    const cid = String(c.customer_id || "").trim().toUpperCase();
    const { data: rows } = await sb
      .from("commercial_dealer_rebate")
      .select("rebate_amount")
      .eq("customer_id", cid)
      .eq("status", "POSTED")
      .eq("settle_mode", "CARRY_FORWARD");
    const expected = Math.round(
      (rows || []).reduce(function (s, r) {
        return s + Number(r.rebate_amount || 0);
      }, 0) * 100
    ) / 100;
    const before = Number(c.dealer_rebate_credit_balance || 0);
    if (Math.abs(before - expected) < 1e-9) continue;
    const { error: updErr } = await sb
      .from("customer")
      .update({
        dealer_rebate_credit_balance: expected,
        updated_by: ACTOR,
        updated_at: new Date().toISOString()
      })
      .eq("customer_id", cid);
    if (updErr) throw new Error(updErr.message);
    console.log(cid + ": " + before + " → " + expected);
  }
  console.log("完成");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
