/**
 * 作廢一般出貨 AR（用於舊資料：出貨已作廢但 AR 仍留在未結清）
 * 用法：
 *   node scripts/void-shipment-ar.mjs SHIP-260706-2121-D19E [原因]
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
const { voidArForCancelledShipment_ } = require("../src/bundles/ar");

const shipmentId = String(process.argv[2] || "").trim().toUpperCase();
const reason = String(process.argv[3] || "").trim() || "作廢出貨";
const ACTOR = "admin";

async function main() {
  if (!shipmentId) {
    console.error("需要 shipment_id，例如 SHIP-260706-2121-D19E");
    process.exit(1);
  }
  if (String(envName() || "").toUpperCase() === "PROD") {
    console.error("拒絕在 PROD 執行");
    process.exit(1);
  }
  const sb = getSupabase();
  const res = await voidArForCancelledShipment_(sb, shipmentId, reason, ACTOR, new Date().toISOString());
  console.log(res);
}

main().catch(function (e) {
  console.error(e?.message || e);
  process.exit(1);
});

