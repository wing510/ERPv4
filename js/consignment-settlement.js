/*********************************
 * Consignment 寄賣 · 結算 v4.2.2 + v4.2.3 促銷
 *********************************/

var ccStlPoolItems_ = [];
var ccStlCaseMeta_ = null;
var ccStlIdempotencyKey_ = "";
var ccStlActivePromo_ = { promos: [], conflicts: {}, candidates: [] };
var ccStlPromoOverrides_ = {};
var ccStlDealerCtx_ = { enabled: false };
var ccStlPromoColFlags_ = { free: false, discount: false, fixedPrice: false };

function ccStlPoolTableColspan_() {
  const f = ccStlPromoColFlags_;
  let n = 8;
  if (f.free) n += 1;
  if (f.discount) n += 1;
  if (f.fixedPrice) n += 1;
  return n;
}

function ccApplyStlPoolPromoColVisibility_(flags) {
  ccStlPromoColFlags_ = flags || { free: false, discount: false, fixedPrice: false };
  const f = ccStlPromoColFlags_;
  const table = document.getElementById("cc_stl_pool_table");
  if (!table) return;
  table.classList.toggle("cc-stl-show-free", !!f.free);
  table.classList.toggle("cc-stl-show-discount", !!f.discount);
  table.classList.toggle("cc-stl-show-fixed", !!f.fixedPrice);
}

function ccRefreshStlPoolPromoColVisibility_() {
  ccApplyStlPoolPromoColVisibility_(ccDetectPromoColFlagsFromActive_(ccStlActivePromo_));
}

function ccApplySettlementPermissions_() {
  const ok = ccCanOperate_();
  const btn = document.getElementById("cc_stl_submit_btn");
  if (btn) btn.disabled = !ok;
}

function ccRenderSettlementSummary_() {
  const box = document.getElementById("cc_stl_summary_box");
  if (!box) return;
  const meta = ccStlCaseMeta_;
  if (!meta) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  const closed = String(meta.status || "").trim().toUpperCase() === "CLOSED";
  const custId = String(meta.customer_id || "").trim().toUpperCase();
  const cust = ccCustomers_[custId];
  const creditBal = cust ? Number(cust.dealer_rebate_credit_balance || 0) : 0;
  const settleDate = String(document.getElementById("cc_stl_settlement_date")?.value || "").trim();
  const settleYm = settleDate.length >= 7 ? settleDate.slice(0, 7) : "";
  let dealerHint = "";
  if (creditBal > 1e-9) {
    dealerHint =
      '<div style="margin-top:8px;font-size:13px;color:#0369a1;">經銷折抵餘額：<strong>' +
      ccFmtMoney_(creditBal) +
      "</strong>（僅<strong>回饋月份次月（含）起</strong>的結算才自動抵扣 AR";
    if (settleYm) {
      dealerHint += "；本次結算 " + ccEsc_(settleYm) + " 若尚無可套用的次月回饋則不扣";
    }
    dealerHint += "）</div>";
  }
  box.innerHTML = ccBuildCaseSummaryHtml_(meta, { closedSettleHint: true }) + dealerHint + ccFormatCumulativeDealerSettlementHtml_(ccStlDealerCtx_);
  const promoBox = document.getElementById("cc_stl_promo_summary");
  if (promoBox) {
    promoBox.style.display = "";
    promoBox.innerHTML = ccFormatActivePromoSummaryHtml_(ccStlActivePromo_);
  }
  const btn = document.getElementById("cc_stl_submit_btn");
  if (btn && closed) btn.disabled = true;
}

function ccPoolUnsoldQty_(it) {
  return Number(it && (it.unsold_qty != null ? it.unsold_qty : it.remaining_qty) != null
    ? (it.unsold_qty != null ? it.unsold_qty : it.remaining_qty)
    : 0);
}

function ccSettlementCollectQtyItems_() {
  const inputs = document.querySelectorAll("#cc_stl_pool_tbody .cc-stl-qty");
  const items = [];
  inputs.forEach(function (inp) {
    const poolId = String(inp.getAttribute("data-pool-id") || "").trim().toUpperCase();
    const qty = Number(inp.value || 0);
    if (poolId && qty > 1e-9) items.push({ pool_item_id: poolId, settle_qty: qty });
  });
  return items;
}

