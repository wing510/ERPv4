/*********************************
 * Commercial 商業方案 · Dealer 經銷（寄賣月結回饋）
 *********************************/

var cdDealerEditing_ = false;
var cdDealerRebateLocked_ = false;
var cdDealerTierSeq_ = 0;
var cdDealerListRows_ = [];
var cdDealerSelectedSchemeId_ = "";
var cdDealerSort_ = { field: "", asc: true };

var CD_DEALER_STATUS_LABELS_ = {
  DRAFT: "草稿",
  ACTIVE: "生效",
  ENDED: "結束"
};

var CD_SCHEME_TYPE_LABELS_ = {
  MONTHLY_REBATE: "月結回饋",
  CUMULATIVE_AMOUNT: "經銷等級"
};

var CD_STAT_SOURCE_LABELS_ = {
  CONSIGNMENT: "寄賣",
  GENERAL: "一般銷售",
  ALL: "寄賣＋一般"
};

function cdDealerStatSourceLabel_(statSource) {
  const s = String(statSource || "CONSIGNMENT").trim().toUpperCase();
  return CD_STAT_SOURCE_LABELS_[s] || s || "—";
}

var CD_DEFAULT_TIERS_ = [
  { amount_from: 0, amount_to: 29999.99, rebate_pct: 0 },
  { amount_from: 30000, amount_to: 99999.99, rebate_pct: 5 },
  { amount_from: 100000, amount_to: 299999.99, rebate_pct: 8 },
  { amount_from: 300000, amount_to: "", rebate_pct: 10 }
];

var CD_DEFAULT_CUMULATIVE_TIERS_ = [
  { tier_label: "一般經銷", amount_from: 0, price_rate: 85 },
  { tier_label: "銀級", amount_from: 300000, price_rate: 82 },
  { tier_label: "金級", amount_from: 1000000, price_rate: 80 },
  { tier_label: "白金", amount_from: 3000000, price_rate: 78 },
  { tier_label: "鑽石", amount_from: 5000000, price_rate: 75 }
];

function cdDealerSchemeTypeLabel_(type) {
  const t = String(type || "").trim().toUpperCase();
  return CD_SCHEME_TYPE_LABELS_[t] || t || "—";
}

function cdDealerGetSchemeType_() {
  const v = String(document.getElementById("cd_dealer_scheme_type")?.value || "").trim().toUpperCase();
  if (v === "CUMULATIVE_AMOUNT") return "CUMULATIVE_AMOUNT";
  if (v === "MONTHLY_REBATE") return "MONTHLY_REBATE";
  return "";
}

function cdDealerIsCumulative_() {
  return cdDealerGetSchemeType_() === "CUMULATIVE_AMOUNT";
}

function cdDealerTierColspan_() {
  const t = cdDealerGetSchemeType_();
  if (!t) return 6;
  return cdDealerIsCumulative_() ? 5 : 4;
}

function cdDealerOnSchemeTypeChange_() {
  if (cdDealerRebateLocked_) return;
  cdDealerApplySchemeTypeUi_();
  if (cdDealerGetSchemeType_()) cdDealerLoadDefaultTiers_();
  else cdDealerClearTierPlaceholder_();
}

function cdDealerClearTierPlaceholder_() {
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (body) {
    body.innerHTML =
      '<tr><td colspan="' + cdDealerTierColspan_() + '" class="text-muted">請先選類型</td></tr>';
  }
}

function cdDealerApplySchemeTypeUi_() {
  const schemeType = cdDealerGetSchemeType_();
  const cumulative = schemeType === "CUMULATIVE_AMOUNT";
  const typeEl = document.getElementById("cd_dealer_scheme_type");
  if (typeEl) typeEl.disabled = !!cdDealerRebateLocked_;

  const title = document.getElementById("cd_dealer_tier_title");
  if (title) {
    if (!schemeType) title.textContent = "級距明細（請先選類型）";
    else {
      title.textContent = cumulative
        ? "級距明細（月結累積 → 經銷價）"
        : "級距明細（月結請款淨額 → 回饋％）";
    }
  }

  document.querySelectorAll(".cd-tier-col-label").forEach(function (el) {
    el.style.display = cumulative ? "" : "none";
  });
  document.querySelectorAll(".cd-tier-col-to").forEach(function (el) {
    el.style.display = !schemeType || cumulative ? "none" : "";
  });
  document.querySelectorAll(".cd-tier-col-pct").forEach(function (el) {
    el.style.display = !schemeType || cumulative ? "none" : "";
  });
  document.querySelectorAll(".cd-tier-col-rate").forEach(function (el) {
    el.style.display = cumulative ? "" : "none";
  });

  const hint = document.getElementById("cdDealerStatusHint");
  if (hint && !cdDealerRebateLocked_) {
    if (!schemeType) hint.textContent = "請先選類型";
    else hint.textContent = cumulative ? "經銷等級級距" : cdDealerPermissionHint_();
  }
}

