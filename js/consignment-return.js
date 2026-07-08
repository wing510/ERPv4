/*********************************
 * Consignment 寄賣 · 收回 v4.2.2
 *********************************/

var ccRetCaseMeta_ = null;
var ccRetPoolItems_ = [];
var ccRetRequiresRemark_ = false;
var ccRetLineSeq_ = 0;
var ccRetIdempotencyKey_ = "";

var CC_RET_POOL_OPT_PREFIX_ = "__PI__::";

function ccApplyReturnPermissions_() {
  const ok = ccCanOperate_();
  const btn = document.getElementById("cc_ret_post_btn");
  if (btn) btn.disabled = !ok;
}

function ccReturnWarehouseOptionsHtml_(selectedId) {
  const selId = String(selectedId || "").trim();
  const rows = Object.values(ccWarehouses_ || {}).slice();
  rows.sort(function (a, b) {
    return String(a.warehouse_name || a.warehouse_id || "").localeCompare(String(b.warehouse_name || b.warehouse_id || ""));
  });
  return (
    '<option value="">請選擇</option>' +
    rows
      .map(function (w) {
        const id = String(w.warehouse_id || "").trim();
        const name = ccWarehouseName_(id);
        return (
          '<option value="' +
          ccEsc_(id) +
          '"' +
          (id === selId ? " selected" : "") +
          ">" +
          ccEsc_(name) +
          "</option>"
        );
      })
      .join("")
  );
}

function ccReturnDefaultWarehouseId_() {
  const main = Object.values(ccWarehouses_ || {}).find(function (w) {
    return String(w.warehouse_id || "").trim().toUpperCase() === "MAIN";
  });
  return main ? String(main.warehouse_id || "").trim() : "";
}

function ccReturnFirstWarehouseId_() {
  const sels = document.querySelectorAll("#cc_ret_lines_tbody .cc-ret-warehouse");
  for (let i = 0; i < sels.length; i++) {
    const v = String(sels[i].value || "").trim();
    if (v) return v;
  }
  return "";
}

function ccReturnSyncWarehouseSelects_(warehouseId, skipEl) {
  const v = String(warehouseId || "").trim();
  document.querySelectorAll("#cc_ret_lines_tbody .cc-ret-warehouse").forEach(function (sel) {
    if (skipEl && sel === skipEl) return;
    if (v) sel.value = v;
  });
}

function ccReturnOnWarehouseChange_(sel) {
  ccReturnSyncWarehouseSelects_(String(sel?.value || "").trim(), null);
  ccReturnClearPreview_();
  ccReturnRefreshAllLineWarehouseVisual_();
}

function ccReturnLineWarehouseChanged_(tr) {
  if (!tr) return false;
  const whSel = tr.querySelector(".cc-ret-warehouse");
  const returnWh = String(whSel?.value || "").trim().toUpperCase();
  const lotVal = String(tr.querySelector(".cc-ret-lot")?.value || "").trim();
  if (!returnWh || !lotVal) return false;
  const shipWh = ccReturnPoolShipWarehouse_(ccReturnParseLotOptionValue_(lotVal));
  return !!(shipWh && returnWh !== shipWh);
}

function ccReturnRefreshLineWarehouseVisual_(tr) {
  if (!tr) return;
  const whSel = tr.querySelector(".cc-ret-warehouse");
  if (!whSel) return;
  const changed = ccReturnLineWarehouseChanged_(tr);
  whSel.style.borderColor = changed ? "#dc2626" : "";
  whSel.style.boxShadow = changed ? "0 0 0 1px #dc2626" : "";
  let hint = tr.querySelector(".cc-ret-wh-hint");
  if (changed) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "cc-ret-wh-hint";
      hint.style.cssText = "font-size:11px;color:#dc2626;margin-top:4px;line-height:1.3;";
      whSel.parentElement.appendChild(hint);
    }
    hint.textContent = "改倉說明必填";
    hint.style.display = "";
  } else if (hint) {
    hint.style.display = "none";
  }
}

function ccReturnRefreshAllLineWarehouseVisual_() {
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    ccReturnRefreshLineWarehouseVisual_(tr);
  });
  ccReturnSyncNoteFieldGroups_();
}

