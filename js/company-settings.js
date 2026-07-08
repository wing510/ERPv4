/*********************************
 * Company Profile（公司資料）
 *********************************/

function cpCanEdit_(){
  try{
    return typeof erpCanChangeMasterStatus_ === "function" && erpCanChangeMasterStatus_();
  }catch(_e){
    return false;
  }
}

function cpCanManageBackup_(){
  return cpCanEdit_();
}

function cpApplyFormPermissions_(){
  const canEdit = cpCanEdit_();
  const editActions = document.getElementById("companyProfileEditActions");
  const grid = document.getElementById("companyProfileFormGrid");

  if(editActions){
    editActions.style.display = canEdit ? "" : "none";
  }

  if(grid){
    const fields = grid.querySelectorAll("input, select, textarea");
    fields.forEach(function(el){
      el.disabled = !canEdit;
      el.readOnly = !canEdit;
    });
  }
  const finGrid = document.getElementById("companyProfileFinanceGrid");
  if(finGrid){
    const finFields = finGrid.querySelectorAll("input, select, textarea");
    finFields.forEach(function(el){
      el.disabled = !canEdit;
      el.readOnly = !canEdit;
    });
  }

  cpApplyBackupCardVisibility_();
}

function cpApplyBackupCardVisibility_(){
  const card = document.getElementById("cpBackupCard");
  if(!card) return;
  card.style.display = cpCanManageBackup_() ? "" : "none";
}

async function companySettingsInit(){
  cpApplyFormPermissions_();
  const tasks = [loadCompanyProfileForm()];
  if(cpCanManageBackup_()) tasks.push(loadCompanyBackupList());
  await Promise.all(tasks);
}

function cpEscapeHtml_(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cpBackupKindLabel_(kind){
  const k = String(kind || "").toLowerCase();
  if(k === "manual") return "手動";
  if(k === "scheduled") return "自動";
  return k || "—";
}

function cpBackupKindHtml_(kind){
  const k = String(kind || "").toLowerCase();
  if(k === "manual"){
    return "<span class=\"cp-backup-kind-badge cp-backup-kind-manual\">手動</span>";
  }
  if(k === "scheduled"){
    return "<span class=\"cp-backup-kind-badge cp-backup-kind-auto\">自動</span>";
  }
  return cpEscapeHtml_(cpBackupKindLabel_(kind));
}

function cpFormatBackupSize_(row){
  const mb = row && row.size_mb != null ? Number(row.size_mb) : NaN;
  if(Number.isFinite(mb) && mb > 0) return mb + " MB";
  const bytes = row && row.size_bytes != null ? Number(row.size_bytes) : 0;
  if(bytes > 0) return Math.round(bytes / 1024) + " KB";
  return "—";
}

/** 列表顯示用短檔名（還原仍用完整 file_name） */
function cpShortBackupFileName_(fileName){
  const name = String(fileName || "").trim();
  if(!name || name === "—") return name;
  let short = name.replace(/^erp_supabase_/i, "").replace(/\.dump$/i, "");
  short = short.replace(/^manual_/i, "");
  return short || name;
}

async function loadCompanyBackupList(){
  const body = document.getElementById("cpBackupTableBody");
  if(!body) return;
  if(!cpCanManageBackup_()) return;

  body.innerHTML = '<tr><td colspan="5" class="text-muted">載入中…</td></tr>';
  try{
    const r = await callAPI({ action: "list_supabase_backups", limit: 10 }, { method: "GET" });
    const rows = Array.isArray(r?.data) ? r.data : [];
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="5" class="text-muted">尚無備份紀錄</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function(row){
      const tRaw = String(row.display_time || row.modified_at || "").trim();
      const t = tRaw
        ? (typeof erpFormatListDateTime_ === "function" ? erpFormatListDateTime_(tRaw) : tRaw)
        : "—";
      const name = String(row.file_name || "").trim() || "—";
      const shortName = cpShortBackupFileName_(name);
      const size = cpFormatBackupSize_(row);
      const kindHtml = cpBackupKindHtml_(row.backup_kind);
      const nameJs = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const nameTitle = name !== "—" ? ' title="' + cpEscapeHtml_(name) + '"' : "";
      const restoreBtn = name !== "—"
        ? (
          "<button class=\"btn-secondary\" type=\"button\" " +
          "style=\"color:#b42318;border-color:#fecdca;\" " +
          "onclick=\"restoreCompanySupabaseBackup('" + nameJs + "', this)\">還原</button>"
        )
        : "—";
      return (
        "<tr>" +
        "<td class=\"col-backup-timefile\">" +
        "<div class=\"cp-backup-time\">" + cpEscapeHtml_(t) + "</div>" +
        "<div class=\"cp-backup-filename\"" + nameTitle + ">" + cpEscapeHtml_(shortName) + "</div>" +
        "</td>" +
        "<td class=\"col-backup-filename-desk\"" + nameTitle + ">" + cpEscapeHtml_(name) + "</td>" +
        "<td class=\"col-backup-size\">" + cpEscapeHtml_(size) + "</td>" +
        "<td class=\"col-backup-kind\">" + kindHtml + "</td>" +
        "<td class=\"col-backup-action\">" + restoreBtn + "</td>" +
        "</tr>"
      );
    }).join("");
  }catch(_e){
    body.innerHTML = '<tr><td colspan="5" class="text-muted">無法載入備份紀錄</td></tr>';
  }
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
    cpSet_("cp_ar_overdue_days_normal", r?.ar_overdue_days_normal != null ? r.ar_overdue_days_normal : 14);
    cpSet_("cp_ar_overdue_days_consignment", r?.ar_overdue_days_consignment != null ? r.ar_overdue_days_consignment : 30);
    cpSet_("cp_ar_reminder_days_before_overdue", r?.ar_reminder_days_before_overdue != null ? r.ar_reminder_days_before_overdue : 5);
  }catch(_e){
    showToast("無法載入公司設定", "error");
  }finally{
    cpApplyFormPermissions_();
  }
}

