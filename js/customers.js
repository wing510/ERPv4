/*********************************
 * Customers Module - Enterprise v3 (API 版)
 *********************************/

let customerEditing = false;
let customerLoadInFlight_ = false;
let customerPendingLoadId_ = "";
let custRecipients_ = [];
let custEditingRecipientId_ = "";

function custSetV_(id, v){
  try{
    if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(id, v);
  }catch(_e){}
  const el = document.getElementById(String(id || ""));
  if(el && "value" in el) el.value = v;
}

function custClear_(ids){
  try{
    if(typeof window.erpClearIds_ === "function") return window.erpClearIds_(ids);
  }catch(_e){}
  const list = Array.isArray(ids) ? ids : [ids];
  for(let i = 0; i < list.length; i++){
    const el = document.getElementById(String(list[i] || ""));
    if(el && "value" in el) el.value = "";
  }
}

/* ===== 企業級設定 ===== */
const CUSTOMER_RULES = {
  idRegex: /^[A-Z0-9_-]+$/,
  idMax: 30
};

// `bindUppercaseInput`、`syncSelectWithLegacy_` 已移至 `js/core/utils.js`

function custIsTaiwanCountry_(country){
  const c = String(country || "").trim();
  return c === "台灣" || c === "Taiwan" || c === "TW";
}

function custIsChinaCountry_(country){
  const c = String(country || "").trim();
  return c === "中國" || c === "China" || c === "CN";
}

function custGetCustomerType_(){
  const person = document.getElementById("c_customer_type_person");
  return (person && person.checked) ? "PERSON" : "COMPANY";
}

function custSetCustomerType_(val){
  const v = String(val || "").trim().toUpperCase();
  const person = document.getElementById("c_customer_type_person");
  const company = document.getElementById("c_customer_type_company");
  if(v === "PERSON"){
    if(person) person.checked = true;
  }else if(company){
    company.checked = true;
  }
}

function custSyncUsciRequiredHint_(){
  const lbl = document.getElementById("c_consignee_usci_label");
  const sel = document.getElementById("c_country");
  if(!lbl || !sel) return;
  const required = custIsChinaCountry_(sel.value) && custGetCustomerType_() === "COMPANY";
  lbl.textContent = required ? "統一社會信用代碼 (USCI) *" : "統一社會信用代碼 (USCI)";
}

function custSyncCountryPanels_(){
  const twRow = document.getElementById("c_tw_invoice_row");
  const ciSec = document.getElementById("c_ci_export_section");
  const sel = document.getElementById("c_country");
  const country = String(sel?.value || "").trim();
  const isTw = custIsTaiwanCountry_(country);
  const showCi = !!country && !isTw;
  if(twRow) twRow.style.display = isTw ? "block" : "none";
  if(ciSec) ciSec.style.display = showCi ? "block" : "none";
  custSyncUsciRequiredHint_();
}

function custValidateCustomerForm_(){
  const country = String(c_country?.value || "").trim();
  if(custIsChinaCountry_(country) && custGetCustomerType_() === "COMPANY"){
    const usci = String(document.getElementById("c_consignee_usci")?.value || "").trim();
    if(!usci) return "中國＋公司：請填統一社會信用代碼 (USCI)";
  }
  return "";
}

/** @deprecated 相容舊名稱 */
function custSyncTwInvoiceRow_(){
  custSyncCountryPanels_();
}

/* ===== 經銷方案（月結回饋 + 累積金額制） ===== */
function custFmtDealerMoney_(n) {
  const v = Number(n || 0);
  return typeof formatMoney === "function" ? formatMoney(v) : v.toFixed(2);
}

function custFmtDealerTierLine_(label, rate) {
  const name = String(label || "").trim();
  const r = Number(rate || 0);
  if (!name && !(r > 0)) return "—";
  if (name && r > 0) return name + "（" + r + " 折）";
  if (name) return name;
  return r > 0 ? r + " 折" : "—";
}

async function custLoadDealerSchemeRows_() {
  try {
    const r = await callAPI({ action: "list_commercial_dealer_scheme_enriched" }, { method: "GET" });
    return (r?.data || []).filter(function (row) {
      return String(row.status || "").trim().toUpperCase() === "ACTIVE";
    });
  } catch (_e) {
    return [];
  }
}

function custFillDealerSchemeSelect_(el, schemeType, selected, activeRows) {
  if (!el) return;
  const sel = String(selected != null ? selected : el.value || "").trim().toUpperCase();
  const want = String(schemeType || "").trim().toUpperCase();
  const rows = (activeRows || []).filter(function (r) {
    const st = String(r.scheme_type || "MONTHLY_REBATE").trim().toUpperCase();
    return want === "CUMULATIVE_AMOUNT" ? st === "CUMULATIVE_AMOUNT" : st !== "CUMULATIVE_AMOUNT";
  });
  let html = '<option value="">（未設定）</option>';
  rows.forEach(function (r) {
    const id = String(r.scheme_id || "").trim().toUpperCase();
    const label = id + " " + String(r.scheme_name || "");
    html += '<option value="' + custEscHtml_(id) + '"' + (id === sel ? " selected" : "") + ">" + custEscHtml_(label) + "</option>";
  });
  if (sel && !rows.some(function (r) { return String(r.scheme_id || "").trim().toUpperCase() === sel; })) {
    html += '<option value="' + custEscHtml_(sel) + '" selected>' + custEscHtml_(sel) + "｜（非生效）</option>";
  }
  el.innerHTML = html;
}

