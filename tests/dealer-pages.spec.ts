import { test, expect } from "@playwright/test";

const siteUrl = (process.env.ERP_SMOKE_SITE_URL || "http://127.0.0.1:5501").replace(/\/+$/, "");
const userId = process.env.ERP_SMOKE_USER || "admin";
const password = process.env.ERP_SMOKE_PASSWORD || "admin";

async function loginIfNeeded(page: import("@playwright/test").Page) {
  await page.goto(`${siteUrl}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginOverlay", { state: "attached" });

  const userInput = page.locator("#loginUserId");
  const passInput = page.locator("#loginPassword");
  const submitBtn = page.locator("#loginSubmitBtn");
  let canSeeLogin = (await userInput.isVisible().catch(() => false)) && (await passInput.isVisible().catch(() => false));

  if (!canSeeLogin) {
    const localBtn = page.locator("#loginLocalTestBtn");
    if (await localBtn.isVisible().catch(() => false)) {
      await localBtn.click().catch(() => {});
    }
    const adminToggle = page.locator("#loginAdminToggle");
    if (await adminToggle.isVisible().catch(() => false)) {
      await adminToggle.check().catch(() => {});
    }
    canSeeLogin = (await userInput.isVisible().catch(() => false)) && (await passInput.isVisible().catch(() => false));
  }

  if (canSeeLogin) {
    await userInput.fill(userId);
    await passInput.fill(password);
    await submitBtn.click();
  }

  await page.waitForSelector("#sidebarNav", { state: "attached" });
  await expect(page.locator("body")).not.toHaveClass(/erp-locked/);
  await page.waitForFunction(() => {
    try {
      return !!String(localStorage.getItem("erp_session_token") || sessionStorage.getItem("erp_session_token") || "").trim();
    } catch (_e) {
      return false;
    }
  });
  await page.evaluate(() => {
    localStorage.setItem("erp_allowed_modules", "*");
    sessionStorage.setItem("erp_allowed_modules", "*");
  });
}

async function openModule(page: import("@playwright/test").Page, key: string) {
  await page.evaluate((k) => {
    // @ts-ignore
    if (typeof window.navigate === "function") window.navigate(k);
    else location.hash = "#" + k;
  }, key);
  await page.waitForTimeout(800);
  await page.waitForFunction(() => {
    const el = document.getElementById("content");
    return !!el && !String(el.textContent || "").includes("載入模組失敗");
  });
}

test.describe("Dealer 經銷方案相關頁面", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("Dealer 經銷方案：表單與按鈕", async ({ page }) => {
    await openModule(page, "commercial_dealer");
    const content = page.locator("#content");
    await expect(content).toContainText("Dealer 經銷方案");
    await expect(content).toContainText("請選擇");
    await expect(page.locator("#cd_dealer_scheme_type")).toBeAttached();
    await expect(page.locator("#cd_dealer_create_btn")).toBeAttached();
    await expect(page.locator('button:has-text("新增級距")')).toBeAttached();
    await expect(page.locator('button:has-text("載入預設級距")')).toBeAttached();
  });

  test("Dealer 經銷方案：選類型後級距欄位切換", async ({ page }) => {
    await openModule(page, "commercial_dealer");
    await page.locator("#cd_dealer_scheme_type").selectOption("MONTHLY_REBATE", { force: true });
    await page.evaluate(() => {
      // @ts-ignore
      if (typeof cdDealerOnSchemeTypeChange_ === "function") cdDealerOnSchemeTypeChange_();
    });
    await expect(page.locator("#cd_dealer_tier_title")).toContainText("回饋％");
    await page.locator("#cd_dealer_scheme_type").selectOption("CUMULATIVE_AMOUNT", { force: true });
    await page.evaluate(() => {
      // @ts-ignore
      if (typeof cdDealerOnSchemeTypeChange_ === "function") cdDealerOnSchemeTypeChange_();
    });
    await expect(page.locator("#cd_dealer_tier_title")).toContainText("經銷價");
    await expect(page.locator(".cd-tier-col-label").first()).toHaveCSS("display", "table-cell");
  });

  test("月結回饋頁可開啟", async ({ page }) => {
    await openModule(page, "dealer_rebate");
    await expect(page.locator("#content")).toContainText("月結回饋");
    await expect(page.locator('button:has-text("預覽")')).toBeAttached();
    await expect(page.locator("#dr_rebate_post_btn")).toBeAttached();
  });

  test("客戶設定：經銷方案收折區塊", async ({ page }) => {
    test.skip(!process.env.ERP_SMOKE_FULL, "需 ERP_SMOKE_FULL=1 且帳號含 customers 模組 API 權限");
    await openModule(page, "customers");
    await expect(page.locator("#content")).toContainText("客戶設定");
    await expect(page.locator("#c_dealer_details summary")).toContainText("經銷方案");
    await expect(page.locator("#c_recipient_details summary")).toContainText("收件人");
  });

  test("寄賣結算：經銷價摘要區塊存在", async ({ page }) => {
    test.skip(!process.env.ERP_SMOKE_FULL, "需 ERP_SMOKE_FULL=1 且帳號含 consignment 模組 API 權限");
    await openModule(page, "consignment_settlement");
    await expect(page.locator("#content")).toContainText("Settlement 結算");
    await expect(page.locator("#cc_stl_summary_box")).toBeAttached();
  });
});
