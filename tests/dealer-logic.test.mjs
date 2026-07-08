/**
 * Dealer 經銷方案 — 純邏輯單元測試（不需 DB）
 * 執行：node tests/dealer-logic.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyCumulativeDealerPriceToLines_, computeEligibleDealerCreditForSettlement_ } from "../server/src/bundles/commercial-dealer.js";

const require = createRequire(import.meta.url);
const { computeSettlementPromoLines_ } = require("../server/src/bundles/consignment-promo.js");

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

const dealerCtx = {
  enabled: true,
  tier_label: "銀級",
  price_rate: 85,
  price_source: "CURRENT"
};

t("無經銷價設定時不變更明細", () => {
  const lines = [{ pool_item_id: "P1", list_unit_price: 100, settle_unit_price: 100, billable_qty: 2, amount: 200, promo_scheme_id: "" }];
  const out = applyCumulativeDealerPriceToLines_(lines, { enabled: false });
  assert.equal(out[0].amount, 200);
});

t("無促銷時維持出貨經銷價（不重算折數）", () => {
  const lines = [
    {
      pool_item_id: "P1",
      list_unit_price: 2240,
      settle_unit_price: 2240,
      billable_qty: 2,
      amount: 4480,
      promo_scheme_id: ""
    }
  ];
  const out = applyCumulativeDealerPriceToLines_(lines, dealerCtx);
  assert.equal(out[0].settle_unit_price, 2240);
  assert.equal(out[0].amount, 4480);
  assert.equal(out[0].dealer_cumulative_price_rate, 85);
});

t("有促銷時不套經銷價重算", () => {
  const lines = [
    {
      pool_item_id: "P1",
      list_unit_price: 2240,
      settle_unit_price: 1568,
      billable_qty: 1,
      amount: 1568,
      promo_scheme_id: "PROMO1"
    }
  ];
  const out = applyCumulativeDealerPriceToLines_(lines, dealerCtx);
  assert.equal(out[0].settle_unit_price, 1568);
  assert.equal(out[0].amount, 1568);
  assert.equal(out[0].dealer_cumulative_price_rate, undefined);
});

t("買N送M無促銷方案時仍維持經銷價", () => {
  const lines = [
    {
      pool_item_id: "P1",
      list_unit_price: 2240,
      settle_unit_price: 2240,
      billable_qty: 2,
      settle_qty: 3,
      free_qty: 1,
      amount: 4480,
      promo_scheme_id: ""
    }
  ];
  const out = applyCumulativeDealerPriceToLines_(lines, dealerCtx);
  assert.equal(out[0].settle_unit_price, 2240);
  assert.equal(out[0].amount, 4480);
});

t("Promo 後不重算經銷價（整合）", () => {
  const poolMap = {
    P1: { pool_item_id: "P1", product_id: "PROD1", unit_price: 2240 }
  };
  const schemePacks = [
    {
      scheme: { scheme_id: "CP1", scheme_name: "7月促銷", scope_type: "CASE", created_at: "2026-07-01" },
      lines: [{ product_id: "PROD1", promo_type: "DISCOUNT_PCT", discount_pct: 70 }],
      priority: 10
    }
  ];
  const promoLines = computeSettlementPromoLines_([{ pool_item_id: "P1", settle_qty: 2 }], poolMap, schemePacks, {});
  const priced = applyCumulativeDealerPriceToLines_(promoLines, dealerCtx);
  assert.equal(priced[0].settle_unit_price, 1568);
  assert.equal(priced[0].amount, 3136);
});

t("次月折抵：同月結算不可套用", () => {
  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate: "2026-07-15",
    creditBalance: 1960,
    postedCarryForwardRebates: [
      { period_ym: "2026-07", rebate_amount: 1960, status: "POSTED", settle_mode: "CARRY_FORWARD" }
    ]
  });
  assert.equal(eligible, 0);
});

t("次月折抵：次月結算可套用全額", () => {
  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate: "2026-08-01",
    creditBalance: 1960,
    postedCarryForwardRebates: [
      { period_ym: "2026-07", rebate_amount: 1960, status: "POSTED", settle_mode: "CARRY_FORWARD" }
    ]
  });
  assert.equal(eligible, 1960);
});

t("次月折抵：同月僅能套用上個月回饋", () => {
  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate: "2026-08-10",
    creditBalance: 2460,
    postedCarryForwardRebates: [
      { period_ym: "2026-07", rebate_amount: 1960, status: "POSTED", settle_mode: "CARRY_FORWARD" },
      { period_ym: "2026-08", rebate_amount: 500, status: "POSTED", settle_mode: "CARRY_FORWARD" }
    ]
  });
  assert.equal(eligible, 1960);
});

t("次月折抵：FIFO 扣除已消耗額度", () => {
  const eligible = computeEligibleDealerCreditForSettlement_({
    settlementDate: "2026-09-01",
    creditBalance: 500,
    postedCarryForwardRebates: [
      { period_ym: "2026-07", rebate_amount: 1960, status: "POSTED", settle_mode: "CARRY_FORWARD" },
      { period_ym: "2026-08", rebate_amount: 500, status: "POSTED", settle_mode: "CARRY_FORWARD" }
    ]
  });
  assert.equal(eligible, 500);
});

console.log("\nDealer 邏輯測試：" + passed + " 通過，" + failed + " 失敗");
process.exit(failed ? 1 : 0);