async function custRefreshDealerSchemeSelects_(rebateSelected, cumulativeSelected) {
  const rows = await custLoadDealerSchemeRows_();
  const rebateEl = document.getElementById("c_dealer_rebate_scheme_id");
  const cumEl = document.getElementById("c_dealer_cumulative_scheme_id");
  custFillDealerSchemeSelect_(rebateEl, "MONTHLY_REBATE", rebateSelected, rows);
  custFillDealerSchemeSelect_(cumEl, "CUMULATIVE_AMOUNT", cumulativeSelected, rows);
}

/** @deprecated 相容舊呼叫 */
async function custRefreshDealerSchemeSelect_(selected) {
  await custRefreshDealerSchemeSelects_(selected, null);
}

function custResolveRebateSchemeId_(row) {
  const c = row || {};
  return String(c.dealer_rebate_scheme_id || c.dealer_scheme_id || "").trim().toUpperCase();
}

function custSetDealerFields_(c) {
  const row = c || {};
  const rebateEl = document.getElementById("c_dealer_rebate_scheme_id");
  if (rebateEl) rebateEl.value = custResolveRebateSchemeId_(row);
  const cumEl = document.getElementById("c_dealer_cumulative_scheme_id");
  if (cumEl) cumEl.value = String(row.dealer_cumulative_scheme_id || "").trim().toUpperCase();
  const modeEl = document.getElementById("c_dealer_rebate_settle_mode");
  if (modeEl) modeEl.value = String(row.dealer_rebate_settle_mode || "CREDIT_NOTE").trim().toUpperCase() || "CREDIT_NOTE";
  const balEl = document.getElementById("c_dealer_rebate_credit_balance");
  if (balEl) balEl.value = custFmtDealerMoney_(row.dealer_rebate_credit_balance);
  const startedEl = document.getElementById("c_dealer_cumulative_started_at");
  if (startedEl) startedEl.value = String(row.dealer_cumulative_started_at || "").slice(0, 10);
  const cumAmtEl = document.getElementById("c_dealer_cumulative_amount");
  if (cumAmtEl) cumAmtEl.value = custFmtDealerMoney_(row.dealer_cumulative_amount);
  const tierEl = document.getElementById("c_dealer_cumulative_tier_display");
  if (tierEl) {
    const cumScheme = String(row.dealer_cumulative_scheme_id || "").trim();
    tierEl.value = cumScheme
      ? custFmtDealerTierLine_(row.dealer_cumulative_tier_label, row.dealer_cumulative_price_rate)
      : "—";
  }
  const pendingEl = document.getElementById("c_dealer_cumulative_pending_display");
  if (pendingEl) {
    const cumScheme = String(row.dealer_cumulative_scheme_id || "").trim();
    if (!cumScheme) {
      pendingEl.value = "—";
    } else {
      const pending = custFmtDealerTierLine_(
        row.dealer_cumulative_pending_tier_label,
        row.dealer_cumulative_pending_price_rate
      );
      pendingEl.value = pending === "—" ? "—" : pending + "（次月生效）";
    }
  }
}

function custSchemeNameById_(rows, id) {
  const want = String(id || "").trim().toUpperCase();
  if (!want) return "";
  const hit = (rows || []).find(function (r) {
    return String(r.scheme_id || "").trim().toUpperCase() === want;
  });
  return hit ? String(hit.scheme_name || "").trim() : "";
}

async function custRenderDealerSummaryReadOnly_(c) {
  const row = c || {};
  const schemeRows = await custLoadDealerSchemeRows_();
  const rebateId = custResolveRebateSchemeId_(row);
  const cumId = String(row.dealer_cumulative_scheme_id || "").trim().toUpperCase();
  const rebateName = rebateId ? custSchemeNameById_(schemeRows, rebateId) : "";
  const cumName = cumId ? custSchemeNameById_(schemeRows, cumId) : "";
  const credit = Number(row.dealer_rebate_credit_balance || 0);

  const elRebate = document.getElementById("c_dealer_summary_rebate");
  const elCum = document.getElementById("c_dealer_summary_cumulative");
  const elAmt = document.getElementById("c_dealer_summary_cumulative_amt");
  const elTier = document.getElementById("c_dealer_summary_tier");
  const elCredit = document.getElementById("c_dealer_summary_credit");

  if (elRebate) {
    if (!rebateId) elRebate.textContent = "—";
    else elRebate.textContent = rebateName ? rebateId + " " + rebateName : rebateId;
  }
  if (elCum) {
    if (!cumId) elCum.textContent = "—";
    else elCum.textContent = cumName ? cumId + " " + cumName : cumId;
  }

  if (elAmt) {
    elAmt.textContent = cumId ? custFmtDealerMoney_(row.dealer_cumulative_amount) : "—";
  }
  if (elTier) {
    if (!cumId) elTier.textContent = "—";
    else {
      const tier = custFmtDealerTierLine_(row.dealer_cumulative_tier_label, row.dealer_cumulative_price_rate);
      elTier.textContent = tier === "—" ? "—" : tier;
    }
  }
  if (elCredit) {
    elCredit.textContent =
      credit > 0 || rebateId ? custFmtDealerMoney_(row.dealer_rebate_credit_balance) : "—";
  }
}