function ccSettlementGetPreview_() {
  const items = ccSettlementCollectQtyItems_();
  if (!items.length) return { lines: [], amount_system: 0 };
  const promoPreview = ccComputeSettlementPromoPreview_(items, ccStlPoolItems_, ccStlActivePromo_, ccStlPromoOverrides_);
  return ccApplyCumulativeDealerPriceToLines_(promoPreview.lines, ccStlDealerCtx_);
}

function ccSettlementUpdatePreviewCells_() {
  const preview = ccSettlementGetPreview_();
  const map = {};
  (preview.lines || []).forEach(function (ln) {
    map[String(ln.pool_item_id || "").trim().toUpperCase()] = ln;
  });
  document.querySelectorAll("#cc_stl_pool_tbody tr[data-pool-id]").forEach(function (tr) {
    const pid = String(tr.getAttribute("data-pool-id") || "").trim().toUpperCase();
    const ln = map[pid] || {};
    const freeEl = tr.querySelector(".cc-stl-free");
    const discEl = tr.querySelector(".cc-stl-discount");
    const fixedEl = tr.querySelector(".cc-stl-fixed");
    const billEl = tr.querySelector(".cc-stl-billable");
    const subEl = tr.querySelector(".cc-stl-subtotal");
    const qty = Number(tr.querySelector(".cc-stl-qty")?.value || 0);
    const promoCols = ccSettlementPromoCols_(ln);
    if (freeEl) freeEl.textContent = qty > 0 ? promoCols.free : "—";
    if (discEl) discEl.textContent = qty > 0 ? promoCols.discount : "—";
    if (fixedEl) fixedEl.textContent = qty > 0 ? promoCols.fixedPrice : "—";
    if (billEl) billEl.textContent = qty > 0 ? String(ln.billable_qty != null ? ln.billable_qty : 0) : "—";
    if (subEl) subEl.textContent = qty > 0 ? ccFmtMoney_(ln.amount) : "—";
  });
  const totalEl = document.getElementById("cc_stl_preview_total");
  if (totalEl) totalEl.textContent = ccFmtMoney_(preview.amount_system);
}

function ccSettlementOnQtyInput_(inp) {
  ccSettlementUpdatePreviewCells_();
}

function ccSettlementOnPromoOverrideChange_() {
  ccStlPromoOverrides_ = {};
  document.querySelectorAll(".cc-stl-promo-pick").forEach(function (sel) {
    const pid = String(sel.getAttribute("data-product-id") || "").trim().toUpperCase();
    const sid = String(sel.value || "").trim().toUpperCase();
    if (pid && sid) ccStlPromoOverrides_[pid] = sid;
  });
  ccSettlementUpdatePreviewCells_();
}

function ccRenderSettlementConflictPicks_() {
  const host = document.getElementById("cc_stl_conflict_box");
  if (!host) return;
  const conflicts = ccStlActivePromo_?.conflicts || {};
  const keys = Object.keys(conflicts);
  if (!keys.length) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }
  host.style.display = "";
  const rows = keys
    .map(function (pid) {
      const opts = conflicts[pid] || [];
      const pname = ccProductName_(pid);
      const options = opts
        .map(function (c) {
          const sid = String(c.scheme_id || "").trim().toUpperCase();
          const label = String(c.scheme_name || sid) + "（" + (CC_PROMO_TYPE_LABELS_[c.promo_type] || c.promo_type) + "）";
          return '<option value="' + ccEsc_(sid) + '">' + ccEsc_(label) + "</option>";
        })
        .join("");
      return (
        '<div class="form-group" style="min-width:220px;">' +
        "<label>" +
        ccEsc_(pname) +
        " 套用方案</label>" +
        '<select class="cc-stl-promo-pick" data-product-id="' +
        ccEsc_(pid) +
        '" onchange="ccSettlementOnPromoOverrideChange_()">' +
        options +
        "</select></div>"
      );
    })
    .join("");
  host.innerHTML = '<div style="font-size:13px;color:#475569;margin-bottom:8px;">以下品項有多個適用方案，請選擇：</div><div class="form-grid-4">' + rows + "</div>";
  ccSettlementOnPromoOverrideChange_();
}

