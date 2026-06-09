/**
 * 資料表後台連結
 * - GAS：Google Sheets（env_info.spreadsheet_id）
 * - Supabase：Dashboard → Database → Tables（env_info.supabase_project_ref）
 */
let ERP_SPREADSHEET_ID_CACHE_ = "";
let ERP_SHEET_GIDS_CACHE_ = null;
let ERP_SUPABASE_PROJECT_REF_CACHE_ = "";
let ERP_SUPABASE_URL_CACHE_ = "";
let ERP_ENV_INFO_PROMISE_ = null;

function erpEnvInfoLsKey_(){
  try{
    const base = (typeof window === "object" && window && window.__ERP_CONFIG__ && window.__ERP_CONFIG__.API_BASE)
      ? String(window.__ERP_CONFIG__.API_BASE || "").trim()
      : "";
    if(!base) return "erp_env_info_cache_v1";
    return "erp_env_info_cache_v1@" + base;
  }catch(_e){
    return "erp_env_info_cache_v1";
  }
}
const ERP_ENV_INFO_LS_TTL_MS_ = 7 * 24 * 60 * 60 * 1000;

const ERP_TABLE_ZH_ = {
  product: "產品",
  supplier: "供應商",
  customer: "客戶",
  customer_recipient: "客戶收件人",
  warehouse: "倉庫",
  user: "使用者",
  purchase_order: "採購單",
  purchase_order_item: "採購明細",
  import_document: "進口報單",
  import_item: "報單明細",
  goods_receipt: "採購收貨",
  goods_receipt_item: "採購收貨明細",
  import_receipt: "進口收貨",
  import_receipt_item: "進口收貨明細",
  lot: "批號",
  lot_relation: "批次關聯",
  process_order: "委外加工單",
  process_order_input: "委外投料",
  process_order_output: "委外產出",
  sales_order: "銷售單",
  sales_order_item: "銷售明細",
  shipment: "出貨單",
  shipment_item: "出貨明細",
  commercial_invoice: "商業發票",
  commercial_invoice_line: "商業發票明細",
  commercial_invoice_blank: "空白商業發票",
  commercial_invoice_blank_line: "空白商業發票明細",
  erp_company_profile: "公司資料",
  inventory_movement: "庫存異動",
  logs: "操作紀錄"
};

/** Sheet 按鈕 key → Postgres 表名 */
const ERP_SHEET_KEY_TO_PG_ = {
  user: "erp_user"
};

function erpTableLabelZh_(key){
  const k = String(key || "").trim();
  return ERP_TABLE_ZH_[k] || k;
}

function pgTableNameForSheetKey_(key){
  const k = String(key || "").trim();
  return ERP_SHEET_KEY_TO_PG_[k] || k;
}

function supabaseProjectRefFromUrl_(url){
  const u = String(url || "").trim();
  const m = u.match(/^https?:\/\/([^.]+)\.supabase\.co/i);
  return m ? m[1] : "";
}

function erpIsSupabaseDataBackend_(){
  try{
    if(String(window.__ERP_BACKEND__ || "") === "supabase") return true;
    const cfg =
      typeof window.__ERP_CONFIG__ === "object" && window.__ERP_CONFIG__ !== null
        ? window.__ERP_CONFIG__
        : {};
    const base = String(cfg.API_BASE || "").trim();
    if(/127\.0\.0\.1:\d+|localhost:\d+/i.test(base)) return true;
    if(base && !/script\.google\.com/i.test(base)) return true;
  }catch(_e){}
  return false;
}