function custClearDealerSummaryReadOnly_() {
  ["c_dealer_summary_rebate", "c_dealer_summary_cumulative", "c_dealer_summary_cumulative_amt", "c_dealer_summary_tier", "c_dealer_summary_credit"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.textContent = "—";
  });
}

function custGoDealerCustomerSettings_(customerId) {
  const cid = String(customerId || document.getElementById("c_id")?.value || "").trim();
  if (!cid) return showToast("請先載入客戶", "error");
  if (typeof navigate !== "function") return;
  try {
    sessionStorage.setItem("erp_dealer_customer_preset", cid);
  } catch (_e) {}
  navigate("commercial_dealer_customer");
}

async function custMaybeSyncCumulativeTierDisplay_(row) {
  const cid = String(row?.customer_id || "").trim().toUpperCase();
  const schemeId = String(row?.dealer_cumulative_scheme_id || "").trim();
  if (!cid || !schemeId) return row;
  try {
    const r = await callAPI(
      {
        action: "sync_customer_cumulative_tier",
        customer_id: cid,
        updated_by: typeof getCurrentUser === "function" ? getCurrentUser() : ""
      },
      { method: "POST", silent: true }
    );
    if (!r) return row;
    const merged = Object.assign({}, row, {
      dealer_cumulative_amount:
        r.cumulative_after != null
          ? r.cumulative_after
          : r.recalc && r.recalc.cumulative_after != null
            ? r.recalc.cumulative_after
            : row.dealer_cumulative_amount,
      dealer_cumulative_tier_label: r.dealer_cumulative_tier_label || row.dealer_cumulative_tier_label,
      dealer_cumulative_price_rate:
        r.dealer_cumulative_price_rate != null ? r.dealer_cumulative_price_rate : row.dealer_cumulative_price_rate,
      dealer_cumulative_pending_tier_label:
        r.dealer_cumulative_pending_tier_label || row.dealer_cumulative_pending_tier_label,
      dealer_cumulative_pending_price_rate:
        r.dealer_cumulative_pending_price_rate != null
          ? r.dealer_cumulative_pending_price_rate
          : row.dealer_cumulative_pending_price_rate
    });
    await custRenderDealerSummaryReadOnly_(merged);
    return merged;
  } catch (_e) {
    return row;
  }
}

function custCollectDealerFields_() {
  const rebateSchemeId = String(document.getElementById("c_dealer_rebate_scheme_id")?.value || "").trim().toUpperCase();
  const cumulativeSchemeId = String(document.getElementById("c_dealer_cumulative_scheme_id")?.value || "").trim().toUpperCase();
  const startedRaw = String(document.getElementById("c_dealer_cumulative_started_at")?.value || "").trim();
  return {
    dealer_rebate_scheme_id: rebateSchemeId,
    dealer_scheme_id: rebateSchemeId,
    dealer_cumulative_scheme_id: cumulativeSchemeId,
    dealer_rebate_settle_mode: String(document.getElementById("c_dealer_rebate_settle_mode")?.value || "CREDIT_NOTE").trim().toUpperCase(),
    dealer_rebate_excluded: false,
    dealer_cumulative_started_at: startedRaw || null
  };
}

/** 儲存用：方案改（未設定）時一併清掉等級快照欄位 */
function custDealerFieldsForSave_() {
  const base = custCollectDealerFields_();
  if (!base.dealer_cumulative_scheme_id) {
    base.dealer_cumulative_tier_label = "";
    base.dealer_cumulative_price_rate = null;
    base.dealer_cumulative_pending_tier_label = "";
    base.dealer_cumulative_pending_price_rate = null;
    base.dealer_cumulative_started_at = null;
  }
  if (!base.dealer_rebate_scheme_id) {
    base.dealer_scheme_id = "";
  }
  return base;
}

function custOnDealerSchemeSelectChange_() {
  const cumScheme = String(document.getElementById("c_dealer_cumulative_scheme_id")?.value || "").trim();
  if (!cumScheme) {
    const tierEl = document.getElementById("c_dealer_cumulative_tier_display");
    const pendingEl = document.getElementById("c_dealer_cumulative_pending_display");
    const startedEl = document.getElementById("c_dealer_cumulative_started_at");
    if (tierEl) tierEl.value = "—";
    if (pendingEl) pendingEl.value = "—";
    if (startedEl) startedEl.value = "";
  }
}

