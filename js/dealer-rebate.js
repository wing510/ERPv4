/*********************************
 * FINANCE · 寄賣月結回饋（Dealer Rebate）
 *********************************/

var drRebatePreviewPack_ = null;
var drRebateListRows_ = [];
var drRebateSelectedId_ = "";
var drStatPreviewPack_ = null;
var drStatListRows_ = [];
var drLevelPreviewPack_ = null;
var drLevelListRows_ = [];
var drLevelSelectedId_ = "";
var drStatCustRows_ = [];
var drStatCustSortState_ = { field: "customer_name", asc: true };
var drStatCustMonthIndex_ = {};
var drStatPeriodLoadSeq_ = 0;
var drDealerSchemeNameMap_ = { __loaded: false };

function drRebateCumulativeSchemeLabel_(cum) {
  const c = cum || {};
  const name = String(c.scheme_name || "").trim();
  if (name) return name;
  const id = String(c.scheme_id || "").trim().toUpperCase();
  if (id && drDealerSchemeNameMap_[id]) return drDealerSchemeNameMap_[id];
  if (id) return id;
  const custId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const cumId = String(ccCustomers_[custId]?.dealer_cumulative_scheme_id || "").trim().toUpperCase();
  if (cumId && drDealerSchemeNameMap_[cumId]) return drDealerSchemeNameMap_[cumId];
  return cumId || "—";
}

async function drRebateEnsureSchemeNames_() {
  if (drDealerSchemeNameMap_.__loaded) return;
  try {
    const r = await callAPI({ action: "list_commercial_dealer_scheme_enriched" }, { method: "GET" });
    (r?.data || []).forEach(function (s) {
      const id = String(s.scheme_id || "").trim().toUpperCase();
      if (!id) return;
      drDealerSchemeNameMap_[id] = String(s.scheme_name || "").trim() || id;
    });
    drDealerSchemeNameMap_.__loaded = true;
  } catch (_e) {}
}

var DR_REBATE_SETTLE_LABELS_ = {
  CREDIT_NOTE: "折讓",
  CARRY_FORWARD: "次月結算折抵"
};

var DR_REBATE_STATUS_LABELS_ = {
  POSTED: "已產生",
  VOID: "已作廢"
};

function drFmtMoney_(n) {
  if (typeof ccFmtMoney_ === "function") return ccFmtMoney_(n);
  return String(Number(n || 0).toFixed(2));
}

function drCanOperate_() {
  try {
    return typeof erpCanOperateDealerRebate_ === "function" && erpCanOperateDealerRebate_();
  } catch (_e) {
    return false;
  }
}

function drRebatePermissionHint_() {
  if (drCanOperate_()) return "產生後落地 AR 折讓或次月結算折抵";
  if (typeof erpHasModule_ === "function" && (erpHasModule_("dealer_rebate") || erpHasModule_("commercial_dealer"))) {
    return "僅檢視；預覽／產生須會計／CEO／GA／ADMIN";
  }
  return "您沒有權限操作月結回饋";
}

function drStatPermissionHint_() {
  if (drCanOperate_()) return "每月統計請款淨額並過帳定案；等級與回饋請於下方延伸作業";
  if (typeof erpHasModule_ === "function" && (erpHasModule_("dealer_rebate") || erpHasModule_("commercial_dealer"))) {
    return "僅檢視；預覽／過帳須會計／CEO／GA／ADMIN";
  }
  return "您沒有權限操作月結統計";
}

var DR_STAT_STATUS_LABELS_ = {
  POSTED: "已過帳",
  VOID: "已作廢"
};

var DR_MONTHLY_CLOSE_STEP2_NEED_STAT_ = "須先完成月結統計過帳";
var DR_STAT_POST_BTN_LABEL_ = "月結統計過帳";
var DR_LEVEL_POST_BTN_LABEL_ = "確認經銷等級";
var DR_REBATE_POST_BTN_LABEL_ = "月結回饋";
var DR_STAT_BATCH_LIMIT_ = 20;
var drMonthlyClosePostInFlight_ = false;

function drHasBillingNet_(n) {
  return Number(n || 0) > 0.009;
}

function drTryBeginMonthlyClosePost_(skipNotify) {
  if (drMonthlyClosePostInFlight_) {
    if (!skipNotify) showToast("月結作業進行中，請稍候…", "warn");
    return false;
  }
  drMonthlyClosePostInFlight_ = true;
  drUpdateMonthlyCloseActions_();
  return true;
}

function drEndMonthlyClosePostGuard_() {
  drMonthlyClosePostInFlight_ = false;
  drEndMonthlyCloseSaveHint_();
  drUpdateMonthlyCloseActions_();
}

function drDisableMonthlyCloseActionBtns_(disabled) {
  ["dr_stat_post_btn", "dr_level_post_btn", "dr_rebate_post_btn", "dr_stat_batch_post_btn"].forEach(function (id) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

async function drPreviewAllMonthlyClose_(opts) {
  const silent = !!(opts && opts.silent);
  await drStatPreview_({ silent: silent, skipLevelChain: true });
  if (!drStatGetCustomerId_()) return;
  await drLevelPreview_({ silent: silent });
  await drRebatePreview_({ auto: true, silent: silent });
}

function drStatGetCustomerId_() {
  return String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
}

function drSelectedPeriodYm_() {
  return String(document.getElementById("dr_rebate_period")?.value || "").trim();
}

function drRowMatchesSelectedPeriod_(row) {
  const ym = drSelectedPeriodYm_();
  if (!ym) return true;
  return String(row?.period_ym || "").trim() === ym;
}

function drStatSetCustomerId_(customerId) {
  const el = document.getElementById("dr_rebate_customer_id");
  if (el) el.value = String(customerId || "").trim().toUpperCase();
  drStatRenderSelectedCustomer_();
}

var drDealerSchemeNameMap_ = { __loaded: false };
var drRebateSchemeNone_ = false;

function drCustHasRebateScheme_(customerId) {
  const row = drRebateGetCustRow_(customerId);
  return !!drStatCustResolveRebateSchemeId_(row);
}

function drCustHasCumulativeScheme_(customerId) {
  const row = drRebateGetCustRow_(customerId);
  return !!String(row?.dealer_cumulative_scheme_id || "").trim();
}

/** 須執行月結作業：至少綁定回饋或等級方案其一 */
function drCustNeedsMonthlyClose_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return false;
  return drCustHasRebateScheme_(cid) || drCustHasCumulativeScheme_(cid);
}

function drBillingSourcePack_() {
  return drStatPreviewPack_ || drRebatePreviewPack_ || null;
}

function drMonthlyCloseSectionOpen_(title) {
  return (
    '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;">' +
    '<div style="font-weight:600;margin-bottom:6px;">' +
    ccEsc_(title) +
    "</div>"
  );
}

function drMonthlyCloseSectionClose_() {
  return "</div>";
}

function drFmtStatSourceBillingLabel_(statSource) {
  const src = String(statSource || "").trim().toUpperCase();
  if (src === "GENERAL") return "一般出貨請款淨額";
  if (src === "CONSIGNMENT") return "寄賣請款淨額";
  return "請款淨額";
}

function drFmtMonthlyStatBillingBlock_(statPack, opts) {
  const o = opts || {};
  const pack = statPack || null;
  if (!pack) return "";
  const statStale = !!o.statStale;
  const billingNet = Number(pack.billing_net || 0);
  if (!(billingNet > 0.009) && !o.allowZero) return "";
  const liveNet =
    statStale && pack.live_billing_net != null ? Number(pack.live_billing_net) : billingNet;
  const livePack =
    statStale && pack.live_billing_net != null
      ? Object.assign({}, pack, {
          billing_net: pack.live_billing_net,
          billing_net_consignment: pack.live_billing_net_consignment,
          billing_net_general: pack.live_billing_net_general
        })
      : pack;
  let html =
    "<div><strong>請款淨額</strong>" +
    (statStale ? "（即時）" : "") +
    "：" +
    drFmtMoney_(liveNet) +
    drFmtBillingDetailFromPack_(livePack) +
    "</div>";
  if (statStale && Number(pack.posted_billing_net || 0) > 0.009) {
    html +=
      '<div class="text-muted" style="font-size:12px;margin-top:2px;">已過帳金額：' +
      drFmtMoney_(pack.posted_billing_net) +
      "（作廢重過帳後，摘要才會全部改為新金額）</div>";
  }
  html +=
    '<div class="text-muted" style="font-size:12px;margin-top:2px;">用於<strong>月結統計過帳</strong>（與上方列表「請款淨額」同一口徑）</div>';
  return html;
}

/** 列表已有請款金額、摘要預覽尚未載入 */
function drSummaryAwaitingPreview_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid || drBillingSourcePack_()) return false;
  const hit = drStatCustMonthIndex_[cid];
  if (!hit) return false;
  const net = Number(hit.billing_net || 0);
  const cons = Number(hit.billing_net_consignment || 0);
  const gen = Number(hit.billing_net_general || 0);
  return net > 0.009 || cons > 0.009 || gen > 0.009;
}

function drMonthlyCloseLoadingStatusHtml_() {
  return '<span class="dr-monthly-close-step-muted">讀取中…</span>';
}

function drFmtBillingDetailFromPack_(pack) {
  if (!pack) return "";
  if (pack.from_posted) return "（產生時快照）";
  const settleCnt = String(pack.settlement_count != null ? pack.settlement_count : 0);
  const shipCnt = String(pack.shipment_count != null ? pack.shipment_count : 0);
  const arAdj = Number(pack.ar_discount_total || 0);
  const billingCons = Number(pack.billing_net_consignment || 0);
  const billingGen = Number(pack.billing_net_general || 0);
  const parts = [
    "寄賣結算 " + ccEsc_(settleCnt) + " 筆共 " + drFmtMoney_(billingCons),
    "一般出貨 " + ccEsc_(shipCnt) + " 筆共 " + drFmtMoney_(billingGen)
  ];
  if (arAdj > 0.009) parts.push("應收調降 " + drFmtMoney_(arAdj));
  return "（" + parts.join("；") + "）";
}

function drEmptyBillingPack_() {
  return {
    billing_net: 0,
    billing_net_consignment: 0,
    billing_net_general: 0,
    settlement_count: 0,
    shipment_count: 0
  };
}

function drFmtBillingNetLine_(pack, opts) {
  const o = opts || {};
  const p = pack || drEmptyBillingPack_();
  return (
    "<div><strong>請款淨額</strong>" +
    (o.stale ? "（即時）" : "") +
    "：" +
    drFmtMoney_(Number(p.billing_net || 0)) +
    drFmtBillingDetailFromPack_(p) +
    "</div>"
  );
}

/** 計算基準用：僅金額明細，不含筆數；寄賣／一般固定都顯示 */
function drFmtBillingBasisDetail_(pack) {
  if (!pack) return "";
  if (pack.from_posted) return "（產生時快照）";
  const billingCons = Number(pack.billing_net_consignment || 0);
  const billingGen = Number(pack.billing_net_general || 0);
  const arAdj = Number(pack.ar_discount_total || 0);
  const parts = [
    "寄賣結算 " + drFmtMoney_(billingCons),
    "一般出貨 " + drFmtMoney_(billingGen)
  ];
  if (arAdj > 0.009) parts.push("應收調降 " + drFmtMoney_(arAdj));
  return "（" + parts.join("；") + "）";
}

function drSchemeStatSourceAllows_(statSource, channel) {
  const src = String(statSource || "ALL").trim().toUpperCase();
  const ch = String(channel || "").trim().toUpperCase();
  if (src === "ALL") return true;
  return src === ch;
}

/** 等級累積計算基準：依方案實際計入累積的金額（非請款淨額合計） */
function drLevelBasisFromStat_(statPack, cum) {
  const p = statPack || {};
  const c = cum || {};
  const addCons = Number(p.cumulative_add_consignment || 0);
  const addGen = Number(p.cumulative_add_general || 0);
  const total = Number(
    c.cumulative_add != null && c.enabled
      ? c.cumulative_add
      : p.cumulative_add_total != null
        ? p.cumulative_add_total
        : roundMoney_(addCons + addGen)
  );
  return {
    cumulative_stat_source: String(p.cumulative_stat_source || p.stat_source || "ALL").trim().toUpperCase(),
    cumulative_add_consignment: addCons,
    cumulative_add_general: addGen,
    cumulative_add_total: total
  };
}

function drFmtLevelBasisDetail_(basis) {
  const b = basis || {};
  const addCons = Number(b.cumulative_add_consignment || 0);
  const addGen = Number(b.cumulative_add_general || 0);
  const parts = [];
  if (addCons > 0.009) parts.push("寄賣結算 " + drFmtMoney_(addCons));
  if (addGen > 0.009) parts.push("一般出貨 " + drFmtMoney_(addGen));
  return parts.length ? "（" + parts.join("；") + "）" : "";
}

function drFmtLevelBasisLine_(basis, opts) {
  const o = opts || {};
  const total = Number((basis || {}).cumulative_add_total || 0);
  let html =
    "<div><strong>計算基準</strong>：" +
    drFmtMoney_(total) +
    drFmtLevelBasisDetail_(basis);
  if (o.postedTag) html += "（過帳時快照）";
  return html + "</div>";
}