function loadEnvInfoFromLocal_(){
  try{
    if(typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(erpEnvInfoLsKey_());
    if(!raw) return;
    const obj = JSON.parse(raw);
    const ts = Number(obj && obj.ts || 0);
    if(!ts || (Date.now() - ts) > ERP_ENV_INFO_LS_TTL_MS_) return;
    const sid = String(obj && obj.spreadsheet_id || "").trim();
    const gids = obj && obj.sheet_gids && typeof obj.sheet_gids === "object" ? obj.sheet_gids : null;
    const pref = String(obj && obj.supabase_project_ref || "").trim();
    const surl = String(obj && obj.supabase_url || "").trim();
    if(sid) ERP_SPREADSHEET_ID_CACHE_ = sid;
    if(gids) ERP_SHEET_GIDS_CACHE_ = gids;
    if(pref) ERP_SUPABASE_PROJECT_REF_CACHE_ = pref;
    if(surl) ERP_SUPABASE_URL_CACHE_ = surl;
  }catch(_e){}
}

function saveEnvInfoToLocal_(sid, gids, supabaseMeta){
  try{
    if(typeof localStorage === "undefined") return;
    const spreadsheet_id = String(sid || "").trim();
    const sheet_gids = (gids && typeof gids === "object") ? gids : null;
    const meta = supabaseMeta && typeof supabaseMeta === "object" ? supabaseMeta : {};
    const supabase_project_ref = String(meta.supabase_project_ref || "").trim();
    const supabase_url = String(meta.supabase_url || "").trim();
    if(!spreadsheet_id && !supabase_project_ref && !supabase_url) return;
    localStorage.setItem(erpEnvInfoLsKey_(), JSON.stringify({
      ts: Date.now(),
      spreadsheet_id,
      sheet_gids,
      supabase_project_ref,
      supabase_url
    }));
  }catch(_e){}
}

const DEFAULT_SHEET_GIDS_ = {
  product: 1114076682,
  supplier: 99221118,
  customer: 1601673747,
  warehouse: 267971627,
  user: 1751545572,
  purchase_order: 1975679446,
  purchase_order_item: 1592901409,
  import_document: 1372231910,
  import_item: 1501371837,
  goods_receipt: 280711382,
  goods_receipt_item: 2022541079,
  import_receipt: 1725385985,
  import_receipt_item: 478887238,
  lot: 11316360,
  lot_relation: 783277553,
  process_order: 356318207,
  process_order_input: 37876354,
  process_order_output: 1313935145,
  sales_order: 1520633879,
  sales_order_item: 1113223744,
  shipment: 1147399524,
  shipment_item: 1610733267,
  inventory_movement: 88937962,
  logs: 475164289
};

function applyEnvInfoPayload_(res){
  const sid = String(res?.spreadsheet_id || res?.data?.spreadsheet_id || "").trim();
  const g = res?.sheet_gids || res?.data?.sheet_gids || null;
  const backend = String(res?.backend || res?.data?.backend || "").trim().toLowerCase();
  const surl = String(res?.supabase_url || res?.data?.supabase_url || "").trim();
  let pref = String(res?.supabase_project_ref || res?.data?.supabase_project_ref || "").trim();
  if(!pref && surl) pref = supabaseProjectRefFromUrl_(surl);
  if(sid) ERP_SPREADSHEET_ID_CACHE_ = sid;
  if(g && typeof g === "object") ERP_SHEET_GIDS_CACHE_ = g;
  if(pref) ERP_SUPABASE_PROJECT_REF_CACHE_ = pref;
  if(surl) ERP_SUPABASE_URL_CACHE_ = surl;
  if(backend === "supabase"){
    try{ window.__ERP_BACKEND__ = "supabase"; }catch(_e0){}
  }
  saveEnvInfoToLocal_(sid, (g && typeof g === "object") ? g : null, {
    supabase_project_ref: pref,
    supabase_url: surl
  });
  return { spreadsheet_id: sid, sheet_gids: g, supabase_project_ref: pref, supabase_url: surl, backend };
}

async function getSpreadsheetIdFromBackend_(){
  if(ERP_SPREADSHEET_ID_CACHE_) return ERP_SPREADSHEET_ID_CACHE_;
  const info = await getEnvInfoFromBackend_();
  return ERP_SPREADSHEET_ID_CACHE_ || String(info?.spreadsheet_id || "").trim() || "";
}

async function getSheetGidsFromBackend_(){
  if(ERP_SHEET_GIDS_CACHE_) return ERP_SHEET_GIDS_CACHE_;
  const info = await getEnvInfoFromBackend_();
  return ERP_SHEET_GIDS_CACHE_ || info?.sheet_gids || null;
}

async function getSupabaseProjectRef_(){
  if(ERP_SUPABASE_PROJECT_REF_CACHE_) return ERP_SUPABASE_PROJECT_REF_CACHE_;
  if(ERP_SUPABASE_URL_CACHE_){
    const hit = supabaseProjectRefFromUrl_(ERP_SUPABASE_URL_CACHE_);
    if(hit) return hit;
  }
  const info = await getEnvInfoFromBackend_();
  return ERP_SUPABASE_PROJECT_REF_CACHE_
    || supabaseProjectRefFromUrl_(info?.supabase_url)
    || String(info?.supabase_project_ref || "").trim()
    || "";
}

async function getEnvInfoFromBackend_(){
  if(ERP_SPREADSHEET_ID_CACHE_ && ERP_SHEET_GIDS_CACHE_) {
    return {
      spreadsheet_id: ERP_SPREADSHEET_ID_CACHE_,
      sheet_gids: ERP_SHEET_GIDS_CACHE_,
      supabase_project_ref: ERP_SUPABASE_PROJECT_REF_CACHE_,
      supabase_url: ERP_SUPABASE_URL_CACHE_
    };
  }
  if(typeof callAPI !== "function") return null;

  try{
    if(typeof erpCanOpenSheet_ === "function" && !erpCanOpenSheet_()){
      return null;
    }
  }catch(_eRole){}

  if(!ERP_ENV_INFO_PROMISE_){
    ERP_ENV_INFO_PROMISE_ = (async function(){
      try{
        const res = await callAPI({ action: "env_info" }, { method: "GET", silent: true });
        return applyEnvInfoPayload_(res);
      }catch(_e){
        return null;
      }finally{
        ERP_ENV_INFO_PROMISE_ = null;
      }
    })();
  }
  return await ERP_ENV_INFO_PROMISE_;
}

function buildSheetUrl_(spreadsheetId, key, gids){
  const sid = String(spreadsheetId || "").trim();
  if(!sid) return "";
  const k = String(key || "").trim();
  const gidRaw = gids && k ? gids[k] : null;
  const gid = gidRaw === 0 ? 0 : Number(gidRaw || "");
  if(Number.isFinite(gid)){
    return `https://docs.google.com/spreadsheets/d/${sid}/edit?gid=${gid}#gid=${gid}`;
  }
  return `https://docs.google.com/spreadsheets/d/${sid}/edit`;
}

async function resolveSupabaseTableEditorUrl_(key){
  const k = String(key || "").trim();
  const pg = pgTableNameForSheetKey_(k);
  const zh = erpTableLabelZh_(k);

  try{
    if(typeof callAPI === "function"){
      const res = await callAPI(
        { action: "supabase_table_editor_url", table_key: k },
        { method: "GET", silent: true }
      );
      if(res && res.success === false){
        const errMsg = Array.isArray(res.errors) && res.errors.length ? String(res.errors[0]) : "無法解析 Supabase 表連結";
        return { url: "", pg, zh, direct: false, error: errMsg };
      }
      const url = String(res?.url || res?.data?.url || "").trim();
      if(url){
        return {
          url,
          pg: String(res?.pg_table || res?.data?.pg_table || pg),
          zh,
          direct: !!(res?.direct || res?.data?.direct)
        };
      }
    }
  }catch(e){
    return {
      url: "",
      pg,
      zh,
      direct: false,
      error: (e && e.message) ? String(e.message) : "無法解析 Supabase 表連結"
    };
  }

  return {
    url: "",
    pg,
    zh,
    direct: false,
    error: "找不到表 " + pg + " 的連結。請在 Supabase 執行 server/sql/v4.1.08_Supabase表編輯RPC.sql"
  };
}

function erpCanOpenSheet_(){
  try{
    const r = (typeof getCurrentUserRole === "function" ? String(getCurrentUserRole() || "") : "").trim().toUpperCase();
    return r === "CEO" || r === "GA" || r === "ADMIN";
  }catch(_e){
    return false;
  }
}

function erpSheetButtonKey_(btn){
  const raw = String(btn && btn.getAttribute("onclick") || "");
  const m = raw.match(/openSheetLink\(\s*['"]([^'"]+)['"]\s*\)/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function erpApplySheetPermissions(){
  try{
    const ok = erpCanOpenSheet_();
    const supa = erpIsSupabaseDataBackend_();
    document.querySelectorAll("button.btn-sheet").forEach(btn=>{
      btn.style.display = ok ? "" : "none";
      btn.setAttribute("aria-hidden", ok ? "false" : "true");
      if(!ok) return;

      const key = erpSheetButtonKey_(btn);
      if(!btn.hasAttribute("data-erp-sheet-original-label")){
        btn.setAttribute("data-erp-sheet-original-label", String(btn.textContent || "").trim());
        btn.setAttribute("data-erp-sheet-original-title", String(btn.getAttribute("title") || "").trim());
      }

      if(supa){
        const pg = pgTableNameForSheetKey_(key);
        const zh = erpTableLabelZh_(key);
        btn.textContent = "Supabase";
        btn.title = zh
          ? ("在 Supabase 開啟表 " + pg + "（" + zh + "）")
          : ("在 Supabase 開啟表 " + pg);
        btn.classList.add("btn-supabase");
      }else{
        const origLabel = btn.getAttribute("data-erp-sheet-original-label") || "Sheet";
        const origTitle = btn.getAttribute("data-erp-sheet-original-title") || "";
        btn.textContent = origLabel;
        if(origTitle) btn.title = origTitle;
        else btn.removeAttribute("title");
        btn.classList.remove("btn-supabase");
      }
    });
  }catch(_e){}
}
try{ window.erpApplySheetPermissions = erpApplySheetPermissions; }catch(_e0){}

async function openSupabaseTableLink(key){
  try{
    const ok = erpCanOpenSheet_();
    if(!ok){
      if(typeof showToast === "function") showToast("僅 CEO/總務/ADMIN 可開啟 Supabase 後台。", "error");
      return;
    }
  }catch(_e0){}

  const pack = await resolveSupabaseTableEditorUrl_(key);
  if(!pack.url){
    if(typeof showToast === "function"){
      showToast(
        pack.error ||
          ("找不到表 " + pack.pg + " 的 Supabase 連結。請在 Supabase SQL Editor 執行 server/sql/v4.1.08_Supabase表編輯RPC.sql"),
        "error"
      );
    }
    return;
  }

  window.open(pack.url, "_blank", "noopener,noreferrer");
  if(typeof showToast === "function"){
    showToast("已開啟 Table Editor：" + pack.pg + (pack.zh ? ("（" + pack.zh + "）") : ""), "success");
  }
}

/**
 * @param {string} key - 表 key（同 openSheetLink 參數）
 */
async function openSheetLink(key) {
  if(erpIsSupabaseDataBackend_()){
    return openSupabaseTableLink(key);
  }

  try{
    const ok = erpCanOpenSheet_();
    if(!ok){
      if(typeof showToast === "function") showToast("僅 CEO/總務/ADMIN 可開啟 Sheet。", "error");
      return;
    }
  }catch(_e0){}

  const sidFast = ERP_SPREADSHEET_ID_CACHE_;
  const gidsFast = ERP_SHEET_GIDS_CACHE_ || DEFAULT_SHEET_GIDS_;
  const fastUrl = buildSheetUrl_(sidFast, key, gidsFast);
  if(fastUrl){
    try{ getEnvInfoFromBackend_(); }catch(_eBg){}
    window.open(fastUrl, "_blank", "noopener,noreferrer");
    return;
  }

  const sid = await getSpreadsheetIdFromBackend_();
  const gids = (await getSheetGidsFromBackend_()) || DEFAULT_SHEET_GIDS_;
  const url = buildSheetUrl_(sid, key, gids);
  if(!url){
    if(typeof showToast === "function") showToast("取得試算表連結失敗（請確認後端 env_info 與權限）", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function bindSheetButtons_(){
  try{
    if(document.documentElement && document.documentElement.getAttribute("data-erp-sheetbind") === "1") return;
    if(document.documentElement) document.documentElement.setAttribute("data-erp-sheetbind","1");
  }catch(_e){}

  document.addEventListener("click", function(ev){
    const t = ev && ev.target;
    if(!t) return;
    const btn = (typeof t.closest === "function") ? t.closest("button.btn-sheet") : null;
    if(!btn) return;

    const key = erpSheetButtonKey_(btn);
    if(!key) return;

    try{
      ev.preventDefault();
      ev.stopPropagation();
    }catch(_e2){}

    try{
      openSheetLink(key);
    }catch(_e3){
      if(typeof showToast === "function") showToast("開啟後台失敗", "error");
    }
  }, true);
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", function(){
    loadEnvInfoFromLocal_();
    bindSheetButtons_();
    erpApplySheetPermissions();
    try{ getEnvInfoFromBackend_().then(function(){ erpApplySheetPermissions(); }); }catch(_eW){}
  });
}else{
  loadEnvInfoFromLocal_();
  bindSheetButtons_();
  erpApplySheetPermissions();
  try{ getEnvInfoFromBackend_().then(function(){ erpApplySheetPermissions(); }); }catch(_eW2){}
}