function custClearDealerFields_() {
  custSetDealerFields_({
    dealer_rebate_scheme_id: "",
    dealer_scheme_id: "",
    dealer_cumulative_scheme_id: "",
    dealer_rebate_settle_mode: "CREDIT_NOTE",
    dealer_rebate_excluded: false,
    dealer_rebate_credit_balance: 0,
    dealer_cumulative_amount: 0,
    dealer_cumulative_tier_label: "",
    dealer_cumulative_price_rate: null,
    dealer_cumulative_pending_tier_label: "",
    dealer_cumulative_pending_price_rate: null,
    dealer_cumulative_started_at: ""
  });
}

async function customersInit(){
  bindUppercaseInput("c_id");
  bindAutoSearchToolbar_([
    ["search_customer_keyword", "input"],
    ["search_customer_category", "change"],
    ["search_customer_status", "change"]
  ], () => searchCustomers());
  if(typeof masterSearchStatusDefault_ === "function") masterSearchStatusDefault_("search_customer_status");
  await searchCustomers();
  clearCustomerForm();
  if(typeof bindStatusSelectLamp_ === "function") bindStatusSelectLamp_("c_status");
  if(typeof erpLockStatusSelect_ === "function") erpLockStatusSelect_("c_status");
}

function setCustomerButtons_(){
  const createBtn = document.getElementById("c_create_btn");
  const updateBtn = document.getElementById("c_update_btn");
  if(createBtn){
    createBtn.disabled = !!customerEditing;
    createBtn.title = customerEditing ? "已載入客戶，請用更新" : "建立新客戶";
  }
  if(updateBtn){
    updateBtn.disabled = !customerEditing;
    updateBtn.title = customerEditing ? "更新此客戶" : "請先載入客戶";
  }
  custSyncRecipientPanel_();
}