function ccReturnPoolShipWarehouse_(parsed) {
  const pools = ccRetPoolItems_ || [];
  const pid = String(parsed.pool_item_id || "").trim().toUpperCase();
  if (pid) {
    const hit = pools.find(function (it) {
      return String(it.pool_item_id || "").trim().toUpperCase() === pid;
    });
    return String(hit && hit.warehouse_id != null ? hit.warehouse_id : "")
      .trim()
      .toUpperCase();
  }
  const fl = String(parsed.factory_lot || "").trim().toUpperCase();
  const prodId = String(parsed.product_id || "").trim();
  if (!fl) return "";
  const hit = pools.find(function (it) {
    return (
      String(it.factory_lot || "").trim().toUpperCase() === fl &&
      (!prodId || String(it.product_id || "").trim() === prodId)
    );
  });
  return String(hit && hit.warehouse_id != null ? hit.warehouse_id : "")
    .trim()
    .toUpperCase();
}

function ccReturnDetectWarehouseChange_() {
  const returnWh = String(ccReturnFirstWarehouseId_() || "").trim().toUpperCase();
  if (!returnWh) return false;
  let changed = false;
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    if (changed) return;
    const qty = Number(tr.querySelector(".cc-ret-qty")?.value || 0);
    if (!(qty > 1e-9)) return;
    const lotVal = String(tr.querySelector(".cc-ret-lot")?.value || "").trim();
    const shipWh = ccReturnPoolShipWarehouse_(ccReturnParseLotOptionValue_(lotVal));
    if (shipWh && returnWh !== shipWh) changed = true;
  });
  return changed;
}

function ccReturnSyncNoteFieldGroups_() {
  const reason = String(document.getElementById("cc_ret_reason")?.value || "").trim();
  const otherGrp = document.getElementById("cc_ret_other_note_group");
  const whGrp = document.getElementById("cc_ret_wh_change_note_group");
  if (otherGrp) otherGrp.style.display = reason === "OTHER" ? "" : "none";
  const whNeed = ccRetRequiresRemark_ || ccReturnDetectWarehouseChange_();
  if (whGrp) whGrp.style.display = whNeed ? "" : "none";
}

function ccReturnRefreshLineWarehouseDropdowns_() {
  const preset = ccReturnFirstWarehouseId_() || ccReturnDefaultWarehouseId_();
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    const whSel = tr.querySelector(".cc-ret-warehouse");
    if (!whSel || whSel.tagName !== "SELECT") return;
    const cur = String(whSel.value || "").trim() || preset;
    whSel.innerHTML = ccReturnWarehouseOptionsHtml_(cur);
    whSel.value = cur;
  });
  ccReturnRefreshAllLineWarehouseVisual_();
}

function ccReturnPoolItemOptionValue_(poolItemId) {
  const pid = String(poolItemId || "").trim().toUpperCase();
  if (!pid) return "";
  return CC_RET_POOL_OPT_PREFIX_ + pid;
}

/** 舊版 Lot::產品 value → 對應第一筆可收回池子（出貨日最早） */
function ccReturnLegacyLotToPoolItemId_(parsed) {
  const fl = String(parsed && parsed.factory_lot || "").trim().toUpperCase();
  const prodId = String(parsed && parsed.product_id || "").trim();
  if (!fl) return "";
  const matches = (ccRetPoolItems_ || []).filter(function (it) {
    const avail = Number(it.unsold_qty != null ? it.unsold_qty : it.remaining_qty || 0);
    if (avail <= 1e-9) return false;
    if (String(it.factory_lot || "").trim().toUpperCase() !== fl) return false;
    if (prodId && String(it.product_id || "").trim() !== prodId) return false;
    return true;
  });
  matches.sort(function (a, b) {
    const da = String(a.ship_date || "");
    const db = String(b.ship_date || "");
    if (da !== db) return da.localeCompare(db);
    return String(a.pool_item_id || "").localeCompare(String(b.pool_item_id || ""));
  });
  const hit = matches[0];
  return hit ? String(hit.pool_item_id || "").trim().toUpperCase() : "";
}

function ccReturnNormalizeLotOptionValue_(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const parsed = ccReturnParseLotOptionValue_(s);
  if (parsed.pool_item_id) return ccReturnPoolItemOptionValue_(parsed.pool_item_id);
  const legacyPid = ccReturnLegacyLotToPoolItemId_(parsed);
  return legacyPid ? ccReturnPoolItemOptionValue_(legacyPid) : s;
}

function ccReturnParseLotOptionValue_(raw) {
  const s = String(raw || "").trim();
  if (!s) return { factory_lot: "", product_id: "", pool_item_id: "" };
  if (s.toUpperCase().indexOf(CC_RET_POOL_OPT_PREFIX_) === 0) {
    return {
      pool_item_id: s.slice(CC_RET_POOL_OPT_PREFIX_.length).trim().toUpperCase(),
      factory_lot: "",
      product_id: ""
    };
  }
  const i = s.indexOf("::");
  if (i < 0) return { factory_lot: s.toUpperCase(), product_id: "", pool_item_id: "" };
  return {
    factory_lot: s.slice(0, i).trim().toUpperCase(),
    product_id: s.slice(i + 2).trim(),
    pool_item_id: ""
  };
}