function cdCanOperate_() {
  try {
    return typeof erpCanOperateCommercialDealer_ === "function" && erpCanOperateCommercialDealer_();
  } catch (_e) {
    return false;
  }
}

function cdDealerPermissionHint_() {
  if (cdCanOperate_()) return "月結回饋級距";
  if (typeof erpHasModule_ === "function" && erpHasModule_("commercial_dealer")) {
    return "僅檢視；建立／更新須會計／CEO／GA／ADMIN";
  }
  return "您沒有權限維護經銷方案";
}

function cdDealerSyncListRowHighlight_() {
  const sel = String(cdDealerSelectedSchemeId_ || "").trim().toUpperCase();
  document.querySelectorAll("#cd_dealer_list_tbody tr[data-scheme-id]").forEach(function (tr) {
    const id = String(tr.getAttribute("data-scheme-id") || "").trim().toUpperCase();
    tr.classList.toggle("erp-list-row-open", id === sel);
  });
}

function cdDealerSetButtons_() {
  const canOp = cdCanOperate_();
  const createBtn = document.getElementById("cd_dealer_create_btn");
  const updateBtn = document.getElementById("cd_dealer_update_btn");
  if (createBtn) {
    createBtn.disabled = !canOp || !!cdDealerEditing_;
    createBtn.title = !canOp
      ? "須模組權限 + 會計／CEO／GA／ADMIN"
      : cdDealerEditing_
        ? "已載入方案，請用更新"
        : "建立新方案";
  }
  if (updateBtn) {
    updateBtn.disabled = !canOp || !cdDealerEditing_ || !!cdDealerRebateLocked_;
    updateBtn.title = !canOp
      ? "須模組權限 + 會計／CEO／GA／ADMIN"
      : !cdDealerEditing_
        ? "請先從列表載入方案"
        : cdDealerRebateLocked_
          ? "已有月結回饋紀錄，不可更新"
          : "更新此方案";
  }
}

