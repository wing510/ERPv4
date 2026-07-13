/**
 * ERP Core Utils
 * - 以「穩定可追溯」為優先：ID 由前端產生並寫入 Sheet
 * - 時間：nowIsoTaipei() 寫入 API（含 +08:00）；nowIso16() 僅供表單預設日期；列表顯示用 erpFormatListDateTime_
 */

/** 台灣時間 ISO（含 +08:00；與後端 nowIso 一致，供寫入 created_at） */
function nowIsoTaipei() {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    return (
      get("year") +
      "-" +
      get("month") +
      "-" +
      get("day") +
      "T" +
      get("hour") +
      ":" +
      get("minute") +
      ":" +
      get("second") +
      "+08:00"
    );
  } catch (_e) {
    return nowIso16();
  }
}

/** 唯一共用：台灣本地時間 YYYY-MM-DDTHH:mm（供 datetime-local 與 created_at/updated_at 儲存用） */
function nowIso16(){
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 擷取 YYYY-MM-DD，供 `<input type="date">` 與列表顯示（相容舊資料含時間） */
function dateInputValue_(v){
  const s = String(v || "").trim();
  if(!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * 產生可讀且不易撞號的 ID
 * 範例：IMP-260320-1813-9CF6
 */
function generateId(prefix){
  const d = new Date();
  const pad = (n) => String(n).padStart(2,"0");
  // YYMMDD（短版）+ HHMM（分鐘精度）+ 4 位隨機（16 進位）
  const yy = String(d.getFullYear()).slice(-2);
  const ymd = `${yy}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const rnd = Math.random().toString(16).slice(2,6).toUpperCase();
  return `${prefix}-${ymd}-${hm}-${rnd}`;
}

/** 較短的主檔 ID：例如 P260411-A3（日期後僅 2 碼英數，主檔用） */
function generateShortId(prefix){
  const d = new Date();
  const pad = (n) => String(n).padStart(2,"0");
  const yy = String(d.getFullYear()).slice(-2);
  const ymd = `${yy}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const n = Math.floor(Math.random() * 36 * 36);
  const rnd = n.toString(36).toUpperCase().padStart(2, "0");
  return `${prefix}${ymd}-${rnd}`;
}

/**
 * 統一「表單自動產生 ID」的填入規則（收斂重複）
 *
 * - 預設：只有當欄位為空時才會填入（避免覆蓋已載入/已輸入的 ID）
 * - force=true：強制重設為新 ID（通常用在 reset/clear）
 *
 * 支援用法：
 * 1) 自訂 generator：
 *    erpInitAutoId_("so_id", { gen: () => generateId("SO") })
 * 2) 文件/事件類（generateId）：
 *    erpInitAutoId_("so_id", "doc", "SO")
 * 3) 主檔類（generateShortId）：
 *    erpInitAutoId_("c_id", "master", "C")
 */
function erpInitAutoId_(inputId, kindOrOpts, prefixOrOpts) {
  const id = String(inputId || "");
  if(!id) return "";
  const el = document.getElementById(id);
  if(!el) return "";

  let gen = null;
  let force = false;
  let upper = true;

  if(typeof kindOrOpts === "string"){
    const kind = String(kindOrOpts || "").trim().toLowerCase();
    const pref = String(prefixOrOpts || "").trim();
    if(kind === "doc"){
      gen = () => (typeof generateId === "function" ? generateId(pref) : "");
    }else if(kind === "master"){
      gen = () => (typeof generateShortId === "function" ? generateShortId(pref) : "");
    }
  }else{
    const opts = kindOrOpts && typeof kindOrOpts === "object" ? kindOrOpts : {};
    gen = typeof opts.gen === "function" ? opts.gen : null;
    force = !!opts.force;
    upper = opts.upper === false ? false : true;
  }

  if(typeof prefixOrOpts === "object" && prefixOrOpts){
    // 允許第三參數傳 opts（方便從舊呼叫漸進改）
    const o2 = prefixOrOpts;
    if(typeof o2.gen === "function") gen = o2.gen;
    if("force" in o2) force = !!o2.force;
    if("upper" in o2) upper = o2.upper === false ? false : true;
  }

  if(!gen) return String(el.value || "");

  const cur = String(el.value || "").trim();
  if(cur && !force) return cur;

  let next = "";
  try{ next = String(gen() || ""); }catch(_e){ next = ""; }
  next = String(next || "").trim();
  if(upper) next = next.toUpperCase();

  if(next){
    try{ el.value = next; }catch(_e2){}
  }
  return next || cur;
}

/**
 * 下拉與既有資料對齊：若值不在固定選項內，暫時加一筆「舊資料」避免載入後空白。
 * 適用客戶分類／國家、供應商國家、進口原產地等。
 */
function syncSelectWithLegacy_(selectId, storedValue){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  sel.querySelectorAll("option[data-legacy='1']").forEach(function(o){
    o.remove();
  });
  const v = String(storedValue || "").trim();
  if(!v){
    try{
      if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(selectId, "");
    }catch(_e){}
    sel.value = "";
    return;
  }
  const exists = Array.from(sel.options).some(function(o){
    return String(o.value) === v;
  });
  if(!exists){
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v + "（舊資料）";
    opt.dataset.legacy = "1";
    sel.appendChild(opt);
  }
  sel.value = v;
}

/** 數量框旁單位後綴：hidden 存值、span 顯示；無單位時空白（不顯示佔位符）。 */
function syncErpQtyUnitSuffix_(hiddenId, suffixId){
  const h = document.getElementById(hiddenId);
  const s = document.getElementById(suffixId);
  if(!s) return;
  const u = h ? String(h.value || "").trim() : "";
  s.textContent = u;
}

/* =========================================================
   Phase 3：跨模組一致文案（提示/導引）
========================================================= */

/**
 * 「已帶入明細」標準提示（供 Sales/Purchase/Import 對齊）
 * opts:
 * - canEditStructure: 是否允許改數量/單價等結構
 * - needsEditItemsFirst: 是否必須先按「編輯明細」才可改結構
 * - extraStructureHint(optional): 結構修改的額外提示（例如 Sales 需要「套用至本列」）
 */
function erpHintPickedLineText_(opts){
  const o = opts && typeof opts === "object" ? opts : {};
  const canEdit = !!o.canEditStructure;
  const needEditFirst = !!o.needsEditItemsFirst;
  const extra = String(o.extraStructureHint || "").trim();
  if(!canEdit){
    return "已帶入明細（僅改備註請按「儲存備註」）";
  }
  const struct =
    (needEditFirst ? "改數量請先「編輯明細」" : "可修改數量/結構") + (extra ? "；" + extra : "");
  return "已帶入明細（僅改備註請按「儲存備註」；" + struct + "）";
}

try{
  window.erpHintPickedLineText_ = erpHintPickedLineText_;
}catch(_e){}

/**
 * 表單 FlowHint 統一句型（供 Sales/Purchase/Import/Shipping 文字對齊）
 * - moduleLabel: "銷售" / "採購" / "報單" / "出貨"
 * - stateText: 例如 "已載入 · 未收貨"、"已載入 · 編輯中"、"新單"
 * - actionHint(optional): 例如 "請先「編輯主檔／編輯明細」再儲存"
 */
function erpFlowHintText_(moduleLabel, stateText, actionHint){
  const m = String(moduleLabel || "").trim();
  const s = String(stateText || "").trim();
  const a = String(actionHint || "").trim();
  if(!m) return (s ? (s + (a ? " · " + a : "")) : (a || ""));
  if(!s) return m + "：" + (a ? " " + a : "");
  return m + "：" + s + (a ? " · " + a : "");
}

try{
  window.erpFlowHintText_ = erpFlowHintText_;
}catch(_e){}

/* =========================================================
   主檔狀態（ACTIVE/INACTIVE）修改權限：僅 CEO/GA/ADMIN
========================================================= */

function erpCanChangeMasterStatus_(){
  try{
    var r = (typeof getCurrentUserRole === "function") ? String(getCurrentUserRole() || "").trim().toUpperCase() : "";
    return r === "CEO" || r === "GA" || r === "ADMIN";
  }catch(_e){
    return false;
  }
}

/** 操作人／登入者顯示：超管帳號 adminerp → 開發管理（全站 UI 用；API 仍送 adminerp） */
function erpDisplayOperatorName_(userIdOrName){
  const s = String(userIdOrName || "").trim();
  if(!s) return "";
  if(s.toLowerCase() === "adminerp") return "開發管理";
  return s;
}

/** 角色代碼 → 中文（頂欄、Users 等共用） */
function erpRoleLabelZh_(role){
  const r = String(role || "").trim().toUpperCase();
  if(!r) return "";
  const map = {
    CEO: "CEO",
    FN: "財務",
    GA: "總務",
    OP: "作業",
    QA: "品保",
    SL: "業務",
    AS: "助理",
    WH: "倉管",
    ADMIN: "管理者"
  };
  return map[r] || r;
}

/** 人員下拉：CEO 固定第一，其餘依姓名、user_id */
function erpSortUsersForDropdown_(users){
  function rank_(u){
    const role = String(u && u.role || "").trim().toUpperCase();
    const uid = String(u && u.user_id || "").trim().toLowerCase();
    if(role === "CEO" || uid === "ceo") return 0;
    return 1;
  }
  return (users || []).slice().sort(function(a, b){
    const ra = rank_(a);
    const rb = rank_(b);
    if(ra !== rb) return ra - rb;
    const an = String(a.user_name || "").trim();
    const bn = String(b.user_name || "").trim();
    if(an && bn && an !== bn) return an.localeCompare(bn, undefined, { sensitivity: "base" });
    return String(a.user_id || "").localeCompare(String(b.user_id || ""), undefined, { sensitivity: "base" });
  });
}

/** 頂欄登入者：畫面中文名；title 保留原始 user_id */
function erpTopbarUserText_(userId, role){
  const uid = String(userId || "").trim();
  if(!uid) return { label: "—", title: "" };
  const display = erpDisplayOperatorName_(uid);
  const roleZh = erpRoleLabelZh_(role);
  const label = roleZh ? roleZh + " - " + display : display;
  const title = "目前登入：" + (roleZh ? roleZh + " - " + uid : uid);
  return { label, title };
}

/** v4.2 應收/收款：CEO、財務、總務、管理者，或 Users 勾選 ar */
function erpCanManageAr_(){
  try{
    var r = (typeof getCurrentUserRole === "function") ? String(getCurrentUserRole() || "").trim().toUpperCase() : "";
    if(r === "CEO" || r === "FN" || r === "FINANCE" || r === "GA" || r === "ADMIN") return true;
    return erpHasModule_("ar");
  }catch(_e){
    return false;
  }
}

/** Users 勾選模組（空白=全關；* / ALL=全開） */
function erpReadAllowedModuleSet_(){
  try{
    var raw = "";
    if(typeof getCurrentUserAllowedModules === "function"){
      raw = String(getCurrentUserAllowedModules() || "").trim();
    }else{
      raw = String(localStorage.getItem("erp_allowed_modules") || sessionStorage.getItem("erp_allowed_modules") || "").trim();
    }
    if(!raw) return {};
    if(raw === "*" || raw.toUpperCase() === "ALL") return null;
    var set = {};
    raw.split(",").map(function(s){ return String(s||"").trim(); }).filter(Boolean).forEach(function(k){ set[k] = true; });
    return set;
  }catch(_e){
    return null;
  }
}

function erpHasModule_(moduleKey){
  var k = String(moduleKey || "").trim();
  if(!k) return true;
  var set = erpReadAllowedModuleSet_();
  if(set === null) return true;
  if(!set || !Object.keys(set).length) return false;
  return !!set[k];
}

/** Dealer 方案客戶：綁定客戶與經銷／月結方案（不需會計角色） */
function erpCanOperateCommercialDealerCustomer_(){
  return erpHasModule_("commercial_dealer_customer");
}

/** Dealer 方案寫入：模組 commercial_dealer + 會計角色 */
function erpCanOperateCommercialDealer_(){
  return erpCanManageAr_() && erpHasModule_("commercial_dealer");
}

/** 月結回饋寫入：模組 dealer_rebate 或 commercial_dealer + 會計角色 */
function erpCanOperateDealerRebate_(){
  return erpCanManageAr_() && (erpHasModule_("dealer_rebate") || erpHasModule_("commercial_dealer"));
}

/** 列表排序：依欄位順序取第一個非空值（通常業務日期 → created_at） */
function erpRowSortKey_(row, fields){
  var list = fields || ["created_at"];
  for(var i = 0; i < list.length; i++){
    var v = String(row && row[list[i]] != null ? row[list[i]] : "").trim();
    if(v) return v;
  }
  return "";
}

/** 新→舊比較（依序比各日期欄；最後比單號） */
function erpCompareNewestFirst_(a, b, dateFields, idField){
  var fields = dateFields || ["created_at"];
  var idKey = String(idField || "id");
  for(var i = 0; i < fields.length; i++){
    var fa = String(a && a[fields[i]] != null ? a[fields[i]] : "").trim();
    var fb = String(b && b[fields[i]] != null ? b[fields[i]] : "").trim();
    if(fa !== fb) return fb.localeCompare(fa);
  }
  var ida = String(a && a[idKey] != null ? a[idKey] : "").trim();
  var idb = String(b && b[idKey] != null ? b[idKey] : "").trim();
  if(ida !== idb) return idb.localeCompare(ida);
  return 0;
}

function erpSortRowsNewestFirst_(rows, dateFields, idField){
  return (rows || []).slice().sort(function(a, b){
    return erpCompareNewestFirst_(a, b, dateFields, idField);
  });
}

/** v4.2 FINANCE 選單可見：ADMIN / CEO / 總務 / 財務 */
function erpCanViewFinanceByRole_(){
  try{
    var r = (typeof getCurrentUserRole === "function") ? String(getCurrentUserRole() || "").trim().toUpperCase() : "";
    return r === "CEO" || r === "FN" || r === "FINANCE";
  }catch(_e){
    return false;
  }
}

/** FINANCE 選單：CEO／財務角色，或已勾選任一財務模組 */
function erpCanViewFinanceModule_(){
  try{
    if(erpCanViewFinanceByRole_()) return true;
    var set = erpReadAllowedModuleSet_();
    if(set === null) return true;
    return !!(set.ar || set.dealer_rebate || set.invoice || set.invoice_blank);
  }catch(_e){
    return false;
  }
}
try{
  window.erpDisplayOperatorName_ = erpDisplayOperatorName_;
  window.erpRoleLabelZh_ = erpRoleLabelZh_;
  window.erpSortUsersForDropdown_ = erpSortUsersForDropdown_;
  window.erpTopbarUserText_ = erpTopbarUserText_;
  window.erpCanManageAr_ = erpCanManageAr_;
  window.erpCanViewFinanceModule_ = erpCanViewFinanceModule_;
  window.erpCanViewFinanceByRole_ = erpCanViewFinanceByRole_;
  window.erpReadAllowedModuleSet_ = erpReadAllowedModuleSet_;
  window.erpHasModule_ = erpHasModule_;
  window.erpCanOperateCommercialDealer_ = erpCanOperateCommercialDealer_;
  window.erpCanOperateCommercialDealerCustomer_ = erpCanOperateCommercialDealerCustomer_;
  window.erpCanOperateDealerRebate_ = erpCanOperateDealerRebate_;
  window.erpRowSortKey_ = erpRowSortKey_;
  window.erpCompareNewestFirst_ = erpCompareNewestFirst_;
  window.erpSortRowsNewestFirst_ = erpSortRowsNewestFirst_;
}catch(_eAr){}

function erpLockStatusSelect_(selectId){
  var el = document.getElementById(String(selectId || ""));
  if(!el) return;
  var ok = erpCanChangeMasterStatus_();
  el.disabled = !ok;
  el.setAttribute("aria-disabled", ok ? "false" : "true");
  if(!ok){
    el.setAttribute("title","僅 CEO／GA／ADMIN 可修改狀態（ACTIVE/INACTIVE）");
  }else{
    try{ el.removeAttribute("title"); }catch(_e2){}
  }
}

/* =========================================================
   QA / 批次 / 異動 名詞：雙語或白話（新手友善）
========================================================= */
var TERM_LABELS = {
  PENDING: "PENDING（待QA）",
  APPROVED: "APPROVED（QA已放行）",
  REJECTED: "REJECTED（QA已退回）",
  ACTIVE: "ACTIVE（使用中）",
  INACTIVE: "INACTIVE（停用）",
  CLOSED: "CLOSED（已收完）",
  VOID: "VOID（作廢不可用）",
  OPEN: "OPEN（未出貨）",
  PARTIAL: "PARTIAL（部分出貨）",
  CANCELLED: "CANCELLED（已作廢）",
  SHIPPED: "SHIPPED（全數出貨）",
  POSTED: "POSTED（已過帳）",
  PROCESS_OUT: "PROCESS_OUT（加工扣庫）",
  PROCESS_IN: "PROCESS_IN（加工入庫）",
  SHIP_OUT: "SHIP_OUT（出貨扣庫）",
  IN: "IN（入庫）",
  OUT: "OUT（手動扣庫）",
  ADJUST: "ADJUST（調整）",
  PASSED: "PASSED（已通過）",
  FAILED: "FAILED（未通過）",
  INTERNAL_USE: "INTERNAL_USE（內部領用）",
  SAMPLE: "SAMPLE（樣品）",
  NORMAL: "NORMAL（一般買斷）",
  CONSIGNMENT: "CONSIGNMENT（寄賣補貨）",
  GIFT: "GIFT（贈品）",
  PR: "PR（公關）",
  RESHIP: "RESHIP（補寄）",
  SCRAP: "SCRAP（報廢）",
  OTHER: "OTHER（其他）"
  ,AMBIENT: "AMBIENT（常溫）"
  ,CHILLED: "CHILLED（冷藏）"
  ,FROZEN: "FROZEN（冷凍）"
  ,RM: "RM（原料）"
  ,WIP: "WIP（半成品）"
  ,FG: "FG（成品）"
};

/** ISO 字串是否含時區（Z 或 ±HH:MM） */
function erpHasTimezoneSuffix_(s) {
  return /[Zz]$|[+-]\d{2}:\d{2}$/.test(String(s || "").trim());
}

/** nowIso16 風格（無時區尾碼）→ 顯示用 parts；含時區則回 null */
function erpParseIsoNoTzParts_(raw) {
  const s = String(raw || "").trim();
  if (!s || erpHasTimezoneSuffix_(s)) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return null;
  return { yyyy: m[1], mm: m[2], dd: m[3], hh: m[4], mi: m[5] };
}

/** Date → 台灣時間 YYYY-MM-DD HH:mm */
function erpFormatDateTaipeiYmdHm_(d) {
  if (!d || Number.isNaN(d.getTime())) return "";
  try {
    const s = d.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
    return s.length >= 16 ? s.slice(0, 16) : s;
  } catch (_e) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

/** 列表時間：YYYY-MM-DD HH:mm（台灣；無時區尾碼視為已是本地） */
function erpFormatListDateTime_(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const parts = erpParseIsoNoTzParts_(s);
  if (parts) return `${parts.yyyy}-${parts.mm}-${parts.dd} ${parts.hh}:${parts.mi}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return erpFormatDateTaipeiYmdHm_(d);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (m) return m[1] + " " + m[2];
  const dOnly = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return dOnly ? dOnly[1] : s;
}

/** 時間部分 HH:mm（台灣；供列表灰字） */
function erpFormatLocalTimeHm_(v) {
  const full = erpFormatListDateTime_(v);
  if (!full) return "";
  const m = full.match(/(\d{2}:\d{2})$/);
  return m ? m[1] : "";
}

/**
 * 搭配業務日期（如 AR 起算日）顯示時間。
 * 舊資料若無時區被 PG 當 UTC 儲存，台灣日期會與起算日差一天 → 改取 UTC 牆鐘時分。
 */
function erpFormatLocalTimeHmForBizDate_(v, bizDateYmd) {
  const raw = String(v || "").trim();
  const bizDate = String(bizDateYmd || "").slice(0, 10);
  if (!raw || !bizDate) return erpFormatLocalTimeHm_(v);
  if (erpHasTimezoneSuffix_(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      const taipeiFull = erpFormatDateTaipeiYmdHm_(d);
      if (taipeiFull.slice(0, 10) !== bizDate) {
        const wm = raw.match(/T(\d{2}):(\d{2})/);
        if (wm) return wm[1] + ":" + wm[2];
      }
    }
  }
  return erpFormatLocalTimeHm_(v);
}

/** 全站列表／Logs 共用：台灣本地時間 YYYY-MM-DD HH:mm */
function formatLocalTime(dateStr) {
  return erpFormatListDateTime_(dateStr);
}

/** 解析時間戳供排序（無 TZ 當本地；有 TZ 依 Date） */
function erpParseLocalDateTime_(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const parts = erpParseIsoNoTzParts_(s);
  if (parts) {
    const d = new Date(
      Number(parts.yyyy),
      Number(parts.mm) - 1,
      Number(parts.dd),
      Number(parts.hh),
      Number(parts.mi),
      0,
      0
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function termLabel(code) {
  if (code == null || code === "") return "";
  var s = String(code).trim().toUpperCase();
  return TERM_LABELS[s] || code;
}

/** 列表等僅顯示中文：termLabel 為「CODE（說明）」時取括號內，否則沿用原字串。 */
function termLabelZhOnly(code) {
  if (code == null || code === "") return "";
  var full = (typeof termLabel === "function" ? termLabel(code) : String(code)) || "";
  var m = String(full).match(/^([A-Z0-9_]+)（([^）]+)）$/);
  if (m) return m[2];
  return full;
}

/**
 * 狀態徽章內文：英文碼一行、（中文說明）下一行（對齊 termLabel「CODE（說明）」）
 */
function termStatusBadgeInnerHtml(code){
  var full = (typeof termLabel === "function" ? termLabel(code) : String(code || "")) || "";
  var esc = function(t){
    return String(t || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };
  var m = String(full).match(/^([A-Z0-9_]+)（([^）]+)）$/);
  if(m){
    return '<span class="badge-line badge-line-en">' + esc(m[1]) + '</span>' +
      '<span class="badge-line badge-line-zh">（' + esc(m[2]) + '）</span>';
  }
  return esc(full);
}

/**
 * 主檔列表狀態：僅燈號（hover 可看完整說明，與表單旁燈號同色）
 */
function termStatusLampHtml(code){
  var raw = String(code == null ? "" : code).trim();
  var st = raw.toUpperCase();
  var active = st === "ACTIVE";
  var inactive = st === "INACTIVE";
  var esc = function(t){
    return String(t || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };
  var normCode = active ? "ACTIVE" : (inactive ? "INACTIVE" : (raw || "INACTIVE"));
  var labelFull = (typeof termLabelZhOnly === "function" ? termLabelZhOnly(normCode) : ((typeof termLabel === "function" ? termLabel(normCode) : normCode) || normCode)) || normCode;
  var modClass = active ? "status-lamp--active" : (inactive ? "status-lamp--inactive" : "status-lamp--unknown");
  return (
    '<span class="status-lamp status-lamp--solo ' + modClass + '" title="' + esc(labelFull) + '" aria-label="' + esc(labelFull) + '" role="img">' +
    '<span class="status-lamp-dot" aria-hidden="true"></span></span>'
  );
}

/**
 * 主檔表單：依狀態下拉目前值更新旁邊燈號（lamp 預設 id = selectId + "_lamp"）
 */
function syncStatusSelectLamp_(selectId, lampId){
  var sel = document.getElementById(selectId);
  var lamp = document.getElementById(lampId || (selectId + "_lamp"));
  if(!sel || !lamp) return;
  var raw = String(sel.value || "").trim();
  var st = raw.toUpperCase();
  var active = st === "ACTIVE";
  var inactive = st === "INACTIVE";
  var normCode = active ? "ACTIVE" : (inactive ? "INACTIVE" : (raw || "INACTIVE"));
  var labelFull = (typeof termLabel === "function" ? termLabel(normCode) : normCode) || normCode;
  var modClass = active ? "status-lamp--active" : (inactive ? "status-lamp--inactive" : "status-lamp--unknown");
  lamp.className = "status-lamp status-lamp--solo " + modClass;
  lamp.setAttribute("title", labelFull);
  lamp.setAttribute("aria-label", labelFull);
  lamp.setAttribute("role", "img");
  lamp.innerHTML = '<span class="status-lamp-dot" aria-hidden="true"></span>';
}

function bindStatusSelectLamp_(selectId, lampId){
  var sel = document.getElementById(selectId);
  if(!sel || sel.dataset.statusLampBound) return;
  sel.dataset.statusLampBound = "1";
  var lid = lampId || (selectId + "_lamp");
  sel.addEventListener("change", function(){
    syncStatusSelectLamp_(selectId, lid);
  });
  syncStatusSelectLamp_(selectId, lid);
}

/**
 * 取「短中文」標籤（常用於下拉/列表的倉別等）
 * - 若 termLabel(term) 形如 "AMBIENT（常溫）" → 回傳 "常溫"
 * - 否則回傳 termLabel(term)（或原字串）
 */
function termShortZh_(term){
  var full = (typeof termLabel === "function" ? termLabel(term) : String(term || "")) || "";
  var m = String(full).match(/（([^）]+)）/);
  return m ? m[1] : String(full || "");
}

/* =========================================================
   UI 基礎：Toast / Uppercase Input
========================================================= */

var __erpToastTimer__ = null;

function erpDismissToast_(){
  const toast = document.getElementById("toast");
  if(!toast) return;
  if(__erpToastTimer__){
    clearTimeout(__erpToastTimer__);
    __erpToastTimer__ = null;
  }
  toast.className = "toast";
  toast.onclick = null;
  const btn = document.getElementById("toastCloseBtn");
  if(btn) btn.style.display = "none";
  const copyBtn = document.getElementById("toastCopyBtn");
  if(copyBtn) copyBtn.style.display = "none";
}

function erpCopyToastTextFallback_(text, finish){
  try{
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    finish(!!ok);
  }catch(_e){
    finish(false);
  }
}

function erpCopyToastText_(btn){
  const textEl = document.getElementById("toastText");
  const msg = String(textEl?.textContent || "").trim();
  if(!msg) return;
  const finish = function(ok){
    if(!btn) return;
    const orig = btn.textContent || "複製";
    btn.textContent = ok ? "已複製" : "複製失敗";
    setTimeout(function(){ btn.textContent = orig; }, 1500);
  };
  if(navigator.clipboard && typeof navigator.clipboard.writeText === "function"){
    navigator.clipboard.writeText(msg).then(function(){ finish(true); }).catch(function(){
      erpCopyToastTextFallback_(msg, finish);
    });
    return;
  }
  erpCopyToastTextFallback_(msg, finish);
}

/**
 * 同步輸入框唯讀狀態與全站灰底樣式（readonly 屬性 + .erp-input-readonly）
 * @param {HTMLElement|null} el
 * @param {boolean} [readOnly] 若省略則依目前 el.readOnly / readonly 屬性
 */
function erpSyncInputReadonlyStyle_(el, readOnly){
  if(!el) return;
  const ro =
    readOnly != null
      ? !!readOnly
      : !!(el.readOnly || el.hasAttribute("readonly") || el.classList.contains("erp-input-readonly"));
  try{
    el.readOnly = ro;
  }catch(_e){}
  if(ro) el.setAttribute("readonly", "readonly");
  else el.removeAttribute("readonly");
  el.classList.toggle("erp-input-readonly", ro);
}
window.erpSyncInputReadonlyStyle_ = erpSyncInputReadonlyStyle_;

function showToast(message, type="success", durationMsOverride){
  const toast = document.getElementById("toast");
  if(!toast) return alert(message);

  const textEl = document.getElementById("toastText") || toast;
  textEl.textContent = String(message || "");
  toast.className = "toast show " + type;
  const t = String(type || "").toLowerCase();
  const closeBtn = document.getElementById("toastCloseBtn");
  const copyBtn = document.getElementById("toastCopyBtn");
  if(__erpToastTimer__){
    clearTimeout(__erpToastTimer__);
    __erpToastTimer__ = null;
  }

  if(t === "error"){
    if(copyBtn){
      copyBtn.style.display = "";
      copyBtn.onclick = function(e){
        try{ e.stopPropagation(); }catch(_e){}
        erpCopyToastText_(copyBtn);
      };
    }
    if(closeBtn){
      closeBtn.style.display = "";
      closeBtn.onclick = function(e){
        try{ e.stopPropagation(); }catch(_e){}
        erpDismissToast_();
      };
    }
    toast.onclick = function(){
      erpDismissToast_();
    };
    if(Number(durationMsOverride) > 0){
      __erpToastTimer__ = setTimeout(erpDismissToast_, Number(durationMsOverride));
    }
    return;
  }

  if(copyBtn) copyBtn.style.display = "none";
  if(closeBtn) closeBtn.style.display = "none";
  toast.onclick = null;
  const durationMsDefault = 6000;
  const durationMs = Number(durationMsOverride) > 0 ? Number(durationMsOverride) : durationMsDefault;
  __erpToastTimer__ = setTimeout(erpDismissToast_, durationMs);
}

/**
 * 載入中提示（橘色 warn）：不固定秒數，會跟著流程結束關閉
 * - 回傳 token，結束時用 token 關閉，避免「後續訊息」被誤關掉
 */
function erpBeginLoadWarnToast_(message){
  try{
    const toast = document.getElementById("toast");
    if(!toast) return "";
    const token = "loadwarn-" + Date.now() + "-" + Math.floor(Math.random()*100000);
    const w = (typeof window !== "undefined" && window) ? window : {};
    w.__ERP_LOADWARN_TOAST_TOKEN__ = token;
    const textEl = document.getElementById("toastText") || toast;
    textEl.textContent = String(message || "載入中…");
    const closeBtn = document.getElementById("toastCloseBtn");
    if(closeBtn) closeBtn.style.display = "none";
    const copyBtn = document.getElementById("toastCopyBtn");
    if(copyBtn) copyBtn.style.display = "none";
    toast.onclick = null;
    toast.className = "toast show warn";
    // 不讓它自動消失：給一個極長時間（真正關閉由 end 來做）
    setTimeout(function(){
      try{
        if(w.__ERP_LOADWARN_TOAST_TOKEN__ === token){
          toast.className = "toast";
        }
      }catch(_e){}
    }, 10 * 60 * 1000);
    return token;
  }catch(_e){
    return "";
  }
}

function erpEndLoadWarnToast_(token){
  try{
    const toast = document.getElementById("toast");
    if(!toast) return;
    const w = (typeof window !== "undefined" && window) ? window : {};
    if(!token) return;
    if(String(w.__ERP_LOADWARN_TOAST_TOKEN__ || "") !== String(token)) return;
    w.__ERP_LOADWARN_TOAST_TOKEN__ = "";
    // 載入完成後若已顯示 success/error 等後續 Toast，不要清掉
    const cls = String(toast.className || "");
    if(cls.indexOf("warn") >= 0){
      toast.className = "toast";
    }
  }catch(_e){}
}

/**
 * 輸入時自動轉大寫。僅用於代碼／單號欄位（如 c_id、po_id），勿綁中文名稱或備註。
 */
function bindUppercaseInput(elementId){
  const el = document.getElementById(elementId);
  if(!el) return;
  if(el.dataset.uppercaseBound) return;
  el.dataset.uppercaseBound = "1";

  let composing = false;

  function applyUppercase_(){
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const upper = (el.value || "").toUpperCase();
    if(el.value !== upper){
      el.value = upper;
      if(start != null && end != null){
        el.setSelectionRange(start, end);
      }
    }
  }

  el.addEventListener("compositionstart", function () {
    composing = true;
  });
  el.addEventListener("compositionend", function () {
    composing = false;
    applyUppercase_();
  });

  el.addEventListener("input", () => {
    if (composing) return;
    applyUppercase_();
  });
}

/* =========================================================
   UX：列表按 Load 後捲到上方編輯區
========================================================= */

function scrollToEditorTop(){
  try{
    // 這個專案的滾動容器是 #content（不是整個 window）
    const content = document.getElementById("content");
    if(content && typeof content.scrollTo === "function"){
      content.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }catch(_e){
    try{
      const content = document.getElementById("content");
      if(content) content.scrollTop = 0;
      window.scrollTo(0,0);
    }catch(_e2){}
  }
}

/** 主檔版型 A：展開下方明細卡片 */
function showMasterEditCard_(formCardIdOrEl){
  try{
    const el =
      typeof formCardIdOrEl === "string"
        ? document.getElementById(formCardIdOrEl)
        : formCardIdOrEl;
    if(el) el.classList.remove("master-edit-collapsed");
  }catch(_e){}
}

/** 主檔版型 A：隱藏明細卡片 */
function hideMasterEditCard_(formCardIdOrEl){
  try{
    const el =
      typeof formCardIdOrEl === "string"
        ? document.getElementById(formCardIdOrEl)
        : formCardIdOrEl;
    if(el) el.classList.add("master-edit-collapsed");
  }catch(_e){}
}

/** 主檔列表「新增」：清空表單 → 展開明細 → 捲動 */
function newMasterFromList_(formCardId, clearFn){
  try{
    if(typeof clearFn === "function") clearFn();
  }catch(_e){}
  showMasterEditCard_(formCardId);
  if(typeof scrollToMasterForm_ === "function") scrollToMasterForm_(formCardId);
}

/** 主檔列表「重設」：還原搜尋後收合明細、回列表頂 */
/** 主檔列表搜尋：狀態預設 ACTIVE（使用中） */
function masterSearchStatusDefault_(selectId){
  const el = document.getElementById(String(selectId || ""));
  if(el) el.value = "ACTIVE";
}

function resetMasterListView_(formCardId, clearFn){
  try{
    if(typeof clearFn === "function") clearFn();
  }catch(_e){}
  hideMasterEditCard_(formCardId);
  if(typeof scrollToEditorTop === "function") scrollToEditorTop();
}

function masterListEsc_(s){
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** 主檔列表：ID 上（灰小字）＋名稱下（單格 HTML，非 table cell） */
function masterListIdNameHtml_(id, name){
  const i = String(id ?? "").trim();
  const n = String(name ?? "").trim();
  if(!i && !n) return '<span class="text-muted">—</span>';
  if(!i) return '<div class="master-list-name">' + masterListEsc_(n) + "</div>";
  if(!n) return '<div class="master-list-id">' + masterListEsc_(i) + "</div>";
  return (
    '<div class="master-list-id">' +
    masterListEsc_(i) +
    '</div><div class="master-list-name">' +
    masterListEsc_(n) +
    "</div>"
  );
}

/** 主檔列表：ID 上（灰小字）＋名稱下（桌機／手機共用） */
function masterListIdNameCells_(id, name){
  const i = masterListEsc_(id);
  const n = masterListEsc_(name);
  return (
    '<td class="col-master-idname"><div class="master-list-id">' +
    i +
    '</div><div class="master-list-name">' +
    n +
    "</div></td><td class=\"col-master-name-desk\">" +
    n +
    "</td>"
  );
}

/** 主檔列表：僅名稱（桌機／手機共用，不顯示 ID） */
function masterListNameOnlyCells_(name) {
  const n = masterListEsc_(name);
  return (
    '<td class="col-master-idname"><div class="master-list-name">' +
    n +
    "</div></td><td class=\"col-master-name-desk\">" +
    n +
    "</td>"
  );
}

/** 主檔列表：桌機類型／流程兩欄；手機合併為類型上＋流程下（皆小字） */
function masterListTypeFlowCells_(type, flow){
  const t = masterListEsc_(type);
  const f = masterListEsc_(flow);
  const tTitle = t ? ' title="' + t + '"' : "";
  const fTitle = f ? ' title="' + f + '"' : "";
  return (
    '<td class="col-master-typeflow">' +
    '<div class="master-list-type"' + tTitle + ">" +
    t +
    '</div><div class="master-list-flow"' + fTitle + ">" +
    f +
    '</div></td><td class="col-master-flow-desk">' +
    f +
    "</td>"
  );
}

/** 主檔列表：桌機聯絡人／電話兩欄；手機合併為聯絡人上＋電話下（灰小字） */
function masterListContactPhoneCells_(contact, phone){
  const c = masterListEsc_(contact);
  const p = masterListEsc_(phone);
  const cTitle = c ? ' title="' + c + '"' : "";
  const pTitle = p ? ' title="' + p + '"' : "";
  return (
    '<td class="col-master-contact">' +
    '<div class="master-list-contact"' + cTitle + ">" +
    c +
    '</div><div class="master-list-phone"' + pTitle + ">" +
    p +
    '</div></td><td class="col-master-phone col-master-phone-desk">' +
    p +
    "</td>"
  );
}

/** 主檔版型 A：Load 後捲到下方編輯卡片 */
function scrollToMasterForm_(formCardIdOrEl){
  showMasterEditCard_(formCardIdOrEl);
  try{
    const el =
      typeof formCardIdOrEl === "string"
        ? document.getElementById(formCardIdOrEl)
        : formCardIdOrEl;
    if(!el) return;
    const content = document.getElementById("content");
    if(content && typeof content.scrollTo === "function"){
      const contentRect = content.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const top = content.scrollTop + (elRect.top - contentRect.top) - 8;
      content.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }catch(_e){
    try{
      const el =
        typeof formCardIdOrEl === "string"
          ? document.getElementById(formCardIdOrEl)
          : formCardIdOrEl;
      if(el) el.scrollIntoView(true);
    }catch(_e2){}
  }
}

/* =========================================================
   UX：資料表 tbody 載入中（與收貨「已收列表」同風格）
========================================================= */

function setTbodyLoading_(tbodyOrId, colspan, message){
  const tbody = typeof tbodyOrId === "string" ? document.getElementById(tbodyOrId) : tbodyOrId;
  if(!tbody) return;
  const n = Math.max(1, Number(colspan) || 1);
  const msg = message == null || message === "" ? "載入中…" : String(message);
  const esc = msg.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  tbody.innerHTML =
    `<tr><td colspan="${n}" style="text-align:center;color:#64748b;padding:18px;">${esc}</td></tr>`;
}

function erpSyncListRowHighlight_(tbodyId, attrName, selectedId){
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  const sel = String(selectedId || "").trim().toUpperCase();
  const attr = String(attrName || "data-row-id");
  tbody.querySelectorAll("tr[" + attr + "]").forEach(function(tr){
    const id = String(tr.getAttribute(attr) || "").trim().toUpperCase();
    tr.classList.toggle("erp-list-row-open", id === sel);
  });
}
window.erpSyncListRowHighlight_ = erpSyncListRowHighlight_;

/** 列表列：再點同一列（ID 不分大小寫） */
function erpListRowToggleClose_(selectedId, clickedId){
  const a = String(selectedId || "").trim().toUpperCase();
  const b = String(clickedId || "").trim().toUpperCase();
  return !!(a && b && a === b);
}

/** 程式觸發重載（建立／儲存後）時略過「再點同一列收合」 */
function erpTxnLoadForce_(options) {
  return !!(options && (options.force === true || options.forceReload === true));
}

function erpTxnLoadShouldToggleClose_(editing, curId, nextId, options) {
  if (erpTxnLoadForce_(options)) return false;
  if (!editing) return false;
  return erpListRowToggleClose_(curId, nextId);
}

/** 主檔版型 A：下方明細卡片是否已展開 */
function erpMasterEditCardIsOpen_(formCardId){
  const el = document.getElementById(String(formCardId || ""));
  if(!el) return false;
  return !el.classList.contains("master-edit-collapsed");
}

/**
 * 主檔列表：已載入且明細已展開時，再點同一列 → 清空、收合、取消 highlight
 * @returns {boolean} true 表示已收合（呼叫端應 return）
 */
function erpTryToggleCloseMasterListRow_(selectedId, clickedId, formCardId, clearFn, tbodyId, attrName){
  if(!erpListRowToggleClose_(selectedId, clickedId)) return false;
  if(!erpMasterEditCardIsOpen_(formCardId)) return false;
  try{
    if(typeof clearFn === "function") clearFn();
  }catch(_e){}
  hideMasterEditCard_(formCardId);
  if(tbodyId && typeof erpSyncListRowHighlight_ === "function"){
    erpSyncListRowHighlight_(tbodyId, attrName || "data-row-id", "");
  }
  if(typeof scrollToEditorTop === "function") scrollToEditorTop();
  return true;
}

window.__erpListRowCollapsed_ = window.__erpListRowCollapsed_ || {};

function erpClearTxnListRowCollapsed_(moduleKey){
  if(moduleKey) window.__erpListRowCollapsed_[moduleKey] = false;
}

/** 交易單列表 render：是否顯示 erp-list-row-open */
function erpListRowOpenInRender_(moduleKey, selId, rowId){
  if(window.__erpListRowCollapsed_[moduleKey]) return false;
  return String(selId || "").trim().toUpperCase() === String(rowId || "").trim().toUpperCase();
}

/**
 * 交易單列表：再點同一列 → 收合／展開 highlight（不清表單）
 * @returns {boolean} true 表示已處理 toggle（呼叫端應 return）
 */
function erpTryToggleCloseTxnListRow_(moduleKey, selectedId, clickedId, tbodyId){
  if(!erpListRowToggleClose_(selectedId, clickedId)) return false;
  const collapsed = !!window.__erpListRowCollapsed_[moduleKey];
  if(!collapsed){
    window.__erpListRowCollapsed_[moduleKey] = true;
    if(tbodyId) erpSyncListRowHighlight_(tbodyId, "data-row-id", "");
    if(typeof scrollToEditorTop === "function") scrollToEditorTop();
    return true;
  }
  window.__erpListRowCollapsed_[moduleKey] = false;
  if(tbodyId) erpSyncListRowHighlight_(tbodyId, "data-row-id", clickedId);
  if(typeof scrollToEditorTop === "function") scrollToEditorTop();
  return true;
}

window.erpListRowToggleClose_ = erpListRowToggleClose_;
window.erpTxnLoadForce_ = erpTxnLoadForce_;
window.erpTxnLoadShouldToggleClose_ = erpTxnLoadShouldToggleClose_;
window.erpMasterEditCardIsOpen_ = erpMasterEditCardIsOpen_;
window.erpTryToggleCloseMasterListRow_ = erpTryToggleCloseMasterListRow_;
window.erpClearTxnListRowCollapsed_ = erpClearTxnListRowCollapsed_;
window.erpListRowOpenInRender_ = erpListRowOpenInRender_;
window.erpTryToggleCloseTxnListRow_ = erpTryToggleCloseTxnListRow_;

/* =========================================================
   參考關聯檢查（停用策略用）
========================================================= */

async function isIdUsedInAny(idValue, refs){
  const id = String(idValue || "");
  const list = Array.isArray(refs) ? refs : [];
  if(!id || list.length === 0) return false;

  // 簡單快取：避免同一輪重複打 API
  const cache = {};

  for(const r of list){
    const type = r?.type;
    const field = r?.field;
    if(!type || !field) continue;

    if(!cache[type]){
      // 這是「停用前的提醒用檢查」：若因權限不足/網路等原因讀不到，不應噴錯干擾主流程
      cache[type] = await getAll(type, { silent: true }).catch(()=>[]);
    }
    const rows = cache[type] || [];
    if(rows.some(x => String(x[field] || "") === id)){
      return true;
    }
  }
  return false;
}

/* =========================================================
   搜尋列：輸入／下拉變更即篩選（比照 Logs，不必再按「搜尋」）
========================================================= */

/**
 * @param {Array<[string, "input"|"change"]>} controls - [元素 id, 事件名稱]
 * @param {Function} callback - 例如 searchProducts 或 () => renderShipments()
 */
function bindAutoSearchToolbar_(controls, callback){
  if(!Array.isArray(controls) || typeof callback !== "function") return;
  controls.forEach(function(pair){
    const id = pair[0];
    const ev = pair[1] || "input";
    const el = document.getElementById(id);
    if(!el) return;
    if(el.dataset.erpAutoSearchBound) return;
    el.dataset.erpAutoSearchBound = "1";
    el.addEventListener(ev, function(){
      try{
        const ret = callback();
        if(ret && typeof ret.then === "function"){
          ret.catch(function(){});
        }
      }catch(_e){}
    });
  });
}

/* =========================================================
  單位換算（主檔規則）
========================================================= */

function normalizeUnit(unit){
  return String(unit || "").trim().toUpperCase();
}

function parseUnitRatioToBaseMap(raw){
  if(raw == null || raw === "") return {};
  let obj = raw;
  if(typeof raw === "string"){
    try{
      obj = JSON.parse(raw);
    }catch(_e){
      return null;
    }
  }
  if(!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  Object.keys(obj).forEach(k => {
    const key = normalizeUnit(k);
    const val = Number(obj[k]);
    if(!key) return;
    if(!(val > 0)) return;
    out[key] = val;
  });
  return out;
}

function parseProductUomConfigFromRemark_(remark){
  const text = String(remark || "");
  const m = text.match(/@UOM:\s*(\{[\s\S]*?\})\s*(?:\n|$)/);
  if(!m) return null;
  try{
    const obj = JSON.parse(m[1]);
    if(!obj || typeof obj !== "object") return null;
    const base = normalizeUnit(obj.base_unit || "");
    const map = parseUnitRatioToBaseMap(obj.map || {});
    if(!base) return null;
    if(map === null) return null;
    return { base_unit: base, map: map || {} };
  }catch(_e){
    return null;
  }
}

/** 從 product.uom_config 欄位解析（與 @UOM JSON 相同結構） */
function parseProductUomConfigFromField_(uomRaw){
  const text = String(uomRaw || "").trim();
  if(!text) return null;
  try{
    const obj = JSON.parse(text);
    if(!obj || typeof obj !== "object") return null;
    const base = normalizeUnit(obj.base_unit || "");
    const map = parseUnitRatioToBaseMap(obj.map || {});
    if(!base) return null;
    if(map === null) return null;
    return { base_unit: base, map: map || {} };
  }catch(_e){
    return null;
  }
}

/**
 * 讀取產品多單位設定：優先 uom_config，其次備註內舊版 @UOM:
 */
function getProductUomConfig(product){
  const p = product || {};
  const fromField = parseProductUomConfigFromField_(p.uom_config);
  if(fromField) return fromField;
  return parseProductUomConfigFromRemark_(p.remark);
}

function upsertProductUomRemark(remark, cfg){
  const raw = String(remark || "");
  const cleaned = raw.replace(/\n?@UOM:\s*\{[\s\S]*?\}\s*(?:\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if(!cfg) return cleaned;
  const base = normalizeUnit(cfg.base_unit || "");
  const map = cfg.map && typeof cfg.map === "object" ? cfg.map : {};
  const json = JSON.stringify({ base_unit: base, map }, null, 0);
  return (cleaned ? (cleaned + "\n") : "") + `@UOM:${json}`;
}

function stripProductUomRemark(remark){
  const raw = String(remark || "");
  return raw.replace(/\n?@UOM:\s*\{[\s\S]*?\}\s*(?:\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 將 qty + unit 轉為產品基準單位數量
 * 規則：
 * - unit === base_unit 時直接回傳 qty
 * - 否則查 product.unit_ratio_to_base_json[unit]
 * - 找不到或格式錯誤時回傳 null
 */
function convertToBase(product, qty, unit){
  const q = Number(qty);
  if(!Number.isFinite(q)) return null;
  const p = product || {};
  const cfg = getProductUomConfig(p);
  const baseUnit = normalizeUnit(cfg?.base_unit || p.unit || "");
  const srcUnit = normalizeUnit(unit || p.unit || "");
  if(!baseUnit || !srcUnit) return null;
  if(srcUnit === baseUnit) return q;

  const map = cfg ? (cfg.map || {}) : {};
  if(!map) return null;
  const rate = Number(map[srcUnit] || 0);
  if(!(rate > 0)) return null;
  return q * rate;
}

/* =========================================================
  PDF/列印（前端：另存為 PDF）
========================================================= */

function erpEscapeHtml_(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function erpOpenPrintWindow_(title, bodyHtml, opts){
  const o = opts && typeof opts === "object" ? opts : {};
  const minimal = !!o.minimalPrintChrome;
  const skipBrand = !!o.skipBrandHeader;
  const t = String(title || "").trim() || (minimal ? "Commercial Invoice" : "ERP");
  const cfg = (typeof window === "object" && window && window.__ERP_CONFIG__) ? window.__ERP_CONFIG__ : {};
  const logoUrlRaw = String(cfg && (cfg.COMPANY_LOGO_URL || "") || "").trim();
  const logoUrl = (function(){
    const u = String(logoUrlRaw || "").trim();
    if(!u) return "";
    if(/^data:/i.test(u)) return u;
    if(/^https?:\/\//i.test(u)) return u;
    // print window 是 about:blank，相對路徑會失效；這裡統一轉成絕對 URL
    try{ return new URL(u, String(location && location.href || "")).href; }catch(_e){ return u; }
  })();
  const nameZh = String(cfg && (cfg.COMPANY_NAME_ZH || "") || "").trim();
  const nameEn = String(cfg && (cfg.COMPANY_NAME_EN || "") || "").trim();
  const headerHtml = skipBrand ? "" : (function(){
    if(!logoUrl && !nameZh && !nameEn) return "";
    const logo = logoUrl ? `<img class="brand-logo" src="${erpEscapeHtml_(logoUrl)}" alt="logo">` : "";
    const zh = nameZh ? `<div class="brand-zh">${erpEscapeHtml_(nameZh)}</div>` : "";
    const en = nameEn ? `<div class="brand-en">${erpEscapeHtml_(nameEn)}</div>` : "";
    const names = (zh || en) ? `<div class="brand-names">${zh}${en}</div>` : "";
    // 若沒有文字，就只顯示大 Logo（置中）
    return `<div class="brand ${names ? "has-names" : "logo-only"}">${logo}${names}</div>`;
  })();
  const pageCss = minimal
    ? `@page{ size:A4; margin:0; }
       @media print{
         html,body{ margin:0 !important; padding:12mm 14mm !important; }
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
       .ci-invoice .ci-lines-table tbody td,
       .ci-invoice .ci-lines-table tfoot td{
         background:transparent !important;
       }
       .ci-invoice .ci-summary-table td{
         border:none !important;
         background:transparent !important;
       }
       .ci-invoice .ci-footer{
         align-items:stretch !important;
       }
       .ci-invoice .ci-footer-logo{
         height:100% !important;
         width:auto !important;
         max-width:100% !important;
         object-fit:contain !important;
         object-position:left bottom !important;
       }
       .ci-batch-page{
         page-break-inside:avoid;
       }`
    : `@media print{ body{ margin:10mm; } }`;
  const css = `
    :root{ --fg:#0f172a; --muted:#475569; --line:#e2e8f0; }
    *{ box-sizing:border-box; }
    body{ font-family: system-ui, -apple-system, "Segoe UI", Arial, "Noto Sans TC", sans-serif; color:var(--fg); margin:18px; }
    .brand{ display:flex; align-items:center; justify-content:center; gap:12px; padding-bottom:8px; margin-bottom:10px; }
    .brand.logo-only{ padding-bottom:12px; }
    .brand-logo{ width:auto; height:75px; max-width:900px; object-fit:contain; }
    .brand-names{ display:flex; flex-direction:column; gap:2px; }
    .brand-zh{ font-size:16px; font-weight:700; line-height:1.2; }
    .brand-en{ font-size:12.5px; color:var(--muted); line-height:1.2; margin-top:2px; }
    h1{ font-size:18px; margin:0 0 8px 0; }
    .meta{ color:var(--muted); font-size:12px; margin-bottom:12px; line-height:1.5; }
    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:8px 18px; margin:10px 0 14px; }
    .kv{ font-size:12.5px; }
    .k{ color:var(--muted); margin-right:6px; }
    table{ width:100%; border-collapse:collapse; font-size:12px; }
    th,td{ border:1px solid var(--line); padding:6px 8px; vertical-align:middle; }
    th{ background:#eef2f7; text-align:left; }
    .foot{ margin-top:16px; font-size:12px; color:var(--muted); }
    .foot.right{ text-align:right; }
    ${pageCss}
    @media print{
      *{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      a{ color:inherit; text-decoration:none; }
    }
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${erpEscapeHtml_(t)}</title><style>${css}</style></head><body>${headerHtml}${bodyHtml || ""}</body></html>`;
  let w = null;
  let blobUrl = "";
  try{
    if(minimal && typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL){
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      blobUrl = URL.createObjectURL(blob);
      w = window.open(blobUrl, "_blank");
    }else{
      w = window.open("", "_blank");
      if(w){
        w.document.open();
        w.document.write(html);
        w.document.close();
      }
    }
  }catch(_eOpen){
    w = window.open("", "_blank");
    if(w){
      w.document.open();
      w.document.write(html);
      w.document.close();
    }
  }
  if(!w) throw new Error("popup blocked");
  try{ w.focus(); }catch(_e){}
  setTimeout(function(){
    try{ w.print(); }catch(_e2){}
    if(blobUrl){
      setTimeout(function(){
        try{ URL.revokeObjectURL(blobUrl); }catch(_e3){}
      }, 60000);
    }
  }, 50);
  return w;
}