function ccReturnFormatLotDropdownLabel_(g) {
  const prod = ccProductName_(g.product_id);
  const fl = String(g.factory_lot || g.lot_id || "").trim() || "—";
  const unsoldStr = String(Math.round(Number(g.unsold || 0) * 1000) / 1000);
  const wh = ccWarehouseName_(g.warehouse_id);
  const shipDate = String(g.ship_date || "").trim() || "—";
  const price = Number(g.unit_price || 0);
  const priceStr = price > 0 ? " | 經銷價：" + ccFmtMoney_(price) : "";
  return prod + " | " + fl + " | 未售：" + unsoldStr + priceStr + " | 出貨倉：" + wh + " | 出貨日" + shipDate;
}

function ccReturnLineOptionsHtml_(selected) {
  const selRaw = String(selected || "").trim();
  const selNorm = ccReturnNormalizeLotOptionValue_(selRaw);
  const selParsed = ccReturnParseLotOptionValue_(selNorm || selRaw);
  const selPoolId = String(selParsed.pool_item_id || "").trim().toUpperCase();
  const list = (ccRetPoolItems_ || [])
    .map(function (it) {
      const poolId = String(it.pool_item_id || "").trim().toUpperCase();
      if (!poolId) return null;
      const avail = Number(it.unsold_qty != null ? it.unsold_qty : it.remaining_qty || 0);
      if (avail <= 1e-9) return null;
      return {
        pool_item_id: poolId,
        product_id: String(it.product_id || "").trim(),
        factory_lot: String(it.factory_lot || "").trim().toUpperCase(),
        lot_id: String(it.lot_id || "").trim().toUpperCase(),
        warehouse_id: String(it.warehouse_id || "MAIN").trim().toUpperCase(),
        unit_price: Number(it.unit_price || 0),
        ship_date: String(it.ship_date || "").trim(),
        unsold: avail
      };
    })
    .filter(Boolean)
    .sort(function (a, b) {
      const pa = ccProductName_(a.product_id);
      const pb = ccProductName_(b.product_id);
      if (pa !== pb) return pa.localeCompare(pb);
      const fla = String(a.factory_lot || a.lot_id || "");
      const flb = String(b.factory_lot || b.lot_id || "");
      if (fla !== flb) return fla.localeCompare(flb);
      if (a.warehouse_id !== b.warehouse_id) return a.warehouse_id.localeCompare(b.warehouse_id);
      const da = String(a.ship_date || "");
      const db = String(b.ship_date || "");
      if (da !== db) return da.localeCompare(db);
      if (Number(a.unit_price || 0) !== Number(b.unit_price || 0)) {
        return Number(a.unit_price || 0) - Number(b.unit_price || 0);
      }
      return a.pool_item_id.localeCompare(b.pool_item_id);
    });
  if (!list.length) {
    const caseId = String(document.getElementById("cc_ret_case_id")?.value || "").trim();
    if (!caseId) return '<option value="">請先選寄賣案</option>';
    return '<option value="">尚無可收回品項（請確認品項池）</option>';
  }
  let html = '<option value="">請選擇</option>';
  list.forEach(function (g) {
    const optVal = ccReturnPoolItemOptionValue_(g.pool_item_id);
    const unsoldStr = String(Math.round(g.unsold * 1000) / 1000);
    const label = ccReturnFormatLotDropdownLabel_(g);
    const picked = selNorm === optVal || selRaw === optVal || selPoolId === g.pool_item_id;
    html +=
      '<option value="' +
      ccEsc_(optVal) +
      '" data-max="' +
      ccEsc_(String(unsoldStr)) +
      '"' +
      (picked ? " selected" : "") +
      ">" +
      ccEsc_(label) +
      "</option>";
  });
  return html;
}

function ccReturnFactoryLotOptionsHtml_(selected) {
  return ccReturnLineOptionsHtml_(selected);
}

function ccReturnLineAllocKey_(parsed) {
  const p = parsed || {};
  const pid = String(p.pool_item_id || "").trim().toUpperCase();
  if (pid) return "PI:" + pid;
  const fl = String(p.factory_lot || "").trim().toUpperCase();
  const prod = String(p.product_id || "").trim();
  if (fl) return "LOT:" + fl + "::" + prod;
  return "";
}