function ccPromoLabelForPoolRow_(poolItem) {
  const pid = String(poolItem.product_id || "").trim().toUpperCase();
  const promos = ccStlActivePromo_?.promos || [];
  const hit = promos.find(function (p) {
    return String(p.product_id || "").trim().toUpperCase() === pid;
  });
  if (!hit) return "";
  const type = CC_PROMO_TYPE_LABELS_[String(hit.promo_type || "").toUpperCase()] || hit.promo_type;
  return '<div class="cc-pool-stack-sub">促銷：' + ccEsc_(String(hit.scheme_name || hit.scheme_id) + " · " + type) + "</div>";
}

function ccRenderSettlementPool_() {
  const body = document.getElementById("cc_stl_pool_tbody");
  if (!body) return;
  const rows = ccStlPoolItems_ || [];
  const settleable = rows.filter(function (it) {
    return ccPoolUnsoldQty_(it) > 1e-9;
  });
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="' + ccStlPoolTableColspan_() + '" class="text-muted">尚無可結算品項</td></tr>';
    return;
  }
  if (!settleable.length) {
    body.innerHTML =
      '<tr><td colspan="' +
      ccStlPoolTableColspan_() +
      '" class="text-muted">未售剩餘皆為 0（可能已全部結算或已收回）。請查看下方<strong>結算歷史</strong>；若誤結算且 AR 未收款可「作廢」。</td></tr>';
    return;
  }

  body.innerHTML = settleable
    .map(function (it, idx) {
      const rem = ccPoolUnsoldQty_(it);
      const pid = String(it.pool_item_id || "").trim();
      const remStr = String(Math.round(rem * 1000) / 1000);
      const promoHint = ccPromoLabelForPoolRow_(it);
      const productCell = ccFormatPoolProductLotCell_(it) + promoHint;
      return (
        '<tr data-pool-id="' +
        ccEsc_(pid) +
        '">' +
        "<td>" +
        productCell +
        "</td>" +
        "<td>" +
        ccFormatPoolShipExpiryCell_(it) +
        "</td>" +
        "<td>" +
        ccEsc_(remStr) +
        "</td>" +
        "<td>" +
        ccEsc_(ccPoolUnit_(it)) +
        "</td>" +
        "<td>" +
        ccEsc_(ccFmtMoney_(it.unit_price)) +
        "</td>" +
        '<td><input type="number" class="cc-stl-qty" data-pool-id="' +
        ccEsc_(pid) +
        '" data-max="' +
        remStr +
        '" data-idx="' +
        idx +
        '" min="0" max="' +
        remStr +
        '" step="0.001" value="0" style="width:100px;" oninput="ccSettlementOnQtyInput_(this)"></td>' +
        '<td class="cc-stl-free cc-stl-col-free text-muted">—</td>' +
        '<td class="cc-stl-discount cc-stl-col-discount text-muted">—</td>' +
        '<td class="cc-stl-fixed cc-stl-col-fixed text-muted">—</td>' +
        '<td class="cc-stl-billable text-muted">—</td>' +
        '<td class="cc-stl-subtotal text-muted">—</td>' +
        "</tr>"
      );
    })
    .join("");
  ccRefreshStlPoolPromoColVisibility_();
  ccSettlementUpdatePreviewCells_();
}

async function ccSettlementLoadPromos_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  const settlementDate = String(document.getElementById("cc_stl_date")?.value || ccTodayYmd_()).trim();
  if (!id) {
    ccStlActivePromo_ = { promos: [], conflicts: {}, candidates: [] };
    ccStlDealerCtx_ = { enabled: false };
    ccStlPromoOverrides_ = {};
    ccApplyStlPoolPromoColVisibility_({ free: false, discount: false, fixedPrice: false });
    ccRenderSettlementConflictPicks_();
    return;
  }
  const customerId = String(ccStlCaseMeta_?.customer_id || "").trim().toUpperCase();
  try {
    const loads = [ccListPromoActiveForCase_(id, settlementDate)];
    if (customerId) {
      loads.push(ccPreviewCumulativeDealerForSettlement_(customerId, settlementDate, { silent: true }));
    }
    const results = await Promise.all(loads);
    ccStlActivePromo_ = results[0] || { promos: [], conflicts: {}, candidates: [] };
    ccStlDealerCtx_ = customerId && results[1] ? results[1] : { enabled: false };
    ccStlPromoOverrides_ = {};
    ccRefreshStlPoolPromoColVisibility_();
    ccRenderSettlementConflictPicks_();
  } catch (_e) {
    ccStlActivePromo_ = { promos: [], conflicts: {}, candidates: [] };
    ccStlDealerCtx_ = { enabled: false };
    ccApplyStlPoolPromoColVisibility_({ free: false, discount: false, fixedPrice: false });
    ccRenderSettlementConflictPicks_();
  }
}

