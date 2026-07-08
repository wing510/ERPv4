/*********************************
 * FINANCE · 寄賣月結回饋（Dealer Rebate）
 *********************************/

var drRebatePreviewPack_ = null;
var drRebateListRows_ = [];
var drRebateSelectedId_ = "";
var drStatPreviewPack_ = null;
var drStatListRows_ = [];
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
  if (drCanOperate_()) return "每月先統計請款淨額；寄賣部分計入月結累積";
  if (typeof erpHasModule_ === "function" && (erpHasModule_("dealer_rebate") || erpHasModule_("commercial_dealer"))) {
    return "僅檢視；預覽／過帳須會計／CEO／GA／ADMIN";
  }
  return "您沒有權限操作月結統計";
}

var DR_STAT_STATUS_LABELS_ = {
  POSTED: "已過帳",
  VOID: "已作廢"
};

function drStatRenderPreview_(pack) {
  const box = document.getElementById("dr_stat_preview");
  if (!box) return;
  if (!pack) {
    box.classList.add("dr-rebate-box-hidden");
    box.innerHTML = "";
    return;
  }
  if (pack.already_posted) {
    box.innerHTML =
      '<div style="color:#b45309;">此客戶該月已有月結統計（' +
      ccEsc_(pack.existing_stat_id || "—") +
      "）。若要重算，請先在列表<strong>作廢</strong>後再預覽過帳。</div>";
    box.classList.remove("dr-rebate-box-hidden");
    return;
  }
  const billingCons = Number(pack.billing_net_consignment || 0);
  const billingGen = Number(pack.billing_net_general || 0);
  const cumAdd = Number(pack.cumulative_add_consignment || 0);
  const settleCnt = String(pack.settlement_count || 0);
  const shipCnt = String(pack.shipment_count || 0);
  let html =
    "<div><strong>請款淨額合計</strong>：" +
    drFmtMoney_(pack.billing_net) +
    "（寄賣 " +
    drFmtMoney_(billingCons) +
    (settleCnt !== "0" ? "，" + ccEsc_(settleCnt) + " 筆結算" : "") +
    "；一般 " +
    drFmtMoney_(billingGen) +
    (shipCnt !== "0" ? "，" + ccEsc_(shipCnt) + " 筆出貨" : "") +
    "）</div>";
  if (pack.cumulative_note) {
    html += '<div style="color:#64748b;margin-top:4px;">' + ccEsc_(pack.cumulative_note) + "</div>";
  }
  html +=
    '<div style="margin-top:6px;"><strong>本次寄賣累積</strong>：+' +
    drFmtMoney_(cumAdd) +
    "；<strong>一般</strong>：" +
    drFmtMoney_(billingGen) +
    "（已於出貨過帳計入，不重複加）</div>";
  const cum = pack.cumulative_preview || {};
  if (cum.enabled) {
    html +=
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;"><strong>方案</strong>：' +
      ccEsc_(drRebateCumulativeSchemeLabel_(cum)) +
      "</div>" +
      "<div><strong>目前等級</strong>：" +
      ccEsc_(cum.current_tier_label || "—") +
      (cum.current_price_rate != null ? "（" + String(cum.current_price_rate) + " 折）" : "") +
      "</div>" +
      "<div><strong>月結累積</strong>：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after) +
      "（本月 +" +
      drFmtMoney_(cum.cumulative_add) +
      "）</div>";
    if (cum.upgrade && cum.pending_tier_label) {
      html +=
        '<div style="color:#15803d;"><strong>次月待生效</strong>：' +
        ccEsc_(cum.pending_tier_label) +
        (cum.pending_price_rate != null ? "（" + String(cum.pending_price_rate) + " 折）" : "") +
        "</div>";
    }
  } else if (cum.err) {
    html += '<div style="margin-top:6px;color:#b45309;">' + ccEsc_(cum.err) + "</div>";
  }
  box.innerHTML = html;
  box.classList.remove("dr-rebate-box-hidden");
}

