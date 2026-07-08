/**
 * 依一般出貨 AR 重算客戶月結累積（補登舊資料）
 * 用法：node scripts/sync-general-shipment-cumulative.mjs [CUSTOMER_ID]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { syncCustomerCumulativeTierBundle } = require("../src/bundles/commercial-dealer");
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
  let custQuery = sb
    .from("customer")
    .select("customer_id, customer_name, dealer_cumulative_scheme_id, dealer_cumulative_amount")
    .neq("dealer_cumulative_scheme_id", "");
  if (custFilter) custQuery = custQuery.eq("customer_id", custFilter);
  const { data: customers, error } = await custQuery;
  if (error) throw new Error(error.message);

  for (const c of customers || []) {
    const cid = String(c.customer_id || "").trim().toUpperCase();
    const before = Number(c.dealer_cumulative_amount || 0);
    const res = await syncCustomerCumulativeTierBundle({
      customer_id: cid,
      updated_by: ACTOR,
      _session: { allowed_modules: "*" }
    });
    if (!res.success) {
      console.error(cid, res.errors);
      continue;
    }
    const after = res.dealer_cumulative_amount != null ? res.dealer_cumulative_amount : res.cumulative_after;
    console.log(
      cid,
      String(c.customer_name || "").trim(),
      "before=" + before,
      "after=" + (after != null ? after : before),
      res.backfill && !res.backfill.skipped ? "backfill=" + JSON.stringify(res.backfill) : "",
      res.recalc && !res.recalc.skipped ? "recalc" : ""
    );
  }
}

main().catch(function (e) {
  console.error(e?.message || e);
  process.exit(1);
});
