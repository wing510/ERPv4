/**
 * Phase 1 - Shipment Promotion Snapshot（純邏輯測試，不需 DB）
 * 執行：node tests/p1-shipment-promo.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeShipmentPromoLinesPhase1_ } = require("../server/src/bundles/consignment-promo.js");

function run(name, fn) {
  try {
    fn();
    console.log("✓ " + name);
    return true;
  } catch (e) {
    console.error("✗ " + name);
    console.error("  " + (e && e.message ? e.message : e));
    return false;
  }
}

let passed = 0;
let failed = 0;
function t(name, fn) {
  if (run(name, fn)) passed++;
  else failed++;
}

const snap = (overrides) =>
  Object.assign(
    {
      pricing_snapshot_id: "SOPS-1",
      so_item_id: "SOI-1",
      pricing_version: 1,
      product_id: "PROD1",
      list_unit_price: 100,
      base_unit_price: 80
    },
    overrides || {}
  );

t("FIXED_PRICE：每件固定促銷價（PER_SHIPMENT）", () => {
  const schemePacks = [
    {
      scheme: { scheme_id: "CP1", scheme_name: "固定價", scope_type: "CUSTOMER", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "FIXED_PRICE", promo_unit_price: 50, price_basis: "DEALER" }],
      priority: 10
    }
  ];
  const soSnapshotMap = { "SOI-1": snap() };
  const items = [{ shipment_item_id: "SHI-1", so_item_id: "SOI-1", ship_qty: 2 }];
  const out = computeShipmentPromoLinesPhase1_(items, soSnapshotMap, schemePacks, {});
  assert.equal(out[0].unit_price, 50);
  assert.equal(out[0].amount, 100);
  assert.equal(out[0].promo_scope, "PER_SHIPMENT");
});

t("DISCOUNT_PCT：折扣% 套用於 frozen base（不取 live dealer）", () => {
  const schemePacks = [
    {
      scheme: { scheme_id: "CP2", scheme_name: "九折", scope_type: "CUSTOMER", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "DISCOUNT_PCT", discount_pct: 90, price_basis: "DEALER" }],
      priority: 10
    }
  ];
  const soSnapshotMap = { "SOI-1": snap({ base_unit_price: 80 }) };
  const items = [{ shipment_item_id: "SHI-1", so_item_id: "SOI-1", ship_qty: 3 }];
  const out = computeShipmentPromoLinesPhase1_(items, soSnapshotMap, schemePacks, {});
  assert.equal(out[0].unit_price, 72);
  assert.equal(out[0].amount, 216);
});

t("BUY_N_GET_M：同批出貨成組，free_qty 只依本批 qty", () => {
  const schemePacks = [
    {
      scheme: { scheme_id: "CP3", scheme_name: "買3送1", scope_type: "CUSTOMER", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "BUY_N_GET_M", buy_qty: 3, free_qty: 1, price_basis: "DEALER" }],
      priority: 10
    }
  ];
  const soSnapshotMap = { "SOI-1": snap({ base_unit_price: 80 }) };
  const items = [{ shipment_item_id: "SHI-1", so_item_id: "SOI-1", ship_qty: 4 }];
  const out = computeShipmentPromoLinesPhase1_(items, soSnapshotMap, schemePacks, {});
  assert.equal(out[0].free_qty, 1);
  assert.equal(out[0].billable_qty, 3);
  assert.equal(out[0].amount, 240);
});

t("Partial shipment：兩次出貨各自成組（不跨出貨累積）", () => {
  const schemePacks = [
    {
      scheme: { scheme_id: "CP3", scheme_name: "買3送1", scope_type: "CUSTOMER", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "BUY_N_GET_M", buy_qty: 3, free_qty: 1, price_basis: "DEALER" }],
      priority: 10
    }
  ];
  const soSnapshotMap = { "SOI-1": snap({ base_unit_price: 80 }) };
  const outA = computeShipmentPromoLinesPhase1_(
    [{ shipment_item_id: "SHI-A", so_item_id: "SOI-1", ship_qty: 3 }],
    soSnapshotMap,
    schemePacks,
    {}
  );
  const outB = computeShipmentPromoLinesPhase1_(
    [{ shipment_item_id: "SHI-B", so_item_id: "SOI-1", ship_qty: 1 }],
    soSnapshotMap,
    schemePacks,
    {}
  );
  assert.equal(outA[0].free_qty, 0);
  assert.equal(outB[0].free_qty, 0);
});

t("Idempotency：相同輸入重算結果一致", () => {
  const schemePacks = [
    {
      scheme: { scheme_id: "CP2", scheme_name: "九折", scope_type: "CUSTOMER", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "DISCOUNT_PCT", discount_pct: 90, price_basis: "DEALER" }],
      priority: 10
    }
  ];
  const soSnapshotMap = { "SOI-1": snap({ base_unit_price: 80 }) };
  const items = [{ shipment_item_id: "SHI-1", so_item_id: "SOI-1", ship_qty: 3 }];
  const a = computeShipmentPromoLinesPhase1_(items, soSnapshotMap, schemePacks, {});
  const b = computeShipmentPromoLinesPhase1_(items, soSnapshotMap, schemePacks, {});
  assert.deepEqual(a, b);
});

console.log("\nPhase1 shipment promo 測試：" + passed + " 通過，" + failed + " 失敗");
process.exit(failed ? 1 : 0);