function drFmtTierCell_(label, rate) {
  const lb = String(label || "").trim();
  if (!lb) return "—";
  const rateNum = rate != null && rate !== "" ? Number(rate) : null;
  return (
    ccEsc_(lb) +
    (rateNum != null && !Number.isNaN(rateNum) ? "（" + String(rateNum) + " 折）" : "")
  );
}
function drFmtRebateBasisDetail_(pack) {
  if (!pack) return "（寄賣結算 " + drFmtMoney_(0) + "）";
  if (pack.from_posted) return "（產生時快照）";
  const statSource = String(pack.stat_source || "CONSIGNMENT").trim().toUpperCase();
  const billingCons = Number(
    pack.billing_net_consignment != null ? pack.billing_net_consignment : pack.billing_net || 0
  );
  const billingGen = Number(pack.billing_net_general || 0);
  const parts = [];
  if (statSource === "ALL") {
    parts.push("寄賣結算 " + drFmtMoney_(billingCons));
    parts.push("一般出貨 " + drFmtMoney_(billingGen));
  } else if (statSource === "GENERAL") {
    parts.push("一般出貨 " + drFmtMoney_(billingGen || pack.billing_net || 0));
  } else {
    parts.push("寄賣結算 " + drFmtMoney_(billingCons));
  }
  return "（" + parts.join("；") + "）";
}

function drSnapshotDetailPack_(pack) {
  if (!pack) return null;
  const p = Object.assign({}, pack, { from_posted: false });
  const billingGen = Number(p.billing_net_general || 0);
  if (!p.stat_source) {
    p.stat_source = billingGen > 0.009 ? "ALL" : "CONSIGNMENT";
  }
  return p;
}

function drFmtRebateCalcBasisLine_(pack, opts) {
  const o = opts || {};
  const basisNet = Number(pack?.billing_net || 0);
  const detailPack = drSnapshotDetailPack_(pack) || {};
  const src = String(detailPack.stat_source || "CONSIGNMENT").trim().toUpperCase();
  if (detailPack.billing_net_consignment == null && detailPack.billing_net_general == null) {
    if (src === "GENERAL") {
      detailPack.billing_net_general = basisNet;
    } else {
      detailPack.billing_net_consignment = basisNet;
    }
  }
  return (
    "<div><strong>計算基準</strong>：" +
    drFmtMoney_(basisNet) +
    drFmtRebateBasisDetail_(detailPack) +
    (o.fromPosted ? "（產生時快照）" : "") +
    "</div>"
  );
}

function drMonthlyCloseDivider_() {
  return '<div class="dr-monthly-close-divider"></div>';
}

function drBillingPackForDisplay_(pack, opts) {
  const o = opts || {};
  if (!pack) return null;
  if (o.statStale && pack.live_billing_net != null) {
    return Object.assign({}, pack, {
      billing_net: pack.live_billing_net,
      billing_net_consignment: pack.live_billing_net_consignment,
      billing_net_general: pack.live_billing_net_general
    });
  }
  return pack;
}

function drLevelStatusInlineHtml_(statPosted, statStale, billingNet) {
  if (statPosted && statStale) {
    return '<span class="dr-monthly-close-step-warn">已過帳・有新單</span>';
  }
  if (statPosted) return '<span class="dr-monthly-close-step-done">已過帳</span>';
  if (!(billingNet > 0.009)) return '<span class="dr-monthly-close-step-muted">無請款</span>';
  return '<span class="dr-monthly-close-step-warn">' + DR_MONTHLY_CLOSE_STEP2_NEED_STAT_ + "</span>";
}

function drRebateStatusInlineHtml_(hasRebate, rebatePosted, rebateStale, rebatePack, statPack, statPosted, billingNet) {
  if (!hasRebate || drRebateSchemeNone_) {
    return '<span class="dr-monthly-close-step-muted">未綁定方案</span>';
  }
  if (rebatePosted && rebateStale) {
    return '<span class="dr-monthly-close-step-warn">已產生・有新單</span>';
  }
  if (rebatePosted) return '<span class="dr-monthly-close-step-done">已產生</span>';
  if (!statPosted) {
    return '<span class="dr-monthly-close-step-warn">' + DR_MONTHLY_CLOSE_STEP2_NEED_STAT_ + "</span>";
  }
  if (!(billingNet > 0.009)) return '<span class="dr-monthly-close-step-muted">無請款</span>';
  return '<span class="dr-monthly-close-step-warn">待產生</span>';
}

function drRebateSettleModeLabel_(pack) {
  const mode = String(pack?.settle_mode_default || "").trim().toUpperCase();
  return DR_REBATE_SETTLE_LABELS_[mode] || mode || "—";
}

function drMonthlyCloseStepHtml_(num, label, statusHtml) {
  return (
    '<div class="dr-monthly-close-step">' +
    '<span class="dr-monthly-close-step-num">' +
    ccEsc_(num) +
    "</span>" +
    "<span>" +
    ccEsc_(label) +
    "</span>" +
    statusHtml +
    "</div>"
  );
}

function drMonthlyCloseBillingStale_(statPack, rebatePack) {
  if (statPack?.already_posted && statPack?.has_new_billing) return true;
  if (rebatePack?.already_posted && rebatePack?.has_new_billing) return true;
  return false;
}

function drMonthlyCloseActionGroup_() {
  return document.querySelector(".dr-billing-actions");
}

function drBeginMonthlyCloseSaveHint_() {
  if (typeof showSaveHint === "function") {
    showSaveHint(drMonthlyCloseActionGroup_());
  }
}

function drEndMonthlyCloseSaveHint_() {
  if (typeof hideSaveHint === "function") {
    hideSaveHint();
  }
}

function drMonthlyClosePermTitle_() {
  return "須會計／CEO／GA／ADMIN 權限";
}

function drSetMonthlyCloseActionsVisible_(visible) {
  void visible;
}

function drUpdateMonthlyCloseActions_() {
  const cid = drStatGetCustomerId_();
  const canOp = drCanOperate_();
  const hasCumulative = drCustHasCumulativeScheme_(cid);
  const hasRebate = drCustHasRebateScheme_(cid);
  const statPack = drStatPreviewPack_;
  const levelPack = drLevelPreviewPack_;
  const rebatePack = drRebatePreviewPack_;
  const billingNet = Number((statPack || drBillingSourcePack_() || {}).billing_net || 0);
  const statPosted = !!statPack?.already_posted;
  const levelPosted = !!(levelPack?.already_posted || levelPack?.legacy_bundled_in_stat);
  const rebatePosted = !!rebatePack?.already_posted;
  const billingStale = drMonthlyCloseBillingStale_(statPack, rebatePack);
  const permTitle = drMonthlyClosePermTitle_();
  const awaiting = drSummaryAwaitingPreview_(cid);
  const inflight = !!drMonthlyClosePostInFlight_;

  drSetSectionVisible_("dr_billing_summary_panel", !!cid);
  drSetSectionVisible_("dr_stat_record_section", !!cid);

  const statBtn = document.getElementById("dr_stat_post_btn");
  const levelBtn = document.getElementById("dr_level_post_btn");
  const rebateBtn = document.getElementById("dr_rebate_post_btn");
  const batchBtn = document.getElementById("dr_stat_batch_post_btn");

  if (batchBtn) {
    batchBtn.disabled = !canOp || inflight;
    batchBtn.title = !canOp
      ? permTitle
      : inflight
        ? "月結作業進行中…"
        : "對目前列表執行月結統計過帳";
  }

  if (awaiting || inflight) {
    [statBtn, levelBtn, rebateBtn].forEach(function (btn) {
      if (btn) {
        btn.disabled = true;
        btn.title = inflight ? "月結作業進行中…" : "請款資料讀取中…";
      }
    });
    return;
  }

  if (statBtn) {
    statBtn.textContent = DR_STAT_POST_BTN_LABEL_;
    const blocked = !canOp || !cid || statPosted || billingStale || !drHasBillingNet_(billingNet);
    statBtn.disabled = blocked;
    statBtn.title = !canOp
      ? permTitle
      : statPosted
        ? "本月統計已過帳"
        : billingStale
          ? "過帳後有新單，請先作廢本月月結"
          : !(billingNet > 0.009)
            ? "本月無請款淨額"
            : "";
  }

  if (levelBtn) {
    levelBtn.textContent = DR_LEVEL_POST_BTN_LABEL_;
    levelBtn.style.display = hasCumulative ? "" : "none";
    const needStat = !statPosted;
    const blocked =
      !canOp || !cid || !hasCumulative || levelPosted || billingStale || needStat;
    levelBtn.disabled = blocked;
    levelBtn.title = !canOp
      ? permTitle
      : needStat
        ? DR_MONTHLY_CLOSE_STEP2_NEED_STAT_
        : levelPosted
          ? "本月等級已確認"
          : billingStale
            ? "過帳後有新單，請先作廢本月月結"
            : "";
  }

  if (rebateBtn) {
    rebateBtn.textContent = DR_REBATE_POST_BTN_LABEL_;
    rebateBtn.style.display = hasRebate && !drRebateSchemeNone_ ? "" : "none";
    const needStat = !statPosted;
    const rebateNet = Number(rebatePack?.billing_net || 0);
    const blocked =
      !canOp ||
      !cid ||
      !hasRebate ||
      drRebateSchemeNone_ ||
      rebatePosted ||
      billingStale ||
      needStat ||
      !(rebateNet > 0.009);
    rebateBtn.disabled = blocked;
    rebateBtn.title = !canOp
      ? permTitle
      : needStat
        ? DR_MONTHLY_CLOSE_STEP2_NEED_STAT_
        : billingStale
          ? "過帳後有新單，請先作廢本月月結"
          : rebatePosted
            ? "本月回饋已產生"
            : !(rebateNet > 0.009)
              ? "本月無回饋可產生"
              : "";
  }
}

function drSetSectionVisible_(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("dr-rebate-box-hidden", !visible);
}

function drStatRenderSelectedCustomer_() {
  drUpdateMonthlyCloseActions_();
}

function drBuildBillingSummaryHtml_() {
  const cid = drStatGetCustomerId_();
  if (!cid) return "";
  const statPack = drStatPreviewPack_;
  const billPack = statPack || drBillingSourcePack_() || drEmptyBillingPack_();
  const statPosted = !!statPack?.already_posted;
  const statStale = !!(statPosted && statPack?.has_new_billing);
  if (drSummaryAwaitingPreview_(cid)) {
    return '<span class="text-muted">讀取中…</span>';
  }
  let html = "";
  if (statPosted && statStale) {
    const parts = drFmtBillingDriftParts_(statPack);
    html +=
      '<div style="color:#b45309;margin-bottom:8px;">月結統計已過帳（' +
      ccEsc_(statPack.existing_stat_id || "—") +
      "），但過帳後又有新請款" +
      (parts.length ? "（" + ccEsc_(parts.join("；")) + "）" : "") +
      "，請先<strong>作廢本月月結</strong>再重新過帳。</div>";
  }
  const topPack = drBillingPackForDisplay_(billPack, { statStale: statStale }) || drEmptyBillingPack_();
  html += drFmtBillingNetLine_(topPack, { stale: statStale });
  const statusHtml = statPosted
    ? statStale
      ? '<span class="dr-monthly-close-step-warn">已過帳・有新單</span>'
      : '<span class="dr-monthly-close-step-done">已過帳</span>'
    : Number(topPack.billing_net || 0) > 0.009
      ? '<span class="dr-monthly-close-step-warn">預覽未過帳</span>'
      : '<span class="dr-monthly-close-step-muted">無請款</span>';
  html += '<div style="margin-top:6px;"><strong>狀態</strong>：' + statusHtml + "</div>";
  return html;
}

function drBuildLevelSummaryHtml_() {
  const cid = drStatGetCustomerId_();
  if (!cid || !drCustHasCumulativeScheme_(cid)) return "";
  const levelPack = drLevelPreviewPack_;
  const levelPosted = !!(levelPack?.already_posted || levelPack?.legacy_bundled_in_stat);

  if (!levelPack) return '<span class="text-muted">讀取中…</span>';

  const cum = levelPack.cumulative_preview || {};
  const statPosted = !!drStatPreviewPack_?.already_posted;
  const levelStatus = levelPosted
    ? '<span class="dr-monthly-close-step-done">已過帳</span>'
    : !statPosted
      ? '<span class="dr-monthly-close-step-warn">' + DR_MONTHLY_CLOSE_STEP2_NEED_STAT_ + "</span>"
      : '<span class="dr-monthly-close-step-warn">待過帳</span>';
  let html =
    '<div><strong>等級方案</strong>：' +
    ccEsc_(drRebateCumulativeSchemeLabel_(cum)) +
    " " +
    levelStatus +
    "</div>";

  html += drFmtLevelBasisLine_(drLevelBasisFromStat_(levelPack, cum));

  if (cum.enabled) {
    html +=
      "<div><strong>目前等級</strong>：" +
      ccEsc_(cum.current_tier_label || "—") +
      (cum.current_price_rate != null ? "（" + String(cum.current_price_rate) + " 折）" : "") +
      "</div>" +
      "<div><strong>經銷等級累積</strong>：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after) +
      "（本月 +" +
      drFmtMoney_(cum.cumulative_add) +
      "）" +
      (levelPosted ? '<span class="text-muted" style="font-size:12px;">（過帳時寫入）</span>' : "") +
      "</div>" +
      drRebatePendingTierHtml_(cum);
  }
  if (levelPack.legacy_bundled_in_stat) {
    html +=
      '<div class="text-muted" style="font-size:12px;margin-top:6px;">此筆等級已於舊版月結統計一併過帳。</div>';
  }
  if (cum.err) html += '<div style="color:#b45309;">' + ccEsc_(cum.err) + "</div>";
  return html;
}

