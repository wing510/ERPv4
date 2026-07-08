/**
 * Commercial Invoice 商業發票（獨立模組）
 * 以 POSTED 出貨單為主；開立／編輯／PDF
 */
let invCiMap_ = Object.create(null);
let invCiBlankById_ = Object.create(null);
let invCiStandaloneList_ = [];
let invCiMapLoadedAt_ = 0;
let invShipments_ = [];
let invCustomers_ = [];
let invProducts_ = [];
let invSalesItems_ = [];
let invDraftLines_ = [];
let invCiLines_ = [];
let invCiLoadedId_ = "";
let invCiSaveInFlight_ = false;
let invCompanyProfile_ = null;
let invSellerSnapshot_ = {};
let invLoadInFlight_ = false;
/** 空白開立：不連結出貨單，手填後儲存至雲端 */
let invStandaloneMode_ = false;
let invSoOrder_ = null;
let invStandaloneDraftTimer_ = null;
/** 出貨 CI：收件人中文名（PDF 顯示 English (中文)） */
let invCiBuyerNameZh_ = "";

const INV_SHIPMENT_BUYER_FIELD_IDS_ = [
  "inv_ci_buyer_name", "inv_ci_buyer_id_no", "inv_ci_buyer_usci",
  "inv_ci_buyer_phone", "inv_ci_buyer_country", "inv_ci_buyer_address"
];

const INV_STANDALONE_DRAFT_FIELD_IDS_ = [
  "inv_ci_no", "inv_ci_date", "inv_ci_currency", "inv_ci_waybill", "inv_ci_origin",
  "inv_ci_incoterms", "inv_ci_payment_terms",
  "inv_ci_buyer_name", "inv_ci_buyer_address", "inv_ci_buyer_phone", "inv_ci_buyer_country",
  "inv_ci_buyer_id_no", "inv_ci_buyer_usci",
  "inv_ci_remark", "inv_ci_signature_date"
];

function invStandaloneDraftStorageKey_(){
  const u = (typeof getCurrentUser === "function" ? getCurrentUser() : "") || "guest";
  return "erp_ci_standalone_draft:" + String(u).trim().toUpperCase();
}

function invCaptureStandaloneDraft_(){
  invCiSyncLinesFromTable_();
  const fields = {};
  INV_STANDALONE_DRAFT_FIELD_IDS_.forEach(id => {
    fields[id] = String(document.getElementById(id)?.value || "");
  });
  return {
    saved_at: (typeof nowIso16 === "function" ? nowIso16() : new Date().toISOString()),
    fields,
    lines: (invCiLines_ || []).map(ln => ({
      description_en: String(ln.description_en || ""),
      qty: Number(ln.qty || 0),
      unit: String(ln.unit || ""),
      unit_price: Number(ln.unit_price || 0),
      amount: Number(ln.amount || 0)
    }))
  };
}

function invStandaloneDraftHasContent_(draft){
  const d = draft || {};
  const fields = d.fields || {};
  const hasField = INV_STANDALONE_DRAFT_FIELD_IDS_.some(id => String(fields[id] || "").trim());
  const hasLine = (d.lines || []).some(ln =>
    String(ln.description_en || "").trim() ||
    Number(ln.qty || 0) > 0 ||
    Number(ln.unit_price || 0) > 0
  );
  return hasField || hasLine;
}

