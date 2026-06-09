/*********************************
 * Company Profile（公司資料）
 *********************************/

async function companySettingsInit(){
  await loadCompanyProfileForm();
}

function cpSet_(id, v){
  const el = document.getElementById(id);
  if(el && "value" in el) el.value = v != null ? v : "";
}

async function loadCompanyProfileForm(){
  try{
    const r = await callAPI({ action: "get_company_profile" }, { method: "GET" });
    cpSet_("cp_company_name_zh", r?.company_name_zh || "");
    cpSet_("cp_company_name_en", r?.company_name_en || "");
    cpSet_("cp_address_zh", r?.address_zh || "");
    cpSet_("cp_address_en", r?.address_en || "");
    cpSet_("cp_city_zh", r?.city_zh || "");
    cpSet_("cp_city_en", r?.city_en || "");
    cpSet_("cp_country_zh", r?.country_zh || "台灣");
    cpSet_("cp_country_en", r?.country_en || "Taiwan");
    cpSet_("cp_postal_code", r?.postal_code || "");
    cpSet_("cp_phone", r?.phone || "");
    cpSet_("cp_email", r?.email || "");
    cpSet_("cp_tax_id", r?.tax_id || "");
    cpSet_("cp_default_currency", r?.default_currency || "USD");
    cpSet_("cp_default_origin", r?.default_country_of_origin || "Taiwan");
    cpSet_("cp_default_incoterms", r?.default_incoterms || "");
    cpSet_("cp_declaration_text", r?.declaration_text || "I declare that the information is true and correct.");
    cpSet_("cp_remark", r?.remark || "");
  }catch(_e){
    showToast("無法載入公司設定", "error");
  }
}

async function saveCompanyProfile(triggerEl){
  const company_name_en = String(document.getElementById("cp_company_name_en")?.value || "").trim();
  const address_en = String(document.getElementById("cp_address_en")?.value || "").trim();
  if(!company_name_en) return showToast("請填 English 公司名稱（CI 必填）", "error");
  if(!address_en) return showToast("請填 English 地址（CI 必填）", "error");

  showSaveHint(triggerEl);
  try{
    await callAPI({
      action: "update_company_profile",
      company_name_zh: String(document.getElementById("cp_company_name_zh")?.value || "").trim(),
      company_name_en,
      address_zh: String(document.getElementById("cp_address_zh")?.value || "").trim(),
      address_en,
      city_zh: String(document.getElementById("cp_city_zh")?.value || "").trim(),
      city_en: String(document.getElementById("cp_city_en")?.value || "").trim(),
      country_zh: String(document.getElementById("cp_country_zh")?.value || "台灣").trim(),
      country_en: String(document.getElementById("cp_country_en")?.value || "Taiwan").trim(),
      postal_code: String(document.getElementById("cp_postal_code")?.value || "").trim(),
      phone: String(document.getElementById("cp_phone")?.value || "").trim(),
      email: String(document.getElementById("cp_email")?.value || "").trim(),
      tax_id: String(document.getElementById("cp_tax_id")?.value || "").trim(),
      default_currency: String(document.getElementById("cp_default_currency")?.value || "USD").trim(),
      default_country_of_origin: String(document.getElementById("cp_default_origin")?.value || "Taiwan").trim(),
      default_incoterms: String(document.getElementById("cp_default_incoterms")?.value || "").trim(),
      declaration_text: String(document.getElementById("cp_declaration_text")?.value || "").trim(),
      remark: String(document.getElementById("cp_remark")?.value || "").trim(),
      updated_by: getCurrentUser(),
      updated_at: nowIso16()
    }, { method: "POST" });
    showToast("公司資料已儲存", "success");
  }catch(err){
    if(!(err && err.erpApiToastShown)) showToast("儲存失敗", "error");
  }finally{
    hideSaveHint();
  }
}