function drBuildRebateSummaryHtml_() {
  const cid = drStatGetCustomerId_();
  if (!cid || !drCustHasRebateScheme_(cid)) return "";
  if (drRebateSchemeNone_) {
    return "<div><strong>回饋方案</strong>：無</div>";
  }
  const statPack = drStatPreviewPack_;
  const rebatePack = drRebatePreviewPack_;
  const statPosted = !!statPack?.already_posted;
  const rebatePosted = !!rebatePack?.already_posted;
  const statStale = !!(statPosted && statPack?.has_new_billing);
  if (!rebatePack) return '<span class="text-muted">讀取中…</span>';
  const periodYm = drSelectedPeriodYm_();
  const postedRebateRow = rebatePosted ? drRebateFindActivePostedRow_(cid, periodYm) : null;
  const rebateStale = !!(rebatePosted && (rebatePack?.has_new_billing || statStale));
  const rebateDisplayPack =
    postedRebateRow && (rebateStale || rebatePack.rebate_amount_source === "posted_snapshot")
      ? Object.assign({}, rebatePack, drRebatePackFromRow_(postedRebateRow))
      : rebatePack;
  let html =
    '<div><strong>回饋方案</strong>：' +
    ccEsc_(rebateDisplayPack.scheme_name || rebateDisplayPack.scheme_id || "—") +
    " " +
    drRebateStatusInlineHtml_(
      true,
      rebatePosted,
      rebateStale,
      rebateDisplayPack,
      statPack,
      statPosted,
      Number(rebateDisplayPack.billing_net || 0)
    ) +
    "</div>";
  html +=
    "<div><strong>計算基準</strong>：" +
    drFmtMoney_(rebateDisplayPack.billing_net || 0) +
    drFmtRebateBasisDetail_(rebateDisplayPack) +
    "</div>";
  html += drRebateSchemeDetailHtml_(rebateDisplayPack, { skipSchemeLine: true });
  return html;
}

function drRenderMonthlyCloseSummary_() {
  const bodyEl = document.getElementById("dr_billing_summary_body");
  if (!bodyEl) return;
  const cid = drStatGetCustomerId_();
  if (!cid) {
    bodyEl.innerHTML = '<span class="text-muted">請點上方客戶列表選擇客戶</span>';
    drUpdateMonthlyCloseActions_();
    return;
  }
  const parts = [];
  const billingHtml = drBuildBillingSummaryHtml_();
  if (billingHtml) parts.push(billingHtml);
  const levelHtml = drBuildLevelSummaryHtml_();
  if (levelHtml) parts.push(levelHtml);
  const rebateHtml = drBuildRebateSummaryHtml_();
  if (rebateHtml) parts.push(rebateHtml);
  bodyEl.innerHTML = parts.length ? parts.join(drMonthlyCloseDivider_()) : '<span class="text-muted">—</span>';
  drUpdateMonthlyCloseActions_();
}

function drRebatePendingTierHtml_(cum) {
  const c = cum || {};
  const label = String(c.pending_tier_label || "").trim();
  if (!label) return "";
  return (
    '<div style="color:#15803d;"><strong>次月待生效</strong>：' +
    ccEsc_(label) +
    (c.pending_price_rate != null ? "（" + String(c.pending_price_rate) + " 折）" : "") +
    "</div>"
  );
}

function drStatRenderPreview_(pack) {
  void pack;
  drRenderMonthlyCloseSummary_();
}

async function drStatPreview_(opts) {
  const silent = !!(opts && opts.silent);
  const customerId = drStatGetCustomerId_();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) {
    drStatPreviewPack_ = null;
    drStatRenderPreview_(null);
    drStatRenderSelectedCustomer_();
    return;
  }
  if (!periodYm) return showToast("請選月份", "error");
  try {
    const pack = await callAPI(
      {
        action: "preview_commercial_dealer_monthly_stat_bundle",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "POST", silent: silent }
    );
    drStatPreviewPack_ = pack;
    if (drRebatePreviewPack_ && !drRebatePreviewPack_.already_posted) {
      drRebatePreviewPack_ = drRebateAlignBillingDriftFromStat_(drRebatePreviewPack_, pack);
    }
    drStatRenderPreview_(pack);
    drStatCustApplyPreviewPack_(customerId, pack);
    drStatRenderSelectedCustomer_();
    if (!(opts && opts.skipLevelChain)) {
      await drLevelPreview_({ silent: true });
    }
    try {
      const previewBox = document.getElementById("dr_billing_summary_panel");
      if (previewBox && !previewBox.classList.contains("dr-rebate-box-hidden")) {
        previewBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } catch (_eScroll) {}
  } catch (err) {
    drStatPreviewPack_ = null;
    drStatRenderPreview_(null);
    drStatRenderSelectedCustomer_();
    const errMsg = String(err?.erpUserMessage || err?.message || err || "");
    if (!(err && err.erpApiToastShown) && !silent && !drIsNoBillingMsg_(errMsg)) {
      showToast("預覽失敗", "error");
    }
  }
}