async function drStatPreview_() {
  if (!drCanOperate_()) return showToast("您沒有權限操作月結統計（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) return showToast("請選客戶", "error");
  if (!periodYm) return showToast("請選月份", "error");
  try {
    const pack = await callAPI(
      {
        action: "preview_commercial_dealer_monthly_stat_bundle",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "POST" }
    );
    drStatPreviewPack_ = pack;
    drStatRenderPreview_(pack);
    const postBtn = document.getElementById("dr_stat_post_btn");
    if (postBtn) postBtn.disabled = !!(pack && pack.already_posted);
  } catch (err) {
    drStatPreviewPack_ = null;
    drStatRenderPreview_(null);
    if (!(err && err.erpApiToastShown)) showToast("預覽失敗", "error");
  }
}

async function drStatPost_() {
  if (!drCanOperate_()) return showToast("您沒有權限過帳月結統計", "error");
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  const remark = String(document.getElementById("dr_stat_remark")?.value || "").trim();
  if (!customerId) return showToast("請選客戶", "error");
  if (!periodYm) return showToast("請選月份", "error");

  const billingNet = Number(drStatPreviewPack_?.billing_net || 0);
  if (!(billingNet > 0)) {
    await drStatPreview_();
    if (!(Number(drStatPreviewPack_?.billing_net || 0) > 0)) {
      return showToast("本月無請款淨額", "warn");
    }
  }
  if (drStatPreviewPack_?.already_posted) return showToast("此客戶該月已有月結統計", "warn");

  const cumAdd = Number(drStatPreviewPack_?.cumulative_add_consignment || 0);
  const cum = drStatPreviewPack_?.cumulative_preview || {};
  let confirmMsg =
    "確定過帳 " + periodYm + " 月結統計？\n請款淨額：" + drFmtMoney_(drStatPreviewPack_?.billing_net || billingNet);
  if (cumAdd > 0) {
    confirmMsg += "\n寄賣累積：+" + drFmtMoney_(cumAdd);
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
  }
  const okGo = window.confirm ? window.confirm(confirmMsg) : true;
  if (!okGo) return;

  try {
    const res = await callAPI(
      {
        action: "post_commercial_dealer_monthly_stat_bundle",
        customer_id: customerId,
        period_ym: periodYm,
        remark: remark,
        created_by: getCurrentUser(),
        updated_by: getCurrentUser()
      },
      { method: "POST" }
    );
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_();
    } catch (_eLoad) {}
    const cumAfter = res?.cumulative;
    let cumHint = "";
    if (cumAfter && cumAfter.cumulative_after != null) {
      cumHint = "；月結累積 " + drFmtMoney_(cumAfter.cumulative_after);
      if (cumAfter.pending_tier_label) cumHint += "（次月 " + cumAfter.pending_tier_label + "）";
    }
    showToast("月結統計已過帳：" + String(res.stat_id || "") + cumHint, "success");
    drStatPreviewPack_ = null;
    drStatRenderPreview_(null);
    await drStatRenderList_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("過帳失敗", "error");
  }
}

async function drStatVoid_(statId) {
  if (!drCanOperate_()) return showToast("您沒有權限作廢月結統計", "error");
  const sid = String(statId || "").trim();
  if (!sid) return;
  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason === null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");
  const okGo = window.confirm
    ? window.confirm(
        "確定作廢月結統計 " +
          sid +
          "？\n若有寄賣累積異動，將一併扣回並清除本次升級待生效。\n已產生的月結回饋須先作廢。"
      )
    : true;
  if (!okGo) return;
  try {
    await callAPI(
      {
        action: "void_commercial_dealer_monthly_stat_bundle",
        stat_id: sid,
        void_reason: String(reason).trim(),
        updated_by: getCurrentUser(),
        created_by: getCurrentUser()
      },
      { method: "POST" }
    );
    showToast("月結統計已作廢：" + sid, "success", 5000);
    await drStatRenderList_();
    if (drStatPreviewPack_) await drStatPreview_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗", "error");
  }
}