async function saveCompanyProfile(triggerEl){
  if(!cpCanEdit_()){
    return showToast("僅 CEO／GA／ADMIN 可修改公司資料。", "error");
  }

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
      ar_overdue_days_normal: String(document.getElementById("cp_ar_overdue_days_normal")?.value || "14").trim(),
      ar_overdue_days_consignment: String(document.getElementById("cp_ar_overdue_days_consignment")?.value || "30").trim(),
      ar_reminder_days_before_overdue: String(document.getElementById("cp_ar_reminder_days_before_overdue")?.value || "5").trim(),
      updated_by: getCurrentUser(),
      updated_at: nowIsoTaipei()
    }, { method: "POST" });
    showToast("公司資料已儲存", "success");
  }catch(err){
    if(!(err && err.erpApiToastShown)) showToast("儲存失敗", "error");
  }finally{
    hideSaveHint();
  }
}

async function restoreCompanySupabaseBackup(fileName, triggerEl){
  if(!cpCanManageBackup_()){
    return showToast("僅 CEO／GA／ADMIN 可執行還原。", "error");
  }

  const name = String(fileName || "").trim();
  if(!name) return showToast("缺少備份檔名", "error");

  let envLabel = "";
  try{
    const info = await callAPI({ action: "env_info" }, { method: "GET", silent: true });
    envLabel = String(info?.env || "").trim();
  }catch(_e){}

  const confirmMsg =
    "【危險操作】還原將覆寫資料庫 public schema 內所有 ERP 資料（訂單、庫存等）。\n" +
    "環境：" + (envLabel || "未知") + "\n" +
    "檔案：" + name + "\n\n" +
    "僅還原 public schema（不含 Supabase 系統 schema）。\n" +
    "建議先按「立即備份」保存現況。\n\n" +
    "確定要繼續嗎？";

  let okFirst = false;
  if(typeof window.erpConfirmModalAsync_ === "function"){
    okFirst = await window.erpConfirmModalAsync_({
      title: "還原 Supabase 備份",
      message: confirmMsg,
      okText: "下一步",
      cancelText: "取消"
    });
  }else{
    okFirst = window.confirm(confirmMsg);
  }
  if(!okFirst) return;

  const typed = (window.prompt("請輸入 RESTORE 以確認還原（大小寫須相符）") || "").trim();
  if(typed !== "RESTORE"){
    if(typed) showToast("確認字不符，已取消還原", "error");
    return;
  }

  const statusEl = document.getElementById("cpBackupStatus");
  const btn = triggerEl;
  if(btn) btn.disabled = true;
  if(statusEl){
    statusEl.textContent = "還原中…（請勿關閉頁面，約需 1～3 分鐘）";
    statusEl.classList.add("cp-backup-restoring");
  }

  try{
    const r = await callAPI({
      action: "trigger_supabase_restore",
      file_name: name,
      confirm_token: "RESTORE"
    }, { method: "POST", timeout_ms: 300000 });
    const exitCode = r?.pg_restore_exit_code;
    let msg = "還原完成：" + name;
    if(exitCode === 1) msg += "（有部分警告，public 通常仍成功）";
    if(statusEl){
      statusEl.classList.remove("cp-backup-restoring");
      statusEl.textContent = msg;
    }
    showToast(msg, "success");
    const hint = String(r?.hint || "").trim();
    if(hint) setTimeout(function(){ showToast(hint, "info"); }, 800);
  }catch(err){
    if(statusEl){
      statusEl.classList.remove("cp-backup-restoring");
      statusEl.textContent = "";
    }
    if(!(err && err.erpApiToastShown)) showToast("還原失敗", "error");
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function triggerCompanySupabaseBackup(triggerEl){
  if(!cpCanManageBackup_()){
    return showToast("僅 CEO／GA／ADMIN 可執行備份。", "error");
  }

  const statusEl = document.getElementById("cpBackupStatus");
  const btn = triggerEl || document.getElementById("cpBackupBtn");
  if(btn) btn.disabled = true;
  if(statusEl) statusEl.textContent = "備份中…";

  try{
    const r = await callAPI({ action: "trigger_supabase_backup" }, { method: "POST" });
    const name = r?.file_name || "";
    const mb = r?.size_mb != null ? r.size_mb : "";
    const msg = name ? ("完成：" + name + (mb !== "" ? "（" + mb + " MB）" : "")) : "備份完成";
    if(statusEl) statusEl.textContent = msg;
    showToast(msg, "success");
    await loadCompanyBackupList();
  }catch(err){
    if(statusEl) statusEl.textContent = "";
    if(!(err && err.erpApiToastShown)) showToast("備份失敗", "error");
  }finally{
    if(btn) btn.disabled = false;
  }
}