async function drStatPost_(opts) {
  const skipConfirm = !!(opts && opts.skipConfirm);
  const skipSaveHint = !!(opts && opts.skipSaveHint);
  if (!drCanOperate_()) {
    if (!skipConfirm) showToast("您沒有權限過帳月結統計", "error");
    return false;
  }
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) {
    if (!skipConfirm) showToast("請先選客戶", "error");
    return false;
  }
  if (!periodYm) {
    if (!skipConfirm) showToast("請選月份", "error");
    return false;
  }

  const billingNet = Number(drStatPreviewPack_?.billing_net || 0);
  if (!drHasBillingNet_(billingNet)) {
    await drStatPreview_({ silent: true });
    if (!drHasBillingNet_(Number(drStatPreviewPack_?.billing_net || 0))) {
      if (!skipConfirm) showToast("本月無請款淨額，無法過帳", "warn");
      return false;
    }
  }
  if (drStatPreviewPack_?.already_posted) {
    if (!skipConfirm) showToast("此客戶該月已有月結統計", "warn");
    return false;
  }
  if (drMonthlyCloseBillingStale_(drStatPreviewPack_, drRebatePreviewPack_)) {
    if (!skipConfirm) showToast("過帳後又有新請款，請先作廢月結統計再重新過帳", "warn");
    return false;
  }

  if (!skipConfirm) {
    const confirmMsg =
      "確定過帳 " +
      periodYm +
      " 月結統計？\n請款淨額：" +
      drFmtMoney_(drStatPreviewPack_?.billing_net || billingNet) +
      "\n（僅定案請款，不含等級與回饋）";
    const okGo = window.confirm ? window.confirm(confirmMsg) : true;
    if (!okGo) return false;
  }

  if (!skipSaveHint) {
    if (!drTryBeginMonthlyClosePost_(skipConfirm)) return false;
    drBeginMonthlyCloseSaveHint_();
  }
  try {
    const res = await callAPI(
      {
        action: "post_commercial_dealer_monthly_stat_bundle",
        customer_id: customerId,
        period_ym: periodYm,
        remark: "",
        created_by: getCurrentUser(),
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    if (!skipConfirm) showToast("月結統計已過帳：" + String(res.stat_id || ""), "success");
    await drRefreshMonthlyCloseAfterMutation_();
    return true;
  } catch (err) {
    if (!(err && err.erpApiToastShown) && !skipConfirm) showToast("過帳失敗", "error");
    return false;
  } finally {
    if (!skipSaveHint) drEndMonthlyClosePostGuard_();
  }
}

async function drMonthlyCloseVoid_(customerId, periodYm) {
  const cid = normId_(customerId);
  const ym = String(periodYm || "").trim();
  if (!cid || !ym) return;
  if (!drCanOperate_()) return showToast("您沒有權限作廢本月月結", "error");
  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason === null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");
  const okGo = window.confirm
    ? window.confirm(
        "確定作廢 " +
          ym +
          " 本月月結？\n系統將依序作廢：月結回饋 → 經銷等級 → 月結統計。"
      )
    : true;
  if (!okGo) return;
  try {
    await callAPI(
      {
        action: "void_commercial_dealer_monthly_close_bundle",
        customer_id: cid,
        period_ym: ym,
        void_reason: String(reason).trim(),
        updated_by: getCurrentUser(),
        created_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("本月月結已作廢", "success", 5000);
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    await drRefreshMonthlyCloseAfterMutation_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗", "error");
  }
}

async function drStatVoid_(statId) {
  const sid = String(statId || "").trim();
  const row = (drStatListRows_ || []).find(function (r) {
    return String(r.stat_id || "").trim() === sid;
  });
  const cid = String(row?.customer_id || drStatGetCustomerId_() || "").trim().toUpperCase();
  const ym = String(row?.period_ym || drSelectedPeriodYm_() || "").trim();
  await drMonthlyCloseVoid_(cid, ym);
}

function normId_(v) {
  return String(v || "").trim().toUpperCase();
}

async function drStatQuickPost_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  drStatSetCustomerId_(cid);
  await drStatPreview_({ silent: true });
  await drStatPost_();
}

async function drStatBatchPost_() {
  if (!drCanOperate_()) return showToast("您沒有權限批次過帳", "error");
  if (!drTryBeginMonthlyClosePost_()) return;
  const periodYm = drSelectedPeriodYm_();
  if (!periodYm) {
    drEndMonthlyClosePostGuard_();
    return showToast("請選月份", "error");
  }
  const ids = (drStatCustRows_ || [])
    .map(function (c) {
      return String(c.customer_id || "").trim().toUpperCase();
    })
    .filter(Boolean)
    .slice(0, DR_STAT_BATCH_LIMIT_);
  if (!ids.length) {
    drEndMonthlyClosePostGuard_();
    return showToast("目前列表無客戶", "warn");
  }
  const okGo = window.confirm
    ? window.confirm(
        "將對列表前 " +
          DR_STAT_BATCH_LIMIT_ +
          " 位客戶執行「批次統計過帳」？\n僅定案請款，不含等級與回饋。"
      )
    : true;
  if (!okGo) {
    drEndMonthlyClosePostGuard_();
    return;
  }
  try {
    const res = await callAPI(
      {
        action: "batch_post_commercial_dealer_monthly_stat_bundle",
        period_ym: periodYm,
        customer_ids: ids.join(","),
        created_by: getCurrentUser(),
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    const msg =
      "完成：成功 " +
      Number(res.succeeded_count || 0) +
      "、跳過 " +
      Number(res.skipped_count || 0) +
      "、失敗 " +
      Number(res.failed_count || 0);
    showToast(msg, res.failed_count ? "warn" : "success", 6000);
    await drRefreshMonthlyCloseAfterMutation_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("批次過帳失敗", "error");
  } finally {
    drEndMonthlyClosePostGuard_();
  }
}

async function drLevelPreview_(opts) {
  const silent = !!(opts && opts.silent);
  const customerId = drStatGetCustomerId_();
  const periodYm = drSelectedPeriodYm_();
  if (!customerId || !periodYm || !drCustHasCumulativeScheme_(customerId)) {
    drLevelPreviewPack_ = null;
    drRenderMonthlyCloseSummary_();
    return;
  }
  try {
    drLevelPreviewPack_ = await callAPI(
      {
        action: "preview_commercial_dealer_level_bundle",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "POST", silent: silent }
    );
  } catch (_e) {
    drLevelPreviewPack_ = null;
    if (!silent) showToast("等級預覽載入失敗", "error");
  }
  drRenderMonthlyCloseSummary_();
  drUpdateMonthlyCloseActions_();
}

async function drLevelPost_() {
  if (!drCanOperate_()) return showToast("您沒有權限確認經銷等級", "error");
  const customerId = drStatGetCustomerId_();
  const periodYm = drSelectedPeriodYm_();
  if (!customerId) return showToast("請先選客戶", "error");
  if (!periodYm) return showToast("請選月份", "error");
  await drPreviewAllMonthlyClose_({ silent: true });
  if (!drLevelPreviewPack_ || drLevelPreviewPack_.needs_stat_first) {
    return showToast(DR_MONTHLY_CLOSE_STEP2_NEED_STAT_, "warn");
  }
  if (drLevelPreviewPack_.already_posted || drLevelPreviewPack_.legacy_bundled_in_stat) {
    return showToast("本月等級已確認", "warn");
  }
  if (drMonthlyCloseBillingStale_(drStatPreviewPack_, drRebatePreviewPack_)) {
    return showToast("過帳後又有新單，請先作廢本月月結", "warn");
  }
  const cum = drLevelPreviewPack_.cumulative_preview || {};
  if (cum.err) return showToast(String(cum.err), "warn");
  let msg = "確定確認 " + periodYm + " 經銷等級？";
  if (cum.enabled) {
    msg +=
      "\n累積：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after);
    if (cum.pending_tier_label) msg += "\n次月待生效：" + cum.pending_tier_label;
  }
  if (!(window.confirm ? window.confirm(msg) : true)) return;
  if (!drTryBeginMonthlyClosePost_()) return;
  drBeginMonthlyCloseSaveHint_();
  try {
    const res = await callAPI(
      {
        action: "post_commercial_dealer_level_bundle",
        customer_id: customerId,
        period_ym: periodYm,
        created_by: getCurrentUser(),
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("經銷等級已確認：" + String(res.level_post_id || ""), "success");
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    await drRefreshMonthlyCloseAfterMutation_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("確認失敗", "error");
  } finally {
    drEndMonthlyClosePostGuard_();
  }
}

async function drRenderMonthlyRecordLists_() {
  await Promise.all([drStatRenderList_(), drRebateRenderList_(), drLevelRenderList_()]);
}

async function drLevelRenderList_() {
  const body = document.getElementById("dr_level_list_tbody");
  if (!body) return;
  const customerId = drStatGetCustomerId_();
  body.innerHTML = '<tr><td colspan="7" class="text-muted">載入中…</td></tr>';
  if (!customerId) {
    drLevelListRows_ = [];
    drLevelSelectedId_ = "";
    drLevelRenderSnapshot_(null);
    body.innerHTML = '<tr><td colspan="7" class="text-muted">—</td></tr>';
    return;
  }
  try {
    const periodYm = drSelectedPeriodYm_();
    const r = await callAPI(
      {
        action: "list_commercial_dealer_level_post_enriched",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "GET" }
    );
    const rows = (r?.data || []).filter(function (row) {
      return (
        String(row.customer_id || "").trim().toUpperCase() === customerId &&
        drRowMatchesSelectedPeriod_(row)
      );
    });
    drLevelListRows_ = rows;
    if (!rows.length) {
      drLevelSelectedId_ = "";
      drLevelRenderSnapshot_(null);
      body.innerHTML =
        '<tr><td colspan="7" class="text-muted">' +
        (periodYm ? "此客戶該月尚無等級過帳紀錄" : "此客戶尚無等級過帳紀錄") +
        "</td></tr>";
      return;
    }
    const canOp = drCanOperate_();
    body.innerHTML = rows
      .map(function (row) {
        const st = String(row.status || "").trim().toUpperCase();
        const stLabel = DR_STAT_STATUS_LABELS_[st] || st || "—";
        const stStyle = st === "VOID" ? "color:#94a3b8" : st === "POSTED" ? "color:#15803d" : "";
        const rowVoidStyle = st === "VOID" ? ' style="opacity:0.75"' : "";
        const before =
          row.cumulative_before != null && row.cumulative_before !== ""
            ? roundMoney_(row.cumulative_before)
            : null;
        const monthAdd = roundMoney_(
          Number(row.cumulative_add_consignment || 0) + Number(row.cumulative_add_general || 0)
        );
        const currentTier = drFmtTierCell_(
          row.display_current_tier_label,
          row.display_current_tier_price_rate
        );
        const pendingLabel = String(row.cumulative_pending_tier_label || "").trim();
        const pendingTier = pendingLabel
          ? drFmtTierCell_(pendingLabel, row.cumulative_pending_price_rate)
          : "—";
        const lid = String(row.level_post_id || "").trim();
        let actionCell = "—";
        if (st === "POSTED" && canOp) {
          actionCell =
            '<button type="button" class="btn-secondary btn-sm" onclick="event.stopPropagation();drLevelVoid_(\'' +
            lid.replace(/'/g, "\\'") +
            "')\">作廢</button>";
        }
        const safeLid = lid.replace(/'/g, "\\'");
        return (
          '<tr class="erp-list-row-selectable" data-level-id="' +
          ccEsc_(lid) +
          '" onclick="drLevelSelectRow_(\'' +
          safeLid +
          "')\" title=\"點列查看產生時快照\"" +
          rowVoidStyle +
          ">" +
          "<td>" +
          ccEsc_(row.period_ym || "") +
          "</td>" +
          "<td>" +
          (before != null ? ccEsc_(drFmtMoney_(before)) : "—") +
          "</td>" +
          "<td>" +
          ccEsc_(drFmtMoney_(monthAdd)) +
          "</td>" +
          "<td>" +
          currentTier +
          "</td>" +
          "<td>" +
          pendingTier +
          "</td>" +
          '<td style="' +
          stStyle +
          '">' +
          ccEsc_(stLabel) +
          "</td>" +
          "<td>" +
          actionCell +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    drLevelHighlightSelectedRow_();
    const sel = String(drLevelSelectedId_ || "").trim();
    if (sel) {
      const picked = rows.find(function (row) {
        return String(row.level_post_id || "").trim() === sel;
      });
      if (picked) {
        drLevelRenderSnapshot_(drLevelPackFromRow_(picked));
      } else {
        drLevelSelectedId_ = "";
        drLevelRenderSnapshot_(null);
        drLevelHighlightSelectedRow_();
      }
    }
  } catch (_e) {
    drLevelSelectedId_ = "";
    drLevelRenderSnapshot_(null);
    body.innerHTML = '<tr><td colspan="7" class="text-muted">載入失敗</td></tr>';
  }
}

function drLevelPackFromRow_(row) {
  const r = row || {};
  const cumAddCons = Number(r.cumulative_add_consignment || 0);
  const cumAddGen = Number(r.cumulative_add_general || 0);
  const monthAdd = roundMoney_(cumAddCons + cumAddGen);
  const cumBefore = r.cumulative_before != null && r.cumulative_before !== "" ? roundMoney_(r.cumulative_before) : null;
  const cumAfter =
    r.cumulative_after != null && r.cumulative_after !== ""
      ? roundMoney_(r.cumulative_after)
      : cumBefore != null
        ? cumBefore
        : null;
  const schemeId = String(r.cumulative_scheme_id || "").trim();
  const pendingLabel = String(r.cumulative_pending_tier_label || "").trim();
  const cumulativePreview = {
    enabled: cumBefore != null || cumAfter != null || monthAdd > 0.009,
    scheme_id: schemeId,
    scheme_name: schemeId ? String(drDealerSchemeNameMap_[schemeId.toUpperCase()] || "").trim() : "",
    cumulative_before: cumBefore != null ? cumBefore : 0,
    cumulative_after: cumAfter != null ? cumAfter : 0,
    cumulative_add: monthAdd,
    current_tier_label: String(r.display_current_tier_label || "").trim(),
    current_price_rate:
      r.display_current_tier_price_rate != null && r.display_current_tier_price_rate !== ""
        ? Number(r.display_current_tier_price_rate)
        : null,
    upgrade: !!pendingLabel,
    pending_tier_label: pendingLabel,
    pending_price_rate:
      r.cumulative_pending_price_rate != null && r.cumulative_pending_price_rate !== ""
        ? Number(r.cumulative_pending_price_rate)
        : null
  };
  return {
    from_posted: true,
    posted_level_id: String(r.level_post_id || ""),
    posted_status: String(r.status || "").trim().toUpperCase(),
    posted_stat_id: String(r.stat_id || "").trim(),
    period_ym: String(r.period_ym || ""),
    cumulative_scheme_id: schemeId,
    cumulative_add_consignment: cumAddCons,
    cumulative_add_general: cumAddGen,
    cumulative_add_total: monthAdd,
    cumulative_stat_source:
      cumAddGen > 0.009 && cumAddCons > 0.009 ? "ALL" : cumAddGen > 0.009 ? "GENERAL" : "CONSIGNMENT",
    cumulative_preview: cumulativePreview,
    remark: String(r.remark || "").trim()
  };
}

function drLevelHighlightSelectedRow_() {
  const sel = String(drLevelSelectedId_ || "").trim();
  document.querySelectorAll("#dr_level_list_tbody tr[data-level-id]").forEach(function (tr) {
    const on = sel && String(tr.getAttribute("data-level-id") || "") === sel;
    tr.classList.toggle("erp-list-row-open", on);
  });
}

function drLevelSelectRow_(levelPostId) {
  const lid = String(levelPostId || "").trim();
  if (
    typeof erpListRowToggleClose_ === "function" &&
    erpListRowToggleClose_(drLevelSelectedId_, lid)
  ) {
    const box = document.getElementById("dr_level_snapshot");
    const snapshotOpen = box && !box.classList.contains("dr-rebate-box-hidden");
    if (snapshotOpen) {
      drLevelSelectedId_ = "";
      drLevelRenderSnapshot_(null);
      drLevelHighlightSelectedRow_();
      return;
    }
  }
  const row = (drLevelListRows_ || []).find(function (r) {
    return String(r.level_post_id || "").trim() === lid;
  });
  if (!row) return;
  drLevelSelectedId_ = lid;
  drLevelRenderSnapshot_(drLevelPackFromRow_(row));
  drLevelHighlightSelectedRow_();
  try {
    const box = document.getElementById("dr_level_snapshot");
    if (box && typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (_e) {}
}

function drLevelRenderSnapshot_(pack) {
  const box = document.getElementById("dr_level_snapshot");
  if (!box) return;
  if (!pack) {
    box.classList.add("dr-rebate-box-hidden");
    box.innerHTML = "";
    return;
  }
  const stLabel = DR_STAT_STATUS_LABELS_[pack.posted_status] || pack.posted_status || "—";
  let html =
    '<div style="color:#64748b;margin-bottom:6px;">經銷等級快照：<strong>' +
    ccEsc_(pack.posted_level_id || "—") +
    "</strong>（" +
    ccEsc_(stLabel) +
    "）</div>";
  const cum = pack.cumulative_preview || {};
  if (cum.enabled) {
    html +=
      "<div><strong>等級方案</strong>：" + ccEsc_(drRebateCumulativeSchemeLabel_(cum)) + "</div>";
    html += drFmtLevelBasisLine_(drLevelBasisFromStat_(pack, cum), { postedTag: true });
    html +=
      "<div><strong>目前等級</strong>：" +
      (cum.current_tier_label ? drFmtTierCell_(cum.current_tier_label, cum.current_price_rate) : "—") +
      "</div>";
    html +=
      "<div><strong>經銷等級累積</strong>：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after) +
      "（本月 +" +
      drFmtMoney_(cum.cumulative_add) +
      "）</div>";
    html += drRebatePendingTierHtml_(cum);
    if (!cum.pending_tier_label && !cum.upgrade) {
      html += "<div>本月累積未達升級門檻</div>";
    }
  }
  if (pack.remark) {
    html += "<div><strong>備註</strong>：" + ccEsc_(pack.remark) + "</div>";
  }
  box.innerHTML = html;
  box.classList.remove("dr-rebate-box-hidden");
}

function roundMoney_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function drStatRenderList_() {
  const body = document.getElementById("dr_stat_list_tbody");
  if (!body) return;
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "")
    .trim()
    .toUpperCase();
  body.innerHTML = '<tr><td colspan="6" class="text-muted">載入中…</td></tr>';
  if (!customerId) {
    drStatListRows_ = [];
    drStatSelectedId_ = "";
    drStatRenderSnapshot_(null);
    body.innerHTML = '<tr><td colspan="6" class="text-muted">—</td></tr>';
    return;
  }
  try {
    const periodYm = drSelectedPeriodYm_();
    const r = await callAPI(
      {
        action: "list_commercial_dealer_monthly_stat_enriched",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "GET" }
    );
    const rows = (r?.data || []).filter(function (row) {
      return (
        String(row.customer_id || "").trim().toUpperCase() === customerId &&
        drRowMatchesSelectedPeriod_(row)
      );
    });
    drStatListRows_ = rows;
    if (!rows.length) {
      drStatSelectedId_ = "";
      drStatRenderSnapshot_(null);
      body.innerHTML =
        '<tr><td colspan="6" class="text-muted">' +
        (periodYm ? "此客戶該月尚無月結統計紀錄" : "此客戶尚無月結統計紀錄") +
        "</td></tr>";
      return;
    }
    const canOp = drCanOperate_();
    body.innerHTML = rows
      .map(function (row) {
        const st = String(row.status || "").trim().toUpperCase();
        const stLabel = DR_STAT_STATUS_LABELS_[st] || st || "—";
        const stStyle = st === "VOID" ? "color:#94a3b8" : st === "POSTED" ? "color:#15803d" : "";
        const sid = String(row.stat_id || "").trim();
        const safeSid = sid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        let actionCell = "—";
        if (st === "POSTED" && canOp) {
          actionCell =
            '<button type="button" class="btn-secondary btn-sm" onclick="event.stopPropagation();drStatVoid_(\'' +
            sid.replace(/'/g, "\\'") +
            "')\">作廢本月月結</button>";
        }
        return (
          '<tr class="erp-list-row-selectable' +
          (drStatSelectedId_ === sid ? " erp-list-row-open" : "") +
          '" data-stat-id="' +
          ccEsc_(sid) +
          '" onclick="drStatSelectRow_(\'' +
          safeSid +
          "')\" title=\"點列查看過帳時快照\"" +
          (st === "VOID" ? ' style="opacity:0.75"' : "") +
          ">" +
          "<td>" + ccEsc_(row.period_ym || "") + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.billing_net_consignment)) + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.billing_net_general)) + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.billing_net_total)) + "</td>" +
          '<td style="' + stStyle + '">' + ccEsc_(stLabel) + "</td>" +
          "<td>" + actionCell + "</td>" +
          "</tr>"
        );
      })
      .join("");
    drStatHighlightSelectedRow_();
    const sel = String(drStatSelectedId_ || "").trim();
    if (sel) {
      const picked = rows.find(function (row) {
        return String(row.stat_id || "").trim() === sel;
      });
      if (picked) {
        drStatRenderSnapshot_(drStatPackFromRow_(picked));
      } else {
        drStatSelectedId_ = "";
        drStatRenderSnapshot_(null);
        drStatHighlightSelectedRow_();
      }
    }
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="6" class="text-muted">載入失敗</td></tr>';
  }
}

function drStatPackFromRow_(row) {
  const r = row || {};
  const cumBefore = r.cumulative_before;
  const cumAfter = r.cumulative_after;
  const cumAddCons = Number(r.cumulative_add_consignment || 0);
  const cumAddGen = Number(r.cumulative_add_general || 0);
  const pendingLabel = String(r.cumulative_pending_tier_label || "").trim();
  const hasCum = cumBefore != null || cumAfter != null || cumAddCons > 0.009 || cumAddGen > 0.009;
  let cumulativePreview = { enabled: false };
  if (hasCum) {
    const cid = String(r.customer_id || "").trim().toUpperCase();
    const cumSchemeId = String(r.cumulative_scheme_id || ccCustomers_[cid]?.dealer_cumulative_scheme_id || "").trim();
    const cust = ccCustomers_[cid] || {};
    cumulativePreview = {
      enabled: true,
      scheme_id: cumSchemeId,
      scheme_name: cumSchemeId ? String(drDealerSchemeNameMap_[cumSchemeId.toUpperCase()] || "").trim() : "",
      cumulative_before: Number(cumBefore || 0),
      cumulative_after: Number(cumAfter != null ? cumAfter : cumBefore || 0),
      cumulative_add: roundMoney_(cumAddCons + cumAddGen),
      current_tier_label: String(cust.dealer_cumulative_tier_label || "").trim(),
      current_price_rate:
        cust.dealer_cumulative_price_rate != null && cust.dealer_cumulative_price_rate !== ""
          ? Number(cust.dealer_cumulative_price_rate)
          : null,
      upgrade: !!pendingLabel,
      pending_tier_label: pendingLabel,
      pending_price_rate:
        r.cumulative_pending_price_rate != null && r.cumulative_pending_price_rate !== ""
          ? Number(r.cumulative_pending_price_rate)
          : null
    };
  }
  const billingGen = Number(r.billing_net_general || 0);
  return {
    from_posted: true,
    posted_stat_id: String(r.stat_id || ""),
    posted_status: String(r.status || "").trim().toUpperCase(),
    period_ym: String(r.period_ym || ""),
    stat_source: billingGen > 0.009 && cumAddCons > 0.009 ? "ALL" : cumAddGen > 0.009 ? "GENERAL" : "CONSIGNMENT",
    billing_net: Number(r.billing_net_total || 0),
    billing_net_consignment: Number(r.billing_net_consignment || 0),
    billing_net_general: billingGen,
    gross_settlement: Number(r.gross_settlement || 0),
    gross_shipment: Number(r.gross_shipment || 0),
    cumulative_add_consignment: cumAddCons,
    cumulative_add_general: cumAddGen,
    cumulative_add_total: roundMoney_(cumAddCons + cumAddGen),
    cumulative_preview: cumulativePreview,
    remark: String(r.remark || "").trim()
  };
}

function drStatHighlightSelectedRow_() {
  const sel = String(drStatSelectedId_ || "").trim();
  document.querySelectorAll("#dr_stat_list_tbody tr[data-stat-id]").forEach(function (tr) {
    const on = sel && String(tr.getAttribute("data-stat-id") || "") === sel;
    tr.classList.toggle("erp-list-row-open", on);
  });
}

function drStatSelectRow_(statId) {
  const sid = String(statId || "").trim();
  if (
    typeof erpListRowToggleClose_ === "function" &&
    erpListRowToggleClose_(drStatSelectedId_, sid)
  ) {
    const box = document.getElementById("dr_stat_snapshot");
    const snapshotOpen = box && !box.classList.contains("dr-rebate-box-hidden");
    if (snapshotOpen) {
      drStatSelectedId_ = "";
      drStatRenderSnapshot_(null);
      drStatHighlightSelectedRow_();
      return;
    }
  }
  const row = (drStatListRows_ || []).find(function (r) {
    return String(r.stat_id || "").trim() === sid;
  });
  if (!row) return;
  drStatSelectedId_ = sid;
  drStatRenderSnapshot_(drStatPackFromRow_(row));
  drStatHighlightSelectedRow_();
  try {
    const box = document.getElementById("dr_stat_snapshot");
    if (box && typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (_e) {}
}

function drStatRenderSnapshot_(pack) {
  const box = document.getElementById("dr_stat_snapshot");
  if (!box) return;
  if (!pack) {
    box.classList.add("dr-rebate-box-hidden");
    box.innerHTML = "";
    return;
  }
  const stLabel = DR_STAT_STATUS_LABELS_[pack.posted_status] || pack.posted_status || "—";
  let html =
    '<div style="color:#64748b;margin-bottom:6px;">月結統計快照：<strong>' +
    ccEsc_(pack.posted_stat_id || "—") +
    "</strong>（" +
    ccEsc_(stLabel) +
    "）</div>";
  const billingNet = Number(pack.billing_net || 0);
  const detailPack = drSnapshotDetailPack_(pack);
  if (billingNet > 0.009) {
    html +=
      "<div><strong>請款淨額</strong>：" +
      drFmtMoney_(billingNet) +
      drFmtBillingBasisDetail_(detailPack) +
      "（過帳時快照）</div>";
  }
  if (pack.remark) {
    html += "<div><strong>備註</strong>：" + ccEsc_(pack.remark) + "</div>";
  }
  box.innerHTML = html;
  box.classList.remove("dr-rebate-box-hidden");
}

function drRebateParseTierSnapshot_(row) {
  if (!row) return null;
  try {
    const raw = row.tier_snapshot_json;
    if (raw == null || raw === "") return null;
    if (typeof raw === "object") return raw;
    return JSON.parse(String(raw));
  } catch (_e) {
    return null;
  }
}

function drRebatePackFromRow_(row) {
  const tier = drRebateParseTierSnapshot_(row) || {};
  const cumBefore = row.cumulative_before;
  const cumAfter = row.cumulative_after;
  const hasCum = cumBefore != null || cumAfter != null;
  const pendingLabel = String(row.cumulative_pending_tier_label || "").trim();
  let cumulativePreview = { enabled: false };
  if (hasCum) {
    const cid = String(row.customer_id || "").trim().toUpperCase();
    const cumSchemeId = String(ccCustomers_[cid]?.dealer_cumulative_scheme_id || "").trim();
    cumulativePreview = {
      enabled: true,
      scheme_id: cumSchemeId,
      scheme_name: cumSchemeId ? String(drDealerSchemeNameMap_[cumSchemeId.toUpperCase()] || "").trim() : "",
      cumulative_before: Number(cumBefore || 0),
      cumulative_after: Number(cumAfter != null ? cumAfter : cumBefore || 0),
      cumulative_add: Number(
        row.cumulative_added != null ? row.cumulative_added : row.billing_net || 0
      ),
      upgrade: !!pendingLabel,
      pending_tier_label: pendingLabel,
      pending_price_rate:
        row.cumulative_pending_price_rate != null && row.cumulative_pending_price_rate !== ""
          ? Number(row.cumulative_pending_price_rate)
          : null
    };
  }
  return {
    scheme_name: row.scheme_name_snapshot || row.scheme_id || "—",
    scheme_id: row.scheme_id || "",
    stat_source: "CONSIGNMENT",
    billing_net: row.billing_net,
    billing_net_consignment: Number(row.billing_net || 0),
    billing_net_general: 0,
    rebate_amount: row.rebate_amount,
    rebate_pct: row.rebate_pct,
    settle_mode_default: row.settle_mode,
    tier_snapshot: tier,
    cumulative_preview: cumulativePreview,
    from_posted: true,
    posted_rebate_id: row.rebate_id,
    posted_status: String(row.status || "").trim().toUpperCase(),
    posted_remark: String(row.remark || "").trim(),
    ar_id: String(row.ar_id || "").trim()
  };
}

function drRebateFindActivePostedRow_(customerId, periodYm) {
  const cid = String(customerId || "").trim().toUpperCase();
  const ym = String(periodYm || "").trim();
  return (
    (drRebateListRows_ || []).find(function (row) {
      return (
        String(row.customer_id || "").trim().toUpperCase() === cid &&
        String(row.period_ym || "").trim() === ym &&
        String(row.status || "").trim().toUpperCase() === "POSTED"
      );
    }) || null
  );
}

function drRebateAlignBillingDriftFromStat_(preview, statPack) {
  const p = preview || {};
  if (!statPack?.already_posted || p.already_posted) return p;
  return Object.assign({}, p, {
    has_new_billing: !!statPack.has_new_billing,
    posted_billing_net: statPack.posted_billing_net,
    posted_billing_net_consignment: statPack.posted_billing_net_consignment,
    posted_billing_net_general: statPack.posted_billing_net_general,
    live_billing_net: statPack.live_billing_net,
    live_billing_net_consignment: statPack.live_billing_net_consignment,
    live_billing_net_general: statPack.live_billing_net_general,
    billing_net_diff: statPack.billing_net_diff,
    billing_net_consignment_diff: statPack.billing_net_consignment_diff,
    billing_net_general_diff: statPack.billing_net_general_diff,
    monthly_stat_posted: true,
    existing_stat_id: statPack.existing_stat_id || p.existing_stat_id || ""
  });
}

/** @deprecated 請用 drRebateAlignBillingDriftFromStat_ */
function drRebateInheritBillingDriftFromStat_(preview, statPack) {
  return drRebateAlignBillingDriftFromStat_(preview, statPack);
}

/** 以列表有效回饋補齊摘要；已產生且有新單時，回饋金額須用產生當下快照勿跟即時請款重算 */
function drRebateApplyPostedRowToPreviewPack_(customerId, periodYm) {
  const posted = drRebateFindActivePostedRow_(customerId, periodYm);
  if (!posted) return;
  const preview = drRebateAlignBillingDriftFromStat_(drRebatePreviewPack_ || {}, drStatPreviewPack_);
  const hasDrift = !!preview.has_new_billing;
  if (preview.already_posted && !hasDrift) return;
  const fromRow = drRebatePackFromRow_(posted);
  drRebatePreviewPack_ = Object.assign({}, preview, fromRow, {
    already_posted: true,
    existing_rebate_id: String(posted.rebate_id || ""),
    has_new_billing: hasDrift,
    posted_billing_net: preview.posted_billing_net,
    posted_billing_net_consignment: preview.posted_billing_net_consignment,
    posted_billing_net_general: preview.posted_billing_net_general,
    live_billing_net: preview.live_billing_net,
    live_billing_net_consignment: preview.live_billing_net_consignment,
    live_billing_net_general: preview.live_billing_net_general,
    billing_net_diff: preview.billing_net_diff,
    billing_net_consignment_diff: preview.billing_net_consignment_diff,
    billing_net_general_diff: preview.billing_net_general_diff,
    monthly_stat_posted: preview.monthly_stat_posted,
    existing_stat_id: preview.existing_stat_id,
    rebate_amount_source: "posted_snapshot",
    from_posted: false
  });
  drRebateSchemeNone_ = false;
}

function drRebateSchemeDetailHtml_(rebatePack, opts) {
  const o = opts || {};
  if (!rebatePack) return "<div><strong>回饋方案</strong>：無</div>";
  const tier = rebatePack.tier_snapshot || {};
  const tierText =
    tier.amount_from != null
      ? "級距 " +
        drFmtMoney_(tier.amount_from) +
        "～" +
        (tier.amount_to != null ? drFmtMoney_(tier.amount_to) : "無上限") +
        " → " +
        String(tier.rebate_pct != null ? tier.rebate_pct : rebatePack.rebate_pct || 0) +
        "%"
      : rebatePack.rebate_pct != null
        ? "回饋 " + String(rebatePack.rebate_pct) + "%"
        : "—";
  let html = "";
  if (!o.skipSchemeLine) {
    html +=
      "<div><strong>回饋方案</strong>：" +
      ccEsc_(rebatePack.scheme_name || rebatePack.scheme_id || "—") +
      "</div>";
  }
  html +=
    "<div><strong>套用級距</strong>：" +
    ccEsc_(tierText) +
    "</div>" +
    "<div><strong>回饋金額</strong>：" +
    drFmtMoney_(rebatePack.rebate_amount) +
    "（回饋方式：" +
    ccEsc_(drRebateSettleModeLabel_(rebatePack)) +
    "）</div>";
  return html;
}

async function drRefreshMonthlyCloseAfterMutation_() {
  const cid = drStatGetCustomerId_();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!cid) return;
  try {
    await drStatCustFetchList_();
    await drStatCustRefreshMonthData_();
    drStatCustRenderList_();
    await drRenderMonthlyRecordLists_();
    await drPreviewAllMonthlyClose_({ silent: true });
  } catch (_e) {}
  drRebateApplyPostedRowToPreviewPack_(cid, periodYm);
  drRenderMonthlyCloseSummary_();
}

function drRebateHighlightSelectedRow_() {
  const sel = String(drRebateSelectedId_ || "").trim();
  document.querySelectorAll("#dr_rebate_list_tbody tr[data-rebate-id]").forEach(function (tr) {
    const on = sel && String(tr.getAttribute("data-rebate-id") || "") === sel;
    tr.classList.toggle("erp-list-row-open", on);
  });
}

function drRebateSelectRow_(rebateId) {
  const rid = String(rebateId || "").trim();
  if (
    typeof erpListRowToggleClose_ === "function" &&
    erpListRowToggleClose_(drRebateSelectedId_, rid)
  ) {
    const box = document.getElementById("dr_rebate_snapshot");
    const snapshotOpen = box && !box.classList.contains("dr-rebate-box-hidden");
    if (snapshotOpen) {
      drRebateSelectedId_ = "";
      drRebateRenderSnapshot_(null);
      drRebateHighlightSelectedRow_();
      return;
    }
  }
  const row = (drRebateListRows_ || []).find(function (r) {
    return String(r.rebate_id || "").trim() === rid;
  });
  if (!row) return;
  drRebateSelectedId_ = rid;
  drRebateRenderSnapshot_(drRebatePackFromRow_(row));
  drRebateHighlightSelectedRow_();
  try {
    const box = document.getElementById("dr_rebate_snapshot");
    if (box && typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (_e) {}
}

function drRebateShowDetailBox_(boxId, pack, titleHtml) {
  const box = document.getElementById(boxId);
  if (!box) return;
  if (!pack) {
    box.classList.add("dr-rebate-box-hidden");
    box.innerHTML = "";
    return;
  }
  if (pack.already_posted && !pack.from_posted) {
    if (pack.has_new_billing) {
      const parts = drFmtBillingDriftParts_(pack);
      box.innerHTML =
        '<div style="color:#b45309;">此客戶該月已有有效回饋（' +
        ccEsc_(pack.existing_rebate_id || "—") +
        "）。</div>" +
        '<div style="color:#b45309;margin-top:6px;">過帳後又有新請款' +
        (parts.length ? "（" + ccEsc_(parts.join("；")) + "）" : "") +
        "，請先<strong>作廢</strong>月結回饋，再<strong>作廢</strong>月結統計重新過帳後再產生。</div>";
    } else {
      box.innerHTML =
        '<div style="color:#b45309;">此客戶該月已有有效回饋（' +
        ccEsc_(pack.existing_rebate_id || "—") +
        "）。若要重算，請先在列表<strong>作廢</strong>該筆後再預覽產生。</div>";
    }
    box.classList.remove("dr-rebate-box-hidden");
    try {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (_e) {}
    return;
  }
  const effectiveMode = String(pack.settle_mode_default || "").trim().toUpperCase();
  const modeLabel = DR_REBATE_SETTLE_LABELS_[effectiveMode] || effectiveMode || "—";
  const tier = pack.tier_snapshot || {};
  const tierText =
    tier.amount_from != null
      ? "級距 " + drFmtMoney_(tier.amount_from) + "～" + (tier.amount_to != null ? drFmtMoney_(tier.amount_to) : "無上限") + " → " + String(tier.rebate_pct != null ? tier.rebate_pct : pack.rebate_pct || 0) + "%"
      : pack.rebate_pct != null
        ? "回饋 " + String(pack.rebate_pct) + "%"
        : "—";
  const fromPosted = !!pack.from_posted;
  let html = titleHtml || "";
  if (pack.has_new_billing && pack.monthly_stat_posted && !pack.already_posted) {
    const parts = drFmtBillingDriftParts_(pack);
    html +=
      '<div style="color:#b45309;margin-bottom:8px;">月結統計已過帳，但過帳後又有新請款' +
      (parts.length ? "（" + ccEsc_(parts.join("；")) + "）" : "") +
      "，請先<strong>作廢本月月結</strong>再重新過帳，方可" + DR_REBATE_POST_BTN_LABEL_ + "。</div>";
  }
  html +=
    "<div><strong>回饋方案</strong>：" +
    ccEsc_(pack.scheme_name || pack.scheme_id || "—") +
    "</div>" +
    drFmtRebateCalcBasisLine_(pack, { fromPosted: fromPosted }) +
    "<div><strong>套用級距</strong>：" +
    ccEsc_(tierText) +
    "</div>" +
    "<div><strong>回饋金額</strong>：" +
    drFmtMoney_(pack.rebate_amount) +
    "（回饋方式：" +
    ccEsc_(modeLabel) +
    "）</div>";
  if (fromPosted && pack.ar_id) {
    html +=
      "<div><strong>應收單號</strong>：" +
      '<button type="button" class="btn-link btn-sm" onclick="drGoArForRebate_(\'' +
      String(pack.ar_id).replace(/'/g, "\\'") +
      "')\">" +
      ccEsc_(pack.ar_id) +
      "</button></div>";
  }
  if (fromPosted && pack.posted_remark) {
    html += "<div><strong>備註</strong>：" + ccEsc_(pack.posted_remark) + "</div>";
  }
  const cum = pack.cumulative_preview || {};
  if (cum.enabled) {
    html +=
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;"><strong>等級方案</strong>：' +
      ccEsc_(drRebateCumulativeSchemeLabel_(cum)) +
      "</div>";
    if (!fromPosted || cum.current_tier_label) {
      html +=
        "<div><strong>目前等級</strong>：" +
        ccEsc_(cum.current_tier_label || "—") +
        (cum.current_price_rate != null ? "（" + String(cum.current_price_rate) + " 折）" : "") +
        "</div>";
    }
    html +=
      "<div><strong>經銷等級累積</strong>：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after) +
      "（本月 +" +
      drFmtMoney_(cum.cumulative_add) +
      "）</div>" +
      drRebatePendingTierHtml_(cum);
    if (!cum.pending_tier_label && !cum.upgrade) {
      html += "<div>本月累積未達升級門檻</div>";
    }
  } else if (cum.err) {
    html +=
      '<div style="margin-top:6px;color:#b45309;">累積預覽：' + ccEsc_(cum.err) + "</div>";
  } else if (cum.note) {
    html +=
      '<div style="margin-top:6px;color:#64748b;">' + ccEsc_(cum.note) + "</div>";
  }
  box.innerHTML = html;
  box.classList.remove("dr-rebate-box-hidden");
  try {
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (_e) {}
}

function drRebateRenderPreview_(pack) {
  void pack;
  drRenderMonthlyCloseSummary_();
}

function drRebateRenderSchemeNonePreview_() {
  drRebateSchemeNone_ = true;
  drRenderMonthlyCloseSummary_();
}

function drRebateGetCustRow_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return null;
  return (
    (drStatCustRows_ || []).find(function (c) {
      return String(c.customer_id || "").trim().toUpperCase() === cid;
    }) || null
  );
}

function drRebateIsNoSchemeMsg_(msg) {
  const m = String(msg || "");
  return m.indexOf("客戶未設定月結回饋方案") >= 0 || m.indexOf("未設定月結回饋方案") >= 0;
}

function drIsNoBillingMsg_(msg) {
  return String(msg || "").indexOf("本月無請款淨額") >= 0;
}

function drRebateRenderSnapshot_(pack) {
  if (!pack) {
    drRebateShowDetailBox_("dr_rebate_snapshot", null);
    return;
  }
  const stLabel = DR_REBATE_STATUS_LABELS_[pack.posted_status] || pack.posted_status || "—";
  const titleHtml =
    '<div style="color:#64748b;margin-bottom:6px;">月結回饋快照：<strong>' +
    ccEsc_(pack.posted_rebate_id || "—") +
    "</strong>（" +
    ccEsc_(stLabel) +
    "）</div>";
  drRebateShowDetailBox_("dr_rebate_snapshot", pack, titleHtml);
}

async function drRebatePreview_(opts) {
  const auto = !!(opts && opts.auto);
  const silent = !!(opts && opts.silent);
  if (!auto && !drCanOperate_()) {
    return showToast("您沒有權限操作月結回饋（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  }
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) {
    if (!auto) return showToast("請先選客戶", "error");
    drRebatePreviewPack_ = null;
    drRebateRenderPreview_(null);
    return;
  }
  if (!periodYm) {
    if (!auto) return showToast("請選月份", "error");
    return;
  }

  if (!auto) {
    drRebateSelectedId_ = "";
    drRebateHighlightSelectedRow_();
    drRebateRenderSnapshot_(null);
  }

  const custRow = drRebateGetCustRow_(customerId);
  if (!drStatCustResolveRebateSchemeId_(custRow)) {
    drRebatePreviewPack_ = null;
    drRebateRenderSchemeNonePreview_();
    return;
  }
  drRebateSchemeNone_ = false;

  try {
    const pack = await callAPI(
      {
        action: "preview_commercial_dealer_rebate_bundle",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "POST", silent: silent }
    );
    drRebatePreviewPack_ = drRebateAlignBillingDriftFromStat_(pack, drStatPreviewPack_);
    drRebateRenderPreview_(drRebatePreviewPack_);
  } catch (err) {
    drRebatePreviewPack_ = null;
    const errMsg = String(err?.erpUserMessage || err?.message || err || "");
    if (drRebateIsNoSchemeMsg_(errMsg)) {
      drRebateRenderSchemeNonePreview_();
      return;
    }
    drRebateRenderPreview_(null);
    if (!(err && err.erpApiToastShown) && !silent) showToast("預覽失敗", "error");
  }
}

async function drRebatePost_(opts) {
  const skipConfirm = !!(opts && opts.skipConfirm);
  const skipSaveHint = !!(opts && opts.skipSaveHint);
  if (!drCanOperate_()) {
    if (!skipConfirm) showToast("您沒有權限操作" + DR_REBATE_POST_BTN_LABEL_ + "（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
    return false;
  }
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) {
    if (!skipConfirm) showToast("請先選客戶", "error");
    return false;
  }
  if (!periodYm) {
    if (!skipConfirm) showToast("請選月份", "error");
    return false;
  }
  if (drRebateSchemeNone_ || !drCustHasRebateScheme_(customerId)) {
    if (!skipConfirm) showToast("此客戶未綁月結回饋方案", "warn");
    return false;
  }

  const billingNet = Number(drRebatePreviewPack_?.billing_net || 0);
  const amt = Number(drRebatePreviewPack_?.rebate_amount || 0);
  if (!drHasBillingNet_(billingNet)) {
    await drRebatePreview_({ auto: true, silent: true });
    if (!drHasBillingNet_(Number(drRebatePreviewPack_?.billing_net || 0))) {
      if (!skipConfirm) showToast("本月無請款淨額，無法產生回饋", "warn");
      return false;
    }
  }
  if (drRebatePreviewPack_?.already_posted) {
    if (!skipConfirm) showToast("此客戶該月已有回饋紀錄", "warn");
    return false;
  }
  if (drMonthlyCloseBillingStale_(drStatPreviewPack_, drRebatePreviewPack_)) {
    if (!skipConfirm) {
      showToast(
        drRebatePreviewPack_?.monthly_stat_posted
          ? "月結統計已過帳但請款已變動，請先作廢月結統計再重新過帳"
          : "過帳後又有新請款，請先作廢月結回饋與月結統計",
        "warn"
      );
    }
    return false;
  }
  if (!drStatPreviewPack_?.already_posted) {
    if (!skipConfirm) showToast(DR_MONTHLY_CLOSE_STEP2_NEED_STAT_, "warn");
    return false;
  }

  const effectiveMode = String(drRebatePreviewPack_?.settle_mode_default || "").trim().toUpperCase();
  const modeLabel = DR_REBATE_SETTLE_LABELS_[effectiveMode] || effectiveMode || "—";
  const cum = drRebatePreviewPack_?.cumulative_preview || {};
  if (!skipConfirm) {
    let confirmMsg =
      "確定產生 " + periodYm + " 月結回饋？\n請款淨額：" + drFmtMoney_(drRebatePreviewPack_?.billing_net || billingNet);
    if (amt > 0) {
      confirmMsg += "\n回饋金額：" + drFmtMoney_(amt) + "\n回饋方式：" + modeLabel + "（客戶預設）";
    } else {
      confirmMsg += "\n回饋金額：0（未達月回饋門檻）";
    }
    if (cum.enabled) {
      confirmMsg +=
        "\n月結累積：" +
        drFmtMoney_(cum.cumulative_before) +
        " → " +
        drFmtMoney_(cum.cumulative_after);
      if (cum.upgrade && cum.pending_tier_label) {
        confirmMsg += "\n次月待生效：" + cum.pending_tier_label;
      }
    }
    const okGo = window.confirm ? window.confirm(confirmMsg) : true;
    if (!okGo) return false;
  }

  if (!skipSaveHint) {
    if (!drTryBeginMonthlyClosePost_(skipConfirm)) return false;
    drBeginMonthlyCloseSaveHint_();
  }
  try {
    const res = await callAPI(
      {
        action: "post_commercial_dealer_rebate_bundle",
        customer_id: customerId,
        period_ym: periodYm,
        remark: "",
        created_by: getCurrentUser(),
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    const balAfter = Number(res?.credit_balance_after || 0);
    const settleModeRes = String(res?.settle_mode || "").trim().toUpperCase();
    if (settleModeRes === "CARRY_FORWARD" && res?.credit_balance_after != null) {
      drStatCustPatchCreditBalance_(customerId, balAfter);
    }
    await drStatCustFetchList_();
    const hint =
      settleModeRes === "CARRY_FORWARD" && balAfter > 1e-9
        ? "；折抵餘額 " + drFmtMoney_(balAfter)
        : "";
    const cumAfter = res?.cumulative;
    let cumHint = "";
    if (cumAfter && cumAfter.cumulative_after != null) {
      cumHint = "；月結累積 " + drFmtMoney_(cumAfter.cumulative_after);
      if (cumAfter.pending_tier_label) {
        cumHint += "（次月 " + cumAfter.pending_tier_label + "）";
      }
    }
    if (!skipConfirm) showToast("月結已產生：" + String(res.rebate_id || "") + hint + cumHint, "success");
    await drRefreshMonthlyCloseAfterMutation_();
    return true;
  } catch (err) {
    if (!(err && err.erpApiToastShown) && !skipConfirm) showToast("產生失敗", "error");
    return false;
  } finally {
    if (!skipSaveHint) drEndMonthlyClosePostGuard_();
  }
}

function drGoArForRebate_(arId) {
  const aid = String(arId || "").trim().toUpperCase();
  if (!aid || aid === "—") return;
  try {
    navigate("ar");
    setTimeout(function () {
      try {
        if (typeof arSelect_ === "function") arSelect_(aid);
      } catch (_e) {}
    }, 400);
  } catch (_e2) {}
}

async function drLevelVoid_(levelPostId) {
  if (!drCanOperate_()) return showToast("您沒有權限作廢經銷等級（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const lid = String(levelPostId || "").trim();
  if (!lid) return;

  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason === null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");

  const okGo = window.confirm
    ? window.confirm(
        "確定作廢經銷等級 " +
          lid +
          "？\n累積將扣回；次月待生效（若有）將一併清除。\n同月月結回饋不受影響（若已產生仍保留）。\n\n若要一併作廢回饋與統計，請改用統計紀錄的「作廢本月月結」。"
      )
    : true;
  if (!okGo) return;

  if (!drTryBeginMonthlyClosePost_()) return;
  try {
    await callAPI(
      {
        action: "void_commercial_dealer_level_post_bundle",
        level_post_id: lid,
        void_reason: String(reason).trim(),
        updated_by: getCurrentUser(),
        created_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("經銷等級已作廢：" + lid, "success", 5000);
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    await drRefreshMonthlyCloseAfterMutation_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗", "error");
  } finally {
    drEndMonthlyClosePostGuard_();
  }
}

async function drRebateVoid_(rebateId) {
  if (!drCanOperate_()) return showToast("您沒有權限作廢回饋（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const rid = String(rebateId || "").trim();
  if (!rid) return;

  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason === null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");

  const okGo = window.confirm
    ? window.confirm(
        "確定只作廢回饋 " +
          rid +
          "？\n折讓將還原應收；次月折抵將扣回餘額。\n\n若要一併作廢等級與統計，請改用統計紀錄的「作廢本月月結」。"
      )
    : true;
  if (!okGo) return;

  if (!drTryBeginMonthlyClosePost_()) return;
  try {
    await callAPI(
      {
        action: "void_commercial_dealer_rebate_bundle",
        rebate_id: rid,
        void_reason: String(reason).trim(),
        updated_by: getCurrentUser(),
        created_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("回饋已作廢：" + rid, "success", 5000);
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
    } catch (_eLoad) {}
    await drRefreshMonthlyCloseAfterMutation_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗", "error");
  } finally {
    drEndMonthlyClosePostGuard_();
  }
}

function drStatCustResolveRebateSchemeId_(row) {
  const c = row || {};
  return String(c.dealer_rebate_scheme_id || c.dealer_scheme_id || "").trim().toUpperCase();
}

function drStatCustLiveCustRow_(row) {
  const cid = String(row?.customer_id || "").trim().toUpperCase();
  if (cid && ccCustomers_[cid]) return ccCustomers_[cid];
  return row || {};
}

function drStatCustPatchCreditBalance_(customerId, balance) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  const bal = Number(balance || 0);
  if (ccCustomers_[cid]) {
    ccCustomers_[cid].dealer_rebate_credit_balance = bal;
  }
  drStatCustRows_ = (drStatCustRows_ || []).map(function (c) {
    if (String(c.customer_id || "").trim().toUpperCase() !== cid) return c;
    return Object.assign({}, c, { dealer_rebate_credit_balance: bal });
  });
}

function drStatCustCumulativeAmount_(customerId) {
  const hit = drStatCustMonthStat_(customerId);
  if (hit && hit.dealer_cumulative_amount_as_of != null) {
    return Number(hit.dealer_cumulative_amount_as_of || 0);
  }
  return 0;
}

function drStatCustMonthStat_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  return drStatCustMonthIndex_[cid] || null;
}

function drFmtBillingDriftParts_(pack) {
  const parts = [];
  const cons = Number(pack?.billing_net_consignment_diff || 0);
  const gen = Number(pack?.billing_net_general_diff || 0);
  if (Math.abs(cons) > 0.009) {
    parts.push("寄賣 " + (cons > 0 ? "+" : "") + drFmtMoney_(cons));
  }
  if (Math.abs(gen) > 0.009) {
    parts.push("一般 " + (gen > 0 ? "+" : "") + drFmtMoney_(gen));
  }
  return parts;
}

function drStatCustMonthBillingValue_(hit, kind) {
  if (!hit) return 0;
  return kind === "consignment"
    ? Number(hit.billing_net_consignment || 0)
    : Number(hit.billing_net_general || 0);
}

function drStatCustMonthAmountCellHtml_(customerId, kind) {
  const hit = drStatCustMonthStat_(customerId);
  if (!hit) return '<span class="text-muted">—</span>';
  const stale = !!hit.has_new_billing;
  const st = String(hit.status || "").trim().toUpperCase();
  const amt = drStatCustMonthBillingValue_(hit, kind);
  const text = drFmtMoney_(amt);
  if (stale) {
    return (
      '<span style="color:#64748b;" title="即時請款（未納入已過帳月結）">' + ccEsc_(text) + "</span>"
    );
  }
  if (st === "POSTED" || String(hit.amount_source || "").trim().toLowerCase() === "posted") {
    return ccEsc_(text);
  }
  return (
    '<span style="color:#64748b;" title="預覽統計（尚未過帳）">' + ccEsc_(text) + "</span>"
  );
}

function drStatCustMonthAmountSortValue_(customerId, kind) {
  const hit = drStatCustMonthStat_(customerId);
  if (!hit) return -1;
  return drStatCustMonthBillingValue_(hit, kind);
}

function drStatCustMonthBillingNetValue_(hit) {
  if (!hit) return -1;
  if (hit.billing_net != null) return Number(hit.billing_net || 0);
  return (
    Number(hit.billing_net_consignment || 0) + Number(hit.billing_net_general || 0)
  );
}

function drStatCustMonthBillingNetCellHtml_(customerId) {
  const hit = drStatCustMonthStat_(customerId);
  if (!hit) return '<span class="text-muted">—</span>';
  const stale = !!hit.has_new_billing;
  const st = String(hit.status || "").trim().toUpperCase();
  const text = drFmtMoney_(drStatCustMonthBillingNetValue_(hit));
  if (stale) {
    return (
      '<span style="color:#64748b;" title="即時請款淨額（未納入已過帳月結）">' + ccEsc_(text) + "</span>"
    );
  }
  if (st === "POSTED" || String(hit.amount_source || "").trim().toLowerCase() === "posted") {
    return ccEsc_(text);
  }
  return (
    '<span style="color:#64748b;" title="預覽統計（尚未過帳）">' + ccEsc_(text) + "</span>"
  );
}

function drStatCustMonthBillingNetSortValue_(customerId) {
  const hit = drStatCustMonthStat_(customerId);
  if (!hit) return -1;
  return drStatCustMonthBillingNetValue_(hit);
}

function drStatCustCreditBalance_(row) {
  const live = drStatCustLiveCustRow_(row);
  return Number(live?.dealer_rebate_credit_balance || 0);
}

function drStatCustCreditBalanceSortValue_(row) {
  const live = drStatCustLiveCustRow_(row);
  const rebateId = drStatCustResolveRebateSchemeId_(live);
  const credit = drStatCustCreditBalance_(live);
  if (!rebateId && !(credit > 1e-9)) return -1;
  return credit;
}

function drStatCustCreditBalanceCellHtml_(row) {
  const live = drStatCustLiveCustRow_(row);
  const rebateId = drStatCustResolveRebateSchemeId_(live);
  const credit = drStatCustCreditBalance_(live);
  if (!rebateId && !(credit > 1e-9)) {
    return '<span class="text-muted">—</span>';
  }
  return ccEsc_(drFmtMoney_(credit));
}

function drStatCustHasCumulativeScheme_(row) {
  const live = drStatCustLiveCustRow_(row);
  return !!String(live?.dealer_cumulative_scheme_id || "").trim();
}

function drStatCustCumulativeAmountSortValue_(customerId, row) {
  if (!drStatCustHasCumulativeScheme_(row)) return -1;
  return drStatCustCumulativeAmount_(customerId);
}

function drStatCustCumulativeAmountCellHtml_(customerId, row) {
  if (!drStatCustHasCumulativeScheme_(row)) {
    return '<span class="text-muted">—</span>';
  }
  return ccEsc_(drFmtMoney_(drStatCustCumulativeAmount_(customerId)));
}

function drStatCustMonthCellHtml_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  const hit = drStatCustMonthIndex_[cid];
  if (hit) {
    const st = String(hit.status || "").trim().toUpperCase();
    if (st === "POSTED") {
      if (hit.has_new_billing) {
        return (
          '<span style="color:#b45309;font-weight:600;" title="過帳後有新寄賣結算或一般出貨">已過帳・有新單</span>'
        );
      }
      return '<span style="color:#15803d;font-weight:600;">已過帳</span>';
    }
    if (st === "VOID" && String(hit.amount_source || "").toLowerCase() === "preview") {
      return '<span class="text-muted">預覽未過帳</span>';
    }
  }
  const net = drStatCustMonthBillingNetValue_(hit);
  if (net > 0.009) {
    return '<span class="text-muted">預覽未過帳</span>';
  }
  return '<span class="text-muted">—</span>';
}

function drStatCustQuickPostCellHtml_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  const hit = drStatCustMonthIndex_[cid];
  const canOp = drCanOperate_();
  const net = drStatCustMonthBillingNetValue_(hit);
  const st = hit ? String(hit.status || "").trim().toUpperCase() : "";
  const posted = st === "POSTED";
  const stale = !!(posted && hit?.has_new_billing);
  if (!canOp || posted || stale || !drHasBillingNet_(net)) {
    return '<span class="text-muted">—</span>';
  }
  const safeCid = cid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    '<button type="button" class="btn-secondary btn-sm" onclick="event.stopPropagation();drStatQuickPost_(\'' +
    safeCid +
    "')\">過帳</button>"
  );
}

function drStatCustSyncHighlight_() {
  const sel = drStatGetCustomerId_();
  document.querySelectorAll("#dr_stat_customer_list_tbody tr[data-row-id]").forEach(function (tr) {
    const id = String(tr.getAttribute("data-row-id") || "").trim().toUpperCase();
    tr.classList.toggle("erp-list-row-open", !!sel && id === sel);
  });
}

function drStatCustRenderList_() {
  const tbody = document.getElementById("dr_stat_customer_list_tbody");
  if (!tbody) return;
  let list = (drStatCustRows_ || []).slice();
  if (drStatCustSortState_.field) {
    const field = drStatCustSortState_.field;
    const asc = !!drStatCustSortState_.asc;
    list.sort(function (a, b) {
      let va;
      let vb;
      if (field === "dealer_cumulative_amount") {
        va = drStatCustCumulativeAmountSortValue_(a.customer_id, a);
        vb = drStatCustCumulativeAmountSortValue_(b.customer_id, b);
      } else if (field === "month_consignment") {
        va = drStatCustMonthAmountSortValue_(a.customer_id, "consignment");
        vb = drStatCustMonthAmountSortValue_(b.customer_id, "consignment");
      } else if (field === "month_general") {
        va = drStatCustMonthAmountSortValue_(a.customer_id, "general");
        vb = drStatCustMonthAmountSortValue_(b.customer_id, "general");
      } else if (field === "month_billing_net") {
        va = drStatCustMonthBillingNetSortValue_(a.customer_id);
        vb = drStatCustMonthBillingNetSortValue_(b.customer_id);
      } else if (field === "dealer_rebate_credit_balance") {
        va = drStatCustCreditBalanceSortValue_(a);
        vb = drStatCustCreditBalanceSortValue_(b);
      } else {
        va = String(a[field] ?? "").toLowerCase();
        vb = String(b[field] ?? "").toLowerCase();
      }
      if (va > vb) return asc ? 1 : -1;
      if (va < vb) return asc ? -1 : 1;
      return 0;
    });
  }
  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:24px;">查無符合條件的客戶。</td></tr>';
    return;
  }
  const openId = drStatGetCustomerId_();
  const nameCells =
    typeof masterListNameOnlyCells_ === "function"
      ? masterListNameOnlyCells_
      : function (name) {
          return "<td>" + ccEsc_(name) + "</td><td>" + ccEsc_(name) + "</td>";
        };
  tbody.innerHTML = list
    .map(function (c) {
      const cid = String(c.customer_id || "");
      const safeCid = cid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const open = openId === cid.trim().toUpperCase();
      const name = String(c.customer_name || "").trim() || cid;
      return (
        '<tr class="erp-list-row-selectable' +
        (open ? " erp-list-row-open" : "") +
        '" data-row-id="' +
        ccEsc_(cid) +
        '" onclick="drStatCustSelect_(\'' +
        safeCid +
        "')\" title=\"點列選客戶並預覽統計／回饋\">" +
        nameCells(name) +
        "<td>" +
        drStatCustMonthAmountCellHtml_(cid, "consignment") +
        "</td>" +
        "<td>" +
        drStatCustMonthAmountCellHtml_(cid, "general") +
        "</td>" +
        "<td>" +
        drStatCustMonthBillingNetCellHtml_(cid) +
        "</td>" +
        "<td>" +
        drStatCustCreditBalanceCellHtml_(c) +
        "</td>" +
        "<td>" +
        drStatCustCumulativeAmountCellHtml_(cid, c) +
        "</td>" +
        "<td>" +
        drStatCustMonthCellHtml_(cid) +
        "</td>" +
        "<td>" +
        drStatCustQuickPostCellHtml_(cid) +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function drStatCustSort_(field) {
  if (drStatCustSortState_.field === field) drStatCustSortState_.asc = !drStatCustSortState_.asc;
  else {
    drStatCustSortState_.field = field;
    drStatCustSortState_.asc =
      field === "customer_name" || field === "customer_id";
  }
  drStatCustRenderList_();
}

async function drStatCustFetchList_() {
  const keyword = String(document.getElementById("search_dr_stat_customer_keyword")?.value || "")
    .trim()
    .toUpperCase();
  const bindFilter = String(document.getElementById("search_dr_stat_customer_bind")?.value || "ALL")
    .trim()
    .toUpperCase();
  const statusFilter = String(document.getElementById("search_dr_stat_customer_status")?.value || "ACTIVE")
    .trim()
    .toUpperCase();
  let rows = Object.values(ccCustomers_ || {});
  if (statusFilter && statusFilter !== "ALL") {
    rows = rows.filter(function (c) {
      return String(c.status || "").trim().toUpperCase() === statusFilter;
    });
  }
  if (bindFilter === "ANY" || bindFilter === "BOUND") {
    rows = rows.filter(function (c) {
      const rebate = drStatCustResolveRebateSchemeId_(c);
      const cum = String(c.dealer_cumulative_scheme_id || "").trim().toUpperCase();
      return !!(rebate || cum);
    });
  } else if (bindFilter === "NONE" || bindFilter === "UNBOUND") {
    rows = rows.filter(function (c) {
      const rebate = drStatCustResolveRebateSchemeId_(c);
      const cum = String(c.dealer_cumulative_scheme_id || "").trim().toUpperCase();
      return !rebate && !cum;
    });
  }
  if (keyword) {
    rows = rows.filter(function (c) {
      const cid = String(c.customer_id || "").trim().toUpperCase();
      const name = String(c.customer_name || "").trim().toUpperCase();
      return cid.indexOf(keyword) >= 0 || name.indexOf(keyword) >= 0;
    });
  }
  drStatCustRows_ = rows
    .map(function (c) {
      const rebateId = drStatCustResolveRebateSchemeId_(c);
      const cumId = String(c.dealer_cumulative_scheme_id || "").trim().toUpperCase();
      return Object.assign({}, c, {
        dealer_rebate_scheme_name: rebateId ? String(drDealerSchemeNameMap_[rebateId] || "").trim() : "",
        dealer_cumulative_scheme_name: cumId ? String(drDealerSchemeNameMap_[cumId] || "").trim() : ""
      });
    })
    .sort(function (a, b) {
      const na = String(a.customer_name || a.customer_id || "");
      const nb = String(b.customer_name || b.customer_id || "");
      return na.localeCompare(nb, "zh-Hant");
    });
  return drStatCustRows_;
}

async function drStatCustRefreshMonthData_() {
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  drStatCustMonthIndex_ = {};
  if (!periodYm) return;
  const ids = (drStatCustRows_ || [])
    .map(function (c) {
      return String(c.customer_id || "").trim().toUpperCase();
    })
    .filter(Boolean);
  if (!ids.length) return;
  try {
    const r = await callAPI(
      {
        action: "list_commercial_dealer_monthly_stat_period_summary",
        period_ym: periodYm,
        customer_ids: ids.join(",")
      },
      { method: "GET" }
    );
    (r?.data || []).forEach(function (row) {
      const cid = String(row.customer_id || "").trim().toUpperCase();
      if (!cid) return;
      drStatCustMonthIndex_[cid] = {
        status: String(row.status || "PREVIEW").trim().toUpperCase(),
        amount_source: String(row.amount_source || "preview").trim().toLowerCase(),
        billing_net_consignment: row.billing_net_consignment,
        billing_net_general: row.billing_net_general,
        billing_net: row.billing_net,
        cumulative_add_consignment: row.cumulative_add_consignment,
        cumulative_add_general: row.cumulative_add_general,
        dealer_cumulative_amount_as_of: row.dealer_cumulative_amount_as_of,
        stat_id: row.stat_id || "",
        has_new_billing: !!row.has_new_billing,
        posted_billing_net_consignment: row.posted_billing_net_consignment,
        posted_billing_net_general: row.posted_billing_net_general,
        posted_billing_net: row.posted_billing_net,
        live_billing_net_consignment: row.live_billing_net_consignment,
        live_billing_net_general: row.live_billing_net_general,
        live_billing_net: row.live_billing_net,
        billing_net_consignment_diff: row.billing_net_consignment_diff,
        billing_net_general_diff: row.billing_net_general_diff,
        billing_net_diff: row.billing_net_diff
      };
    });
  } catch (_e) {}
}

function drStatCustApplyPreviewPack_(customerId, pack) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid || !pack) return;
  if (pack.already_posted) {
    drStatCustMonthIndex_[cid] = Object.assign({}, drStatCustMonthIndex_[cid] || {}, {
      status: "POSTED",
      amount_source: pack.has_new_billing ? "posted_stale" : "posted",
      billing_net_consignment: pack.billing_net_consignment,
      billing_net_general: pack.billing_net_general,
      billing_net: pack.billing_net,
      cumulative_add_consignment: pack.cumulative_add_consignment,
      cumulative_add_general: pack.cumulative_add_general,
      stat_id: pack.existing_stat_id || "",
      has_new_billing: !!pack.has_new_billing,
      posted_billing_net_consignment: pack.posted_billing_net_consignment,
      posted_billing_net_general: pack.posted_billing_net_general,
      posted_billing_net: pack.posted_billing_net,
      live_billing_net_consignment: pack.live_billing_net_consignment,
      live_billing_net_general: pack.live_billing_net_general,
      live_billing_net: pack.live_billing_net,
      billing_net_consignment_diff: pack.billing_net_consignment_diff,
      billing_net_general_diff: pack.billing_net_general_diff,
      billing_net_diff: pack.billing_net_diff
    });
  } else {
    drStatCustMonthIndex_[cid] = Object.assign({}, drStatCustMonthIndex_[cid] || {}, {
      status: "PREVIEW",
      amount_source: "preview",
      billing_net_consignment: pack.billing_net_consignment,
      billing_net_general: pack.billing_net_general,
      billing_net: pack.billing_net,
      cumulative_add_consignment: pack.cumulative_add_consignment,
      cumulative_add_general: pack.cumulative_add_general
    });
  }
  drStatCustRenderList_();
}

async function drStatCustSearch_() {
  const tbody = document.getElementById("dr_stat_customer_list_tbody");
  if (typeof setTbodyLoading_ === "function") {
    setTbodyLoading_(tbody, 8);
  } else if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-muted">載入中…</td></tr>';
  }
  try {
    await drStatCustFetchList_();
    await drStatCustRefreshMonthData_();
    drStatCustRenderList_();
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-muted">載入失敗</td></tr>';
    showToast(String(e?.message || e || "載入失敗"), "error");
  }
}

async function drStatCustResetSearch_() {
  const kw = document.getElementById("search_dr_stat_customer_keyword");
  if (kw) kw.value = "";
  const bind = document.getElementById("search_dr_stat_customer_bind");
  if (bind) bind.value = "ALL";
  if (typeof masterSearchStatusDefault_ === "function") {
    masterSearchStatusDefault_("search_dr_stat_customer_status");
  } else {
    const st = document.getElementById("search_dr_stat_customer_status");
    if (st) st.value = "ACTIVE";
  }
  await drStatCustSearch_();
}

async function drStatCustSelect_(customerId) {
  const cid = String(customerId || "").trim().toUpperCase();
  if (!cid) return;
  drStatSetCustomerId_(cid);
  drRebateOnCustomerChange_();
  await drPreviewAllMonthlyClose_({ silent: true });
  try {
    const panel = document.getElementById("dr_billing_summary_panel");
    if (panel && typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (_e) {}
}

async function drStatCustOnPeriodChange_() {
  const seq = ++drStatPeriodLoadSeq_;
  drCollapseExpandedDetailPanels_();
  const tbody = document.getElementById("dr_stat_customer_list_tbody");
  if (typeof setTbodyLoading_ === "function") {
    setTbodyLoading_(tbody, 9);
  } else if (tbody) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted">載入中…</td></tr>';
  }
  drStatPreviewPack_ = null;
  drLevelPreviewPack_ = null;
  drRebatePreviewPack_ = null;
  drRebateSchemeNone_ = false;
  drRenderMonthlyCloseSummary_();
  drDisableMonthlyCloseActionBtns_(true);
  try {
    await drStatCustRefreshMonthData_();
    if (seq !== drStatPeriodLoadSeq_) return;
    drStatCustRenderList_();
    drStatRenderSelectedCustomer_();
    const cid = drStatGetCustomerId_();
    await drRenderMonthlyRecordLists_();
    if (cid) {
      await drPreviewAllMonthlyClose_({ silent: true });
    }
  } catch (e) {
    if (seq !== drStatPeriodLoadSeq_) return;
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="text-muted">載入失敗</td></tr>';
    showToast(String(e?.message || e || "載入失敗"), "error");
    drStatRenderSelectedCustomer_();
  } finally {
    if (seq === drStatPeriodLoadSeq_) drUpdateMonthlyCloseActions_();
  }
}

function drStatCustBindSearchEvents_() {
  if (typeof bindAutoSearchToolbar_ === "function") {
    bindAutoSearchToolbar_(
      [
        ["search_dr_stat_customer_keyword", "input"],
        ["search_dr_stat_customer_bind", "change"],
        ["search_dr_stat_customer_status", "change"]
      ],
      function () {
        drStatCustSearch_();
      }
    );
  }
}

function drCollapseExpandedDetailPanels_() {
  drStatSelectedId_ = "";
  drRebateSelectedId_ = "";
  drLevelSelectedId_ = "";
  drStatRenderSnapshot_(null);
  drRebateRenderSnapshot_(null);
  drLevelRenderSnapshot_(null);
  drStatHighlightSelectedRow_();
  drRebateHighlightSelectedRow_();
  drLevelHighlightSelectedRow_();
}

function drRebateOnCustomerChange_() {
  drCollapseExpandedDetailPanels_();
  drRebatePreviewPack_ = null;
  drStatPreviewPack_ = null;
  drLevelPreviewPack_ = null;
  drRebateSchemeNone_ = false;
  drRebateRenderPreview_(null);
  drStatRenderPreview_(null);
  drStatCustSyncHighlight_();
  drStatRenderList_();
  void drRebateRenderList_().then(function () {
    return drLevelRenderList_();
  });
}

async function drRebateRenderList_() {
  const body = document.getElementById("dr_rebate_list_tbody");
  if (!body) return;
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "")
    .trim()
    .toUpperCase();
  body.innerHTML = '<tr><td colspan="8" class="text-muted">載入中…</td></tr>';
  if (!customerId) {
    drRebateListRows_ = [];
    drRebateSelectedId_ = "";
    body.innerHTML = '<tr><td colspan="8" class="text-muted">—</td></tr>';
    return;
  }
  try {
    const periodYm = drSelectedPeriodYm_();
    const r = await callAPI(
      {
        action: "list_commercial_dealer_rebate_enriched",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "GET" }
    );
    const allRows = r?.data || [];
    const rows = allRows.filter(function (row) {
      return (
        String(row.customer_id || "").trim().toUpperCase() === customerId &&
        drRowMatchesSelectedPeriod_(row)
      );
    });
    drRebateListRows_ = rows;
    if (!rows.length) {
      drRebateSelectedId_ = "";
      drRebateRenderSnapshot_(null);
      body.innerHTML =
        '<tr><td colspan="8" class="text-muted">' +
        (periodYm ? "此客戶該月尚無回饋紀錄" : "此客戶尚無回饋紀錄") +
        "</td></tr>";
      return;
    }
    const canOp = drCanOperate_();
    body.innerHTML = rows
      .map(function (row) {
        const arId = String(row.ar_id || "").trim();
        const arCell =
          arId && arId !== "—"
            ? '<button type="button" class="btn-link btn-sm" onclick="event.stopPropagation();drGoArForRebate_(\'' +
              arId.replace(/'/g, "\\'") +
              "')\" title=\"開啟 AR 查看調整歷程\">" +
              ccEsc_(arId) +
              "</button>"
            : ccEsc_("—");
        const st = String(row.status || "").trim().toUpperCase();
        const stLabel = DR_REBATE_STATUS_LABELS_[st] || st || "—";
        const stStyle = st === "VOID" ? "color:#94a3b8" : st === "POSTED" ? "color:#15803d" : "";
        let actionCell = "—";
        if (st === "POSTED" && canOp) {
          actionCell =
            '<button type="button" class="btn-secondary btn-sm" onclick="event.stopPropagation();drRebateVoid_(\'' +
            String(row.rebate_id || "").replace(/'/g, "\\'") +
            "')\">作廢</button>";
        }
        const rid = String(row.rebate_id || "").trim();
        const safeRid = rid.replace(/'/g, "\\'");
        return (
          '<tr class="erp-list-row-selectable" data-rebate-id="' +
          ccEsc_(rid) +
          '" onclick="drRebateSelectRow_(\'' +
          safeRid +
          "')\" title=\"點列查看產生時快照\"" +
          (st === "VOID" ? ' style="opacity:0.75"' : "") +
          ">" +
          "<td>" + ccEsc_(row.period_ym || "") + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.billing_net)) + "</td>" +
          "<td>" + ccEsc_(String(row.rebate_pct != null ? row.rebate_pct : "")) + "%</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.rebate_amount)) + "</td>" +
          "<td>" + ccEsc_(DR_REBATE_SETTLE_LABELS_[row.settle_mode] || row.settle_mode || "") + "</td>" +
          '<td style="' + stStyle + '">' + ccEsc_(stLabel) + "</td>" +
          "<td>" + arCell + "</td>" +
          "<td>" + actionCell + "</td>" +
          "</tr>"
        );
      })
      .join("");
    drRebateHighlightSelectedRow_();
    const sel = String(drRebateSelectedId_ || "").trim();
    if (sel) {
      const picked = rows.find(function (row) {
        return String(row.rebate_id || "").trim() === sel;
      });
      if (picked) {
        drRebateRenderSnapshot_(drRebatePackFromRow_(picked));
      } else {
        drRebateSelectedId_ = "";
        drRebateRenderSnapshot_(null);
        drRebateHighlightSelectedRow_();
      }
    }
    if (customerId === drStatGetCustomerId_()) {
      drRebateApplyPostedRowToPreviewPack_(
        customerId,
        drSelectedPeriodYm_()
      );
      drRenderMonthlyCloseSummary_();
    }
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="8" class="text-muted">載入失敗</td></tr>';
  }
}

function drApplyRebatePermissions_() {
  drUpdateMonthlyCloseActions_();
}

async function dealerRebateInit() {
  const hint = document.getElementById("drRebateStatusHint");
  if (hint) hint.textContent = drRebatePermissionHint_();
  const statHint = document.getElementById("drStatStatusHint");
  if (statHint) statHint.textContent = drStatPermissionHint_();
  drApplyRebatePermissions_();
  if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_({ refresh: true });
  await drRebateEnsureSchemeNames_();

  const periodEl = document.getElementById("dr_rebate_period");
  if (periodEl && !periodEl.value) {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    periodEl.value = d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }

  let drPreset = null;
  try {
    const raw = String(sessionStorage.getItem("erp_dealer_rebate_preset") || "").trim();
    if (raw) {
      sessionStorage.removeItem("erp_dealer_rebate_preset");
      drPreset = JSON.parse(raw);
    }
  } catch (_e) {}

  if (periodEl && drPreset && drPreset.period_ym) {
    periodEl.value = String(drPreset.period_ym).trim();
  }

  drStatRenderSelectedCustomer_();
  drStatCustBindSearchEvents_();
  await drStatCustSearch_();

  await drRenderMonthlyRecordLists_();

  if (drPreset && drPreset.customer_id) {
    await drStatCustSelect_(String(drPreset.customer_id).trim().toUpperCase());
  }
}