async function drStatRenderList_() {
  const body = document.getElementById("dr_stat_list_tbody");
  if (!body) return;
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "")
    .trim()
    .toUpperCase();
  body.innerHTML = '<tr><td colspan="7" class="text-muted">載入中…</td></tr>';
  if (!customerId) {
    drStatListRows_ = [];
    body.innerHTML = '<tr><td colspan="7" class="text-muted">請先選客戶以查看統計紀錄</td></tr>';
    return;
  }
  try {
    const r = await callAPI({ action: "list_commercial_dealer_monthly_stat_enriched" }, { method: "GET" });
    const rows = (r?.data || []).filter(function (row) {
      return String(row.customer_id || "").trim().toUpperCase() === customerId;
    });
    drStatListRows_ = rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-muted">此客戶尚無月結統計紀錄</td></tr>';
      return;
    }
    const canOp = drCanOperate_();
    body.innerHTML = rows
      .map(function (row) {
        const st = String(row.status || "").trim().toUpperCase();
        const stLabel = DR_STAT_STATUS_LABELS_[st] || st || "—";
        const stStyle = st === "VOID" ? "color:#94a3b8" : st === "POSTED" ? "color:#15803d" : "";
        let actionCell = "—";
        if (st === "POSTED" && canOp) {
          actionCell =
            '<button type="button" class="btn-secondary btn-sm" onclick="drStatVoid_(\'' +
            String(row.stat_id || "").replace(/'/g, "\\'") +
            "')\">作廢</button>";
        }
        return (
          "<tr" +
          (st === "VOID" ? ' style="opacity:0.75"' : "") +
          ">" +
          "<td>" + ccEsc_(row.stat_id || "") + "</td>" +
          "<td>" + ccEsc_(row.period_ym || "") + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.billing_net_total)) + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.cumulative_add_consignment)) + "</td>" +
          "<td>" + ccEsc_(drFmtMoney_(row.cumulative_add_general)) + "</td>" +
          '<td style="' + stStyle + '">' + ccEsc_(stLabel) + "</td>" +
          "<td>" + actionCell + "</td>" +
          "</tr>"
        );
      })
      .join("");
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="7" class="text-muted">載入失敗</td></tr>';
  }
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
    billing_net: row.billing_net,
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
  drRebatePreviewPack_ = null;
  const custSel = document.getElementById("dr_rebate_customer_id");
  if (custSel) custSel.value = String(row.customer_id || "").trim().toUpperCase();
  const periodEl = document.getElementById("dr_rebate_period");
  if (periodEl) periodEl.value = String(row.period_ym || "").trim();
  const modeEl = document.getElementById("dr_rebate_settle_mode");
  if (modeEl) modeEl.value = String(row.settle_mode || "").trim().toUpperCase();
  const remarkEl = document.getElementById("dr_rebate_remark");
  if (remarkEl) remarkEl.value = String(row.remark || "").trim();
  drRebateRenderPreview_(null);
  drRebateRenderSnapshot_(drRebatePackFromRow_(row));
  const postBtn = document.getElementById("dr_rebate_post_btn");
  if (postBtn) postBtn.disabled = true;
  drRebateHighlightSelectedRow_();
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
    box.innerHTML =
      '<div style="color:#b45309;">此客戶該月已有有效回饋（' +
      ccEsc_(pack.existing_rebate_id || "—") +
      "）。若要重算，請先在列表<strong>作廢</strong>該筆後再預覽產生。</div>";
    box.classList.remove("dr-rebate-box-hidden");
    try {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (_e) {}
    return;
  }
  const pickedMode = String(document.getElementById("dr_rebate_settle_mode")?.value || "")
    .trim()
    .toUpperCase();
  const effectiveMode = pickedMode || String(pack.settle_mode_default || "").trim().toUpperCase();
  const modeLabel = DR_REBATE_SETTLE_LABELS_[effectiveMode] || effectiveMode || "—";
  const defaultLabel = DR_REBATE_SETTLE_LABELS_[pack.settle_mode_default] || pack.settle_mode_default || "—";
  const tier = pack.tier_snapshot || {};
  const tierText =
    tier.amount_from != null
      ? "級距 " + drFmtMoney_(tier.amount_from) + "～" + (tier.amount_to != null ? drFmtMoney_(tier.amount_to) : "無上限") + " → " + String(tier.rebate_pct != null ? tier.rebate_pct : pack.rebate_pct || 0) + "%"
      : pack.rebate_pct != null
        ? "回饋 " + String(pack.rebate_pct) + "%"
        : "—";
  const fromPosted = !!pack.from_posted;
  const gross = Number(pack.gross_settlement || 0);
  const grossShip = Number(pack.gross_shipment || 0);
  const arAdj = Number(pack.ar_discount_total || 0);
  const settleCnt = String(pack.settlement_count || 0);
  const shipCnt = String(pack.shipment_count || 0);
  const statSource = String(pack.stat_source || "CONSIGNMENT").trim().toUpperCase();
  const billingCons = Number(pack.billing_net_consignment || 0);
  const billingGen = Number(pack.billing_net_general || 0);
  let billingDetail = "";
  if (fromPosted) {
    billingDetail = "（產生時快照）";
  } else if (statSource === "ALL" || statSource === "GENERAL") {
    const parts = [];
    if (billingCons > 0.009 || settleCnt !== "0") {
      parts.push("寄賣 " + drFmtMoney_(billingCons) + (settleCnt ? "（" + ccEsc_(settleCnt) + " 筆結算）" : ""));
    }
    if (billingGen > 0.009 || shipCnt !== "0") {
      parts.push("一般 " + drFmtMoney_(billingGen) + (shipCnt ? "（" + ccEsc_(shipCnt) + " 筆出貨）" : ""));
    }
    if (arAdj > 0.009) {
      parts.push("應收調降 " + drFmtMoney_(arAdj));
    }
    if (parts.length) billingDetail = "（" + parts.join("；") + "）";
  } else if (arAdj > 0.009) {
    billingDetail =
      "（結算 " +
      drFmtMoney_(gross) +
      " − 應收調降 " +
      drFmtMoney_(arAdj) +
      "，如已售退貨等；不含月結回饋，共 " +
      ccEsc_(settleCnt) +
      " 筆）";
  } else if (settleCnt) {
    billingDetail = "（本月已過帳結算加總，共 " + ccEsc_(settleCnt) + " 筆）";
  } else if (shipCnt && grossShip > 0.009) {
    billingDetail = "（本月已過帳出貨加總，共 " + ccEsc_(shipCnt) + " 筆）";
  }
  let html = titleHtml || "";
  html +=
    "<div><strong>方案</strong>：" +
    ccEsc_(pack.scheme_name || pack.scheme_id || "—") +
    "</div>" +
    "<div><strong>請款淨額</strong>：" +
    drFmtMoney_(pack.billing_net) +
    billingDetail +
    "</div>" +
    "<div><strong>套用級距</strong>：" +
    ccEsc_(tierText) +
    "</div>" +
    "<div><strong>回饋金額</strong>：" +
    drFmtMoney_(pack.rebate_amount) +
    "（回饋方式：" +
    ccEsc_(modeLabel) +
    (pickedMode ? "；預設：" + ccEsc_(defaultLabel) : "") +
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
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1;"><strong>方案</strong>：' +
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
      "<div><strong>月結累積</strong>：" +
      drFmtMoney_(cum.cumulative_before) +
      " → " +
      drFmtMoney_(cum.cumulative_after) +
      "（本月 +" +
      drFmtMoney_(cum.cumulative_add) +
      "）</div>";
    if (cum.upgrade && cum.pending_tier_label) {
      html +=
        '<div style="color:#15803d;"><strong>次月待生效</strong>：' +
        ccEsc_(cum.pending_tier_label) +
        (cum.pending_price_rate != null ? "（" + String(cum.pending_price_rate) + " 折）" : "") +
        "</div>";
    } else {
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
  if (!pack) {
    drRebateShowDetailBox_("dr_rebate_preview", null);
    return;
  }
  drRebateShowDetailBox_("dr_rebate_preview", pack, "");
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

async function drRebatePreview_() {
  if (!drCanOperate_()) return showToast("您沒有權限操作月結回饋（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  if (!customerId) return showToast("請選客戶", "error");
  if (!periodYm) return showToast("請選月份", "error");

  drRebateSelectedId_ = "";
  drRebateHighlightSelectedRow_();
  drRebateRenderSnapshot_(null);

  try {
    const pack = await callAPI(
      {
        action: "preview_commercial_dealer_rebate_bundle",
        customer_id: customerId,
        period_ym: periodYm
      },
      { method: "POST" }
    );
    drRebatePreviewPack_ = pack;
    drRebateRenderPreview_(pack);
    const postBtn = document.getElementById("dr_rebate_post_btn");
    if (postBtn) postBtn.disabled = !!(pack && pack.already_posted);
  } catch (err) {
    drRebatePreviewPack_ = null;
    drRebateRenderPreview_(null);
    if (!(err && err.erpApiToastShown)) showToast("預覽失敗", "error");
  }
}

async function drRebatePost_() {
  if (!drCanOperate_()) return showToast("您沒有權限產生回饋（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "").trim().toUpperCase();
  const periodYm = String(document.getElementById("dr_rebate_period")?.value || "").trim();
  const settleMode = String(document.getElementById("dr_rebate_settle_mode")?.value || "").trim().toUpperCase();
  const remark = String(document.getElementById("dr_rebate_remark")?.value || "").trim();
  if (!customerId) return showToast("請選客戶", "error");
  if (!periodYm) return showToast("請選月份", "error");

  const billingNet = Number(drRebatePreviewPack_?.billing_net || 0);
  const amt = Number(drRebatePreviewPack_?.rebate_amount || 0);
  if (!(billingNet > 0)) {
    await drRebatePreview_();
    if (!(Number(drRebatePreviewPack_?.billing_net || 0) > 0)) {
      return showToast("本月無請款淨額", "warn");
    }
  }
  if (drRebatePreviewPack_?.already_posted) return showToast("此客戶該月已有回饋紀錄", "warn");

  const effectiveMode = settleMode || String(drRebatePreviewPack_?.settle_mode_default || "").trim().toUpperCase();
  const modeLabel = DR_REBATE_SETTLE_LABELS_[effectiveMode] || effectiveMode || "—";
  const cum = drRebatePreviewPack_?.cumulative_preview || {};
  let confirmMsg =
    "確定產生 " +
    periodYm +
    " 月結處理？\n請款淨額：" +
    drFmtMoney_(drRebatePreviewPack_?.billing_net || billingNet);
  if (amt > 0) {
    confirmMsg += "\n回饋金額：" + drFmtMoney_(amt) + "\n回饋方式：" + modeLabel;
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
  if (!okGo) return;

  try {
    const res = await callAPI(
      Object.assign(
        {
          action: "post_commercial_dealer_rebate_bundle",
          customer_id: customerId,
          period_ym: periodYm,
          remark: remark,
          created_by: getCurrentUser(),
          updated_by: getCurrentUser()
        },
        settleMode ? { settle_mode: settleMode } : {}
      ),
      { method: "POST" }
    );
    try {
      if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_();
    } catch (_eLoad) {}
    const balAfter = Number(res?.credit_balance_after || 0);
    const settleModeRes = String(res?.settle_mode || "").trim().toUpperCase();
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
    showToast("月結已產生：" + String(res.rebate_id || "") + hint + cumHint, "success");
    drRebatePreviewPack_ = null;
    drRebateRenderPreview_(null);
    await drRebateRenderList_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("產生失敗", "error");
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

async function drRebateVoid_(rebateId) {
  if (!drCanOperate_()) return showToast("您沒有權限作廢回饋（須模組權限 + 會計／CEO／GA／ADMIN）", "error");
  const rid = String(rebateId || "").trim();
  if (!rid) return;

  const reason = window.prompt("請填寫作廢原因（必填）：", "");
  if (reason === null) return;
  if (!String(reason || "").trim()) return showToast("請填寫作廢原因", "error");

  const okGo = window.confirm
    ? window.confirm(
        "確定作廢回饋 " +
          rid +
          "？\n折讓將還原應收金額；次月結算折抵將扣回客戶折抵餘額。\n若有月結累積異動，將一併扣回並清除本次升級待生效。"
      )
    : true;
  if (!okGo) return;

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
    await drRebateRenderList_();
    if (drRebatePreviewPack_) await drRebatePreview_();
  } catch (err) {
    if (!(err && err.erpApiToastShown)) showToast("作廢失敗", "error");
  }
}

function drRebateOnCustomerChange_() {
  drRebateSelectedId_ = "";
  drRebatePreviewPack_ = null;
  drStatPreviewPack_ = null;
  drRebateRenderPreview_(null);
  drStatRenderPreview_(null);
  drRebateRenderSnapshot_(null);
  const postBtn = document.getElementById("dr_rebate_post_btn");
  if (postBtn) postBtn.disabled = !drCanOperate_();
  const statPostBtn = document.getElementById("dr_stat_post_btn");
  if (statPostBtn) statPostBtn.disabled = !drCanOperate_();
  drStatRenderList_();
  drRebateRenderList_();
}

async function drRebateRenderList_() {
  const body = document.getElementById("dr_rebate_list_tbody");
  if (!body) return;
  const customerId = String(document.getElementById("dr_rebate_customer_id")?.value || "")
    .trim()
    .toUpperCase();
  body.innerHTML = '<tr><td colspan="9" class="text-muted">載入中…</td></tr>';
  if (!customerId) {
    drRebateListRows_ = [];
    drRebateSelectedId_ = "";
    body.innerHTML = '<tr><td colspan="9" class="text-muted">請先選客戶以查看回饋紀錄</td></tr>';
    return;
  }
  try {
    const r = await callAPI({ action: "list_commercial_dealer_rebate_enriched" }, { method: "GET" });
    const allRows = r?.data || [];
    const rows = allRows.filter(function (row) {
      return String(row.customer_id || "").trim().toUpperCase() === customerId;
    });
    drRebateListRows_ = rows;
    if (!rows.length) {
      drRebateSelectedId_ = "";
      drRebateRenderSnapshot_(null);
      body.innerHTML = '<tr><td colspan="9" class="text-muted">此客戶尚無回饋紀錄</td></tr>';
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
          "<td>" + ccEsc_(row.rebate_id || "") + "</td>" +
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
      if (picked) drRebateRenderSnapshot_(drRebatePackFromRow_(picked));
    }
  } catch (_e) {
    body.innerHTML = '<tr><td colspan="9" class="text-muted">載入失敗</td></tr>';
  }
}

function drApplyRebatePermissions_() {
  const canOp = drCanOperate_();
  const previewBtn = document.querySelector('button[onclick="drRebatePreview_()"]');
  const postBtn = document.getElementById("dr_rebate_post_btn");
  const statPreviewBtn = document.querySelector('button[onclick="drStatPreview_()"]');
  const statPostBtn = document.getElementById("dr_stat_post_btn");
  if (previewBtn) previewBtn.disabled = !canOp;
  if (postBtn && !canOp) postBtn.disabled = true;
  if (statPreviewBtn) statPreviewBtn.disabled = !canOp;
  if (statPostBtn && !canOp) statPostBtn.disabled = true;
}

async function dealerRebateInit() {
  const hint = document.getElementById("drRebateStatusHint");
  if (hint) hint.textContent = drRebatePermissionHint_();
  const statHint = document.getElementById("drStatStatusHint");
  if (statHint) statHint.textContent = drStatPermissionHint_();
  drApplyRebatePermissions_();
  if (typeof ccLoadMasterData_ === "function") await ccLoadMasterData_();
  await drRebateEnsureSchemeNames_();

  const custSel = document.getElementById("dr_rebate_customer_id");
  if (custSel) custSel.innerHTML = ccRenderCustomerSelectOptions_("");

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

  if (custSel && drPreset && drPreset.customer_id) {
    custSel.value = String(drPreset.customer_id).trim().toUpperCase();
    if (typeof drRebateOnCustomerChange_ === "function") drRebateOnCustomerChange_();
  }
  if (periodEl && drPreset && drPreset.period_ym) {
    periodEl.value = String(drPreset.period_ym).trim();
  }

  await drStatRenderList_();
  await drRebateRenderList_();

  if (drPreset && drPreset.customer_id && typeof drStatPreview_ === "function") {
    setTimeout(function () {
      drStatPreview_();
    }, 80);
  }
}