function cdDealerApplyRebateLock_(locked) {
  cdDealerRebateLocked_ = !!locked;
  const hint = document.getElementById("cdDealerStatusHint");
  if (hint) {
    hint.textContent = locked ? "已有月結回饋紀錄，僅可檢視不可更新" : cdDealerPermissionHint_();
    hint.style.color = locked ? "#b45309" : "#64748b";
  }
  ["cd_dealer_name", "cd_dealer_status", "cd_dealer_date_from", "cd_dealer_date_to", "cd_dealer_remark", "cd_dealer_scheme_type"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  const addBtn = document.querySelector('button[onclick="cdDealerAddTier_()"]');
  const defBtn = document.querySelector('button[onclick="cdDealerLoadDefaultTiers_()"]');
  if (addBtn) addBtn.disabled = locked;
  if (defBtn) defBtn.disabled = locked;
  document.querySelectorAll("#cd_dealer_tiers_tbody input, #cd_dealer_tiers_tbody button").forEach(function (el) {
    el.disabled = locked;
  });
  cdDealerSetButtons_();
}

function cdDealerInitNewId_(force) {
  if (cdDealerEditing_) return String(document.getElementById("cd_dealer_id")?.value || "").trim().toUpperCase();
  if (typeof erpInitAutoId_ === "function") {
    return erpInitAutoId_("cd_dealer_id", {
      gen: function () {
        return typeof cdNewDealerSchemeId_ === "function" ? cdNewDealerSchemeId_() : "";
      },
      force: !!force
    });
  }
  const el = document.getElementById("cd_dealer_id");
  if (el && typeof cdNewDealerSchemeId_ === "function" && (!String(el.value || "").trim() || force)) {
    el.value = cdNewDealerSchemeId_();
  }
  return String(document.getElementById("cd_dealer_id")?.value || "").trim().toUpperCase();
}

function cdDealerTierRowHtml_(tier) {
  const ln = tier || {};
  const idx = ++cdDealerTierSeq_;
  const cumulative = cdDealerIsCumulative_();
  if (cumulative) {
    return (
      '<tr data-tier-idx="' +
      idx +
      '">' +
      '<td><input type="text" class="cd-tier-label" value="' +
      ccEsc_(ln.tier_label != null ? ln.tier_label : "") +
      '" style="width:100px;"></td>' +
      '<td><input type="number" class="cd-tier-from" min="0" step="1" value="' +
      ccEsc_(ln.amount_from != null ? ln.amount_from : "") +
      '" style="width:140px;"></td>' +
      '<td><input type="number" class="cd-tier-rate" min="1" max="100" step="0.1" value="' +
      ccEsc_(ln.price_rate != null ? ln.price_rate : "") +
      '" style="width:90px;"></td>' +
      '<td><button type="button" class="btn-secondary btn-sm" onclick="cdDealerRemoveTier_(this)">刪除</button></td>' +
      "</tr>"
    );
  }
  return (
    '<tr data-tier-idx="' +
    idx +
    '">' +
    '<td><input type="number" class="cd-tier-from" min="0" step="0.01" value="' +
    ccEsc_(ln.amount_from != null ? ln.amount_from : "") +
    '" style="width:120px;"></td>' +
    '<td><input type="number" class="cd-tier-to" min="0" step="0.01" placeholder="空白=無上限" value="' +
    ccEsc_(ln.amount_to != null && ln.amount_to !== "" ? ln.amount_to : "") +
    '" style="width:120px;"></td>' +
    '<td><input type="number" class="cd-tier-pct" min="0" max="100" step="0.1" value="' +
    ccEsc_(ln.rebate_pct != null ? ln.rebate_pct : "") +
    '" style="width:80px;"></td>' +
    '<td><button type="button" class="btn-secondary btn-sm" onclick="cdDealerRemoveTier_(this)">刪除</button></td>' +
    "</tr>"
  );
}

function cdDealerAddTier_(prefill) {
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (!body) return;
  if (!body.querySelector("tr")) body.innerHTML = "";
  body.insertAdjacentHTML("beforeend", cdDealerTierRowHtml_(prefill || { rebate_pct: 0 }));
}

function cdDealerRemoveTier_(btn) {
  const tr = btn && btn.closest ? btn.closest("tr") : null;
  if (tr) tr.remove();
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (body && !body.querySelector("tr")) {
    body.innerHTML =
      '<tr><td colspan="' + cdDealerTierColspan_() + '" class="text-muted">請新增至少一筆級距</td></tr>';
  }
}

function cdDealerLoadDefaultTiers_() {
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (!body) return;
  if (!cdDealerGetSchemeType_()) {
    cdDealerClearTierPlaceholder_();
    return;
  }
  body.innerHTML = "";
  const list = cdDealerIsCumulative_() ? CD_DEFAULT_CUMULATIVE_TIERS_ : CD_DEFAULT_TIERS_;
  list.forEach(function (t) {
    cdDealerAddTier_(t);
  });
}

function cdDealerCollectTiers_() {
  const rows = document.querySelectorAll("#cd_dealer_tiers_tbody tr[data-tier-idx]");
  const out = [];
  const cumulative = cdDealerIsCumulative_();
  rows.forEach(function (tr) {
    const amountFrom = Number(tr.querySelector(".cd-tier-from")?.value || 0);
    if (cumulative) {
      out.push({
        tier_label: String(tr.querySelector(".cd-tier-label")?.value || "").trim(),
        amount_from: amountFrom,
        price_rate: Number(tr.querySelector(".cd-tier-rate")?.value || 0)
      });
      return;
    }
    const toRaw = String(tr.querySelector(".cd-tier-to")?.value || "").trim();
    const amountTo = toRaw ? Number(toRaw) : null;
    const rebatePct = Number(tr.querySelector(".cd-tier-pct")?.value || 0);
    out.push({
      amount_from: amountFrom,
      amount_to: amountTo,
      rebate_pct: rebatePct
    });
  });
  return out;
}

function cdDealerClearForm_() {
  cdDealerEditing_ = false;
  cdDealerSelectedSchemeId_ = "";
  cdDealerSyncListRowHighlight_();
  cdDealerApplyRebateLock_(false);
  ["cd_dealer_id", "cd_dealer_name", "cd_dealer_remark"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const st = document.getElementById("cd_dealer_status");
  if (st) st.value = "ACTIVE";
  const ss = document.getElementById("cd_dealer_stat_source");
  if (ss) ss.value = "CONSIGNMENT";
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (body) body.innerHTML = '<tr><td colspan="' + cdDealerTierColspan_() + '" class="text-muted">請先選類型</td></tr>';
  const typeEl = document.getElementById("cd_dealer_scheme_type");
  if (typeEl) typeEl.value = "";
  cdDealerApplySchemeTypeUi_();
  cdDealerClearTierPlaceholder_();
  cdDealerInitNewId_(true);
  cdDealerSetButtons_();
}

async function cdListDealerSchemes_() {
  const r = await callAPI({ action: "list_commercial_dealer_scheme_enriched" }, { method: "GET" });
  return r?.data || [];
}

async function cdSaveDealerScheme_(payload) {
  return callAPI(Object.assign({ action: "save_commercial_dealer_scheme_bundle" }, payload), { method: "POST" });
}

async function cdDealerLoadScheme_(schemeId) {
  const sid = String(schemeId || "").trim().toUpperCase();
  if (
    cdDealerEditing_ &&
    typeof erpTryToggleCloseMasterListRow_ === "function" &&
    erpTryToggleCloseMasterListRow_(cdDealerSelectedSchemeId_, sid, "cd_dealer_edit_card", cdDealerClearForm_)
  ) {
    return;
  }
  cdDealerSelectedSchemeId_ = sid;
  cdDealerSyncListRowHighlight_();
  const row = (cdDealerListRows_ || []).find(function (r) {
    return String(r.scheme_id || "").trim().toUpperCase() === sid;
  });
  if (!row) return showToast("找不到方案", "error");

  cdDealerEditing_ = true;
  cdDealerSetButtons_();
  const idEl = document.getElementById("cd_dealer_id");
  if (idEl) idEl.value = sid;
  const nameEl = document.getElementById("cd_dealer_name");
  if (nameEl) nameEl.value = String(row.scheme_name || "");
  const st = document.getElementById("cd_dealer_status");
  if (st) st.value = String(row.status || "ACTIVE").toUpperCase();
  const df = document.getElementById("cd_dealer_date_from");
  if (df) df.value = String(row.date_from || "").slice(0, 10);
  const dt = document.getElementById("cd_dealer_date_to");
  if (dt) dt.value = String(row.date_to || "").slice(0, 10);
  const rm = document.getElementById("cd_dealer_remark");
  if (rm) rm.value = String(row.remark || "");
  const ss = document.getElementById("cd_dealer_stat_source");
  if (ss) {
    const src = String(row.stat_source || "CONSIGNMENT").trim().toUpperCase();
    ss.value = ["CONSIGNMENT", "GENERAL", "ALL"].includes(src) ? src : "CONSIGNMENT";
  }
  const typeEl = document.getElementById("cd_dealer_scheme_type");
  if (typeEl) {
    const stype = String(row.scheme_type || "MONTHLY_REBATE").trim().toUpperCase();
    typeEl.value = stype === "CUMULATIVE_AMOUNT" ? "CUMULATIVE_AMOUNT" : "MONTHLY_REBATE";
  }
  cdDealerApplySchemeTypeUi_();

  const tiersR = await callAPI({ action: "list_commercial_dealer_scheme_tier", scheme_id: sid }, { method: "GET" });
  let tiers = [];
  try {
    tiers = (tiersR?.data || []).filter(function (ln) {
      return String(ln.scheme_id || "").trim().toUpperCase() === sid;
    });
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("載入級距失敗", "error");
    tiers = [];
  }
  const body = document.getElementById("cd_dealer_tiers_tbody");
  if (body) {
    body.innerHTML = "";
    if (!tiers.length) {
      body.innerHTML =
        '<tr><td colspan="' + cdDealerTierColspan_() + '" class="text-muted">請新增至少一筆級距</td></tr>';
    } else {
      tiers
        .sort(function (a, b) {
          return Number(a.line_no || 0) - Number(b.line_no || 0);
        })
        .forEach(function (ln) {
          cdDealerAddTier_(ln);
        });
    }
  }
  cdDealerApplyRebateLock_(!!row.has_rebate);
  if (typeof showMasterEditCard_ === "function") showMasterEditCard_("cd_dealer_edit_card");
  if (typeof scrollToMasterForm_ === "function") scrollToMasterForm_("cd_dealer_edit_card");
}

async function cdDealerSave_(isUpdate) {
  if (!cdCanOperate_()) return showToast("您沒有權限維護經銷方案（須模組權限 + 會計／CEO／GA／ADMIN）", "error");

  const schemeId = String(document.getElementById("cd_dealer_id")?.value || "").trim().toUpperCase() || cdDealerInitNewId_(true);
  const schemeName = String(document.getElementById("cd_dealer_name")?.value || "").trim();
  const status = String(document.getElementById("cd_dealer_status")?.value || "ACTIVE").trim().toUpperCase();
  const dateFrom = String(document.getElementById("cd_dealer_date_from")?.value || "").trim();
  const dateTo = String(document.getElementById("cd_dealer_date_to")?.value || "").trim();
  const remark = String(document.getElementById("cd_dealer_remark")?.value || "").trim();
  const schemeType = cdDealerGetSchemeType_();
  const statSource = String(document.getElementById("cd_dealer_stat_source")?.value || "CONSIGNMENT")
    .trim()
    .toUpperCase();
  const tiers = cdDealerCollectTiers_();

  if (!schemeName) return showToast("請填方案名稱", "error");
  if (!schemeType) return showToast("請選類型", "error");
  if (!dateFrom || !dateTo) return showToast("請填有效期", "error");
  if (!tiers.length) return showToast("請至少一筆級距", "error");
  if (schemeType === "CUMULATIVE_AMOUNT") {
    for (let i = 0; i < tiers.length; i++) {
      if (!tiers[i].tier_label) return showToast("經銷等級：請填等級名稱（第 " + (i + 1) + " 列）", "error");
      if (!(tiers[i].price_rate >= 1 && tiers[i].price_rate <= 100)) {
        return showToast("經銷等級：經銷價須為 1～100 折（第 " + (i + 1) + " 列）", "error");
      }
    }
  }

  try {
    await cdSaveDealerScheme_({
      scheme_id: schemeId,
      scheme_name: schemeName,
      status: status,
      date_from: dateFrom,
      date_to: dateTo,
      stat_source: statSource,
      scheme_type: schemeType,
      remark: remark,
      tiers_json: JSON.stringify(tiers),
      created_by: getCurrentUser(),
      updated_by: getCurrentUser()
    });
    showToast(isUpdate ? "方案已更新" : "方案已建立", "success");
    await cdDealerRenderList_(true);
    if (!isUpdate) await cdDealerLoadScheme_(schemeId);
    else cdDealerEditing_ = true;
    cdDealerSetButtons_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("儲存失敗", "error");
  }
}

function cdDealerStatusLabel_(status) {
  const s = String(status || "").trim().toUpperCase();
  return CD_DEALER_STATUS_LABELS_[s] || s;
}

function cdDealerFilterRows_(rows) {
  const kw = String(document.getElementById("search_cd_dealer_keyword")?.value || "")
    .trim()
    .toUpperCase();
  const st = String(document.getElementById("search_cd_dealer_status")?.value || "")
    .trim()
    .toUpperCase();
  const type = String(document.getElementById("search_cd_dealer_type")?.value || "")
    .trim()
    .toUpperCase();
  let list = (rows || []).slice();
  if (st) {
    list = list.filter(function (r) {
      return String(r.status || "").trim().toUpperCase() === st;
    });
  }
  if (type) {
    list = list.filter(function (r) {
      return String(r.scheme_type || "MONTHLY_REBATE").trim().toUpperCase() === type;
    });
  }
  if (kw) {
    list = list.filter(function (r) {
      const id = String(r.scheme_id || "").trim().toUpperCase();
      const name = String(r.scheme_name || "").trim().toUpperCase();
      return id.includes(kw) || name.includes(kw);
    });
  }
  if (cdDealerSort_.field) {
    const field = cdDealerSort_.field;
    const asc = !!cdDealerSort_.asc;
    list.sort(function (a, b) {
      let va = a[field];
      let vb = b[field];
      if (field === "tier_count") {
        va = Number(va || 0);
        vb = Number(vb || 0);
      } else {
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
      }
      if (va > vb) return asc ? 1 : -1;
      if (va < vb) return asc ? -1 : 1;
      return 0;
    });
  }
  return list;
}

function cdDealerSort_(field) {
  if (cdDealerSort_.field === field) cdDealerSort_.asc = !cdDealerSort_.asc;
  else {
    cdDealerSort_.field = field;
    cdDealerSort_.asc = true;
  }
  cdDealerRenderList_();
}

async function cdDealerResetSearch_() {
  const kw = document.getElementById("search_cd_dealer_keyword");
  if (kw) kw.value = "";
  const st = document.getElementById("search_cd_dealer_status");
  if (st) st.value = "ACTIVE";
  const type = document.getElementById("search_cd_dealer_type");
  if (type) type.value = "";
  await cdDealerRenderList_(true);
  if (typeof resetMasterListView_ === "function") resetMasterListView_("cd_dealer_edit_card", cdDealerClearForm_);
}

async function cdDealerRenderList_(refetch) {
  const body = document.getElementById("cd_dealer_list_tbody");
  if (!body) return;
  body.innerHTML = '<tr><td colspan="7" class="text-muted">載入中…</td></tr>';
  try {
    if (refetch || !(cdDealerListRows_ || []).length) cdDealerListRows_ = await cdListDealerSchemes_();
    const rows = cdDealerFilterRows_(cdDealerListRows_ || []);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-muted">查無符合條件的經銷方案</td></tr>';
      return;
    }
    const sel = String(cdDealerSelectedSchemeId_ || "").trim().toUpperCase();
    const idNameCells =
      typeof masterListIdNameCells_ === "function"
        ? masterListIdNameCells_
        : function (id, name) {
            return "<td>" + ccEsc_(id) + "</td><td>" + ccEsc_(name) + "</td>";
          };
    body.innerHTML = rows
      .map(function (r) {
        const sid = String(r.scheme_id || "").trim();
        const safeSid = sid.replace(/'/g, "\\'");
        const open = sid.toUpperCase() === sel;
        const period = ccEsc_(String(r.date_from || "").slice(0, 10) + "～" + String(r.date_to || "").slice(0, 10));
        const statusLabel = cdDealerStatusLabel_(r.status) + (r.has_rebate ? "｜已產生回饋" : "");
        const typeLabel = cdDealerSchemeTypeLabel_(r.scheme_type);
        const statLabel = cdDealerStatSourceLabel_(r.stat_source);
        return (
          '<tr class="erp-list-row-selectable' +
          (open ? " erp-list-row-open" : "") +
          '"' +
          ' data-scheme-id="' +
          ccEsc_(sid) +
          '" onclick="cdDealerLoadScheme_(\'' +
          safeSid +
          "')\">" +
          idNameCells(sid, r.scheme_name || "") +
          "<td>" +
          ccEsc_(statLabel) +
          "</td>" +
          "<td>" +
          ccEsc_(typeLabel) +
          "</td>" +
          "<td>" +
          ccEsc_(statusLabel) +
          "</td>" +
          "<td>" +
          period +
          "</td>" +
          "<td>" +
          ccEsc_(String(r.tier_count != null ? r.tier_count : "0")) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="7" class="text-muted">載入失敗</td></tr>';
  }
}

async function commercialDealerInit() {
  const hint = document.getElementById("cdDealerStatusHint");
  if (hint) hint.textContent = cdDealerPermissionHint_();
  bindUppercaseInput("cd_dealer_id");
  if (typeof bindAutoSearchToolbar_ === "function") {
    bindAutoSearchToolbar_(
      [
        ["search_cd_dealer_keyword", "input"],
        ["search_cd_dealer_status", "change"],
        ["search_cd_dealer_type", "change"]
      ],
      function () {
        cdDealerRenderList_();
      }
    );
  }
  if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_();

  cdDealerListRows_ = [];
  if (typeof hideMasterEditCard_ === "function") hideMasterEditCard_("cd_dealer_edit_card");
  cdDealerClearForm_();
  await cdDealerRenderList_(true);
}