function ccReturnMaxQtyForAllocKey_(key) {
  if (!key) return 0;
  if (key.indexOf("PI:") === 0) {
    const pid = key.slice(3);
    const hit = (ccRetPoolItems_ || []).find(function (it) {
      return String(it.pool_item_id || "").trim().toUpperCase() === pid;
    });
    if (!hit) return 0;
    return Number(hit.unsold_qty != null ? hit.unsold_qty : hit.remaining_qty || 0);
  }
  if (key.indexOf("LOT:") === 0) {
    const rest = key.slice(4);
    const i = rest.indexOf("::");
    const fl = i >= 0 ? rest.slice(0, i) : rest;
    const prod = i >= 0 ? rest.slice(i + 2) : "";
    let sum = 0;
    (ccRetPoolItems_ || []).forEach(function (it) {
      if (String(it.factory_lot || "").trim().toUpperCase() !== fl) return;
      if (prod && String(it.product_id || "").trim() !== prod) return;
      const avail = Number(it.unsold_qty != null ? it.unsold_qty : it.remaining_qty || 0);
      if (avail > 1e-9) sum += avail;
    });
    return sum;
  }
  return 0;
}

function ccReturnAllocKeyLabel_(key) {
  if (!key) return "此品項";
  if (key.indexOf("PI:") === 0) {
    const pid = key.slice(3);
    const hit = (ccRetPoolItems_ || []).find(function (it) {
      return String(it.pool_item_id || "").trim().toUpperCase() === pid;
    });
    if (hit) {
      const fl = String(hit.factory_lot || hit.lot_id || "").trim() || pid;
      return ccProductName_(hit.product_id) + " " + fl;
    }
    return pid;
  }
  if (key.indexOf("LOT:") === 0) {
    const rest = key.slice(4);
    const i = rest.indexOf("::");
    const fl = i >= 0 ? rest.slice(0, i) : rest;
    const prod = i >= 0 ? rest.slice(i + 2) : "";
    return (prod ? ccProductName_(prod) + " " : "") + fl;
  }
  return "此品項";
}

function ccReturnBuildAllocQtyTotals_() {
  const totals = {};
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    const lotVal = String(tr.querySelector(".cc-ret-lot")?.value || "").trim();
    const key = ccReturnLineAllocKey_(ccReturnParseLotOptionValue_(lotVal));
    const qty = Number(tr.querySelector(".cc-ret-qty")?.value || 0);
    if (!key || !(qty > 1e-9)) return;
    totals[key] = (totals[key] || 0) + qty;
  });
  return totals;
}

function ccReturnAggregateQtyError_() {
  const totals = ccReturnBuildAllocQtyTotals_();
  const keys = Object.keys(totals);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const max = ccReturnMaxQtyForAllocKey_(key);
    const sum = totals[key];
    if (max > 0 && sum > max + 1e-9) {
      return (
        "「" +
        ccReturnAllocKeyLabel_(key) +
        "」多行加總收回 " +
        sum +
        "，超過未售（最多 " +
        max +
        "）"
      );
    }
  }
  return "";
}

function ccReturnSelectedLineMaxQty_(tr) {
  const lotSel = tr && tr.querySelector ? tr.querySelector(".cc-ret-lot") : null;
  if (!lotSel || lotSel.selectedIndex < 0) return 0;
  const opt = lotSel.options[lotSel.selectedIndex];
  const val = String(opt && opt.value || "").trim();
  if (!val) return 0;
  const max = Number(opt.getAttribute("data-max") || 0);
  return Number.isFinite(max) && max > 0 ? max : 0;
}

function ccReturnSyncLineQtyMax_(tr) {
  if (!tr) return;
  const qtyEl = tr.querySelector(".cc-ret-qty");
  if (!qtyEl) return;
  const max = ccReturnSelectedLineMaxQty_(tr);
  qtyEl.min = "0";
  qtyEl.step = "0.001";
  qtyEl.removeAttribute("max");
  if (max > 0) {
    qtyEl.title = "未售最多 " + max;
  } else {
    qtyEl.removeAttribute("title");
  }
  ccReturnRefreshLineQtyVisual_(tr);
}

function ccReturnLineQtyOverMsg_(tr, rowIndex) {
  const max = ccReturnSelectedLineMaxQty_(tr);
  const qty = Number(tr.querySelector(".cc-ret-qty")?.value || 0);
  if (!(qty > 1e-9) || max <= 0 || qty <= max + 1e-9) return "";
  const n = rowIndex != null && rowIndex >= 0 ? rowIndex + 1 : 0;
  return (n ? "第 " + n + " 筆：" : "") + "收回數量不可超過未售（最多 " + max + "）";
}