async function ccSettlementLoadCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  ccStlCaseMeta_ = null;
  ccStlPoolItems_ = [];

  const body = document.getElementById("cc_stl_pool_tbody");
  if (!id) {
    if (body) body.innerHTML = '<tr><td colspan="' + ccStlPoolTableColspan_() + '" class="text-muted">請先選擇寄賣案</td></tr>';
    const hist = document.getElementById("cc_stl_history_tbody");
    if (hist) hist.innerHTML = '<tr><td colspan="6" class="text-muted">請先選擇寄賣案</td></tr>';
    ccStlActivePromo_ = { promos: [], conflicts: {}, candidates: [] };
    ccStlDealerCtx_ = { enabled: false };
    ccApplyStlPoolPromoColVisibility_({ free: false, discount: false, fixedPrice: false });
    const promoBox = document.getElementById("cc_stl_promo_summary");
    if (promoBox) {
      promoBox.style.display = "none";
      promoBox.innerHTML = "";
    }
    ccRenderSettlementSummary_();
    ccRenderSettlementConflictPicks_();
    return;
  }

  if (body) body.innerHTML = '<tr><td colspan="' + ccStlPoolTableColspan_() + '" class="text-muted">載入中…</td></tr>';
  const histBody = document.getElementById("cc_stl_history_tbody");
  if (histBody) histBody.innerHTML = '<tr><td colspan="6" class="text-muted">載入中…</td></tr>';
  try {
    ccStlCaseMeta_ = (await ccEnsureEnrichedCase_(id, { force: true })) || null;
    const customerId = String(ccStlCaseMeta_?.customer_id || "").trim().toUpperCase();
    const lockedRebatePeriods = await ccLoadLockedDealerRebateMonths_(customerId);
    const poolAndStl = await Promise.all([ccListPool_(id), ccListSettlements_(id), ccSettlementLoadPromos_(id)]);
    ccStlPoolItems_ = poolAndStl[0] || [];
    ccRenderSettlementSummary_();
    ccRenderSettlementPool_();
    ccRenderHistoryTableHtml_(poolAndStl[1], [], "cc_stl_history_tbody", {
      kindFilter: "settle",
      settleDetail: true,
      lockedRebatePeriods: lockedRebatePeriods
    });
    ccApplySettlementPermissions_();
  } catch (_e) {
    if (body) body.innerHTML = '<tr><td colspan="' + ccStlPoolTableColspan_() + '" class="text-muted">載入失敗</td></tr>';
    if (histBody) histBody.innerHTML = '<tr><td colspan="6" class="text-muted">載入失敗</td></tr>';
  }
}

async function ccSettlementReload_(opts) {
  const o = opts || {};
  await ccLoadMasterData_();
  let preset = "";
  if (o.keepSelection) {
    preset = String(document.getElementById("cc_stl_case_id")?.value || "").trim().toUpperCase();
  } else {
    try {
      preset = String(sessionStorage.getItem("erp_consignment_stl_preset") || "").trim().toUpperCase();
      if (preset) sessionStorage.removeItem("erp_consignment_stl_preset");
    } catch (_e) {}
  }

  await ccPopulateCaseDropdown_("cc_stl_case_id", {
    status: "ALL",
    defaultEmpty: !preset,
    selectedId: preset
  });

  const caseId = String(document.getElementById("cc_stl_case_id")?.value || "").trim().toUpperCase();
  await ccSettlementLoadCase_(caseId);
}