function custEscHtml_(s){
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function custSyncRecipientPanel_(){
  const hint = document.getElementById("c_recipient_hint");
  const panel = document.getElementById("c_recipient_panel");
  const on = !!customerEditing;
  if(hint) hint.style.display = on ? "none" : "block";
  if(panel) panel.style.display = on ? "block" : "none";
}

function custClearRecipientForm_(){
  custEditingRecipientId_ = "";
  custClear_(["cr_id", "cr_name", "cr_name_en", "cr_address", "cr_phone", "cr_remark"]);
  const saveBtn = document.getElementById("cr_save_btn");
  if(saveBtn) saveBtn.textContent = "新增收件人";
}

async function custLoadRecipients_(customerId){
  const cid = String(customerId || "").trim();
  if(!cid){
    custRecipients_ = [];
    custRenderRecipients_([]);
    return;
  }
  const all = await getAll("customer_recipient");
  custRecipients_ = all.filter(r =>
    String(r.customer_id || "").trim() === cid &&
    String(r.status || "").trim().toUpperCase() !== "VOID"
  );
  custRenderRecipients_(custRecipients_);
}

function custRecipientNameCellHtml_(r){
  const zh = custEscHtml_(String(r.recipient_name || "").trim() || "—");
  const enRaw = String(r.recipient_name_en || "").trim();
  const en = enRaw ? custEscHtml_(enRaw) : "";
  return `
    <td class="cust-recipient-name-cell">
      <div class="cust-recipient-name-desk">
        <div class="cust-recipient-name-zh">${zh}</div>
        ${en ? `<div class="cust-recipient-name-en">${en}</div>` : ""}
      </div>
    </td>
  `;
}

function custRenderRecipients_(rows){
  const tbody = document.getElementById("cRecipientBody");
  if(!tbody) return;
  const list = Array.isArray(rows) ? rows : [];
  tbody.innerHTML = "";
  if(!list.length){
    tbody.innerHTML = '<tr class="cust-recipient-empty"><td colspan="5" style="text-align:center;color:#64748b;padding:12px;">尚無收件人</td></tr>';
    return;
  }
  list.forEach(r => {
    const rid = String(r.recipient_id || "").trim();
    tbody.innerHTML += `
      <tr class="cust-recipient-row">
        ${custRecipientNameCellHtml_(r)}
        <td data-label="地址">${custEscHtml_(r.address)}</td>
        <td data-label="電話">${custEscHtml_(r.phone)}</td>
        <td data-label="備註">${custEscHtml_(r.remark)}</td>
        <td class="cust-recipient-actions">
          <button type="button" class="btn-edit" onclick="custEditRecipient_('${custEscHtml_(rid)}')">編輯</button>
          <button type="button" class="btn-secondary" onclick="custDeleteRecipient_('${custEscHtml_(rid)}')">刪除</button>
        </td>
      </tr>
    `;
  });
}

function custEditRecipient_(recipientId){
  const rid = String(recipientId || "").trim();
  const row = custRecipients_.find(r => String(r.recipient_id || "").trim() === rid);
  if(!row) return showToast("找不到收件人", "error");
  custEditingRecipientId_ = rid;
  custSetV_("cr_id", rid);
  custSetV_("cr_name", row.recipient_name || "");
  custSetV_("cr_name_en", row.recipient_name_en || "");
  custSetV_("cr_address", row.address || "");
  custSetV_("cr_phone", row.phone || "");
  custSetV_("cr_remark", row.remark || "");
  const saveBtn = document.getElementById("cr_save_btn");
  if(saveBtn) saveBtn.textContent = "更新收件人";
  try{
    document.getElementById("cr_name")?.focus();
  }catch(_e){}
}

async function custSaveRecipient_(triggerEl){
  if(!customerEditing) return showToast("請先載入客戶", "error");
  const customer_id = String(c_id?.value || "").trim();
  if(!customer_id) return showToast("缺少客戶 ID", "error");
  const recipient_name = String(document.getElementById("cr_name")?.value || "").trim();
  const recipient_name_en = String(document.getElementById("cr_name_en")?.value || "").trim();
  const address = String(document.getElementById("cr_address")?.value || "").trim();
  const phone = String(document.getElementById("cr_phone")?.value || "").trim();
  const remark = String(document.getElementById("cr_remark")?.value || "").trim();
  if(!recipient_name && !recipient_name_en) return showToast("請填中文或英文姓名", "error");
  if(!address) return showToast("請填地址", "error");

  showSaveHint(triggerEl);
  try{
    const editingId = String(custEditingRecipientId_ || document.getElementById("cr_id")?.value || "").trim();
    if(editingId){
      await updateRecord("customer_recipient", "recipient_id", editingId, {
        customer_id,
        recipient_name,
        recipient_name_en,
        address,
        phone,
        remark,
        status: "ACTIVE",
        updated_by: getCurrentUser()
      });
      showToast("收件人已更新");
    }else{
      let recipient_id = String(document.getElementById("cr_id")?.value || "").trim().toUpperCase();
      if(!recipient_id){
        recipient_id = typeof generateShortId === "function" ? generateShortId("CR") : "";
      }
      if(!recipient_id) return showToast("收件人 ID 產生失敗", "error");
      await createRecord("customer_recipient", {
        recipient_id,
        customer_id,
        recipient_name,
        recipient_name_en,
        address,
        phone,
        remark,
        status: "ACTIVE",
        created_by: getCurrentUser(),
        created_at: nowIsoTaipei(),
        updated_by: "",
        updated_at: ""
      });
      showToast("收件人已新增");
    }
    custClearRecipientForm_();
    await custLoadRecipients_(customer_id);
  } finally {
    hideSaveHint();
  }
}

async function custDeleteRecipient_(recipientId){
  const rid = String(recipientId || "").trim();
  if(!rid) return;
  if(!confirm("確定刪除此收件人？")) return;
  await deleteRecord("customer_recipient", "recipient_id", rid);
  if(custEditingRecipientId_ === rid) custClearRecipientForm_();
  await custLoadRecipients_(String(c_id?.value || "").trim());
  showToast("收件人已刪除");
}

/* ===== 建立 ===== */
async function createCustomer(triggerEl){

  let customer_id = c_id.value.trim().toUpperCase();
  // ID 預設自動產生：若被清空，直接補回，不用跳「缺少必填：ID」
  if(!customer_id){
    customer_id = erpInitAutoId_("c_id", "master", "C");
  }else{
    c_id.value = customer_id;
  }
  const customer_name = c_name.value.trim();
  const category = (document.getElementById("c_category")?.value || "").trim();
  const country = c_country.value.trim();
  const remark = c_remark.value.trim();

  // 主檔一致化：ID 多為自動產生，缺漏時仍提示；但一般必填以「名稱/分類」為主
  if(!customer_name) return showToast("缺少必填：客戶名稱","error");
  if(!category)
    return showToast("缺少必填：分類","error");
  if(!customer_id) return showToast("客戶ID 產生失敗，請重新整理後再試","error");
  if((category === "其他" || country === "其他") && !remark)
    return showToast("分類/國家 選「其他」時，請填寫備註/原因","error");
  const formErr = custValidateCustomerForm_();
  if(formErr) return showToast(formErr, "error");

  if(customer_id.length > CUSTOMER_RULES.idMax)
    return showToast("ID 長度過長（最多 30 字元）","error");

  if(!CUSTOMER_RULES.idRegex.test(customer_id))
    return showToast("ID 只能使用 A-Z 0-9 _ -","error");

  showSaveHint(triggerEl);
  try {
  const list = await getAll("customer");
  if(list.some(c=>c.customer_id===customer_id))
    return showToast("客戶ID 已存在","error");

  const customer = {
    customer_id,
    customer_name,
    customer_type: custGetCustomerType_(),
    category,
    contact_person: c_contact.value.trim(),
    phone: c_phone.value.trim(),
    email: c_email.value.trim(),
    tax_id: (document.getElementById("c_tax_id")?.value || "").trim(),
    invoice_title: (document.getElementById("c_invoice_title")?.value || "").trim(),
    invoice_email: (document.getElementById("c_invoice_email")?.value || "").trim(),
    invoice_type_default: (document.getElementById("c_invoice_type_default")?.value || "B2B").trim(),
    invoice_name_en: (document.getElementById("c_invoice_name_en")?.value || "").trim(),
    invoice_address_en: (document.getElementById("c_invoice_address_en")?.value || "").trim(),
    consignee_id_no: (document.getElementById("c_consignee_id_no")?.value || "").trim(),
    consignee_usci: (document.getElementById("c_consignee_usci")?.value || "").trim(),
    address: c_address.value.trim(),
    country,
    status: c_status.value,
    remark,
    created_by: getCurrentUser(),
    created_at: nowIsoTaipei(),
    updated_by: "",
    updated_at: ""
  };

  await createRecord("customer", customer);

  await renderCustomers();
  await loadCustomer(customer_id);

  showToast("客戶建立成功，可繼續新增收件人");
  } finally { hideSaveHint(); }
  setCustomerButtons_();
}

/* ===== 更新 ===== */
async function updateCustomer(triggerEl){

  if(!customerEditing)
    return showToast("請先選擇客戶","error");

  showSaveHint(triggerEl);
  try {
  const customer_id = c_id.value.trim();
  const customer = await getOne("customer","customer_id",customer_id);

  if(!customer)
    return showToast("找不到客戶","error");

  const newStatus = c_status.value;
  // 狀態（ACTIVE/INACTIVE）僅 CEO/GA/ADMIN 可改（主檔）
  if(String(customer.status||"") !== String(newStatus||"")){
    if(typeof erpCanChangeMasterStatus_ === "function" && !erpCanChangeMasterStatus_()){
      return showToast("僅 CEO／GA／ADMIN 可修改客戶狀態（ACTIVE/INACTIVE）。", "error");
    }
  }
  const category = (document.getElementById("c_category")?.value || "").trim();
  const country = c_country.value.trim();
  const remark = c_remark.value.trim();
  if(!category)
    return showToast("缺少必填：分類","error");
  if((category === "其他" || country === "其他") && !remark)
    return showToast("分類/國家 選「其他」時，請填寫備註/原因","error");
  const formErr = custValidateCustomerForm_();
  if(formErr) return showToast(formErr, "error");

  // 停用策略建議：允許停用，但若已被使用則提醒確認（不再硬性阻擋）
  if(customer.status==="ACTIVE" && newStatus==="INACTIVE"){
    const isUsed = await isIdUsedInAny(customer_id, [
      { type:"sales_order", field:"customer_id" },
      { type:"shipment", field:"customer_id" }
    ]);

    if(isUsed){
      const ok = window.erpConfirmActionKey_("confirm.master.deactivate.used", {
        name: "此客戶",
        usedHint: "可能已有出貨紀錄",
        fallback: "此客戶已被使用（可能已有出貨紀錄）。\n\n仍要停用嗎？停用後將不能在新單據被選用，但歷史紀錄會保留。"
      });
      if(!ok) return;
    }else{
      const ok = window.erpConfirmActionKey_("confirm.master.deactivate.basic", {
        name: "此客戶",
        fallback: "確定要將此客戶停用（INACTIVE）嗎？"
      });
      if(!ok) return;
    }
  }

  const newData = {
    customer_name: c_name.value.trim(),
    customer_type: custGetCustomerType_(),
    category,
    contact_person: c_contact.value.trim(),
    phone: c_phone.value.trim(),
    email: c_email.value.trim(),
    tax_id: (document.getElementById("c_tax_id")?.value || "").trim(),
    invoice_title: (document.getElementById("c_invoice_title")?.value || "").trim(),
    invoice_email: (document.getElementById("c_invoice_email")?.value || "").trim(),
    invoice_type_default: (document.getElementById("c_invoice_type_default")?.value || "B2B").trim(),
    invoice_name_en: (document.getElementById("c_invoice_name_en")?.value || "").trim(),
    invoice_address_en: (document.getElementById("c_invoice_address_en")?.value || "").trim(),
    consignee_id_no: (document.getElementById("c_consignee_id_no")?.value || "").trim(),
    consignee_usci: (document.getElementById("c_consignee_usci")?.value || "").trim(),
    address: c_address.value.trim(),
    country,
    status: newStatus,
    remark,
    updated_by: getCurrentUser(),
    updated_at: nowIsoTaipei()
  };
  // 主檔一致化：更新也做必填檢核（避免更新成空值）
  if(!newData.customer_name)
    return showToast("缺少必填：客戶名稱","error");

  await updateRecord("customer", "customer_id", customer_id, newData);

  await renderCustomers();
  await loadCustomer(customer_id);

  showToast("客戶更新成功");
  } finally { hideSaveHint(); }
  setCustomerButtons_();
}

/* ===== 清除表單 ===== */
function clearCustomerForm(){
  customerEditing=false;
  c_id.disabled=false;

  custClear_(["c_id","c_name","c_contact","c_phone","c_email","c_tax_id","c_invoice_title","c_invoice_email","c_invoice_name_en","c_invoice_address_en","c_consignee_id_no","c_consignee_usci","c_address","c_remark"]);
  custClearRecipientForm_();
  custRecipients_ = [];
  custRenderRecipients_([]);
  custClearDealerSummaryReadOnly_();

  syncSelectWithLegacy_("c_category", "");
  syncSelectWithLegacy_("c_country", "");
  syncSelectWithLegacy_("c_invoice_type_default", "B2B");
  custSetCustomerType_("COMPANY");
  custSyncCountryPanels_();

  c_status.value="ACTIVE";
  erpInitAutoId_("c_id", { gen: () => (typeof generateShortId === "function" ? generateShortId("C") : ""), force: true });
  if(typeof syncStatusSelectLamp_ === "function") syncStatusSelectLamp_("c_status");
  if(typeof erpLockStatusSelect_ === "function") erpLockStatusSelect_("c_status");
  setCustomerButtons_();
}

function customerSnapshotFromForm_(){
  try{
    const v = (id) => (typeof window.erpVTrimById_ === "function") ? window.erpVTrimById_(id) : String(document.getElementById(id)?.value || "").trim();
    const vU = (id) => (typeof window.erpVTrimUpperById_ === "function") ? window.erpVTrimUpperById_(id) : String(document.getElementById(id)?.value || "").trim().toUpperCase();
    return JSON.stringify({
      customer_id: vU("c_id"),
      customer_name: v("c_name"),
      customer_type: custGetCustomerType_(),
      category: v("c_category"),
      contact_person: v("c_contact"),
      phone: v("c_phone"),
      email: v("c_email"),
      tax_id: v("c_tax_id"),
      invoice_title: v("c_invoice_title"),
      invoice_email: v("c_invoice_email"),
      invoice_type_default: v("c_invoice_type_default"),
      invoice_name_en: v("c_invoice_name_en"),
      invoice_address_en: v("c_invoice_address_en"),
      consignee_id_no: v("c_consignee_id_no"),
      consignee_usci: v("c_consignee_usci"),
      address: v("c_address"),
      country: v("c_country"),
      status: v("c_status"),
      remark: v("c_remark")
    });
  }catch(_e){
    return "";
  }
}

/* ===== 載入 ===== */
async function loadCustomer(id){
  const nextId = String(id || "").trim();
  if(!nextId) return;
  const curIdEarly = String(c_id?.value || "").trim();
  if(
    customerEditing &&
    typeof erpTryToggleCloseMasterListRow_ === "function" &&
    erpTryToggleCloseMasterListRow_(curIdEarly, nextId, "customer_edit_card", clearCustomerForm, "customerTableBody")
  ){
    return;
  }
  if(customerLoadInFlight_){
    customerPendingLoadId_ = nextId;
    showToast(`載入中：已排隊 ${nextId}（完成後自動載入）`, "warn", 6000);
    return;
  }
  try{
    const curId = String(c_id?.value || "").trim();
    const ok = (typeof window.erpGuardMasterLoad_ === "function")
      ? window.erpGuardMasterLoad_({
        nextId,
        curId,
        key: "customer",
        isEditing: !!customerEditing,
        getCurrentSnapshot: () => customerSnapshotFromForm_(),
        getLoadedSnapshot: () => (window.erpDirty_ ? window.erpDirty_.getLoaded("customer") : ""),
        normalizeId: window.erpNormalizeIdUpper_
      })
      : true;
    if(!ok) return;
  }catch(_e0){}
  customerLoadInFlight_ = true;
  try{
    if(typeof scrollToMasterForm_ === "function") scrollToMasterForm_("customer_edit_card");
    const c = await getOne("customer","customer_id",nextId);
    if(!c) return;

    customerEditing=true;

    c_id.value = c.customer_id;
    c_name.value = c.customer_name;
    custSetCustomerType_(c.customer_type || "COMPANY");
    syncSelectWithLegacy_("c_category", c.category);
    c_contact.value = c.contact_person;
    c_phone.value = c.phone;
    c_email.value = c.email;
    if(document.getElementById("c_tax_id")) document.getElementById("c_tax_id").value = c.tax_id || "";
    if(document.getElementById("c_invoice_title")) document.getElementById("c_invoice_title").value = c.invoice_title || "";
    if(document.getElementById("c_invoice_email")) document.getElementById("c_invoice_email").value = c.invoice_email || "";
    syncSelectWithLegacy_("c_invoice_type_default", c.invoice_type_default || "B2B");
    if(document.getElementById("c_invoice_name_en")) document.getElementById("c_invoice_name_en").value = c.invoice_name_en || "";
    if(document.getElementById("c_invoice_address_en")) document.getElementById("c_invoice_address_en").value = c.invoice_address_en || "";
    if(document.getElementById("c_consignee_id_no")) document.getElementById("c_consignee_id_no").value = c.consignee_id_no || "";
    if(document.getElementById("c_consignee_usci")) document.getElementById("c_consignee_usci").value = c.consignee_usci || "";
    c_address.value = c.address;
    syncSelectWithLegacy_("c_country", c.country);
    custSyncCountryPanels_();
    c_status.value = c.status;
    c_remark.value = c.remark;
    let merged = c;
    merged = await custMaybeSyncCumulativeTierDisplay_(c);
    await custRenderDealerSummaryReadOnly_(merged);
    if(typeof syncStatusSelectLamp_ === "function") syncStatusSelectLamp_("c_status");
    if(typeof erpLockStatusSelect_ === "function") erpLockStatusSelect_("c_status");

    c_id.disabled=true;
    if(typeof scrollToMasterForm_ === "function") scrollToMasterForm_("customer_edit_card");
    try{
      if(window.erpDirty_){
        window.erpDirty_.bind("customer", customerSnapshotFromForm_);
        window.erpDirty_.markSaved("customer");
      }
    }catch(_eS){}
    await custLoadRecipients_(nextId);
    setCustomerButtons_();
    if(typeof erpSyncListRowHighlight_ === "function") erpSyncListRowHighlight_("customerTableBody", "data-row-id", nextId);
  } finally {
    customerLoadInFlight_ = false;
    try{
      const next = String(customerPendingLoadId_ || "").trim();
      customerPendingLoadId_ = "";
      if(next && next !== nextId){
        setTimeout(function(){ try{ loadCustomer(next); }catch(_e){} }, 0);
      }
    }catch(_eNext){}
  }
}

/* ===== 搜尋 ===== */
async function searchCustomers(){
  setTbodyLoading_("customerTableBody", 7);

  const kw = (document.getElementById("search_customer_keyword")?.value || "").trim().toLowerCase();
  const cat = (document.getElementById("search_customer_category")?.value || "").trim();
  const status = document.getElementById("search_customer_status")?.value || "";

  const result = (await getAll("customer")).filter(c=>{
    if(cat && String(c.category || "") !== cat) return false;
    const matchKw = !kw ||
      c.customer_id.toLowerCase().includes(kw) ||
      c.customer_name.toLowerCase().includes(kw) ||
      String(c.category || "").toLowerCase().includes(kw) ||
      String(c.contact_person || "").toLowerCase().includes(kw) ||
      String(c.phone || "").toLowerCase().includes(kw) ||
      String(c.email || "").toLowerCase().includes(kw) ||
      String(c.tax_id || "").toLowerCase().includes(kw) ||
      String(c.invoice_title || "").toLowerCase().includes(kw) ||
      String(c.remark || "").toLowerCase().includes(kw);
    return matchKw && (!status || c.status === status);
  });

  renderCustomers(result);
}

async function resetCustomerSearch(){
  custClear_(["search_customer_keyword","search_customer_category"]);
  if(typeof masterSearchStatusDefault_ === "function") masterSearchStatusDefault_("search_customer_status");
  await searchCustomers();
  if(typeof resetMasterListView_ === "function") resetMasterListView_("customer_edit_card", clearCustomerForm);
}

/* ===== 排序 ===== */
let customerSort = { field:"", asc:true };

async function sortCustomers(field){
  setTbodyLoading_("customerTableBody", 7);
  const list = [...(await getAll("customer"))];

  if(customerSort.field===field){
    customerSort.asc=!customerSort.asc;
  }else{
    customerSort.field=field;
    customerSort.asc=true;
  }

  list.sort((a,b)=>{
    let valA=a[field]??"";
    let valB=b[field]??"";

    if(typeof valA==="string") valA=valA.toLowerCase();
    if(typeof valB==="string") valB=valB.toLowerCase();

    if(valA>valB) return customerSort.asc?1:-1;
    if(valA<valB) return customerSort.asc?-1:1;
    return 0;
  });

  renderCustomers(list);
}

/* ===== Render ===== */
async function renderCustomers(list=null){

  const tbody=document.getElementById("customerTableBody");
  if(!tbody) return;

  if(!list){
    setTbodyLoading_(tbody, 7);
    list = await getAll("customer");
  }
  if (!customerSort.field && typeof erpSortRowsNewestFirst_ === "function") {
    list = erpSortRowsNewestFirst_(list, ["updated_at", "created_at"], "customer_id");
  }

  tbody.innerHTML="";
  if(!list.length){
    tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#64748b;padding:24px;">尚無客戶。請在上方表單填寫後按「建立」新增第一筆客戶。</td></tr>';
    return;
  }

  list.forEach(c=>{

    const badge = termStatusLampHtml(c.status);
    const cid = String(c.customer_id || "");
    const safeCid = cid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const selId = String(document.getElementById("c_id")?.value || "").trim().toUpperCase();
    const open = selId === cid.trim().toUpperCase();

    tbody.innerHTML+=`
      <tr class="erp-list-row-selectable${open ? " erp-list-row-open" : ""}" data-row-id="${cid.replace(/"/g, "&quot;")}" onclick="loadCustomer('${safeCid}')">
        ${typeof masterListIdNameCells_ === "function" ? masterListIdNameCells_(c.customer_id, c.customer_name) : `<td>${c.customer_id}</td><td>${c.customer_name}</td>`}
        <td>${c.category||""}</td>
        ${typeof masterListContactPhoneCells_ === "function" ? masterListContactPhoneCells_(c.contact_person, c.phone) : `<td>${c.contact_person||""}</td><td>${c.phone||""}</td>`}
        <td>${c.country||""}</td>
        <td class="col-status">${badge}</td>
      </tr>
    `;
  });
}