function ccReturnRefreshLineQtyVisual_(tr, totals) {
  if (!tr) return;
  const qtyEl = tr.querySelector(".cc-ret-qty");
  if (!qtyEl) return;
  const lineMax = ccReturnSelectedLineMaxQty_(tr);
  const v = Number(qtyEl.value || 0);
  const lotVal = String(tr.querySelector(".cc-ret-lot")?.value || "").trim();
  const key = ccReturnLineAllocKey_(ccReturnParseLotOptionValue_(lotVal));
  const allocTotals = totals || ccReturnBuildAllocQtyTotals_();
  const poolMax = key ? ccReturnMaxQtyForAllocKey_(key) : 0;
  const sumKey = key ? Number(allocTotals[key] || 0) : 0;
  const perLineOver = lineMax > 0 && v > lineMax + 1e-9;
  const aggOver = key && poolMax > 0 && sumKey > poolMax + 1e-9 && v > 1e-9;
  const over = perLineOver || aggOver;
  qtyEl.style.borderColor = over ? "#dc2626" : "";
  qtyEl.style.boxShadow = over ? "0 0 0 1px #dc2626" : "";
  let hint = tr.querySelector(".cc-ret-qty-hint");
  if (over) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "cc-ret-qty-hint";
      hint.style.cssText = "font-size:11px;color:#dc2626;margin-top:4px;line-height:1.3;";
      qtyEl.parentElement.appendChild(hint);
    }
    if (aggOver) {
      hint.textContent = "多行加總超過未售（最多 " + poolMax + "，已填 " + sumKey + "）";
    } else {
      hint.textContent = "超過未售（最多 " + lineMax + "）";
    }
    hint.style.display = "";
  } else if (hint) {
    hint.style.display = "none";
  }
}

function ccReturnRefreshAllLineQtyVisual_() {
  const totals = ccReturnBuildAllocQtyTotals_();
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    ccReturnRefreshLineQtyVisual_(tr, totals);
  });
}

function ccReturnOnLineQtyChange_(tr, toastIfOver) {
  ccReturnRefreshAllLineQtyVisual_();
  if (toastIfOver) {
    const rows = Array.from(document.querySelectorAll("#cc_ret_lines_tbody tr"));
    const idx = rows.indexOf(tr);
    let msg = ccReturnLineQtyOverMsg_(tr, idx);
    if (!msg) msg = ccReturnAggregateQtyError_();
    if (msg && typeof showToast === "function") showToast(msg, "error", 4500);
  }
  ccReturnClearPreview_();
}

function ccReturnSyncAllLineQtyMax_() {
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    ccReturnSyncLineQtyMax_(tr);
  });
  ccReturnRefreshAllLineQtyVisual_();
}

function ccValidateReturnLineQtys_() {
  const rows = document.querySelectorAll("#cc_ret_lines_tbody tr");
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const lotSel = tr.querySelector(".cc-ret-lot");
    const lotVal = String(lotSel?.value || "").trim();
    const qty = Number(tr.querySelector(".cc-ret-qty")?.value || 0);
    if (!(qty > 1e-9)) continue;
    if (!lotVal) return "第 " + (i + 1) + " 筆：請先選擇加工廠 Lot";
    const max = ccReturnSelectedLineMaxQty_(tr);
    if (max > 0 && qty > max + 1e-9) {
      return "第 " + (i + 1) + " 筆：收回數量不可超過未售（最多 " + max + "）";
    }
  }
  const aggErr = ccReturnAggregateQtyError_();
  if (aggErr) return aggErr;
  return "";
}

function ccReturnRefreshLineLotDropdowns_() {
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    const lotSel = tr.querySelector(".cc-ret-lot");
    if (!lotSel || lotSel.tagName !== "SELECT") return;
    const cur = ccReturnNormalizeLotOptionValue_(lotSel.value);
    lotSel.innerHTML = ccReturnFactoryLotOptionsHtml_(cur);
    if (cur && Array.from(lotSel.options || []).some(function (o) { return String(o.value || "") === cur; })) {
      lotSel.value = cur;
    }
    ccReturnSyncLineQtyMax_(tr);
  });
  ccReturnRefreshAllLineQtyVisual_();
  ccReturnRefreshAllLineWarehouseVisual_();
}

function ccReturnClearPreview_() {
  ccRetRequiresRemark_ = false;
  ccReturnSyncNoteFieldGroups_();
}

function ccReturnApplyPreviewPlan_(plan) {
  ccRetRequiresRemark_ = !!(plan && plan.requires_remark);
  ccReturnSyncNoteFieldGroups_();
}

function ccReturnValidateNotes_(header, requiresWarehouseRemark) {
  if (String(header.return_reason || "").trim() === "OTHER" && !String(header.other_reason_note || "").trim()) {
    return "請填寫其他原因說明";
  }
  if (requiresWarehouseRemark && !String(header.warehouse_change_note || "").trim()) {
    return "退回倉庫與原出貨倉不同，請填寫改倉說明";
  }
  return "";
}