function ccCollectSettlementItems_() {
  const inputs = document.querySelectorAll("#cc_stl_pool_tbody .cc-stl-qty");
  const items = [];
  inputs.forEach(function (inp) {
    const poolId = String(inp.getAttribute("data-pool-id") || "").trim().toUpperCase();
    const maxQty = Number(inp.getAttribute("data-max") || 0);
    const qty = Number(inp.value || 0);
    if (poolId && qty > 1e-9) {
      items.push({ pool_item_id: poolId, settle_qty: qty, _max_qty: maxQty });
    }
  });
  return items;
}

function ccValidateSettlementItems_(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = Number(it.settle_qty || 0);
    const maxQty = Number(it._max_qty != null ? it._max_qty : 0);
    if (qty > maxQty + 1e-9) {
      const pool = (ccStlPoolItems_ || []).find(function (p) {
        return String(p.pool_item_id || "").trim().toUpperCase() === String(it.pool_item_id || "").trim().toUpperCase();
      });
      const label = pool ? ccProductName_(pool.product_id) : it.pool_item_id;
      const fl = pool && (pool.factory_lot || pool.lot_id) ? " " + String(pool.factory_lot || pool.lot_id).trim() : "";
      return "「" + label + fl + "」結算量 " + qty + " 超過可結算（最多 " + maxQty + "）";
    }
  }
  return "";
}

function ccSettlementPreviewAmountMismatch_(localPreview, serverPreview) {
  const a = Number(localPreview && localPreview.amount_system != null ? localPreview.amount_system : 0);
  const b = Number(serverPreview && serverPreview.amount_system != null ? serverPreview.amount_system : 0);
  return Math.abs(a - b) > 0.009;
}

function ccBuildSettlementConfirmText_(preview, opts) {
  const o = opts || {};
  const lines = preview?.lines || [];
  const parts = lines.map(function (ln) {
    const pool = (ccStlPoolItems_ || []).find(function (p) {
      return String(p.pool_item_id || "").trim().toUpperCase() === String(ln.pool_item_id || "").trim().toUpperCase();
    });
    const pname = pool ? ccProductName_(pool.product_id) : ln.pool_item_id;
    let row =
      "· " +
      pname +
      " 賣出 " +
      ln.settle_qty +
      "，計價 " +
      ln.billable_qty +
      "，小計 " +
      ccFmtMoney_(ln.amount);
    if (Number(ln.free_qty || 0) > 0) row += "（贈 " + ln.free_qty + "）";
    return row;
  });
  let tail = "\n\n若誤結算且 AR 未收款，可在結算歷史作廢。";
  if (o.differsFromScreen) {
    tail = "\n\n※ 與畫面預覽不同，請以本確認金額為準（伺服器試算）。" + tail;
  }
  return (
    "確定提交結算？\n\n" +
    parts.join("\n") +
    "\n\nAR 原始金額合計：" +
    ccFmtMoney_(preview.amount_system) +
    tail
  );
}