function invLoadStandaloneDraftFromStorage_(){
  try{
    if(typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(invStandaloneDraftStorageKey_());
    if(!raw) return null;
    const draft = JSON.parse(raw);
    return invStandaloneDraftHasContent_(draft) ? draft : null;
  }catch(_e){
    return null;
  }
}

function invApplyStandaloneDraft_(draft){
  const d = draft || {};
  const fields = d.fields || {};
  INV_STANDALONE_DRAFT_FIELD_IDS_.forEach(id => {
    if(Object.prototype.hasOwnProperty.call(fields, id)){
      if(id === "inv_ci_currency" || id === "inv_ci_incoterms" || id === "inv_ci_payment_terms"){
        invSetSelectValue_(id, fields[id]);
      }else{
        invSetV_(id, fields[id]);
      }
    }
  });
  const lines = Array.isArray(d.lines) && d.lines.length
    ? d.lines
    : [{ description_en: "", qty: 1, unit: "", unit_price: 0, amount: 0 }];
  invRenderCiLinesTable_(lines);
}

function invSaveStandaloneDraft_(silent){
  if(!invStandaloneMode_) return false;
  const draft = invCaptureStandaloneDraft_();
  if(!invStandaloneDraftHasContent_(draft)){
    invClearStandaloneDraft_(true);
    if(!silent) showToast("目前沒有可暫存的內容", "warn");
    return false;
  }
  try{
    if(typeof localStorage === "undefined") throw new Error("no localStorage");
    localStorage.setItem(invStandaloneDraftStorageKey_(), JSON.stringify(draft));
    if(!silent) showToast("已暫存至本機（備份用；正式請按「儲存至雲端」）", "success", 4500);
    return true;
  }catch(_e){
    if(!silent) showToast("暫存失敗（瀏覽器可能已停用本地儲存）", "error");
    return false;
  }
}

function invClearStandaloneDraft_(silent){
  try{
    if(typeof localStorage !== "undefined"){
      localStorage.removeItem(invStandaloneDraftStorageKey_());
    }
  }catch(_e){}
  if(!silent) showToast("已清除本機暫存", "success", 3000);
}

function invScheduleStandaloneDraftSave_(){
  if(!invStandaloneMode_) return;
  if(invStandaloneDraftTimer_) clearTimeout(invStandaloneDraftTimer_);
  invStandaloneDraftTimer_ = setTimeout(function(){
    invStandaloneDraftTimer_ = null;
    invSaveStandaloneDraft_(true);
  }, 800);
}

function invBindStandaloneDraftAutosave_(){
  const card = document.getElementById("invEditorCard");
  if(!card || card.dataset.standaloneDraftBound === "1") return;
  card.dataset.standaloneDraftBound = "1";
  card.addEventListener("input", invScheduleStandaloneDraftSave_);
  card.addEventListener("change", invScheduleStandaloneDraftSave_);
}

function invSetV_(id, v){
  const el = document.getElementById(id);
  if(el && "value" in el) el.value = v != null ? v : "";
}

function invSetCiMoney_(id, v){
  if(v == null || v === ""){
    invSetV_(id, "");
    return;
  }
  const n = Number(v);
  invSetV_(id, Number.isFinite(n) ? n : "");
}

function invOpenStandaloneCiEditorFromList_(tr){
  const id = String(tr?.getAttribute("data-row-id") || "").trim();
  if(!id) return;
  const cur = String(invCiLoadedId_ || "").trim();
  const card = document.getElementById("invEditorCard");
  const editorOpen = card && card.style.display !== "none" && invStandaloneMode_;
  if(
    editorOpen &&
    typeof erpListRowToggleClose_ === "function" &&
    erpListRowToggleClose_(cur, id)
  ){
    invCiLoadedId_ = "";
    if(card) card.style.display = "none";
    if(typeof erpSyncListRowHighlight_ === "function"){
      erpSyncListRowHighlight_("invBlankListBody", "data-row-id", "");
    }
    if(typeof scrollToEditorTop === "function") scrollToEditorTop();
    return;
  }
  invOpenStandaloneCiEditor_(id);
}

async function invFetchBlankCiWithLines_(ciId){
  const id = String(ciId || "").trim();
  let ci = invCiBlankById_[id] || null;
  let lines = [];
  let apiWarn = "";
  if(!id) return { ci, lines, apiWarn };
  try{
    const r = await callAPI({ action: "list_commercial_invoice_blank_by_ci", ci_id: id }, { method: "GET" });
    ci = r?.data || ci;
    lines = Array.isArray(r?.lines) ? r.lines : [];
  }catch(_e){
    apiWarn = "明細載入失敗，嘗試從快取補拉";
  }
  if(!lines.length){
    try{
      const all = await getAll("commercial_invoice_blank_line", { refresh: true }).catch(() => []);
      lines = (all || []).filter(function(ln){
        return String(ln.ci_id || "").trim() === id;
      });
    }catch(_e2){}
  }
  if(!lines.length){
    try{
      const legacy = await getAll("commercial_invoice_line", { refresh: true }).catch(() => []);
      lines = (legacy || []).filter(function(ln){
        return String(ln.ci_id || "").trim() === id;
      });
      if(lines.length && !apiWarn){
        apiWarn = "明細來自舊表 commercial_invoice_line，請儲存一次寫入新表";
      }
    }catch(_e3){}
  }
  return { ci, lines, apiWarn };
}

/** select：有選項則選中；無則追加自訂 option（舊資料相容） */
function invSetSelectValue_(id, v){
  const el = document.getElementById(id);
  if(!el || String(el.tagName || "").toUpperCase() !== "SELECT"){
    return invSetV_(id, v);
  }
  const s = String(v != null ? v : "").trim();
  if(!s){
    el.value = "";
    return;
  }
  const opts = Array.from(el.options || []);
  const hit = opts.find(o => String(o.value || "").trim() === s);
  if(hit){
    el.value = hit.value;
    return;
  }
  const opt = document.createElement("option");
  opt.value = s;
  opt.textContent = s + "（自訂）";
  el.appendChild(opt);
  el.value = s;
}

function invIsTaiwanCountry_(country){
  const c = String(country || "").trim();
  return c === "台灣" || c === "Taiwan" || c === "TW";
}

function invIsMainlandChinaCountry_(country){
  const c = String(country || "").trim().toLowerCase();
  if(!c) return false;
  if(c === "cn" || c === "prc" || c === "china" || c === "mainland china") return true;
  if(c.includes("中國") || c.includes("中国")) return true;
  return c === "chinese mainland" || c === "people's republic of china";
}

function invCiBuyerCountry_(){
  const fromForm = String(document.getElementById("inv_ci_buyer_country")?.value || "").trim();
  if(fromForm) return fromForm;
  const cid = String(document.getElementById("inv_customer_id")?.value || "").trim();
  const cust = (invCustomers_ || []).find(c => String(c?.customer_id || "") === cid);
  return String(cust?.country || "").trim();
}

/** 出口用 CI：台灣客戶不需開立 */
function invShipmentNeedsCi_(customer){
  return !invIsTaiwanCountry_(customer?.country);
}

function invResolveSoCurrency_(soOrder, customerId){
  const soCur = String(soOrder?.currency || "").trim().toUpperCase();
  const allowed = ["USD", "TWD", "CNY", "EUR"];
  if(allowed.includes(soCur)) return soCur;
  const cust = (invCustomers_ || []).find(c => String(c?.customer_id || "") === String(customerId || ""));
  if(invIsTaiwanCountry_(cust?.country)) return "TWD";
  return "USD";
}

function invApplySoCurrencyToCi_(soOrder, customerId){
  if(invStandaloneMode_) return;
  const cur = invResolveSoCurrency_(soOrder, customerId);
  invSetSelectValue_("inv_ci_currency", cur);
  const el = document.getElementById("inv_ci_currency");
  if(el) el.disabled = true;
}

function invSyncEditorActionButtons_(opts){
  const o = opts && typeof opts === "object" ? opts : {};
  const status = String(o.ci?.status || invGetCiStatusCode_() || "").trim().toUpperCase();
  const hasSavedCi = !!(o.ci?.ci_id || invCiLoadedId_);
  const voidBtn = document.getElementById("inv_ci_void_btn");
  if(voidBtn){
    voidBtn.style.display = (hasSavedCi && status !== "VOID") ? "" : "none";
  }
}

function invSetSellerSnapshot_(data){
  const d = data || {};
  const name = String(d.seller_company_name_en ?? d.company_name_en ?? "").trim();
  const address = String(d.seller_address_en ?? d.address ?? "").trim();
  const phone = String(d.seller_phone ?? d.phone ?? "").trim();
  const email = String(d.seller_email ?? d.email ?? "").trim();
  const taxId = String(d.seller_tax_id ?? d.tax_id ?? "").trim();
  invSellerSnapshot_ = {
    seller_company_name_en: name,
    seller_address_en: address,
    seller_phone: phone,
    seller_email: email,
    seller_tax_id: taxId
  };
}

function invResolveImageUrl_(raw){
  const u = String(raw || "").trim();
  if(!u) return "";
  if(/^data:image\//i.test(u)) return u;
  if(/^https?:\/\//i.test(u)) return u;
  try{ return new URL(u, String(location && location.href || "")).href; }catch(_e){ return u; }
}

function invGetCompanySealUrl_(){
  const cfg = (typeof window === "object" && window && window.__ERP_CONFIG__) ? window.__ERP_CONFIG__ : {};
  return invResolveImageUrl_(String(cfg.COMPANY_SEAL_URL || "").trim());
}

function invBuildCiSealColumnHtml_(opts){
  const o = opts && typeof opts === "object" ? opts : {};
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : escapeHtml_;
  const sealUrl = invResolveImageUrl_(o.sealUrl);
  const sigDate = String(o.sigDate || "").trim();
  const sigName = String(o.sigName || "").trim();
  if(sealUrl){
    const safeSrc = sealUrl.replace(/"/g, "%22");
    return `<div style="flex:0 0 180px;">
      <div style="width:110px;margin-left:auto;text-align:center;">
        <img src="${safeSrc}" alt="Company Seal" style="display:block;margin:0 auto;max-height:96px;max-width:110px;object-fit:contain;">
        <div style="width:100%;margin-top:8px;border-bottom:1px solid #222;"></div>
        <div style="font-size:11px;margin-top:6px;">Date: ${esc(sigDate || "—")}</div>
      </div>
    </div>`;
  }
  return `<div style="flex:0 0 150px;">
    <div style="width:96px;margin-left:auto;text-align:center;">
      <div style="width:100%;padding-bottom:6px;border-bottom:1px solid #222;font-size:12px;min-height:28px;">
        ${esc(sigName || "")}
      </div>
      <div style="font-size:11px;margin-top:6px;">Date: ${esc(sigDate || "—")}</div>
    </div>
  </div>`;
}

function invBuildSellerAddressLines_(p){
  const prof = p || invCompanyProfile_ || {};
  const raw = String(prof.address_en || "").trim();
  const city = String(prof.city_en || "").trim();
  const postal = String(prof.postal_code || "").trim();
  const country = String(prof.country_en || "Taiwan").trim();
  if(!raw && !city && !postal && !country) return [];

  let line1 = "";
  let district = "";
  const rdMatch = raw.match(/^(.+?\bRd\.)\s*,?\s*(.*)$/i);
  if(rdMatch){
    line1 = rdMatch[1].trim() + ",";
    district = String(rdMatch[2] || "").trim().replace(/,\s*$/, "");
  }else if(raw){
    line1 = raw.endsWith(",") ? raw : raw + ",";
  }

  const cityPostal = [city, postal].filter(Boolean).join(" ");
  const mid = district
    ? [district, cityPostal].filter(Boolean).join(", ")
    : cityPostal;
  const line2 = [mid, country].filter(Boolean).join(", ");
  return [line1, line2].filter(x => String(x || "").trim());
}

function invBuildCiExporterHtml_(seller, esc){
  const s = seller || {};
  const bodyLines = [];
  const name = String(s.seller_company_name_en || "").trim();
  const phone = String(s.seller_phone || "").trim();
  const email = String(s.seller_email || "").trim();
  const taxId = String(s.seller_tax_id || "").trim();
  const addrLines = invBuildSellerAddressLines_(invCompanyProfile_);
  if(name) bodyLines.push(`<div>${esc(name)}</div>`);
  if(addrLines.length){
    addrLines.forEach((line, idx) => {
      const nowrap = idx === 1 ? "white-space:nowrap;" : "";
      bodyLines.push(`<div style="${nowrap}">${esc(line)}</div>`);
    });
  }else if(String(s.seller_address_en || "").trim()){
    bodyLines.push(`<div>${esc(String(s.seller_address_en || "").trim())}</div>`);
  }
  if(phone) bodyLines.push(`<div>Tel: ${esc(phone)}</div>`);
  if(email) bodyLines.push(`<div>Email: ${esc(email)}</div>`);
  if(taxId) bodyLines.push(`<div>Tax ID: ${esc(taxId)}</div>`);
  return `<div style="font-size:12px;line-height:1.55;">
    <div style="font-weight:700;margin-bottom:6px;font-size:13px;">Exporter (Seller)</div>
    ${bodyLines.join("")}
  </div>`;
}

function invMergeBuyerAddressCountry_(address, country){
  const addr = String(address || "").trim();
  const ctry = String(country || "").trim();
  if(!addr && !ctry) return "";
  if(!ctry) return addr;
  if(!addr) return ctry;
  const addrLow = addr.toLowerCase();
  const cLow = ctry.toLowerCase();
  if(addrLow === cLow) return addr;
  const tail = addr.split(",").pop()?.trim().toLowerCase() || "";
  if(tail === cLow || addrLow.endsWith(", " + cLow) || addrLow.endsWith("," + cLow)) return addr;
  if(addrLow.includes(cLow)) return addr;
  return `${addr}, ${ctry}`;
}

function invCountryNameEn_(country){
  const s = String(country || "").trim();
  if(!s) return "";
  if(typeof importOriginCountryEn_ === "function"){
    const mapped = importOriginCountryEn_(s);
    if(mapped) return mapped;
  }
  const k = s.toLowerCase();
  if(k === "china" || s === "中國" || s === "中国") return "China";
  if(k === "taiwan" || s === "台灣" || s === "台湾") return "Taiwan";
  if(k === "japan" || s === "日本") return "Japan";
  if(k === "korea" || s === "韓國") return "Korea";
  if(k === "usa" || s === "美國") return "USA";
  if(k === "uk" || s === "英國") return "UK";
  if(!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(s)) return s;
  return s;
}

function invFormatCiBuyerNamePdf_(en, zh){
  const a = String(en || "").trim();
  const b = String(zh || "").trim();
  if(a && b && a !== b) return `${a} (${b})`;
  return a || b;
}

function invNormalizeBuyerAddressForPdf_(address, country){
  let addr = String(address || "").trim();
  addr = addr
    .replace(/,\s*中國\s*$/u, "")
    .replace(/,\s*中国\s*$/u, "")
    .replace(/,\s*台灣\s*$/u, "")
    .replace(/,\s*台湾\s*$/u, "");
  return invMergeBuyerAddressCountry_(addr, invCountryNameEn_(country));
}

function invEnrichPdfPayloadForPrint_(payload, opts){
  const o = opts || {};
  const buyer = { ...(payload?.buyer || {}) };
  const en = String(buyer.name || "").trim();
  let zh = String(buyer.nameZh || invCiBuyerNameZh_ || "").trim();
  if(o.shipment){
    if(!zh) zh = String(o.shipment.recipient_name || "").trim();
    if(!en) buyer.name = String(o.shipment.recipient_name_en || "").trim() || zh;
  }
  buyer.nameZh = zh;
  buyer.addressPdf = invNormalizeBuyerAddressForPdf_(buyer.address, buyer.country);
  return { ...payload, buyer };
}

function invParseDescParenEnZh_(desc){
  const s = String(desc || "").trim();
  if(!s) return null;
  const m = s.match(/^(.+?)\s*[\(（]\s*([^\(\)（）]+?)\s*[\)）]\s*$/u);
  if(!m) return null;
  const en = m[1].trim();
  const zh = m[2].trim();
  if(!en || !zh || en === zh) return null;
  return { en, zh };
}

function invResolveLineDescPdfParts_(ln){
  const p = ln?.product_id ? invFindProduct_(ln.product_id) : null;
  const enProd = String(p?.product_name_en || "").trim();
  const zhProd = String(p?.product_name || "").trim();
  if(enProd && zhProd && enProd !== zhProd){
    return { en: enProd, zh: zhProd };
  }
  const desc = String(ln?.description_en || "").trim();
  if(!desc) return { en: "", zh: "" };
  const parenParts = invParseDescParenEnZh_(desc);
  if(parenParts) return parenParts;
  const m = desc.match(/^(.+?)\s+([\u4e00-\u9fff\u3400-\u4dbf][\u4e00-\u9fff\u3400-\u4dbf\s]*)$/u);
  if(m) return { en: m[1].trim(), zh: m[2].trim() };
  if(invTextHasCjk_(desc) && /[a-zA-Z]/.test(desc)){
    const m2 = desc.match(/^([^\u4e00-\u9fff\u3400-\u4dbf]+)\s*(.+)$/u);
    if(m2){
      let en = m2[1].trim();
      let zh = m2[2].trim();
      en = en.replace(/[\(（]+$/u, "").trim();
      zh = zh.replace(/^[\)）]+/u, "").replace(/[\)）]+$/u, "").trim();
      return { en, zh };
    }
  }
  if(invTextHasCjk_(desc)) return { en: "", zh: desc };
  return { en: desc, zh: "" };
}

function invBuildCiLineDescPdfHtml_(ln, esc){
  const { en, zh } = invResolveLineDescPdfParts_(ln);
  if(en && zh){
    return `<div>${esc(en)}</div><div style="font-size:10px;color:#444;margin-top:2px;line-height:1.35;">${esc(zh)}</div>`;
  }
  return esc(en || zh || "");
}

function invTextHasCjk_(text){
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(text || ""));
}

/** 開立／列印前：提示產品缺英文品名；非大陸忌純中文，大陸建議英+中 */
function invWarnCiLineDescriptions_(lines){
  const mainland = invIsMainlandChinaCountry_(invCiBuyerCountry_());
  const missingEnIds = [];
  const chineseOnlyLines = [];
  const chineseLines = [];
  (lines || []).forEach(ln => {
    const pid = String(ln?.product_id || "").trim().toUpperCase();
    const desc = String(ln?.description_en || "").trim();
    if(pid){
      const p = invFindProduct_(pid);
      if(p && !String(p.product_name_en || "").trim()){
        missingEnIds.push(pid);
      }
    }
    if(!desc) return;
    if(mainland){
      if(invTextHasCjk_(desc) && !/[a-zA-Z]/.test(desc)){
        chineseOnlyLines.push(desc.length > 24 ? desc.slice(0, 24) + "…" : desc);
      }
      return;
    }
    if(invTextHasCjk_(desc)){
      chineseLines.push(desc.length > 24 ? desc.slice(0, 24) + "…" : desc);
    }
  });
  const parts = [];
  const uniqMissing = [...new Set(missingEnIds)];
  if(uniqMissing.length){
    parts.push(
      mainland
        ? "寄大陸明細建議英+中，產品請補「英文品名（CI）」：" + uniqMissing.join("、")
        : "產品缺少英文品名（請至 Products 補「英文品名（CI）」）：" + uniqMissing.join("、")
    );
  }
  if(mainland && chineseOnlyLines.length){
    parts.push("寄大陸明細建議英+中（英文+中文），請補英文品名或手改 Description");
  }
  if(!mainland && chineseLines.length){
    parts.push("明細品名含中文，報關建議改為英文");
  }
  if(parts.length && typeof showToast === "function"){
    showToast(parts.join("；"), "warn", 9000);
  }
  return parts.length > 0;
}

function invBuildPdfPayloadFromForm_(){
  invCiSyncLinesFromTable_();
  const ciDate = String(document.getElementById("inv_ci_date")?.value || "").trim();
  return {
    ciNo: String(document.getElementById("inv_ci_no")?.value || "").trim(),
    ciDate,
    currency: String(document.getElementById("inv_ci_currency")?.value || "USD").trim(),
    origin: String(document.getElementById("inv_ci_origin")?.value || "Taiwan").trim(),
    incoterms: String(document.getElementById("inv_ci_incoterms")?.value || "").trim(),
    seller: { ...(invSellerSnapshot_ || {}) },
    buyer: {
      name: document.getElementById("inv_ci_buyer_name")?.value,
      nameZh: invCiBuyerNameZh_,
      address: document.getElementById("inv_ci_buyer_address")?.value,
      phone: document.getElementById("inv_ci_buyer_phone")?.value,
      country: document.getElementById("inv_ci_buyer_country")?.value,
      idNo: document.getElementById("inv_ci_buyer_id_no")?.value,
      usci: document.getElementById("inv_ci_buyer_usci")?.value
    },
    lines: (invCiLines_ || []).map(ln => ({ ...ln })),
    subtotal: Number(document.getElementById("inv_ci_subtotal")?.value || 0),
    total: Number(document.getElementById("inv_ci_total")?.value || 0),
    waybill: String(document.getElementById("inv_ci_waybill")?.value || "").trim(),
    paymentTerms: String(document.getElementById("inv_ci_payment_terms")?.value || "").trim(),
    remark: String(document.getElementById("inv_ci_remark")?.value || "").trim(),
    sigDate: String(document.getElementById("inv_ci_signature_date")?.value || ciDate).trim(),
    declaration: invGetCiDeclarationFromProfile_()
  };
}

function invGetCiDeclarationFromProfile_(prof){
  const p = prof || invCompanyProfile_ || {};
  return String(
    p.declaration_text || "I declare that the information is true and correct."
  ).trim();
}

function invBuildPdfPayloadFromCiRecord_(ci, lines){
  const ciDate = dateInputValue_(ci?.ci_date) || "";
  invSetSellerSnapshot_({
    seller_company_name_en: ci?.seller_company_name_en,
    seller_address_en: ci?.seller_address_en,
    seller_phone: ci?.seller_phone,
    seller_email: ci?.seller_email,
    seller_tax_id: ci?.seller_tax_id
  });
  return {
    ciNo: String(ci?.ci_no || "").trim(),
    ciDate,
    currency: String(ci?.currency || "USD").trim(),
    origin: String(ci?.country_of_origin || "Taiwan").trim(),
    incoterms: String(ci?.incoterms || "").trim(),
    seller: { ...(invSellerSnapshot_ || {}) },
    buyer: {
      name: ci?.buyer_name_en,
      address: ci?.buyer_address_en,
      phone: ci?.buyer_phone,
      country: ci?.buyer_country,
      idNo: ci?.buyer_id_no,
      usci: ci?.buyer_usci
    },
    lines: (lines || []).map(ln => ({
      product_id: ln.product_id,
      description_en: ln.description_en,
      hs_code: ln.hs_code,
      qty: ln.qty,
      unit: ln.unit,
      unit_price: ln.unit_price,
      amount: ln.amount
    })),
    subtotal: Number(ci?.subtotal || 0),
    total: Number(ci?.total_amount || 0),
    waybill: String(ci?.waybill_no || "").trim(),
    paymentTerms: String(ci?.payment_terms || "").trim(),
    remark: String(ci?.remark || "").trim(),
    sigDate: dateInputValue_(ci?.signature_date) || ciDate,
    declaration: invGetCiDeclarationFromProfile_(invCompanyProfile_) ||
      String(ci?.declaration_text || "").trim()
  };
}

function invResolveLineHsCode_(ln){
  const fromLine = String(ln?.hs_code || "").trim();
  if(fromLine) return fromLine;
  return String(invFindProduct_(ln?.product_id)?.hs_code || "").trim();
}

function invEnrichPdfLines_(lines){
  return (Array.isArray(lines) ? lines : []).map(ln => ({
    ...ln,
    hs_code: invResolveLineHsCode_(ln)
  }));
}

function invAnalyzeCiPdfLineColumns_(lines){
  const enriched = invEnrichPdfLines_(lines);
  return {
    lines: enriched,
    showHs: enriched.some(ln => String(ln.hs_code || "").trim()),
    showUnit: enriched.some(ln => String(ln.unit || "").trim())
  };
}

/** PDF 明細欄寬（加總 100%；品名欄吃剩餘寬度） */
function invCiPdfColWidths_(headers){
  const weights = {
    "No.": 5,
    "HS Code": 16,
    "Qty": 6,
    "Unit": 7,
    "Unit Price": 12,
    "Total": 10,
    "Amount": 10
  };
  const list = Array.isArray(headers) ? headers : [];
  let fixed = 0;
  list.forEach(h => {
    if(h.label === "Description of Goods") return;
    fixed += weights[h.label] || 8;
  });
  const descW = Math.max(22, 100 - fixed);
  return list.map(h => (h.label === "Description of Goods" ? descW : (weights[h.label] || 8)));
}

function invBuildCiLinesTablePdfHtml_(lines, esc, currency, v2){
  const pack = invAnalyzeCiPdfLineColumns_(lines);
  const enriched = pack.lines;
  const showHs = pack.showHs;
  const showUnit = pack.showUnit;
  const thCell = "border:1px solid #333;padding:6px;text-align:center;";
  const thCellNowrap = thCell + "white-space:nowrap;";
  const tdCell = "border:1px solid #333;padding:6px;text-align:center;";
  const tdDesc = tdCell + "text-align:left;";
  const tdHs = tdCell + "white-space:nowrap;font-size:11px;";
  const thQtyUnit = thCell + "white-space:nowrap;text-align:center;";
  const tdQtyUnit = tdCell + "white-space:nowrap;text-align:center;";
  const thAmt = thCell + "white-space:nowrap;text-align:center;";
  const tdAmt = tdCell + "white-space:nowrap;text-align:right;padding:6px 8px 6px 4px;";
  const amountLabel = v2 ? "Total" : "Amount";
  const isAmtHeader_ = label => label === "Unit Price" || label === "Total" || label === "Amount";
  const isQtyUnitHeader_ = label => label === "Qty" || label === "Unit";

  const headers = [
    { label: "No.", nowrap: false },
    { label: "Description of Goods", nowrap: false }
  ];
  if(showHs) headers.push({ label: "HS Code", nowrap: true });
  headers.push({ label: "Qty", nowrap: true });
  if(showUnit) headers.push({ label: "Unit", nowrap: true });
  headers.push(
    { label: "Unit Price", nowrap: true },
    { label: amountLabel, nowrap: true }
  );

  const colWidths = invCiPdfColWidths_(headers);
  const colgroup = colWidths.map(w => `<col style="width:${w}%">`).join("");
  const thead = headers.map(h => {
    const style = isAmtHeader_(h.label)
      ? thAmt
      : isQtyUnitHeader_(h.label)
        ? thQtyUnit
        : (h.nowrap ? thCellNowrap : thCell);
    return `<th style="${style}background:#f1f5f9;">${esc(h.label)}</th>`;
  }).join("");

  const bodyRows = enriched.map((ln, idx) => {
    const qty = Number(ln.qty || 0);
    const u = String(ln.unit || "").trim();
    const qtyText = showUnit ? String(qty) : (u ? qty + " " + u : String(qty));
    const cells = [
      `<td style="${tdCell}">${idx + 1}</td>`,
      `<td style="${tdDesc}">${invBuildCiLineDescPdfHtml_(ln, esc)}</td>`
    ];
    if(showHs) cells.push(`<td style="${tdHs}">${esc(String(ln.hs_code || ""))}</td>`);
    cells.push(`<td style="${tdQtyUnit}">${esc(qtyText)}</td>`);
    if(showUnit) cells.push(`<td style="${tdQtyUnit}">${esc(u)}</td>`);
    cells.push(
      `<td style="${tdAmt}">${Number(ln.unit_price || 0).toFixed(2)}</td>`,
      `<td style="${tdAmt}">${Number(ln.amount || 0).toFixed(2)}</td>`
    );
    return `<tr>${cells.join("")}</tr>`;
  }).join("");

  return `<table class="ci-lines-table" style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px;">
    <colgroup>${colgroup}</colgroup>
    <thead><tr>${thead}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function invSanitizeCiPdfFilePart_(s){
  return String(s || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

function invBuildCiPdfFileName_(payload){
  const ciNo = invSanitizeCiPdfFilePart_(payload?.ciNo || "") || "NO";
  const buyer = invSanitizeCiPdfFilePart_(payload?.buyer?.name || "") || "BUYER";
  return ciNo + "_" + buyer;
}

function invBuildCommercialInvoicePdfHtml_(payload, v2){
  const p = payload || {};
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : escapeHtml_;
  const currency = String(p.currency || "USD").trim();
  const ciNo = String(p.ciNo || "").trim();
  const ciDate = String(p.ciDate || "").trim();
  const seller = p.seller || {};
  const buyer = p.buyer || {};
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const subtotal = Number(p.subtotal || 0);
  const total = Number(p.total || 0);
  const paymentTerms = String(p.paymentTerms || "").trim();
  const sigDate = String(p.sigDate || ciDate).trim();
  const declaration = String(p.declaration || "").trim();
  const sealUrl = invGetCompanySealUrl_();

  const importerHtml = invBuildCiImporterHtml_(buyer, esc);
  const invoiceMetaHtml = invBuildCiInvoiceMetaHtml_({
    ciNo,
    ciDate,
    waybill: p.waybill || "",
    origin: p.origin || "",
    incoterms: p.incoterms || "",
    currency
  }, esc);
  const linesTableHtml = invBuildCiLinesTablePdfHtml_(lines, esc, currency, v2);
  const declSummaryHtml = invBuildCiDeclarationSummaryHtml_(declaration, subtotal, total, currency, esc);
  const footerHtml = v2
    ? invBuildCiFooterV2Html_(seller, { sealUrl, sigDate })
    : invBuildCiFooterHtml_(seller, { sealUrl, sigDate });
  const headerV2Html = v2 ? invBuildCiHeaderV2Html_() : "";
  const ciColL = "width:50%;vertical-align:top;padding:0 12px 0 0;border:none;";
  const ciColR = "width:50%;vertical-align:top;padding:0 0 0 12px;border:none;";

  const body = `
    <div class="ci-invoice" style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:13px;">
      ${v2 ? headerV2Html : `<h1 style="text-align:center;margin:0 0 32px;font-size:30px;letter-spacing:2px;">COMMERCIAL INVOICE</h1>`}
      <table class="ci-meta-table" style="width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:12px;font-size:13px;border:none;">
        <tr>
          <td style="${ciColL}">${importerHtml}</td>
          <td style="${ciColR}">${invoiceMetaHtml}</td>
        </tr>
      </table>
      ${linesTableHtml}
      ${declSummaryHtml}
      ${paymentTerms ? `<p style="margin:10px 0 4px;font-size:12px;"><b>Payment Terms:</b> ${esc(paymentTerms)}</p>` : ""}
      ${footerHtml}
    </div>
  `;
  return {
    body,
    fileName: invBuildCiPdfFileName_(p)
  };
}

async function invPrintCiPdfByCiId_(ciId, pdfVersion){
  const id = String(ciId || "").trim();
  if(!id) return;
  try{
    await invLoadMasterData_();
    await invLoadCompanyProfile_();
    const hasSeller = invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: false });
    if(!hasSeller) return showToast("請先到「公司設定」填寫 English 公司名稱與地址", "error");

    const r = await callAPI({ action: "list_commercial_invoice_blank_by_ci", ci_id: id }, { method: "GET" });
    const ci = r?.data || null;
    const lines = r?.lines || [];
    if(!ci) return showToast("請先開立並儲存 Commercial Invoice", "error");
    if(!lines.length) return showToast("無明細可列印", "error");

    invWarnCiLineDescriptions_(lines);
    const v2 = String(pdfVersion || "2").trim() === "2";
    const payload = invEnrichPdfPayloadForPrint_(invBuildPdfPayloadFromCiRecord_(ci, lines), {});
    const { body, fileName } = invBuildCommercialInvoicePdfHtml_(payload, v2);
    erpOpenPrintWindow_(fileName, body, { minimalPrintChrome: true, skipBrandHeader: true });
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast("列印失敗，請稍後重試", "error");
    }
  }
}

async function invPrintCiPdfFromList_(shipmentId, pdfVersion){
  const id = String(shipmentId || "").trim().toUpperCase();
  if(!id) return;
  try{
    await invLoadMasterData_();
    await invLoadCompanyProfile_();
    const hasSeller = invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: false });
    if(!hasSeller) return showToast("請先到「公司設定」填寫 English 公司名稱與地址", "error");

    const r = await callAPI({ action: "list_commercial_invoice_by_shipment", shipment_id: id }, { method: "GET" });
    const ci = r?.data || null;
    const lines = r?.lines || [];
    if(!ci) return showToast("請先開立並儲存 Commercial Invoice", "error");
    if(!lines.length) return showToast("無明細可列印", "error");

    invWarnCiLineDescriptions_(lines);
    const v2 = String(pdfVersion || "2").trim() === "2";
    const sh = (invShipments_ || []).find(s => String(s?.shipment_id || "").trim().toUpperCase() === id)
      || await getOne("shipment", "shipment_id", id).catch(() => null);
    const payload = invEnrichPdfPayloadForPrint_(invBuildPdfPayloadFromCiRecord_(ci, lines), { shipment: sh });
    const { body, fileName } = invBuildCommercialInvoicePdfHtml_(payload, v2);
    erpOpenPrintWindow_(fileName, body, { minimalPrintChrome: true, skipBrandHeader: true });
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast("列印失敗，請稍後重試", "error");
    }
  }
}

function invBuildCiImporterHtml_(buyer, esc){
  const b = buyer || {};
  const lines = [];
  const displayName = invFormatCiBuyerNamePdf_(b.name, b.nameZh);
  const address = String(b.address || "").trim();
  const phone = String(b.phone || "").trim();
  const idNo = String(b.idNo || "").trim();
  const usci = String(b.usci || "").trim();
  if(displayName) lines.push(`<div>${esc(displayName)}</div>`);
  const addrLine = b.addressPdf != null
    ? String(b.addressPdf || "").trim()
    : invNormalizeBuyerAddressForPdf_(address, b.country);
  if(addrLine) lines.push(`<div>${esc(addrLine)}</div>`);
  if(phone) lines.push(`<div>Tel: ${esc(phone)}</div>`);
  if(idNo) lines.push(`<div>ID No.: ${esc(idNo)}</div>`);
  if(usci) lines.push(`<div>USCI: ${esc(usci)}</div>`);
  return `<div style="font-size:13px;line-height:1.55;">
    <div style="font-weight:700;margin-bottom:6px;">Importer (Buyer)</div>
    ${lines.join("") || `<div>—</div>`}
  </div>`;
}

function invBuildCiInvoiceMetaHtml_(meta, esc){
  const m = meta || {};
  const rows = [
    ["Invoice No.", m.ciNo],
    ["Date", m.ciDate]
  ];
  const waybill = String(m.waybill || "").trim();
  if(waybill) rows.push(["Waybill No.", waybill]);
  const origin = String(m.origin || "").trim();
  if(origin) rows.push(["Country of Origin", origin]);
  const currency = String(m.currency || "").trim();
  if(currency) rows.push(["Currency", currency]);
  const incoterms = String(m.incoterms || "").trim();
  if(incoterms) rows.push(["Incoterms", incoterms]);
  return `<div style="text-align:right;font-size:13px;line-height:1.55;">
    ${rows.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(String(v != null ? v : ""))}</div>`).join("")}
  </div>`;
}

function invBuildCiLogoFooterHtml_(seller, esc){
  const logoUrl = invGetCompanyLogoUrl_();
  const safeLogo = logoUrl ? logoUrl.replace(/"/g, "%22") : "";
  if(safeLogo){
    return `<img src="${safeLogo}" alt="Logo" class="ci-footer-logo" style="height:100%;width:auto;max-width:100%;object-fit:contain;object-position:left bottom;display:block;">`;
  }
  return `<div style="font-weight:700;font-size:14px;line-height:1.3;">${esc(String(seller?.seller_company_name_en || ""))}</div>`;
}

function invBuildCiFooterHtml_(seller, opts){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : escapeHtml_;
  const logoHtml = invBuildCiLogoFooterHtml_(seller, esc);
  const exporterHtml = invBuildCiExporterHtml_(seller, esc);
  const sealHtml = invBuildCiSealColumnHtml_(opts);
  return `<div class="ci-footer" style="margin-top:52px;display:flex;align-items:stretch;gap:16px;">
    <div style="flex:0 0 30%;min-width:0;display:flex;align-items:flex-end;padding-right:8px;">${logoHtml}</div>
    <div style="flex:1;min-width:0;display:flex;align-items:flex-end;padding:0 8px;">${exporterHtml}</div>
    <div style="flex:0 0 auto;margin-left:auto;display:flex;align-items:flex-end;justify-content:flex-end;padding-right:0;">${sealHtml}</div>
  </div>`;
}

/** V2：頁首左 Logo、右 COMMERCIAL INVOICE；頁尾僅 Exporter＋章 */
function invBuildCiHeaderV2Html_(){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : escapeHtml_;
  const logoUrl = invGetCompanyLogoUrl_();
  const safeLogo = logoUrl ? logoUrl.replace(/"/g, "%22") : "";
  const logoBlock = safeLogo
    ? `<img src="${safeLogo}" alt="Logo" style="height:76px;width:auto;max-width:260px;object-fit:contain;display:block;">`
    : "";
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:32px;">
    <div style="flex:0 0 auto;min-width:0;">${logoBlock}</div>
    <h1 style="margin:0;font-size:30px;letter-spacing:2px;text-align:right;flex:1;white-space:nowrap;">${esc("COMMERCIAL INVOICE")}</h1>
  </div>`;
}

function invBuildCiFooterV2Html_(seller, opts){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : escapeHtml_;
  const exporterHtml = invBuildCiExporterHtml_(seller, esc);
  const sealHtml = invBuildCiSealColumnHtml_(opts);
  return `<div class="ci-footer-v2" style="margin-top:52px;display:flex;align-items:stretch;gap:16px;">
    <div style="flex:1;min-width:0;display:flex;align-items:flex-end;padding-right:8px;">${exporterHtml}</div>
    <div style="flex:0 0 auto;margin-left:auto;display:flex;align-items:flex-end;justify-content:flex-end;">${sealHtml}</div>
  </div>`;
}

function invBuildCiDeclarationSummaryHtml_(declaration, subtotal, total, currency, esc){
  const summaryInner = invBuildCiSummaryTableHtml_(subtotal, total, currency);
  const decl = String(declaration || "").trim();
  if(!decl){
    return `<div style="margin-top:12px;display:flex;justify-content:flex-end;">${summaryInner}</div>`;
  }
  return `<div style="margin-top:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">
    <div style="flex:1;min-width:0;font-size:12px;line-height:1.5;">${esc(decl)}</div>
    <div style="flex:0 0 auto;">${summaryInner}</div>
  </div>`;
}

function invBuildSignatureHtml_(opts){
  const o = opts && typeof opts === "object" ? opts : {};
  return `<div style="margin-top:20px;display:flex;justify-content:flex-end;">${invBuildCiSealColumnHtml_(o)}</div>`;
}

function invGetCompanyLogoUrl_(){
  const cfg = (typeof window === "object" && window && window.__ERP_CONFIG__) ? window.__ERP_CONFIG__ : {};
  const ciLogo = String(cfg.COMPANY_LOGO_CI_URL || "").trim();
  const url = ciLogo || String(cfg.COMPANY_LOGO_URL || "").trim();
  return invResolveImageUrl_(url);
}

function invFormatCiMoney_(n){
  const v = Number(n || 0);
  if(!Number.isFinite(v)) return "0.00";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function invBuildCiSummaryTableHtml_(subtotal, total, currency){
  const cur = String(currency || "USD").trim().toUpperCase();
  const sym = cur === "USD" ? "$" : (cur === "TWD" ? "NT$" : (cur === "EUR" ? "€" : (cur === "CNY" ? "¥" : cur + " ")));
  const sub = invFormatCiMoney_(subtotal);
  const tot = invFormatCiMoney_(total);
  const row = "padding:5px 0;border:none;background:transparent;font-size:13px;";
  const lbl = row + "text-align:left;padding-right:24px;";
  const val = row + "text-align:right;white-space:nowrap;";
  return `<table class="ci-summary-table" style="width:260px;border:none;border-collapse:collapse;">
    <tr><td style="${lbl}">Subtotal</td><td style="${val}">${sym}${sub}</td></tr>
    <tr><td style="${lbl}font-weight:700;">Total Due</td><td style="${val}font-weight:700;">${sym}${tot}</td></tr>
  </table>`;
}

function invBuildCiSummaryHtml_(subtotal, total, currency){
  return `<div style="margin-top:10px;display:flex;justify-content:flex-end;">${invBuildCiSummaryTableHtml_(subtotal, total, currency)}</div>`;
}

function invFindProduct_(productId){
  const id = String(productId || "").trim().toUpperCase();
  return (invProducts_ || []).find(p => String(p?.product_id || "").trim().toUpperCase() === id) || null;
}

function invCiStatusLabel_(status){
  const s = String(status || "").trim().toUpperCase();
  if(s === "ISSUED") return "已開立";
  if(s === "VOID") return "已作廢";
  if(s === "DRAFT") return "草稿";
  return status ? String(status) : "—";
}

function invSetCiStatusDisplay_(code){
  const el = document.getElementById("inv_ci_status");
  if(!el) return;
  const c = String(code || "").trim().toUpperCase();
  el.value = c ? invCiStatusLabel_(c) : "";
  if(c) el.dataset.code = c;
  else delete el.dataset.code;
}

function invGetCiStatusCode_(){
  const el = document.getElementById("inv_ci_status");
  if(el?.dataset?.code) return String(el.dataset.code).trim().toUpperCase();
  return String(el?.value || "").trim().toUpperCase();
}

function invCiListLabel_(sh){
  const sid = String(sh?.shipment_id || "").trim().toUpperCase();
  const ci = invCiMap_[sid] || null;
  const ciNo = String(sh?._ci_no || ci?.ci_no || "").trim();
  if(ciNo) return ciNo;
  const st = String(sh?._ci_status || ci?.status || "").trim().toUpperCase();
  if(st) return invCiStatusLabel_(st);
  return "—";
}

function invGetCiMap_(){
  return invCiMap_;
}

/** 空白 CI 序號起點：CI-YYYYMMDD-201 */
const INV_BLANK_CI_SEQ_START_ = 201;

/** 是否為系統建議格式 CI-YYYYMMDD-序號 */
function invIsAutoCiNo_(no){
  return /^CI-\d{8}-\d+$/i.test(String(no || "").trim());
}

function invIsAutoBlankCiNo_(no){
  const m = String(no || "").trim().toUpperCase().match(/^CI-(\d{8})-(\d+)$/);
  if(!m) return false;
  const seq = parseInt(m[2], 10);
  return Number.isFinite(seq) && seq >= INV_BLANK_CI_SEQ_START_;
}

/**
 * 空白 CI：CI-YYYYMMDD-201 起編（依發票日期每日重置）
 * @param {string} [dateStr] YYYY-MM-DD
 */
async function invSuggestBlankCiNo_(dateStr){
  const d = String(dateStr || nowIso16().slice(0, 10)).trim();
  const ymd = d.replace(/-/g, "");
  if(!/^\d{8}$/.test(ymd)) return "";

  const prefix = "CI-" + ymd + "-";
  let list = [];
  try{
    list = await getAll("commercial_invoice_blank", { silent: true, refresh: true });
  }catch(_e){
    list = [];
  }
  if(!Array.isArray(list)) list = [];

  let maxSeq = INV_BLANK_CI_SEQ_START_ - 1;
  list.forEach(ci => {
    const no = String(ci?.ci_no || "").trim().toUpperCase();
    const m = no.match(/^CI-(\d{8})-(\d+)$/);
    if(!m || m[1] !== ymd) return;
    const seq = parseInt(m[2], 10);
    if(Number.isFinite(seq) && seq >= INV_BLANK_CI_SEQ_START_ && seq > maxSeq) maxSeq = seq;
  });

  return prefix + String(maxSeq + 1);
}

/**
 * 出貨 CI：依發票日期建議下一號（每日重置）：CI-YYYYMMDD-001
 * @param {string} [dateStr] YYYY-MM-DD
 */
async function invSuggestCiNo_(dateStr){
  const d = String(dateStr || nowIso16().slice(0, 10)).trim();
  const ymd = d.replace(/-/g, "");
  if(!/^\d{8}$/.test(ymd)) return "";

  const prefix = "CI-" + ymd + "-";
  let list = [];
  try{
    list = await getAll("commercial_invoice", { silent: true, refresh: true });
  }catch(_e){
    list = [];
  }
  if(!Array.isArray(list)) list = [];

  let maxSeq = 0;
  list.forEach(ci => {
    const no = String(ci?.ci_no || "").trim().toUpperCase();
    const m = no.match(/^CI-(\d{8})-(\d+)$/);
    if(!m || m[1] !== ymd) return;
    const seq = parseInt(m[2], 10);
    if(Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  });

  const width = maxSeq >= 999 ? 4 : 3;
  return prefix + String(maxSeq + 1).padStart(width, "0");
}

/** 帶入建議 Invoice No.；force=true 強制覆寫，否則僅空白或自動格式時才帶 */
async function invApplySuggestedCiNo_(force){
  const noEl = document.getElementById("inv_ci_no");
  if(!noEl){
    if(typeof showToast === "function") showToast("請先開啟 Invoice 編輯畫面", "error");
    return "";
  }
  const cur = String(noEl.value || "").trim();
  const autoOk = invStandaloneMode_ ? invIsAutoBlankCiNo_(cur) : invIsAutoCiNo_(cur);
  if(cur && !force && !autoOk) return cur;

  const dateEl = document.getElementById("inv_ci_date");
  if(dateEl && !String(dateEl.value || "").trim()){
    dateEl.value = nowIso16().slice(0, 10);
  }
  const suggested = invStandaloneMode_
    ? await invSuggestBlankCiNo_(dateEl?.value)
    : await invSuggestCiNo_(dateEl?.value);
  if(suggested){
    noEl.value = suggested;
    try{ noEl.dispatchEvent(new Event("input", { bubbles: true })); }catch(_e){}
  }
  return suggested;
}

/** Suggest 按鈕（含 Toast 回饋） */
async function invSuggestCiNoClick_(btn){
  try{
    if(typeof showSaveHint === "function" && btn) showSaveHint(btn);
    const no = await invApplySuggestedCiNo_(true);
    if(no){
      if(typeof showToast === "function") showToast("已帶入 Invoice No.：" + no, "success", 4500);
    }else if(typeof showToast === "function"){
      showToast("無法產生發票號，請確認發票日期", "error");
    }
  }catch(err){
    console.error("invSuggestCiNoClick_", err);
    if(typeof showToast === "function") showToast("重選發票號失敗，請稍後再試", "error");
  }finally{
    if(typeof hideSaveHint === "function") hideSaveHint();
  }
}

function invBindEditorEvents_(){
  const dateEl = document.getElementById("inv_ci_date");
  if(dateEl && dateEl.dataset.invBound !== "1"){
    dateEl.dataset.invBound = "1";
    dateEl.addEventListener("change", function(){
      if(invCiLoadedId_) return;
      invApplySuggestedCiNo_(false);
    });
  }
}

async function invRefreshCiMap_(force){
  const now = Date.now();
  if(!force && invCiMapLoadedAt_ && (now - invCiMapLoadedAt_) < 15000) return invCiMap_;
  try{
    const [shipList, blankList] = await Promise.all([
      getAll("commercial_invoice", { silent: true, refresh: !!force }).catch(() => []),
      getAll("commercial_invoice_blank", { silent: true, refresh: !!force }).catch(() => [])
    ]);
    invCiMap_ = Object.create(null);
    invCiBlankById_ = Object.create(null);
    invCiStandaloneList_ = [];
    (shipList || []).forEach(ci => {
      const sid = String(ci?.shipment_id || "").trim().toUpperCase();
      if(sid) invCiMap_[sid] = ci;
    });
    (blankList || []).forEach(ci => {
      const cid = String(ci?.ci_id || "").trim();
      if(cid) invCiBlankById_[cid] = ci;
      invCiStandaloneList_.push(ci);
    });
    invCiStandaloneList_ = typeof erpSortRowsNewestFirst_ === "function"
      ? erpSortRowsNewestFirst_(invCiStandaloneList_, ["ci_date", "updated_at", "created_at"], "ci_id")
      : invCiStandaloneList_.sort((a, b) =>
          String(b.ci_date || b.updated_at || b.created_at || "").localeCompare(
            String(a.ci_date || a.updated_at || a.created_at || "")
          )
        );
    invCiMapLoadedAt_ = now;
  }catch(_e){}
  return invCiMap_;
}

function navigateOpenInvoice_(shipmentId){
  const id = String(shipmentId || "").trim().toUpperCase();
  if(!id) return;
  try{ window.__ERP_PENDING_INVOICE_SHIPMENT__ = id; }catch(_e){}
  if(typeof navigate === "function") navigate("invoice");
}

async function invoiceInit(){
  invStandaloneMode_ = false;
  invBindEditorEvents_();
  await invLoadMasterData_();
  invBindShipmentSearch_();
  await invRenderShipmentList_();
  const pending = String(window.__ERP_PENDING_INVOICE_SHIPMENT__ || "").trim().toUpperCase();
  if(pending){
    try{ window.__ERP_PENDING_INVOICE_SHIPMENT__ = ""; }catch(_e){}
    await invOpenEditor_(pending);
  }
}

function invBindShipmentSearch_(){
  ["inv_search_keyword", "inv_search_ci"].forEach(id => {
    const el = document.getElementById(id);
    if(!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("input", function(){ invRenderShipmentList_(); });
    el.addEventListener("change", function(){ invRenderShipmentList_(); });
  });
}

function invBindBlankSearch_(){
  ["inv_blank_search_keyword", "inv_blank_search_status"].forEach(id => {
    const el = document.getElementById(id);
    if(!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("input", function(){ invRenderBlankList_(); });
    el.addEventListener("change", function(){ invRenderBlankList_(); });
  });
}

function invResetSearch_(){
  invSetV_("inv_search_keyword", "");
  invSetV_("inv_search_ci", "");
  invRenderShipmentList_();
}

function invResetBlankSearch_(){
  invSetV_("inv_blank_search_keyword", "");
  invSetV_("inv_blank_search_status", "");
  invRenderBlankList_();
}

async function invLoadMasterData_(){
  const [shipments, customers, products] = await Promise.all([
    getAll("shipment").catch(() => []),
    getAll("customer").catch(() => []),
    getAll("product").catch(() => [])
  ]);
  invCustomers_ = customers || [];
  const custMap = {};
  (invCustomers_ || []).forEach(c => { if(c?.customer_id) custMap[String(c.customer_id)] = c; });
  invShipments_ = (shipments || []).filter(s => {
    if(String(s?.status || "").trim().toUpperCase() !== "POSTED") return false;
    return invShipmentNeedsCi_(custMap[String(s.customer_id || "")]);
  });
  invProducts_ = products || [];
  await invRefreshCiMap_(true);
}

function invCiMatchesListFilter_(ci, qCi, qKw){
  const ciSt = String(ci?.status || "").trim().toUpperCase();
  if(qCi === "MISSING") return false;
  if(qCi === "ISSUED" && ciSt !== "ISSUED") return false;
  if(qCi === "DRAFT" && ciSt !== "DRAFT") return false;
  if(qCi === "VOID" && ciSt !== "VOID") return false;
  if(!qKw) return true;
  const ciNo = String(ci?.ci_no || "").toUpperCase();
  const buyer = String(ci?.buyer_name_en || "").toUpperCase();
  const cid = String(ci?.ci_id || "").toUpperCase();
  return ciNo.includes(qKw) || buyer.includes(qKw) || cid.includes(qKw);
}

async function invRenderBlankList_(){
  const tbody = document.getElementById("invBlankListBody");
  if(!tbody) return;
  await invRefreshCiMap_();
  const qKw = String(document.getElementById("inv_blank_search_keyword")?.value || "").trim().toUpperCase();
  const qSt = String(document.getElementById("inv_blank_search_status")?.value || "").trim().toUpperCase();

  const rows = (invCiStandaloneList_ || []).filter(ci => {
    const ciSt = String(ci?.status || "").trim().toUpperCase();
    if(qSt && ciSt !== qSt) return false;
    if(!qKw) return true;
    const ciNo = String(ci?.ci_no || "").toUpperCase();
    const buyer = String(ci?.buyer_name_en || "").toUpperCase();
    const cid = String(ci?.ci_id || "").toUpperCase();
    return ciNo.includes(qKw) || buyer.includes(qKw) || cid.includes(qKw);
  });

  tbody.innerHTML = "";
  const selectAll = document.getElementById("inv_blank_select_all");
  if(selectAll) selectAll.checked = false;

  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">尚無空白發票。按「新增」建立第一筆。</td></tr>';
    return;
  }

  const selId = String(invCiLoadedId_ || "").trim().toUpperCase();
  rows.forEach(ci => {
    const ciId = String(ci.ci_id || "");
    const open = selId === ciId.trim().toUpperCase();
    const ciNo = ci.ci_no || "—";
    const ciStUp = String(ci.status || "").trim().toUpperCase();
    const ciSt = invCiStatusLabel_(ciStUp);
    const canPdf = ciStUp !== "VOID";
    const pickBox = canPdf
      ? `<input type="checkbox" class="inv-ci-pick" data-ci-id="${escapeHtml_(ciId)}" onclick="event.stopPropagation()">`
      : "";
    tbody.innerHTML += `
      <tr class="erp-list-row-selectable${open ? " erp-list-row-open" : ""}" data-row-id="${escapeHtml_(ciId)}" onclick="invOpenStandaloneCiEditorFromList_(this)">
        <td class="col-ci-pick" onclick="event.stopPropagation()">${pickBox}</td>
        <td>${escapeHtml_(String(ciNo))}</td>
        <td>${escapeHtml_(String(ci.buyer_name_en || ""))}</td>
        <td>${escapeHtml_(String(dateInputValue_(ci.ci_date) || ""))}</td>
        <td>${escapeHtml_(String(ciSt))}</td>
      </tr>
    `;
  });
}

function invCiPdfExportCss_(){
  return `
    .ci-pdf-export-root{
      font-family:Arial,Helvetica,sans-serif;
      color:#111;
      font-size:13px;
      width:794px;
      box-sizing:border-box;
      background:#fff;
    }
    .ci-invoice .ci-meta-table td{
      border:none !important;
      background:transparent !important;
      vertical-align:top;
    }
    .ci-invoice .ci-lines-table th,
    .ci-invoice .ci-lines-table td{
      border:1px solid #333 !important;
    }
    .ci-invoice .ci-lines-table thead th{
      background:#f1f5f9 !important;
    }
    .ci-invoice .ci-summary-table td{
      border:none !important;
      background:transparent !important;
    }
    .ci-invoice .ci-footer-logo{
      max-height:96px;
      max-width:110px;
      object-fit:contain;
    }
  `;
}

function invLoadExternalScriptOnce_(src){
  const key = String(src || "");
  if(!key) return Promise.reject(new Error("missing script src"));
  if(key.includes("html2pdf") && typeof html2pdf !== "undefined") return Promise.resolve();
  if(key.includes("jszip") && typeof JSZip !== "undefined") return Promise.resolve();
  const existing = document.querySelector('script[data-erp-src="' + key.replace(/"/g, "") + '"]');
  if(existing){
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("load failed")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = key;
    s.dataset.erpSrc = key;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load failed: " + key));
    document.head.appendChild(s);
  });
}

async function invEnsureCiPdfZipLibs_(){
  await invLoadExternalScriptOnce_("https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js");
  await invLoadExternalScriptOnce_("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
}

async function invWaitImagesInNode_(node, ms){
  const imgs = node ? node.querySelectorAll("img") : [];
  if(!imgs.length) return;
  const timeout = Number(ms || 4000);
  await Promise.all(Array.from(imgs).map(img => new Promise(resolve => {
    if(img.complete && img.naturalWidth) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    setTimeout(resolve, timeout);
  })));
}

async function invHtmlBodyToPdfBlob_(bodyHtml){
  const root = document.createElement("div");
  root.className = "ci-pdf-export-root";
  root.style.cssText = "position:fixed;left:-10000px;top:0;z-index:-1;";
  const style = document.createElement("style");
  style.textContent = invCiPdfExportCss_();
  root.appendChild(style);
  const content = document.createElement("div");
  content.innerHTML = bodyHtml;
  root.appendChild(content);
  document.body.appendChild(root);
  try{
    await invWaitImagesInNode_(root);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return await html2pdf().set({
      margin: [12, 14, 12, 14],
      filename: "CI.pdf",
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    }).from(content).outputPdf("blob");
  }finally{
    document.body.removeChild(root);
  }
}

function invDownloadBlobFile_(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    try{ URL.revokeObjectURL(url); }catch(_e){}
  }, 60000);
}

function invUniqueZipPdfName_(baseName, usedMap){
  let base = invSanitizeCiPdfFilePart_(baseName) || "CI";
  let entry = base + ".pdf";
  let n = 2;
  while(usedMap[entry]){
    entry = base + "_" + n + ".pdf";
    n += 1;
  }
  usedMap[entry] = 1;
  return entry;
}

async function invDownloadCiPdfZip_(jobs){
  await invEnsureCiPdfZipLibs_();
  const zip = new JSZip();
  const used = Object.create(null);
  for(const job of jobs){
    const blob = await invHtmlBodyToPdfBlob_(job.body);
    zip.file(invUniqueZipPdfName_(job.fileName, used), blob);
  }
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const day = (typeof nowIso16 === "function" ? nowIso16() : new Date().toISOString()).slice(0, 10).replace(/-/g, "");
  invDownloadBlobFile_(zipBlob, "CI_PDF_" + jobs.length + "筆_" + day + ".zip");
}

function invCiListToggleAll_(master, bodyId){
  const tbodyId = String(bodyId || "").trim();
  if(!tbodyId) return;
  const on = !!master?.checked;
  document.querySelectorAll("#" + tbodyId + " input.inv-ci-pick:not(:disabled)").forEach(cb => {
    cb.checked = on;
  });
}

function invBlankListGetSelectedCiIds_(){
  return Array.from(document.querySelectorAll("#invBlankListBody input.inv-ci-pick:checked"))
    .map(el => String(el.getAttribute("data-ci-id") || "").trim())
    .filter(Boolean);
}

function invShipmentListGetSelectedIds_(){
  return Array.from(document.querySelectorAll("#invListBody input.inv-ci-pick:checked"))
    .map(el => String(el.getAttribute("data-shipment-id") || "").trim().toUpperCase())
    .filter(Boolean);
}

async function invPrepareCiPdfBatchContext_(){
  await invLoadMasterData_();
  await invLoadCompanyProfile_();
  const hasSeller = invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: false });
  if(!hasSeller){
    showToast("請先到「公司設定」填寫 English 公司名稱與地址", "error");
    return false;
  }
  return true;
}

async function invBuildCiPdfJobFromBlankCiId_(ciId){
  const r = await callAPI({ action: "list_commercial_invoice_blank_by_ci", ci_id: ciId }, { method: "GET" });
  const ci = r?.data || null;
  const lines = r?.lines || [];
  if(!ci || !lines.length) return null;
  invWarnCiLineDescriptions_(lines);
  const payload = invEnrichPdfPayloadForPrint_(invBuildPdfPayloadFromCiRecord_(ci, lines), {});
  return invBuildCommercialInvoicePdfHtml_(payload, true);
}

async function invBuildCiPdfJobFromShipmentId_(shipmentId){
  const id = String(shipmentId || "").trim().toUpperCase();
  const r = await callAPI({ action: "list_commercial_invoice_by_shipment", shipment_id: id }, { method: "GET" });
  const ci = r?.data || null;
  const lines = r?.lines || [];
  if(!ci || !lines.length) return null;
  invWarnCiLineDescriptions_(lines);
  const sh = (invShipments_ || []).find(s => String(s?.shipment_id || "").trim().toUpperCase() === id)
    || await getOne("shipment", "shipment_id", id).catch(() => null);
  const payload = invEnrichPdfPayloadForPrint_(invBuildPdfPayloadFromCiRecord_(ci, lines), { shipment: sh });
  return invBuildCommercialInvoicePdfHtml_(payload, true);
}

async function invFinishCiPdfBatch_(jobs, skipped){
  if(!jobs.length){
    showToast("勾選的發票皆無法列印（可能未開立、無明細或已作廢）", "error");
    return;
  }
  if(jobs.length === 1){
    erpOpenPrintWindow_(jobs[0].fileName, jobs[0].body, { minimalPrintChrome: true, skipBrandHeader: true });
  }else{
    showToast("正在產生 " + jobs.length + " 份 PDF 並打包…", "success", 4000);
    await invDownloadCiPdfZip_(jobs);
    showToast("已下載壓縮檔（內含 " + jobs.length + " 份 PDF）", "success", 7000);
  }
  if(skipped > 0){
    showToast("已略過 " + skipped + " 筆無法列印的項目", "warn", 5000);
  }
}

async function invPrintBlankCiPdfBatch_(triggerEl){
  const ids = invBlankListGetSelectedCiIds_();
  if(!ids.length) return showToast("請先勾選要下載的發票", "warn");

  if(triggerEl) showSaveHint(triggerEl);
  try{
    if(!await invPrepareCiPdfBatchContext_()) return;

    const jobs = [];
    let skipped = 0;
    for(const id of ids){
      try{
        const job = await invBuildCiPdfJobFromBlankCiId_(id);
        if(!job){ skipped += 1; continue; }
        jobs.push(job);
      }catch(_e){
        skipped += 1;
      }
    }
    await invFinishCiPdfBatch_(jobs, skipped);
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      const msg = String(err && err.message || "").includes("load failed")
        ? "無法載入 PDF 打包元件，請確認網路後重試"
        : "批次下載失敗，請稍後重試";
      showToast(msg, "error");
    }
  }finally{
    if(triggerEl) hideSaveHint();
  }
}

async function invPrintShipmentCiPdfBatch_(triggerEl){
  const ids = invShipmentListGetSelectedIds_();
  if(!ids.length) return showToast("請先勾選要下載的發票", "warn");

  if(triggerEl) showSaveHint(triggerEl);
  try{
    if(!await invPrepareCiPdfBatchContext_()) return;

    const jobs = [];
    let skipped = 0;
    for(const id of ids){
      try{
        const job = await invBuildCiPdfJobFromShipmentId_(id);
        if(!job){ skipped += 1; continue; }
        jobs.push(job);
      }catch(_e){
        skipped += 1;
      }
    }
    await invFinishCiPdfBatch_(jobs, skipped);
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      const msg = String(err && err.message || "").includes("load failed")
        ? "無法載入 PDF 打包元件，請確認網路後重試"
        : "批次下載失敗，請稍後重試";
      showToast(msg, "error");
    }
  }finally{
    if(triggerEl) hideSaveHint();
  }
}

async function invRenderShipmentList_(){
  const tbody = document.getElementById("invListBody");
  if(!tbody) return;
  await invRefreshCiMap_();
  const qKw = String(document.getElementById("inv_search_keyword")?.value || "").trim().toUpperCase();
  const qCi = String(document.getElementById("inv_search_ci")?.value || "").trim().toUpperCase();
  const custMap = {};
  (invCustomers_ || []).forEach(c => { if(c?.customer_id) custMap[String(c.customer_id)] = c; });

  const rows = typeof erpSortRowsNewestFirst_ === "function"
    ? erpSortRowsNewestFirst_(invShipments_ || [], ["ship_date", "created_at"], "shipment_id")
    : (invShipments_ || []).slice().sort((a, b) =>
        String(b.ship_date || b.created_at || "").localeCompare(String(a.ship_date || a.created_at || ""))
      );
  const filtered = rows.filter(sh => {
    const sid = String(sh.shipment_id || "").trim().toUpperCase();
    const ci = invCiMap_[sid] || null;
    const ciSt = String(ci?.status || "").trim().toUpperCase();
    if(qCi === "MISSING" && ci) return false;
    if(qCi === "ISSUED" && ciSt !== "ISSUED") return false;
    if(qCi === "DRAFT" && ciSt !== "DRAFT") return false;
    if(qCi === "VOID" && ciSt !== "VOID") return false;
    if(!qKw) return true;
    const cn = String(custMap[sh.customer_id]?.customer_name || "").toUpperCase();
    const ciNo = String(ci?.ci_no || "").toUpperCase();
    return sid.includes(qKw) || String(sh.so_id || "").toUpperCase().includes(qKw) ||
      cn.includes(qKw) || ciNo.includes(qKw);
  });

  tbody.innerHTML = "";
  const selectAll = document.getElementById("inv_shipment_select_all");
  if(selectAll) selectAll.checked = false;

  if(!filtered.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px;">尚無符合條件的出貨單。</td></tr>';
    return;
  }

  filtered.forEach(sh => {
    const sid = String(sh.shipment_id || "");
    const ci = invCiMap_[sid.toUpperCase()] || null;
    const c = custMap[sh.customer_id] || null;
    const ciNo = ci?.ci_no || "—";
    const ciStUp = String(ci?.status || "").trim().toUpperCase();
    const ciSt = ci ? invCiStatusLabel_(ciStUp) : "—";
    const canPdf = !!(ci && ciStUp !== "VOID");
    const pickBox = canPdf
      ? `<input type="checkbox" class="inv-ci-pick" data-shipment-id="${escapeHtml_(sid)}">`
      : "";
    const soId = String(sh.so_id || "");
    tbody.innerHTML += `
      <tr>
        <td class="col-ci-pick">${pickBox}</td>
        <td class="logs-stack-cell">
          <div class="logs-stack-main inv-list-ship-id">${escapeHtml_(sid)}</div>
          <div class="logs-stack-sub">${escapeHtml_(soId || "—")}</div>
        </td>
        <td>${escapeHtml_(String(c?.customer_name || sh.customer_id || ""))}</td>
        <td>${escapeHtml_(String(dateInputValue_(sh.ship_date) || ""))}</td>
        <td>${escapeHtml_(String(ciNo))}</td>
        <td>${escapeHtml_(String(ciSt))}</td>
        <td class="col-ci-actions">
          <button class="btn-edit" type="button" onclick="invOpenEditor_('${escapeHtml_(sid)}')">${ci ? "編輯" : "開立"}</button>
        </td>
      </tr>
    `;
  });
}

function invCloseEditor_(){
  if(invStandaloneMode_){
    invSaveStandaloneDraft_(true);
  }
  if(invStandaloneDraftTimer_){
    clearTimeout(invStandaloneDraftTimer_);
    invStandaloneDraftTimer_ = null;
  }
  const card = document.getElementById("invEditorCard");
  if(card) card.style.display = "none";
  invCiLines_ = [];
  invCiLoadedId_ = "";
  invCiBuyerNameZh_ = "";
  invDraftLines_ = [];
  invSalesItems_ = [];
  invStandaloneMode_ = false;
  invSoOrder_ = null;
  invSyncStandaloneEditorUi_();
  const curEl = document.getElementById("inv_ci_currency");
  if(curEl) curEl.disabled = false;
  const tbody = document.getElementById("invCiLinesBody");
  if(tbody) tbody.innerHTML = "";
}

function invSyncStandaloneEditorUi_(){
  const standalone = !!invStandaloneMode_;
  const saveBtn = document.getElementById("inv_ci_save_btn");
  const refreshBtn = document.getElementById("inv_ci_refresh_btn");
  const lineTools = document.getElementById("invStandaloneLineTools");
  if(saveBtn){
    saveBtn.textContent = standalone ? "儲存至雲端" : "儲存";
    saveBtn.style.display = "";
  }
  if(refreshBtn){
    refreshBtn.style.display = standalone ? "none" : "";
  }
  if(lineTools){
    lineTools.style.display = standalone ? "" : "none";
  }
  const opHead = document.getElementById("invCiLinesOpHead");
  if(opHead){
    opHead.style.display = standalone ? "" : "none";
  }
  const curEl = document.getElementById("inv_ci_currency");
  if(curEl && standalone) curEl.disabled = false;
  invSyncShipmentBuyerFieldsReadonly_();
  invSyncEditorActionButtons_({ standalone });
}

function invSyncShipmentBuyerFieldsReadonly_(){
  const ro = !invStandaloneMode_;
  const tip = "來自出貨收件人／客戶主檔；要改請至 Shipment 出貨或 Customers 客戶";
  INV_SHIPMENT_BUYER_FIELD_IDS_.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.readOnly = ro;
    if(ro) el.title = tip;
    else el.removeAttribute("title");
  });
}

function invClearBlankEditorFields_(){
  invSetV_("inv_shipment_id", "");
  invSetV_("inv_so_id", "");
  invSetV_("inv_customer_id", "");
  invSetV_("inv_ci_no", "");
  invSetV_("inv_ci_date", "");
  invSetCiStatusDisplay_("");
  invSetV_("inv_ci_currency", "USD");
  invSetV_("inv_ci_waybill", "");
  invSetV_("inv_ci_origin", "");
  invSetSelectValue_("inv_ci_incoterms", "");
  invSetSelectValue_("inv_ci_payment_terms", "");
  invSetSellerSnapshot_({});
  invSetV_("inv_ci_buyer_name", "");
  invSetV_("inv_ci_buyer_address", "");
  invSetV_("inv_ci_buyer_phone", "");
  invSetV_("inv_ci_buyer_country", "");
  invSetV_("inv_ci_buyer_id_no", "");
  invSetV_("inv_ci_buyer_usci", "");
  invSetV_("inv_ci_remark", "");
  invSetV_("inv_ci_signature_date", "");
  invSetV_("inv_ci_subtotal", "");
  invSetV_("inv_ci_total", "");
}

function invApplyCiRecordToEditor_(ci, lines){
  invCiLoadedId_ = ci?.ci_id || "";
  invSetV_("inv_ci_no", ci?.ci_no || "");
  invSetV_("inv_ci_date", dateInputValue_(ci?.ci_date) || nowIso16().slice(0, 10));
  invSetCiStatusDisplay_(ci?.status || "ISSUED");
  invSetSelectValue_("inv_ci_currency", ci?.currency || "USD");
  invSetSelectValue_("inv_ci_incoterms", ci?.incoterms || "");
  invSetV_("inv_ci_waybill", ci?.waybill_no || "");
  invSetV_("inv_ci_origin", ci?.country_of_origin || "Taiwan");
  invSetSellerSnapshot_({
    seller_company_name_en: ci?.seller_company_name_en,
    seller_address_en: ci?.seller_address_en,
    seller_phone: ci?.seller_phone,
    seller_email: ci?.seller_email,
    seller_tax_id: ci?.seller_tax_id
  });
  invSetV_("inv_ci_buyer_name", ci?.buyer_name_en || "");
  invSetV_("inv_ci_buyer_address", ci?.buyer_address_en || "");
  invSetV_("inv_ci_buyer_phone", ci?.buyer_phone || "");
  invSetV_("inv_ci_buyer_country", ci?.buyer_country || "");
  invSetV_("inv_ci_buyer_id_no", ci?.buyer_id_no || "");
  invSetV_("inv_ci_buyer_usci", ci?.buyer_usci || "");
  invSetSelectValue_("inv_ci_payment_terms", ci?.payment_terms || "");
  invSetV_("inv_ci_remark", ci?.remark || "");
  invSetV_("inv_ci_signature_date", dateInputValue_(ci?.signature_date) || dateInputValue_(ci?.ci_date));
  const hasLines = Array.isArray(lines) && lines.length > 0;
  invRenderCiLinesTable_(hasLines ? lines : [{
    description_en: "",
    qty: 1,
    unit: "",
    unit_price: 0,
    amount: 0
  }]);
  if(!hasLines){
    invSetCiMoney_("inv_ci_subtotal", ci?.subtotal);
    invSetCiMoney_("inv_ci_total", ci?.total_amount);
  }
  invWarnCiLineDescriptions_(invCiLines_);
}

async function invOpenStandaloneCiEditor_(ciIdOpt){
  const ciId = String(ciIdOpt || "").trim();
  if(invLoadInFlight_) return showToast("載入中，請稍候", "error");
  invLoadInFlight_ = true;
  try{
    invStandaloneMode_ = true;
    invDraftLines_ = [];
    invSalesItems_ = [];
    invSoOrder_ = null;
    invClearBlankEditorFields_();
    invSetV_("inv_shipment_id", "");
    invSetV_("inv_so_id", "");
    invSetV_("inv_customer_id", "");
    await invLoadCompanyProfile_();
    invBindEditorEvents_();
    invSyncStandaloneEditorUi_();
    const card = document.getElementById("invEditorCard");
    if(card) card.style.display = "block";
    const hint = document.getElementById("invEditorHint");
    const curEl = document.getElementById("inv_ci_currency");
    if(curEl) curEl.disabled = false;

    if(ciId){
      const pack = await invFetchBlankCiWithLines_(ciId);
      const ci = pack.ci;
      const lines = pack.lines;
      if(pack.apiWarn && typeof showToast === "function"){
        showToast(pack.apiWarn, "warn", 5000);
      }
      if(!ci) return showToast("找不到空白 Commercial Invoice", "error");
      invApplyCiRecordToEditor_(ci, lines);
      const ciStatus = String(ci.status || "").trim().toUpperCase();
      if(ciStatus === "VOID"){
        const today = nowIso16().slice(0, 10);
        invSetV_("inv_ci_date", today);
        invSetV_("inv_ci_signature_date", today);
        const newNo = await invApplySuggestedCiNo_(true);
        if(newNo && typeof showToast === "function"){
          showToast("已自動帶入新 Invoice No.：" + newNo, "success", 5000);
        }
        if(hint) hint.textContent = "已作廢 — 已自動帶入新發票號，確認後按「儲存至雲端」重開";
      }else if(hint){
        hint.textContent = "空白 CI（commercial_invoice_blank）— 修改後按「儲存至雲端」";
      }
      invSyncEditorActionButtons_({ standalone: true, ci });
    }else{
      invCiLoadedId_ = "";
      invSetV_("inv_ci_date", nowIso16().slice(0, 10));
      invSetCiStatusDisplay_("DRAFT");
      invSetV_("inv_ci_signature_date", nowIso16().slice(0, 10));
      const hasSeller = invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: true });
      if(!hasSeller && typeof showToast === "function"){
        showToast("請先到「公司設定」填寫 English 公司名稱與地址", "warn", 8000);
      }
      if(hint) hint.textContent = "空白開立 — 填寫後按「儲存至雲端」；亦可「本機暫存」備份";
      const draft = invLoadStandaloneDraftFromStorage_();
      if(draft && confirm("發現本機暫存的空白發票草稿，要載入嗎？（尚未上傳雲端的內容）")){
        invApplyStandaloneDraft_(draft);
        showToast("已載入本機暫存草稿", "success", 4000);
      }else{
        invRenderCiLinesTable_([{
          description_en: "",
          qty: 1,
          unit: "",
          unit_price: 0,
          amount: 0
        }]);
        await invApplySuggestedCiNo_(true);
      }
      invSyncEditorActionButtons_({ standalone: true });
    }
    invBindStandaloneDraftAutosave_();
    try{ card?.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(_e){}
    if(ciId && typeof erpSyncListRowHighlight_ === "function"){
      erpSyncListRowHighlight_("invBlankListBody", "data-row-id", ciId);
    }
  }finally{
    invLoadInFlight_ = false;
  }
}

async function invOpenBlankEditor_(){
  await invOpenStandaloneCiEditor_("");
}

function invLinesForSaveFromRecord_(lines){
  return (lines || []).map(ln => ({
    description_en: String(ln.description_en || ""),
    qty: Number(ln.qty || 0),
    unit: String(ln.unit || ""),
    unit_price: Number(ln.unit_price || 0),
    amount: Number(ln.amount != null ? ln.amount : Number(ln.qty || 0) * Number(ln.unit_price || 0)),
    hs_code: String(ln.hs_code || ""),
    product_id: String(ln.product_id || ""),
    remark: String(ln.remark || "")
  }));
}

async function invCopyBlankCiCore_(ciId){
  const id = String(ciId || "").trim();
  if(!id) throw new Error("missing ci_id");

  const r = await callAPI({ action: "list_commercial_invoice_blank_by_ci", ci_id: id }, { method: "GET" });
  const ci = r?.data;
  let lines = r?.lines || [];
  if(!ci) throw new Error("找不到發票");
  if(!lines.length){
    const legacy = await getAll("commercial_invoice_line", { refresh: true }).catch(() => []);
    lines = (legacy || []).filter(function(ln){
      return String(ln.ci_id || "").trim() === id;
    });
  }
  if(!lines.length){
    throw new Error("來源發票沒有明細，無法複製（請先開啟原單補明細並儲存）");
  }

  const ciDate = dateInputValue_(ci.ci_date) || nowIso16().slice(0, 10);
  const newNo = await invSuggestBlankCiNo_(ciDate);
  if(!newNo) throw new Error("無法產生新發票號");

  await invLoadCompanyProfile_().catch(() => {});
  const declFromProfile = invGetCiDeclarationFromProfile_();

  await callAPI({
    action: "save_standalone_commercial_invoice_bundle",
    ci_id: "",
    ci_no: newNo,
    ci_date: ciDate,
    currency: String(ci.currency || "USD").trim(),
    incoterms: String(ci.incoterms || "").trim(),
    waybill_no: String(ci.waybill_no || "").trim(),
    country_of_origin: String(ci.country_of_origin || "Taiwan").trim(),
    seller_company_name_en: String(ci.seller_company_name_en || "").trim(),
    seller_address_en: String(ci.seller_address_en || "").trim(),
    seller_phone: String(ci.seller_phone || "").trim(),
    seller_email: String(ci.seller_email || "").trim(),
    seller_tax_id: String(ci.seller_tax_id || "").trim(),
    buyer_name_en: String(ci.buyer_name_en || "").trim(),
    buyer_address_en: String(ci.buyer_address_en || "").trim(),
    buyer_phone: String(ci.buyer_phone || "").trim(),
    buyer_country: String(ci.buyer_country || "").trim(),
    buyer_id_no: String(ci.buyer_id_no || "").trim(),
    buyer_usci: String(ci.buyer_usci || "").trim(),
    total_amount: String(ci.total_amount || "0"),
    payment_terms: String(ci.payment_terms || "").trim(),
    remark: String(ci.remark || "").trim(),
    signature_name: String(ci.signature_name || "").trim(),
    signature_date: dateInputValue_(ci.signature_date) || ciDate,
    declaration_text: declFromProfile,
    lines_json: JSON.stringify(invLinesForSaveFromRecord_(lines)),
    created_by: getCurrentUser(),
    updated_by: getCurrentUser(),
    updated_at: nowIsoTaipei()
  }, { method: "POST" });

  return newNo;
}

async function invCopyBlankCi_(ciId, triggerEl){
  const id = String(ciId || "").trim();
  if(!id) return;
  if(!confirm("複製此空白發票？\n系統會自動產生新發票號（CI-日期-序號，從 201 起）並儲存至雲端。")) return;
  if(triggerEl) showSaveHint(triggerEl);
  try{
    const newNo = await invCopyBlankCiCore_(id);
    if(typeof invalidateCache === "function"){
      invalidateCache("commercial_invoice_blank");
      invalidateCache("commercial_invoice_blank_line");
    }
    showToast("已複製，新發票號：" + newNo, "success", 6000);
    await invRefreshCiMap_(true);
    await invRenderBlankList_();
    try{
      document.getElementById("invBlankListCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }catch(_e){}
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast(err?.message === "找不到發票" ? "找不到發票" : (err?.message === "無法產生新發票號" ? "無法產生新發票號" : "複製失敗，請重試"), "error");
    }
  }finally{
    if(triggerEl) hideSaveHint();
  }
}

async function invCopyBlankCiBatch_(triggerEl){
  const ids = invBlankListGetSelectedCiIds_();
  if(!ids.length) return showToast("請先勾選要複製的發票", "warn");

  const msg = ids.length === 1
    ? "複製此空白發票？\n系統會自動產生新發票號（CI-日期-序號，從 201 起）並儲存至雲端。"
    : ("複製已勾選的 " + ids.length + " 筆空白發票？\n每筆會自動產生新發票號並儲存至雲端。");
  if(!confirm(msg)) return;

  if(triggerEl) showSaveHint(triggerEl);
  try{
    const newNos = [];
    for(const id of ids){
      const newNo = await invCopyBlankCiCore_(id);
      newNos.push(newNo);
    }
    if(typeof invalidateCache === "function"){
      invalidateCache("commercial_invoice_blank");
      invalidateCache("commercial_invoice_blank_line");
    }
    const tip = newNos.length === 1
      ? ("已複製，新發票號：" + newNos[0])
      : ("已複製 " + newNos.length + " 筆");
    showToast(tip, "success", 6000);
    await invRefreshCiMap_(true);
    await invRenderBlankList_();
    try{
      document.getElementById("invBlankListCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }catch(_e){}
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast("複製失敗，請重試", "error");
    }
  }finally{
    if(triggerEl) hideSaveHint();
  }
}

function invAddBlankCiLine_(){
  if(!invStandaloneMode_) return;
  invCiSyncLinesFromTable_();
  invCiLines_.push({
    description_en: "",
    qty: 1,
    unit: "",
    unit_price: 0,
    amount: 0
  });
  invRenderCiLinesTable_(invCiLines_);
}

function invRemoveBlankCiLine_(idx){
  if(!invStandaloneMode_) return;
  invCiSyncLinesFromTable_();
  invCiLines_.splice(Number(idx), 1);
  invRenderCiLinesTable_(invCiLines_);
}

function invCiDescEn_(productId){
  const p = invFindProduct_(productId);
  const en = String(p?.product_name_en || "").trim();
  return en || String(p?.product_name || productId || "").trim();
}

/** 明細品名：大陸買方英+中，其餘以英文為主 */
function invCiLineDesc_(productId, mainland){
  const p = invFindProduct_(productId);
  const en = String(p?.product_name_en || "").trim();
  const zh = String(p?.product_name || productId || "").trim();
  if(mainland){
    if(en && zh && en !== zh) return en + " " + zh;
    return en || zh;
  }
  return invCiDescEn_(productId);
}

function invBuildDefaultCiLines_(){
  const soItemMap = {};
  (invSalesItems_ || []).forEach(it => {
    if(it && it.so_item_id) soItemMap[String(it.so_item_id)] = it;
  });
  const mainland = invIsMainlandChinaCountry_(invCiBuyerCountry_());
  const lines = [];
  (invDraftLines_ || []).forEach(it => {
    const qty = Number(it.ship_qty || 0);
    if(!(qty > 0)) return;
    const soItem = soItemMap[String(it.so_item_id || "")] || null;
    const unitPrice = Number(soItem?.unit_price || 0);
    const amount = Math.round(qty * unitPrice * 100) / 100;
    lines.push({
      shipment_item_id: String(it.shipment_item_id || ""),
      so_item_id: it.so_item_id || "",
      product_id: it.product_id || "",
      description_en: invCiLineDesc_(it.product_id, mainland),
      hs_code: String(invFindProduct_(it.product_id)?.hs_code || "").trim(),
      qty,
      unit: it.unit || "",
      unit_price: unitPrice,
      amount
    });
  });
  return lines;
}

function invRenderCiLinesTable_(lines){
  invCiLines_ = Array.isArray(lines) ? lines.map(x => ({ ...x })) : [];
  const tbody = document.getElementById("invCiLinesBody");
  if(!tbody) return;
  tbody.innerHTML = "";
  let subtotal = 0;
  invCiLines_.forEach((ln, idx) => {
    const qty = Number(ln.qty || 0);
    const unitPrice = Number(ln.unit_price || 0);
    const amount = Number(ln.amount != null ? ln.amount : qty * unitPrice);
    subtotal += amount;
    const unit = String(ln.unit || "").trim();
    const qtyCell = invStandaloneMode_
      ? `<input type="number" class="inv-ci-qty" data-idx="${idx}" min="0" step="any" value="${qty}" style="width:72px;">`
      : `${qty} ${escapeHtml_(unit)}`;
    const unitCell = invStandaloneMode_
      ? `<input type="text" class="inv-ci-unit" data-idx="${idx}" value="${escapeHtml_(unit)}" style="width:56px;">`
      : "";
    const opCell = invStandaloneMode_
      ? `<button type="button" class="btn-secondary" onclick="invRemoveBlankCiLine_(${idx})">刪除</button>`
      : "";
    const descCell = invStandaloneMode_
      ? `<input type="text" class="inv-ci-desc" data-idx="${idx}" value="${escapeHtml_(String(ln.description_en || ""))}" style="width:100%;min-width:180px;">`
      : `<span class="inv-ci-desc-text" style="display:block;text-align:left;word-break:break-word;">${escapeHtml_(String(ln.description_en || ""))}</span>`;
    tbody.innerHTML += `
      <tr data-inv-ci-line="${idx}">
        <td>${idx + 1}</td>
        <td>${descCell}</td>
        <td>${invStandaloneMode_ ? `<div style="display:flex;gap:4px;align-items:center;">${qtyCell}${unitCell}</div>` : qtyCell}</td>
        <td><input type="number" class="inv-ci-price" data-idx="${idx}" min="0" step="0.01" value="${unitPrice}" style="width:90px;"></td>
        <td class="inv-ci-amt" data-idx="${idx}">${amount.toFixed(2)}</td>
        ${invStandaloneMode_ ? `<td>${opCell}</td>` : ""}
      </tr>
    `;
  });
  tbody.querySelectorAll(".inv-ci-price, .inv-ci-qty, .inv-ci-unit").forEach(inp => {
    inp.addEventListener("input", invCiRecalcFromTable_);
  });
  if(invStandaloneMode_){
    tbody.querySelectorAll(".inv-ci-desc").forEach(inp => {
      inp.addEventListener("input", function(){
        const i = Number(this.dataset.idx);
        if(invCiLines_[i]) invCiLines_[i].description_en = this.value;
      });
    });
  }
  const total = Math.round(subtotal * 100) / 100;
  invSetCiMoney_("inv_ci_subtotal", total);
  invSetCiMoney_("inv_ci_total", total);
}

function invCiRecalcFromTable_(){
  const tbody = document.getElementById("invCiLinesBody");
  if(!tbody) return;
  let subtotal = 0;
  tbody.querySelectorAll("tr[data-inv-ci-line]").forEach(row => {
    const idx = Number(row.getAttribute("data-inv-ci-line"));
    const ln = invCiLines_[idx];
    if(!ln) return;
    const priceInp = row.querySelector(".inv-ci-price");
    const descInp = row.querySelector(".inv-ci-desc");
    const qtyInp = row.querySelector(".inv-ci-qty");
    const unitInp = row.querySelector(".inv-ci-unit");
    const qty = invStandaloneMode_ && qtyInp
      ? Number(qtyInp.value || 0)
      : Number(ln.qty || 0);
    const unit = invStandaloneMode_ && unitInp
      ? String(unitInp.value || "").trim()
      : String(ln.unit || "").trim();
    const unitPrice = Number(priceInp?.value || 0);
    const amount = Math.round(qty * unitPrice * 100) / 100;
    ln.qty = qty;
    ln.unit = unit;
    ln.unit_price = unitPrice;
    ln.amount = amount;
    if(descInp) ln.description_en = descInp.value;
    const amtCell = row.querySelector(".inv-ci-amt");
    if(amtCell) amtCell.textContent = amount.toFixed(2);
    subtotal += amount;
  });
  const total = Math.round(subtotal * 100) / 100;
  invSetCiMoney_("inv_ci_subtotal", total);
  invSetCiMoney_("inv_ci_total", total);
}

function invCiSyncLinesFromTable_(){
  invCiRecalcFromTable_();
  return invCiLines_;
}

function invRefreshCiPreview_(){
  if(invStandaloneMode_) return showToast("空白開立請手動新增明細", "warn");
  const sid = String(invGetV_("inv_shipment_id") || "").trim().toUpperCase();
  const sh = (invShipments_ || []).find(s => String(s?.shipment_id || "").trim().toUpperCase() === sid);
  if(sh) invFillCiBuyerFromShipment_(sh, sh.customer_id);
  const lines = invBuildDefaultCiLines_();
  invRenderCiLinesTable_(lines);
  invWarnCiLineDescriptions_(lines);
}

async function invLoadCompanyProfile_(){
  try{
    invCompanyProfile_ = await callAPI({ action: "get_company_profile" }, { method: "GET" });
  }catch(_e){
    invCompanyProfile_ = null;
  }
  return invCompanyProfile_;
}

function invBuildSellerAddressEn_(p){
  const prof = p || {};
  const line1 = String(prof.address_en || "").trim();
  const cityZip = [String(prof.city_en || "").trim(), String(prof.postal_code || "").trim()].filter(Boolean).join(" ");
  const country = String(prof.country_en || "").trim();
  return [line1, cityZip, country].filter(Boolean).join(", ");
}

function invFillCiSellerFromProfile_(prof, opts){
  const o = opts && typeof opts === "object" ? opts : {};
  const force = !!o.force;
  const fillDefaults = o.defaults !== false;
  const p = prof || invCompanyProfile_ || {};

  const name = String(p.company_name_en || "").trim();
  const address = invBuildSellerAddressEn_(p);
  const phone = String(p.phone || "").trim();
  const email = String(p.email || "").trim();
  const taxId = String(p.tax_id || "").trim();

  if(force || !String(invSellerSnapshot_.seller_company_name_en || "").trim()){
    invSetSellerSnapshot_({
      seller_company_name_en: name,
      seller_address_en: address,
      seller_phone: phone,
      seller_email: email,
      seller_tax_id: taxId
    });
  }

  if(!fillDefaults) return !!name;

  if(!document.getElementById("inv_ci_currency")?.value){
    invSetV_("inv_ci_currency", p.default_currency || "USD");
  }
  if(!document.getElementById("inv_ci_origin")?.value){
    invSetV_("inv_ci_origin", p.default_country_of_origin || "Taiwan");
  }
  if(!document.getElementById("inv_ci_incoterms")?.value){
    invSetSelectValue_("inv_ci_incoterms", p.default_incoterms || "");
  }
  return !!name;
}

async function invSyncSellerFromProfile_(){
  await invLoadCompanyProfile_();
  return invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: false });
}

function invFillCiBuyerFromShipment_(sh, customerId){
  const shipment = sh || {};
  const cust = (invCustomers_ || []).find(x => String(x?.customer_id || "") === String(customerId || "")) || null;
  const nameEn = String(shipment.recipient_name_en || "").trim()
    || String(cust?.invoice_name_en || "").trim();
  const nameZh = String(shipment.recipient_name || "").trim();
  const fallback = String(cust?.customer_name || "").trim();
  invCiBuyerNameZh_ = (nameEn && nameZh && nameEn !== nameZh) ? nameZh : "";
  invSetV_("inv_ci_buyer_name", nameEn || nameZh || fallback);
  const address = String(shipment.recipient_address || "").trim()
    || String(cust?.invoice_address_en || "").trim()
    || String(cust?.address || "").trim();
  const phone = String(shipment.recipient_phone || "").trim()
    || String(cust?.phone || "").trim();
  invSetV_("inv_ci_buyer_address", address);
  invSetV_("inv_ci_buyer_phone", phone);
  invSetV_("inv_ci_buyer_country", String(cust?.country || "").trim());
  invSetV_("inv_ci_buyer_id_no", String(cust?.consignee_id_no || "").trim());
  invSetV_("inv_ci_buyer_usci", String(cust?.consignee_usci || "").trim());
}

async function invOpenEditor_(shipmentId){
  const id = String(shipmentId || "").trim().toUpperCase();
  if(!id) return;
  if(invLoadInFlight_) return showToast("載入中，請稍候", "error");

  invStandaloneMode_ = false;
  invSyncStandaloneEditorUi_();
  invLoadInFlight_ = true;
  try{
    await invLoadMasterData_();
    const sh = (invShipments_ || []).find(s => String(s?.shipment_id || "").trim().toUpperCase() === id) ||
      await getOne("shipment", "shipment_id", id).catch(() => null);
    if(!sh) return showToast("找不到出貨單", "error");
    if(String(sh.status || "").trim().toUpperCase() !== "POSTED"){
      return showToast("僅 POSTED 出貨單可開立 Commercial Invoice", "error");
    }
    const cust = (invCustomers_ || []).find(c => String(c?.customer_id || "") === String(sh.customer_id || ""));
    if(!invShipmentNeedsCi_(cust)){
      return showToast("台灣客戶不需開立 Commercial Invoice", "error");
    }

    let items = [];
    try{
      const r = await callAPI({ action: "list_shipment_item_by_shipment", shipment_id: id }, { method: "GET" });
      items = (r && r.data) ? r.data : [];
    }catch(_e){
      const all = await getAll("shipment_item").catch(() => []);
      items = (all || []).filter(x => String(x.shipment_id || "").trim().toUpperCase() === id);
    }
    invDraftLines_ = (items || []).map(it => ({
      shipment_item_id: it.shipment_item_id,
      so_item_id: it.so_item_id || "",
      product_id: it.product_id,
      ship_qty: Number(it.ship_qty || 0),
      unit: it.unit || ""
    }));

    invSalesItems_ = [];
    const soId = String(sh.so_id || "").trim().toUpperCase();
    invSoOrder_ = null;
    if(soId){
      invSoOrder_ = await getOne("sales_order", "so_id", soId).catch(() => null);
      try{
        const r = await callAPI({ action: "list_sales_order_item_by_so", so_id: soId }, { method: "GET" });
        invSalesItems_ = (r && r.data) ? r.data : [];
      }catch(_e2){}
    }

    await invLoadCompanyProfile_();

    invSetV_("inv_shipment_id", id);
    invSetV_("inv_so_id", sh.so_id || "");
    invSetV_("inv_customer_id", sh.customer_id || "");

    let ci = null;
    let lines = [];
    try{
      const r = await callAPI({ action: "list_commercial_invoice_by_shipment", shipment_id: id }, { method: "GET" });
      ci = r?.data || null;
      lines = r?.lines || [];
    }catch(_e3){}

    invBindEditorEvents_();
    const card = document.getElementById("invEditorCard");
    if(card) card.style.display = "block";

    const hint = document.getElementById("invEditorHint");

    invCiBuyerNameZh_ = String(sh.recipient_name || "").trim();
    if(ci){
      invCiLoadedId_ = ci.ci_id || "";
      invSetV_("inv_ci_no", ci.ci_no || "");
      invSetV_("inv_ci_date", dateInputValue_(ci.ci_date) || nowIso16().slice(0, 10));
      invSetCiStatusDisplay_(ci.status || "ISSUED");
      invSetSelectValue_("inv_ci_incoterms", ci.incoterms || "");
      invSetV_("inv_ci_waybill", ci.waybill_no || "");
      invSetV_("inv_ci_origin", ci.country_of_origin || "Taiwan");
      invSetSellerSnapshot_({
        seller_company_name_en: ci.seller_company_name_en,
        seller_address_en: ci.seller_address_en,
        seller_phone: ci.seller_phone,
        seller_email: ci.seller_email,
        seller_tax_id: ci.seller_tax_id
      });
      invSetV_("inv_ci_buyer_name", ci.buyer_name_en || "");
      invSetV_("inv_ci_buyer_address", ci.buyer_address_en || "");
      invSetV_("inv_ci_buyer_phone", ci.buyer_phone || "");
      invSetV_("inv_ci_buyer_country", ci.buyer_country || "");
      invSetV_("inv_ci_buyer_id_no", ci.buyer_id_no || "");
      invSetV_("inv_ci_buyer_usci", ci.buyer_usci || "");
      invSetSelectValue_("inv_ci_payment_terms", ci.payment_terms || "");
      invSetV_("inv_ci_remark", ci.remark || "");
      invSetV_("inv_ci_signature_date", dateInputValue_(ci.signature_date) || dateInputValue_(ci.ci_date));
      const hasLines = Array.isArray(lines) && lines.length > 0;
      invRenderCiLinesTable_(hasLines ? lines : invBuildDefaultCiLines_());
      if(!hasLines){
        invSetCiMoney_("inv_ci_subtotal", ci.subtotal);
        invSetCiMoney_("inv_ci_total", ci.total_amount);
      }
      invWarnCiLineDescriptions_(invCiLines_);
    }else{
      invCiLoadedId_ = "";
      invSetV_("inv_ci_date", nowIso16().slice(0, 10));
      invSetCiStatusDisplay_("DRAFT");
      invSetV_("inv_ci_signature_date", nowIso16().slice(0, 10));
      const hasSeller = invFillCiSellerFromProfile_(invCompanyProfile_, { force: true, defaults: true });
      if(!hasSeller && typeof showToast === "function"){
        showToast("請先到「公司設定」填寫 English 公司名稱與地址", "warn", 8000);
      }
      invFillCiBuyerFromShipment_(sh, sh.customer_id);
      invRenderCiLinesTable_(invBuildDefaultCiLines_());
      invWarnCiLineDescriptions_(invCiLines_);
      await invApplySuggestedCiNo_(true);
    }

    invApplySoCurrencyToCi_(invSoOrder_, sh.customer_id);

    const ciStatus = String(ci?.status || invGetCiStatusCode_() || "DRAFT").trim().toUpperCase();
    if(ciStatus === "VOID"){
      const today = nowIso16().slice(0, 10);
      invSetV_("inv_ci_date", today);
      invSetV_("inv_ci_signature_date", today);
      const newNo = await invApplySuggestedCiNo_(true);
      if(newNo && typeof showToast === "function"){
        showToast("已自動帶入新 Invoice No.：" + newNo, "success", 5000);
      }
    }
    if(hint){
      if(ciStatus === "VOID"){
        hint.textContent = "已作廢 — 已自動帶入新發票號，確認後按儲存可重開";
      }else if(ci){
        hint.textContent = "已儲存 — 買方／明細唯讀，僅單價可改；要改資料請回出貨／客戶／產品主檔";
      }else{
        hint.textContent = "由出貨帶入買方／明細（僅單價可改）→ 儲存 → PDF";
      }
    }
    invSyncShipmentBuyerFieldsReadonly_();
    invSyncEditorActionButtons_({ ci });

    try{ card?.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(_e4){}
  }finally{
    invLoadInFlight_ = false;
  }
}

async function invVoidCommercialInvoice_(triggerEl){
  const shipment_id = String(document.getElementById("inv_shipment_id")?.value || "").trim().toUpperCase();
  const ci_id = String(invCiLoadedId_ || "").trim();
  if(invStandaloneMode_){
    if(!ci_id) return showToast("請先儲存至雲端", "error");
  }else if(!shipment_id){
    return showToast("請先選出貨單", "error");
  }
  const ciNo = String(document.getElementById("inv_ci_no")?.value || "").trim();
  const msg = "確定作廢 Commercial Invoice「" + (ciNo || ci_id || shipment_id) + "」？\n作廢後可修改並儲存以重開。";
  if(!confirm(msg)) return;
  if(triggerEl) showSaveHint(triggerEl);
  try{
    await callAPI({
      action: "void_commercial_invoice_bundle",
      shipment_id: invStandaloneMode_ ? "" : shipment_id,
      ci_id: ci_id || "",
      updated_by: getCurrentUser()
    }, { method: "POST" });
    showToast("Commercial Invoice 已作廢", "success", 5000);
    await invRefreshCiMap_(true);
    if(invStandaloneMode_){
      await invRenderBlankList_();
      await invOpenStandaloneCiEditor_(ci_id);
    }else{
      await invRenderShipmentList_();
      await invOpenEditor_(shipment_id);
    }
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast("作廢失敗，請重試", "error");
    }
  }finally{
    if(triggerEl) hideSaveHint();
  }
}

async function invSaveCommercialInvoice(triggerEl){
  if(invCiSaveInFlight_) return showToast("儲存中，請稍候…", "error");

  const ci_no = String(document.getElementById("inv_ci_no")?.value || "").trim();
  const ci_date = String(document.getElementById("inv_ci_date")?.value || "").trim();
  if(!ci_no) return showToast("請填 Invoice No.", "error");
  if(!ci_date) return showToast("請填 Invoice Date", "error");

  if(!invCompanyProfile_) await invLoadCompanyProfile_().catch(() => {});

  invCiSyncLinesFromTable_();
  if(!invCiLines_.length){
    invRefreshCiPreview_();
    invCiSyncLinesFromTable_();
  }
  if(!invCiLines_.length) return showToast("無明細可儲存", "error");
  if(invStandaloneMode_){
    const badQty = invCiLines_.some(function(ln){ return !(Number(ln.qty || 0) > 0); });
    if(badQty) return showToast("明細數量須大於 0 才能儲存", "error");
    const badDesc = invCiLines_.some(function(ln){ return !String(ln.description_en || "").trim(); });
    if(badDesc) return showToast("請填寫每筆明細的品名描述", "error");
  }

  const hasSeller = await invSyncSellerFromProfile_();
  if(!hasSeller) return showToast("請先到「公司設定」填寫 English 公司名稱與地址", "error");

  const savePayload = {
    ci_id: invCiLoadedId_ || "",
    ci_no,
    ci_date,
    currency: String(document.getElementById("inv_ci_currency")?.value || "USD").trim(),
    incoterms: String(document.getElementById("inv_ci_incoterms")?.value || "").trim(),
    waybill_no: String(document.getElementById("inv_ci_waybill")?.value || "").trim(),
    country_of_origin: String(document.getElementById("inv_ci_origin")?.value || "Taiwan").trim(),
    seller_company_name_en: String(invSellerSnapshot_.seller_company_name_en || "").trim(),
    seller_address_en: String(invSellerSnapshot_.seller_address_en || "").trim(),
    seller_phone: String(invSellerSnapshot_.seller_phone || "").trim(),
    seller_email: String(invSellerSnapshot_.seller_email || "").trim(),
    seller_tax_id: String(invSellerSnapshot_.seller_tax_id || "").trim(),
    buyer_name_en: String(document.getElementById("inv_ci_buyer_name")?.value || "").trim(),
    buyer_address_en: String(document.getElementById("inv_ci_buyer_address")?.value || "").trim(),
    buyer_phone: String(document.getElementById("inv_ci_buyer_phone")?.value || "").trim(),
    buyer_country: String(document.getElementById("inv_ci_buyer_country")?.value || "").trim(),
    buyer_id_no: String(document.getElementById("inv_ci_buyer_id_no")?.value || "").trim(),
    buyer_usci: String(document.getElementById("inv_ci_buyer_usci")?.value || "").trim(),
    total_amount: String(document.getElementById("inv_ci_total")?.value || "0"),
    payment_terms: String(document.getElementById("inv_ci_payment_terms")?.value || "").trim(),
    remark: String(document.getElementById("inv_ci_remark")?.value || "").trim(),
    signature_name: "",
    signature_date: String(document.getElementById("inv_ci_signature_date")?.value || ci_date).trim(),
    declaration_text: invGetCiDeclarationFromProfile_(),
    lines_json: JSON.stringify(invCiLines_),
    created_by: getCurrentUser(),
    updated_by: getCurrentUser(),
    updated_at: nowIsoTaipei()
  };

  if(invStandaloneMode_){
    invCiSaveInFlight_ = true;
    showSaveHint(triggerEl || document.getElementById("inv_ci_save_btn"));
    try{
      const r = await callAPI({
        action: "save_standalone_commercial_invoice_bundle",
        ...savePayload
      }, { method: "POST" });
      const newId = String(r?.ci_id || invCiLoadedId_ || "").trim();
      if(newId) invCiLoadedId_ = newId;
      invClearStandaloneDraft_(true);
      invSetCiStatusDisplay_("ISSUED");
      if(typeof invalidateCache === "function"){
        invalidateCache("commercial_invoice_blank");
        invalidateCache("commercial_invoice_blank_line");
      }
      showToast("空白 Commercial Invoice 已儲存至雲端：" + ci_no, "success", 6000);
      await invRefreshCiMap_(true);
      await invRenderBlankList_();
      try{
        document.getElementById("invBlankListCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }catch(_eScroll){}
      if(newId) await invOpenStandaloneCiEditor_(newId);
    }catch(err){
      if(!(err && err.erpApiToastShown)){
        showToast("儲存失敗，請重試", "error");
      }
    }finally{
      invCiSaveInFlight_ = false;
      hideSaveHint();
    }
    return;
  }

  const shipment_id = String(document.getElementById("inv_shipment_id")?.value || "").trim().toUpperCase();
  if(!shipment_id) return showToast("請先選出貨單", "error");

  invCiSaveInFlight_ = true;
  showSaveHint(triggerEl || document.getElementById("inv_ci_save_btn"));
  try{
    const so_id = String(document.getElementById("inv_so_id")?.value || "").trim().toUpperCase();
    await callAPI({
      action: "save_commercial_invoice_bundle",
      ...savePayload,
      shipment_id,
      so_id
    }, { method: "POST" });

    showToast("Commercial Invoice saved: " + ci_no, "success", 6000);
    await invRefreshCiMap_(true);
    await invLoadMasterData_();
    await invRenderShipmentList_();
    await invOpenEditor_(shipment_id);
  }catch(err){
    if(!(err && err.erpApiToastShown)){
      showToast("Save failed — please retry", "error");
    }
  }finally{
    invCiSaveInFlight_ = false;
    hideSaveHint();
  }
}

async function downloadCommercialInvoicePdf(pdfVersion){
  invCiSyncLinesFromTable_();
  const shipment_id = String(document.getElementById("inv_shipment_id")?.value || "").trim().toUpperCase();
  if(!invStandaloneMode_ && !shipment_id) return showToast("請先從列表選出貨單開立", "error");
  if(!invCiLines_.length){
    const tip = invStandaloneMode_
      ? "請先按「新增明細」加入至少 1 筆品項"
      : "無明細可列印：請按「重算明細」或確認出貨單有品項";
    return showToast(tip, "error");
  }
  const badQty = invCiLines_.some(ln => !(Number(ln.qty || 0) > 0));
  if(badQty) return showToast("明細數量需大於 0", "error");

  const ciNo = String(document.getElementById("inv_ci_no")?.value || "").trim();
  const ciDate = String(document.getElementById("inv_ci_date")?.value || "").trim();
  if(!ciNo) return showToast("請填 Invoice No.", "error");
  if(!ciDate) return showToast("請填 Invoice Date", "error");

  const hasSeller = await invSyncSellerFromProfile_();
  if(!hasSeller) return showToast("請先到「公司設定」填寫 English 公司名稱與地址", "error");

  invWarnCiLineDescriptions_(invCiLines_);

  const v2 = String(pdfVersion || "1").trim() === "2";
  const sid = String(document.getElementById("inv_shipment_id")?.value || "").trim().toUpperCase();
  const sh = sid
    ? ((invShipments_ || []).find(s => String(s?.shipment_id || "").trim().toUpperCase() === sid) || null)
    : null;
  const payload = invEnrichPdfPayloadForPrint_(invBuildPdfPayloadFromForm_(), { shipment: sh });
  const { body, fileName } = invBuildCommercialInvoicePdfHtml_(payload, v2);
  erpOpenPrintWindow_(fileName, body, { minimalPrintChrome: true, skipBrandHeader: true });
}

function downloadCommercialInvoicePdfV2(){
  return downloadCommercialInvoicePdf("1");
}

/** 相容舊名稱（出貨列表用） */
function shipCiListLabel_(sh){
  return invCiListLabel_(sh);
}