function ccReturnResolveProductId_(parsed) {
  const p = parsed || {};
  const fromOpt = String(p.product_id || "").trim();
  if (fromOpt) return fromOpt;
  const poolItemId = String(p.pool_item_id || "").trim().toUpperCase();
  if (!poolItemId) return "";
  const hit = (ccRetPoolItems_ || []).find(function (it) {
    return String(it.pool_item_id || "").trim().toUpperCase() === poolItemId;
  });
  return String(hit && hit.product_id != null ? hit.product_id : "").trim();
}

function ccReturnAddLine_(presetPoolItemId, qty) {
  const body = document.getElementById("cc_ret_lines_tbody");
  if (!body) return;
  const presetWh = ccReturnFirstWarehouseId_() || ccReturnDefaultWarehouseId_();
  const presetLotVal = presetPoolItemId
    ? ccReturnNormalizeLotOptionValue_(ccReturnPoolItemOptionValue_(presetPoolItemId))
    : "";
  ccRetLineSeq_ += 1;
  const rowId = "cc_ret_line_" + ccRetLineSeq_;
  const tr = document.createElement("tr");
  tr.id = rowId;
  tr.innerHTML =
    '<td><select class="cc-ret-lot" style="min-width:280px;max-width:100%;">' +
    ccReturnFactoryLotOptionsHtml_(presetLotVal) +
    "</select></td>" +
    '<td><input type="number" class="cc-ret-qty" min="0" step="0.001" value="' +
    ccEsc_(qty != null ? String(qty) : "") +
    '" style="width:100px;"></td>' +
    '<td><select class="cc-ret-warehouse" style="min-width:120px;">' +
    ccReturnWarehouseOptionsHtml_(presetWh) +
    "</select></td>" +
    '<td><button class="btn-secondary btn-sm" type="button" onclick="ccReturnRemoveLine_(\'' +
    rowId +
    "')\">刪除</button></td>";
  body.appendChild(tr);
  const lotSel = tr.querySelector(".cc-ret-lot");
  const qtyEl = tr.querySelector(".cc-ret-qty");
  const whSel = tr.querySelector(".cc-ret-warehouse");
  if (lotSel) {
    lotSel.addEventListener("change", function () {
      ccReturnSyncAllLineQtyMax_();
      ccReturnRefreshAllLineWarehouseVisual_();
      ccReturnClearPreview_();
    });
  }
  if (qtyEl) {
    qtyEl.addEventListener("change", function () {
      ccReturnOnLineQtyChange_(tr, true);
    });
    qtyEl.addEventListener("input", function () {
      ccReturnOnLineQtyChange_(tr, false);
    });
  }
  if (whSel) {
    if (presetWh) whSel.value = presetWh;
    whSel.addEventListener("change", function () {
      ccReturnOnWarehouseChange_(whSel);
    });
  }
  if (presetLotVal && lotSel) {
    if (Array.from(lotSel.options || []).some(function (o) { return String(o.value || "") === presetLotVal; })) {
      lotSel.value = presetLotVal;
    }
  }
  ccReturnSyncLineQtyMax_(tr);
  ccReturnRefreshAllLineQtyVisual_();
  ccReturnRefreshLineWarehouseVisual_(tr);
  ccReturnClearPreview_();
}

function ccReturnRemoveLine_(rowId) {
  const tr = document.getElementById(rowId);
  if (tr) tr.remove();
  ccReturnRefreshAllLineQtyVisual_();
  ccReturnRefreshAllLineWarehouseVisual_();
  ccReturnClearPreview_();
}

function ccCollectReturnItems_() {
  const items = [];
  document.querySelectorAll("#cc_ret_lines_tbody tr").forEach(function (tr) {
    const lotSel = tr.querySelector(".cc-ret-lot");
    const lotVal = String(lotSel?.value || "").trim();
    const parsed = ccReturnParseLotOptionValue_(lotVal);
    const factoryLot = parsed.factory_lot;
    const poolItemId = parsed.pool_item_id;
    const productId = ccReturnResolveProductId_(parsed);
    const returnQty = Number(tr.querySelector(".cc-ret-qty")?.value || 0);
    if (poolItemId && returnQty > 1e-9) {
      items.push({ pool_item_id: poolItemId, return_qty: returnQty });
    } else if (factoryLot && returnQty > 1e-9) {
      const row = { factory_lot: factoryLot, return_qty: returnQty };
      if (productId) row.product_id = productId;
      items.push(row);
    }
  });
  return items;
}