async function ccSettlementSubmit_(triggerEl) {
  if (!ccCanOperate_()) return showToast("您沒有權限結算", "error");

  const caseId = String(document.getElementById("cc_stl_case_id")?.value || "").trim().toUpperCase();
  const settlementDate = String(document.getElementById("cc_stl_date")?.value || "").trim();
  const remark = String(document.getElementById("cc_stl_remark")?.value || "").trim();

  if (!caseId) return showToast("請選擇寄賣案", "error");
  if (!settlementDate) return showToast("請填結算日", "error");

  const items = ccCollectSettlementItems_();
  if (!items.length) return showToast("請至少填一筆結算量（未售剩餘 > 0 的品項）", "error");

  const validateMsg = ccValidateSettlementItems_(items);
  if (validateMsg) {
    showToast(validateMsg, "error", 8000);
    if (caseId) {
      try {
        await ccSettlementLoadCase_(caseId);
      } catch (_e) {}
    }
    return;
  }

  const payloadItems = items.map(function (it) {
    return { pool_item_id: it.pool_item_id, settle_qty: it.settle_qty };
  });
  const promoOverrides =
    Object.keys(ccStlPromoOverrides_ || {}).length > 0 ? JSON.stringify(ccStlPromoOverrides_) : "";

  if (triggerEl) triggerEl.disabled = true;
  try {
    const serverPreview = await ccPreviewSettlementPromo_(
      {
        case_id: caseId,
        settlement_date: settlementDate,
        items_json: JSON.stringify(payloadItems),
        promo_overrides_json: promoOverrides,
        created_by: getCurrentUser()
      },
      { silent: true }
    );
    const localPreview = ccSettlementGetPreview_();
    const confirmOpts = {};
    if (ccSettlementPreviewAmountMismatch_(localPreview, serverPreview)) {
      confirmOpts.differsFromScreen = true;
    }
    const confirmText = ccBuildSettlementConfirmText_(serverPreview, confirmOpts);
    const okConfirm = window.erpConfirmActionKey_
      ? window.erpConfirmActionKey_("confirm.consignment.settlement", { fallback: confirmText })
      : window.confirm(confirmText);
    if (!okConfirm) return;

    if (!ccStlIdempotencyKey_) ccStlIdempotencyKey_ = ccNewDocId_("CS");
    const r = await ccPostSettlement_(
      {
        settlement_id: ccStlIdempotencyKey_,
        case_id: caseId,
        settlement_date: settlementDate,
        remark: remark,
        items_json: JSON.stringify(payloadItems),
        promo_overrides_json: promoOverrides,
        created_by: getCurrentUser()
      },
      { silent: true }
    );
    const stlId = String(r?.settlement_id || "").trim();
    const arId = String(r?.ar_id || "").trim();
    const dealerCredit = Number(r?.dealer_credit_applied || 0);
    const creditWarn = String(r?.dealer_credit_warning || "").trim();
    const creditInfo = String(r?.dealer_credit_info || "").trim();
    let toastMsg = "結算完成" + (stlId ? "：" + stlId : "") + (arId ? " → AR " + arId : "");
    if (dealerCredit > 1e-9) toastMsg += "；經銷折抵 " + ccFmtMoney_(dealerCredit);
    if (creditInfo) toastMsg += "（" + creditInfo + "）";
    if (creditWarn) toastMsg += "（經銷折抵未套用：" + creditWarn + "）";
    showToast(toastMsg, creditWarn ? "warning" : creditInfo ? "info" : "success", creditWarn ? 9000 : creditInfo ? 8000 : 6000);
    ccStlIdempotencyKey_ = "";
    ccInvalidateEnrichedCase_(caseId);
    await ccSettlementReload_({ keepSelection: true });
  } catch (err) {
    const msg =
      typeof formatCallApiUserMessage_ === "function"
        ? formatCallApiUserMessage_(err)
        : String((err && err.message) || err || "結算失敗");
    showToast(msg, "error", 8000);
    if (caseId) {
      try {
        await ccSettlementLoadCase_(caseId);
      } catch (_reloadErr) {}
    }
  } finally {
    ccApplySettlementPermissions_();
  }
}

async function consignmentSettlementInit() {
  ccApplySettlementPermissions_();
  ccApplyStlPoolPromoColVisibility_({ free: false, discount: false, fixedPrice: false });
  await ccLoadMasterData_();

  const dt = document.getElementById("cc_stl_date");
  if (dt && !dt.value) dt.value = ccTodayYmd_();
  if (dt && !dt.dataset.boundPromo) {
    dt.dataset.boundPromo = "1";
    dt.addEventListener("change", function () {
      const caseId = String(document.getElementById("cc_stl_case_id")?.value || "").trim().toUpperCase();
      ccSettlementLoadPromos_(caseId).then(function () {
        ccRenderSettlementSummary_();
        ccRenderSettlementPool_();
      });
    });
  }

  ccBindCaseSelectChange_("cc_stl_case_id", function (id) {
    ccSettlementLoadCase_(id);
  });

  await ccSettlementReload_();
}

function ccNavDealerRebate_() {
  const meta = ccStlCaseMeta_;
  const custId = String(meta && meta.customer_id || "").trim().toUpperCase();
  navigate("dealer_rebate");
  if (!custId) return;
  setTimeout(function () {
    const sel = document.getElementById("dr_rebate_customer_id");
    if (sel) {
      sel.value = custId;
      if (typeof drRebateOnCustomerChange_ === "function") drRebateOnCustomerChange_();
    }
  }, 400);
}