function ccCollectReturnHeader_() {
  const otherNote = String(document.getElementById("cc_ret_other_note")?.value || "").trim();
  const whNote = String(document.getElementById("cc_ret_wh_change_note")?.value || "").trim();
  const generalRemark = String(document.getElementById("cc_ret_remark")?.value || "").trim();
  return {
    case_id: String(document.getElementById("cc_ret_case_id")?.value || "").trim().toUpperCase(),
    return_reason: String(document.getElementById("cc_ret_reason")?.value || "").trim(),
    return_date: String(document.getElementById("cc_ret_date")?.value || "").trim(),
    return_warehouse_id: ccReturnFirstWarehouseId_(),
    other_reason_note: otherNote,
    warehouse_change_note: whNote,
    remark: generalRemark,
    remark_for_api: ccBuildReturnRemarkForApi_(otherNote, whNote, generalRemark)
  };
}

function ccValidateReturnForm_(header, items) {
  if (!header.case_id) return "請選擇寄賣案";
  if (!header.return_reason) return "請選擇收回原因";
  if (!header.return_date) return "請填收回日期";
  const remarkErr = ccReturnValidateNotes_(header, false);
  if (remarkErr) return remarkErr;
  if (!header.return_warehouse_id) return "請選擇退回倉庫";
  if (!items.length) return "請至少填一筆收回明細（加工廠 Lot + 數量）";
  const qtyErr = ccValidateReturnLineQtys_();
  if (qtyErr) return qtyErr;
  return "";
}

function ccRenderReturnSummary_() {
  const box = document.getElementById("cc_ret_summary_box");
  if (!box) return;
  const meta = ccRetCaseMeta_;
  if (!meta) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  const closed = String(meta.status || "").trim().toUpperCase() === "CLOSED";
  box.innerHTML = ccBuildCaseSummaryHtml_(meta, { closedReturnHint: true });
  const postBtn = document.getElementById("cc_ret_post_btn");
  if (closed && postBtn) postBtn.disabled = true;
}

async function ccReturnLoadCase_(caseId) {
  const id = String(caseId || "").trim().toUpperCase();
  ccRetCaseMeta_ = null;
  ccRetPoolItems_ = [];
  ccReturnClearPreview_();

  if (!id) {
    ccRenderReturnSummary_();
    ccReturnRefreshLineLotDropdowns_();
    ccReturnRefreshLineWarehouseDropdowns_();
    const hist = document.getElementById("cc_ret_history_tbody");
    if (hist) hist.innerHTML = '<tr><td colspan="6" class="text-muted">請先選擇寄賣案</td></tr>';
    return;
  }

  const histBody = document.getElementById("cc_ret_history_tbody");
  if (histBody) histBody.innerHTML = '<tr><td colspan="6" class="text-muted">載入中…</td></tr>';

  try {
    const [meta, pool, rets] = await Promise.all([
      ccEnsureEnrichedCase_(id),
      ccListPool_(id).catch(function () { return []; }),
      ccListReturns_(id).catch(function () { return []; })
    ]);
    ccRetCaseMeta_ = meta || null;
    ccRetPoolItems_ = pool || [];
    ccRenderReturnSummary_();
    ccReturnRefreshLineLotDropdowns_();
    ccReturnRefreshLineWarehouseDropdowns_();
    ccRenderHistoryTableHtml_([], rets, "cc_ret_history_tbody", {
      kindFilter: "return",
      returnDetail: true
    });
  } catch (_e) {
    ccRenderReturnSummary_();
    ccReturnRefreshLineLotDropdowns_();
    ccReturnRefreshLineWarehouseDropdowns_();
    if (histBody) histBody.innerHTML = '<tr><td colspan="6" class="text-muted">載入失敗</td></tr>';
  }
}

async function ccReturnReload_(opts) {
  const o = opts || {};
  let preset = "";
  if (o.keepSelection) {
    preset = String(document.getElementById("cc_ret_case_id")?.value || "").trim().toUpperCase();
  } else {
    try {
      preset = String(sessionStorage.getItem("erp_consignment_ret_preset") || "").trim().toUpperCase();
      if (preset) sessionStorage.removeItem("erp_consignment_ret_preset");
    } catch (_e) {}
  }
  await ccPopulateCaseDropdown_("cc_ret_case_id", {
    status: "ALL",
    defaultEmpty: !preset,
    selectedId: preset
  });
  const id = String(document.getElementById("cc_ret_case_id")?.value || "").trim().toUpperCase();
  await ccReturnLoadCase_(id);
}

async function ccReturnResetAfterError_() {
  try {
    ccSetActiveCaseId_("");
  } catch (_e) {}
  ccReturnClearPreview_();
  const sel = document.getElementById("cc_ret_case_id");
  if (sel) sel.value = "";
  await ccPopulateCaseDropdown_("cc_ret_case_id", { status: "ALL", defaultEmpty: true });
  const lineBody = document.getElementById("cc_ret_lines_tbody");
  if (lineBody) {
    lineBody.innerHTML = "";
    ccReturnAddLine_();
  }
  await ccReturnLoadCase_("");
}

async function ccReturnPost_(triggerEl) {
  if (!ccCanOperate_()) return showToast("您沒有權限收回", "error");

  const header = ccCollectReturnHeader_();
  const items = ccCollectReturnItems_();
  const err = ccValidateReturnForm_(header, items);
  if (err) return showToast(err, "error");

  if (triggerEl) triggerEl.disabled = true;
  try {
    const previewPayload = {
      case_id: header.case_id,
      return_reason: header.return_reason,
      return_date: header.return_date,
      return_warehouse_id: header.return_warehouse_id,
      remark: header.remark_for_api,
      items_json: JSON.stringify(items),
      created_by: getCurrentUser()
    };
    const plan = await ccPreviewReturn_(previewPayload, { silent: true });
    ccReturnApplyPreviewPlan_(plan);
    const remarkErr = ccReturnValidateNotes_(header, !!(plan && plan.requires_remark));
    if (remarkErr) {
      showToast(remarkErr, "error");
      return;
    }

    const ok = window.erpConfirmActionKey_
      ? window.erpConfirmActionKey_("confirm.consignment.return", {
          fallback: "確定提交收回？\n\n庫存將加回指定倉庫；誤操作可在收回歷史作廢。"
        })
      : window.confirm("確定提交收回？");
    if (!ok) return;

    if (!ccRetIdempotencyKey_) ccRetIdempotencyKey_ = ccNewDocId_("CR");
    const r = await ccPostReturn_(
      {
        return_id: ccRetIdempotencyKey_,
        case_id: header.case_id,
        return_reason: header.return_reason,
        return_date: header.return_date,
        return_warehouse_id: header.return_warehouse_id,
        remark: header.remark_for_api,
        items_json: JSON.stringify(items),
        created_by: getCurrentUser()
      },
      { silent: true }
    );
    const retId = String(r?.return_id || "").trim();
    showToast("收回完成" + (retId ? "：" + retId : ""), "success", 6000);

    ccRetIdempotencyKey_ = "";
    ccReturnClearPreview_();
    document.getElementById("cc_ret_lines_tbody").innerHTML = "";
    ccReturnAddLine_();
    await ccReturnReload_({ keepSelection: true });
  } catch (err) {
    const msg =
      typeof formatCallApiUserMessage_ === "function"
        ? formatCallApiUserMessage_(err)
        : String((err && err.message) || err || "收回失敗");
    showToast(msg, "error", 8000);
    const caseId = String(document.getElementById("cc_ret_case_id")?.value || "").trim().toUpperCase();
    if (caseId) {
      try {
        await ccReturnLoadCase_(caseId);
        ccReturnRefreshAllLineQtyVisual_();
      } catch (_reloadErr) {}
    }
  } finally {
    ccApplyReturnPermissions_();
  }
}

async function consignmentReturnInit() {
  ccApplyReturnPermissions_();
  await ccLoadMasterData_();

  const dt = document.getElementById("cc_ret_date");
  if (dt && !dt.value) dt.value = ccTodayYmd_();

  ccBindCaseSelectChange_("cc_ret_case_id", function (id) {
    ccReturnLoadCase_(id);
    ccReturnClearPreview_();
  });

  ["cc_ret_reason", "cc_ret_date"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el || el.dataset.ccBound === "1") return;
    el.dataset.ccBound = "1";
    el.addEventListener("change", function () {
      if (id === "cc_ret_reason") ccReturnRefreshLineLotDropdowns_();
      ccReturnClearPreview_();
      if (id === "cc_ret_reason") ccReturnSyncNoteFieldGroups_();
    });
    el.addEventListener("input", ccReturnClearPreview_);
  });

  ["cc_ret_other_note", "cc_ret_wh_change_note", "cc_ret_remark"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el || el.dataset.ccBound === "1") return;
    el.dataset.ccBound = "1";
    el.addEventListener("input", ccReturnClearPreview_);
    el.addEventListener("change", ccReturnClearPreview_);
  });

  ccReturnSyncNoteFieldGroups_();

  const lineBody = document.getElementById("cc_ret_lines_tbody");
  if (lineBody && !lineBody.children.length) ccReturnAddLine_();

  await ccReturnReload_();
}
