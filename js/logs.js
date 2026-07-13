let logsCache = [];
let logsTab = "all";
let currentOpenLogId = null;
let logsLoadInFlight_ = false;
let logsPendingReload_ = false;

function logsSetV_(id, v){
  try{
    if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(id, v);
  }catch(_e){}
  const el = document.getElementById(String(id || ""));
  if(el && "value" in el) el.value = v;
}

function logsClear_(ids){
  try{
    if(typeof window.erpClearIds_ === "function") return window.erpClearIds_(ids);
  }catch(_e){}
  const list = Array.isArray(ids) ? ids : [ids];
  for(let i = 0; i < list.length; i++){
    const el = document.getElementById(String(list[i] || ""));
    if(el && "value" in el) el.value = "";
  }
}

/**
 * 與左側選單區塊對齊：主檔 / 進貨 / 庫存 / 加工 / 銷售 / 出貨
 * （舊鍵 purchase→inbound、shipping→sales+shipment 已拆成兩顆）
 */
const LOG_TAB_TABLES = {
  all: null,
  master: ["product","supplier","customer","customer_recipient","warehouse","user","erp_user","erp_company_profile"],
  inbound: [
    "purchase_order","purchase_order_item",
    "import_document","import_item","import_receipt","import_receipt_item",
    "goods_receipt","goods_receipt_item"
  ],
  inventory: ["lot","inventory_movement","lot_relation","lot_balance"],
  process: ["process_order","process_order_input","process_order_output"],
  sales: ["sales_order","sales_order_item"],
  shipment: ["shipment","shipment_item","commercial_invoice","commercial_invoice_line","commercial_invoice_blank","commercial_invoice_blank_line"],
  finance: ["ar_receivable","ar_payment","consignment_case","consignment_case_pool_item","consignment_case_settlement","consignment_case_settlement_item","consignment_case_return","consignment_case_return_item"]
};

/** 資料表中文名；列表只顯示中文，滑鼠移過顯示原始英文表名 */
const LOG_TABLE_ZH_ = {
  product: "產品",
  supplier: "供應商",
  customer: "客戶",
  customer_recipient: "客戶收件人",
  warehouse: "倉庫",
  user: "使用者",
  erp_user: "使用者",
  erp_company_profile: "公司設定",
  purchase_order: "採購單",
  purchase_order_item: "採購明細",
  import_document: "進口報單",
  import_item: "報單品項",
  import_receipt: "進口收貨",
  import_receipt_item: "進口收貨明細",
  goods_receipt: "收貨入庫",
  goods_receipt_item: "收貨明細",
  lot: "批次",
  inventory_movement: "庫存異動",
  lot_relation: "批次關聯",
  process_order: "加工單",
  process_order_input: "加工投料",
  process_order_output: "加工產出",
  sales_order: "銷售單",
  sales_order_item: "銷售明細",
  shipment: "出貨單",
  shipment_item: "出貨明細",
  commercial_invoice: "商業發票",
  commercial_invoice_line: "商業發票明細",
  commercial_invoice_blank: "空白商業發票",
  commercial_invoice_blank_line: "空白商業發票明細",
  ar_receivable: "應收帳款",
  ar_payment: "收款紀錄",
  consignment_track: "寄賣追蹤（舊 v4.2）",
  consignment_settlement: "寄賣結算（舊 v4.2）",
  consignment_settlement_item: "寄賣結算明細（舊 v4.2）",
  consignment_return: "寄賣未售退回（舊 v4.2）",
  consignment_return_item: "寄賣退回明細（舊 v4.2）",
  consignment_case: "寄賣案件",
  consignment_case_pool_item: "寄賣案件品項池",
  consignment_case_settlement: "寄賣案件結算",
  consignment_case_settlement_item: "寄賣案件結算明細",
  consignment_case_return: "寄賣案件收回",
  consignment_case_return_item: "寄賣案件收回明細",
  lot_balance: "庫存快照",
  logs: "操作紀錄"
};

/** 操作類型中文；列表只顯示中文，滑鼠移過顯示原始 action_type */
const LOG_ACTION_LABELS = {
  CREATE: "建立",
  UPDATE: "更新",
  DELETE: "刪除",
  BUNDLE_CANCEL_PURCHASE_ORDER: "取消採購單",
  BUNDLE_CANCEL_SALES_ORDER: "取消銷售單",
  BUNDLE_POST_SHIPMENT: "出貨過帳",
  BUNDLE_CANCEL_SHIPMENT: "取消出貨",
  BUNDLE_CREATE_CONSIGNMENT_TRACK: "建立寄賣追蹤",
  BUNDLE_POST_CONSIGNMENT_SETTLEMENT: "寄賣結算過帳",
  BUNDLE_POST_CONSIGNMENT_RETURN: "寄賣未售退回",
  BUNDLE_CREATE_CONSIGNMENT_CASE: "建立寄賣案件",
  BUNDLE_POST_CONSIGNMENT_CASE_SETTLEMENT: "寄賣案件結算過帳",
  BUNDLE_CANCEL_CONSIGNMENT_CASE_SETTLEMENT: "寄賣案件結算作廢",
  BUNDLE_VOID_AR_FROM_CASE_SETTLEMENT_CANCEL: "作廢寄賣結算應收",
  BUNDLE_POST_CONSIGNMENT_CASE_RETURN: "寄賣案件收回過帳",
  BUNDLE_CANCEL_CONSIGNMENT_CASE_RETURN: "寄賣案件收回作廢",
  BUNDLE_ADD_CASE_POOL_FROM_SHIPMENT: "出貨加入案件品項池",
  BUNDLE_REMOVE_CASE_POOL_FROM_SHIPMENT_CANCEL: "出貨作廢移除案件品項池",
  BUNDLE_CREATE_AR_FROM_SHIPMENT: "出貨產生應收",
  BUNDLE_CREATE_AR_FROM_SETTLEMENT: "寄賣結算產生應收",
  BUNDLE_REGISTER_AR_PAYMENT: "登記應收收款",
  BUNDLE_UPDATE_AR_PAYMENT: "修改應收收款",
  BUNDLE_ADJUST_AR_AMOUNT: "調整應收金額",
  BUNDLE_SETTLE_AR: "應收結清",
  BUNDLE_FORCE_CLOSE_AR: "應收手動沖銷結案",
  CREATE_PROCESS_ORDER: "建立加工單",
  BUNDLE_ISSUE_PROCESS_ORDER: "加工送料",
  BUNDLE_RECEIVE_PROCESS_OUTPUT: "加工收料",
  BUNDLE_RETRACT_PROCESS_ISSUE: "撤回加工送料",
  BUNDLE_VOID_PROCESS_OUTPUT: "作廢加工產出",
  BUNDLE_VOID_COMMERCIAL_DEALER_REBATE: "作廢經銷月結回饋",
  BUNDLE_POST_COMMERCIAL_DEALER_REBATE: "產生經銷月結回饋",
  BUNDLE_CANCEL_PROCESS_ORDER: "作廢加工單",
  POST_GOODS_RECEIPT: "收貨入庫過帳",
  CANCEL_GOODS_RECEIPT: "取消收貨入庫",
  POST_IMPORT_RECEIPT: "進口收貨過帳",
  CANCEL_IMPORT_RECEIPT: "取消進口收貨",
  SAVE_IMPORT_DOCUMENT: "儲存進口報單",
  CANCEL_IMPORT_DOCUMENT: "取消進口報單",
  SAVE_COMMERCIAL_INVOICE: "儲存商業發票",
  SAVE_COMMERCIAL_INVOICE_BLANK: "儲存空白商業發票",
  VOID_COMMERCIAL_INVOICE: "作廢商業發票",
  VOID_COMMERCIAL_INVOICE_BLANK: "作廢空白商業發票",
  UPDATE_COMPANY_PROFILE: "更新公司設定",
  REGISTER_EINVOICE: "登記電子發票",
  POST_TRANSFER: "批次調撥",
  REBUILD_LOT_BALANCE: "重建庫存快照"
};

function logsDaysFromRange_(rangeVal) {
  const r = String(rangeVal || "7");
  if (r === "all") return 3650;
  const n = Number(r);
  return isNaN(n) ? 90 : n;
}

function getLogTableZh_(tableName){
  const t = String(tableName || "").trim();
  return LOG_TABLE_ZH_[t] || t;
}

function getLogTableLabel_(tableName){
  return getLogTableZh_(tableName);
}

function getLogActionZh_(actionType){
  const a = String(actionType || "").trim();
  if(!a) return "";
  return LOG_ACTION_LABELS[a] || a;
}

function logsOperatorLabel_(createdBy){
  if(typeof erpDisplayOperatorName_ === "function") return erpDisplayOperatorName_(createdBy);
  return String(createdBy || "").trim();
}

/** 相容舊分頁鍵 purchase→inbound */
function normalizeLogsTab_(tab){
  const k = String(tab || "all");
  if(k === "purchase") return "inbound";
  if(k === "ar" || k === "finance") return "finance";
  return k;
}

// 其他模組用：先設定條件，再跳到 Logs 頁面
// openLogs('product','P001','master')
function openLogs(tableName = "", referenceId = "", tab = "all") {
  try {
    window.__pendingOpenLogs = {
      tableName: String(tableName || ""),
      referenceId: String(referenceId || ""),
      tab: String(tab || "all"),
      at: Date.now(),
    };
  } catch (_e) {}
  if (typeof navigate === "function") navigate("logs");
}

function escapeHtml(input){
  const s = (input ?? "").toString();
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===== 時間：針對 nowIso16() 風格（不含時區尾碼）做「純本地」顯示/排序 ===== */
function parseIsoNoTzParts_(raw){
  const s = String(raw || "").trim();
  // 只處理：YYYY-MM-DDTHH:mm(:ss(.sss))?，且不含 Z / +08:00 / -08:00
  // 例如：2026-03-25T14:38 / 2026-03-25T14:38:12 / 2026-03-25T14:38:12.123
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if(!m) return null;
  return {
    yyyy: m[1],
    mm: m[2],
    dd: m[3],
    hh: m[4],
    mi: m[5]
  };
}

function parseIsoNoTzAsLocalDate_(raw){
  if (typeof erpParseLocalDateTime_ === "function") return erpParseLocalDateTime_(raw);
  const parts = parseIsoNoTzParts_(raw);
  if(!parts) return null;
  const yyyy = Number(parts.yyyy);
  const mm = Number(parts.mm);
  const dd = Number(parts.dd);
  const hh = Number(parts.hh);
  const mi = Number(parts.mi);
  const d = new Date(yyyy, mm-1, dd, hh, mi, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* formatLocalTime：見 js/core/utils.js（全站共用，Asia/Taipei） */

/* ===== 分頁 ===== */
function setLogsTab(tab){
  logsTab = normalizeLogsTab_(tab || "all");
  updateLogsTabUI();
  applyLogsFilter();
}

function updateLogsTabUI(){
  const mapping = {
    all: "logs_tab_all",
    master: "logs_tab_master",
    inbound: "logs_tab_inbound",
    inventory: "logs_tab_inventory",
    process: "logs_tab_process",
    sales: "logs_tab_sales",
    shipment: "logs_tab_shipment",
    finance: "logs_tab_finance"
  };

  Object.entries(mapping).forEach(([key, id]) => {
    const btn = document.getElementById(id);
    if(!btn) return;
    btn.classList.toggle("btn-primary", logsTab === key);
    btn.classList.toggle("btn-secondary", logsTab !== key);
  });
}

/* ===== 日期處理 ===== */
function parseLogDate(createdAt){
  if (typeof erpParseLocalDateTime_ === "function") return erpParseLocalDateTime_(createdAt);
  if(!createdAt) return null;
  const raw = String(createdAt || "").trim();
  const local = parseIsoNoTzAsLocalDate_(raw);
  if(local) return local;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clearLogDetail_(){
  const area = document.getElementById("logsDetailArea");
  if(area) area.innerHTML = "";
  currentOpenLogId = null;
}

/* ===== 初始化 ===== */
async function logsInit(){
  await loadLogs();

  initLogsTableOptions_();

  ["logs_search_keyword","logs_search_action",
   "logs_filter_table",
   "logs_filter_range"].forEach(id=>{
     const el = document.getElementById(id);
     if(!el) return;
     el.addEventListener(id.includes("keyword") ? "input" : "change", function(){
       if(id === "logs_filter_range"){
         loadLogs().then(function(){ applyLogsFilter(); initLogsTableOptions_(); });
       }else{
         applyLogsFilter();
       }
     });
   });

  updateLogsTabUI();
  applyPendingOpenLogs_();
  applyLogsFilter();
}

/* ===== 讀取資料 ===== */
async function loadLogs(){
  if(logsLoadInFlight_){
    logsPendingReload_ = true;
    return;
  }
  logsLoadInFlight_ = true;
  setTbodyLoading_("logsTableBody", 4);
  try{
    const pending = window.__pendingOpenLogs;
    const rangeEl = document.getElementById("logs_filter_range");
    const days = logsDaysFromRange_(pending ? "all" : (rangeEl && rangeEl.value));
    let rows = null;

    if(pending && pending.referenceId){
      try{
        const r = await callAPI({
          action: "list_logs_by_ref",
          table_name: String(pending.tableName || ""),
          reference_id: String(pending.referenceId || ""),
          days: days,
          _ts: String(Date.now())
        }, { method: "POST" });
        rows = typeof erpParseArrayDataResponse_ === "function" ? erpParseArrayDataResponse_(r) : [];
      }catch(_eRef){ rows = null; }
    }

    if(!Array.isArray(rows)){
      try{
        const r = await callAPI({
          action: "list_logs_recent",
          days: days,
          limit: "2000",
          _ts: String(Date.now())
        }, { method: "POST" });
        rows = typeof erpParseArrayDataResponse_ === "function" ? erpParseArrayDataResponse_(r) : [];
      }catch(_eRecent){
        rows = await getAll("logs").catch(() => []);
      }
    }

    logsCache = Array.isArray(rows) ? rows : [];

    logsCache.sort((a,b)=>{
      const ta = parseLogDate(a.created_at)?.getTime() || 0;
      const tb = parseLogDate(b.created_at)?.getTime() || 0;
      if(tb !== ta) return tb - ta;
      return (b.log_id || "").localeCompare(a.log_id || "");
    });
  } finally {
    logsLoadInFlight_ = false;
    if(logsPendingReload_){
      logsPendingReload_ = false;
      setTimeout(function(){
        try{ loadLogs().then(()=>applyLogsFilter()); }catch(_e){}
      }, 0);
    }
  }
}

/* ===== 篩選 ===== */
function applyLogsFilter(){
  // 只要切換任一篩選條件，就收起已展開的明細
  clearLogDetail_();

  const keyword = (document.getElementById("logs_search_keyword")?.value || "").toLowerCase();
  const action = document.getElementById("logs_search_action")?.value || "";
  const table = document.getElementById("logs_filter_table")?.value || "";
  const range = document.getElementById("logs_filter_range")?.value || "7";

  const now = Date.now();
  const rangeMs = range === "all" ? null :
    Number(range) === 30 ? 30*24*60*60*1000 :
    7*24*60*60*1000;

  const filtered = logsCache.filter(l=>{
    // tab filter
    const allowTables = LOG_TAB_TABLES[logsTab] ?? null;
    if(Array.isArray(allowTables) && allowTables.length){
      if(!allowTables.includes(l.table_name)) return false;
    }

    if(action){
      if(action === "BUNDLE"){
        if(!String(l.action_type || "").startsWith("BUNDLE_")) return false;
      }else if(l.action_type !== action) return false;
    }
    if(table && l.table_name !== table) return false;

    if(rangeMs != null){
      const d = parseLogDate(l.created_at);
      if(d && now - d.getTime() > rangeMs) return false;
    }

    const text = [
      l.log_id,
      l.table_name,
      getLogTableZh_(l.table_name),
      l.reference_id,
      l.action_type,
      getLogActionZh_(l.action_type),
      l.created_by,
      logsOperatorLabel_(l.created_by),
      l.old_value,
      l.new_value
    ].join(" ").toLowerCase();

    if(keyword && !text.includes(keyword)) return false;

    return true;
  });

  renderLogs(filtered);
}

/* ===== 表格渲染 ===== */
function renderLogs(list){
  const tbody = document.getElementById("logsTableBody");
  if(!tbody) return;

  tbody.innerHTML = "";

  const countEl = document.getElementById("logsCountText");
  if(countEl) countEl.textContent = `顯示 ${list.length} 筆`;

  list.forEach(l=>{
    const encoded = encodeURIComponent(JSON.stringify(l));

    const tr = document.createElement("tr");
    const tbl = String(l.table_name || "");
    const act = String(l.action_type || "");
    const tblZh = getLogTableZh_(tbl);
    const actZh = getLogActionZh_(act);
    tr.innerHTML = `
      <td class="logs-stack-cell">
        <div class="logs-stack-sub">${escapeHtml(l.log_id || "")}</div>
        <div class="logs-stack-main" title="${escapeHtml(tbl)}">${escapeHtml(tblZh)}</div>
      </td>
      <td class="logs-stack-cell">
        <div class="logs-stack-sub">${escapeHtml(l.reference_id || "")}</div>
        <div class="logs-stack-main" title="${escapeHtml(act)}">${escapeHtml(actZh)}</div>
      </td>
      <td class="logs-stack-cell">
        <div class="logs-stack-main">${escapeHtml(logsOperatorLabel_(l.created_by))}</div>
        <div class="logs-stack-sub">${escapeHtml(formatLocalTime(l.created_at))}</div>
      </td>
      <td>
        <span class="logs-view-link"
          onclick="showLogDetail('${encoded}')">
          View
        </span>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function initLogsTableOptions_() {
  const sel = document.getElementById("logs_filter_table");
  if (!sel) return;
  const tables = Array.from(new Set((logsCache || []).map(l => l.table_name).filter(Boolean))).sort();
  sel.innerHTML =
    `<option value="">全部資料表</option>` +
    tables.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(getLogTableLabel_(t))}</option>`).join("");
}

function applyPendingOpenLogs_() {
  const pending = window.__pendingOpenLogs;
  if (!pending) return;

  const tableSel = document.getElementById("logs_filter_table");
  const keywordEl = document.getElementById("logs_search_keyword");
  const rangeSel = document.getElementById("logs_filter_range");
  const actionSel = document.getElementById("logs_search_action");

  // 分頁（相容舊鍵 purchase；shipping 依資料表拆成 銷售單 / 出貨）
  const ptab = String(pending.tab || "all");
  if(ptab === "purchase") setLogsTab("inbound");
  else if(ptab === "shipping"){
    const tid = String(pending.tableName || "");
    if(tid.startsWith("shipment") || tid.startsWith("commercial_invoice")) setLogsTab("shipment");
    else setLogsTab("sales");
  }else if(ptab === "ar" || ptab === "finance"){
    setLogsTab("finance");
  }else{
    setLogsTab(ptab);
  }

  // table filter
  if (tableSel && pending.tableName) tableSel.value = pending.tableName;

  // keyword：帶入 reference_id（最常用）
  if (keywordEl && pending.referenceId) keywordEl.value = pending.referenceId;

  // action：從其他頁跳入時清空，避免被舊條件（如 CREATE）卡住看不到 UPDATE
  logsClear_("logs_search_action");

  // 範圍：避免「最近 7 天」找不到，以「全部時間」更符合查看歷史紀錄
  if (rangeSel) rangeSel.value = "all";

  try { delete window.__pendingOpenLogs; } catch (_e) { window.__pendingOpenLogs = null; }
}

function resetLogsFilters(){
  const tableSel = document.getElementById("logs_filter_table");
  const rangeSel = document.getElementById("logs_filter_range");
  const actionSel = document.getElementById("logs_search_action");
  const keywordEl = document.getElementById("logs_search_keyword");

  logsClear_(["logs_filter_table", "logs_search_action", "logs_search_keyword"]);
  if(rangeSel) rangeSel.value = "7";

  setLogsTab("all");
  applyLogsFilter();
}

/* ===== 顯示 / 收合 明細 ===== */
function safeParseLogJson_(str){
  const s = String(str || "").trim();
  if(!s) return null;
  try{
    const v = JSON.parse(s);
    if(v !== null && typeof v === "object" && !Array.isArray(v)) return v;
    return { _value: v };
  }catch(_e){
    return null;
  }
}

function formatLogDetailScalar_(val){
  if(val == null) return "";
  if(typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function showLogDetail(encoded){
  const area = document.getElementById("logsDetailArea");
  if(!area) return;

  const log = JSON.parse(decodeURIComponent(encoded));

  if(currentOpenLogId === log.log_id){
    area.innerHTML = "";
    currentOpenLogId = null;
    return;
  }

  currentOpenLogId = log.log_id;

  const oldObj = safeParseLogJson_(log.old_value);
  const newObj = safeParseLogJson_(log.new_value);
  const oldPlain = oldObj ? "" : String(log.old_value || "").trim();
  const newPlain = newObj ? "" : String(log.new_value || "").trim();

  let html = `
    <div style="margin-top:16px;">
      <div style="color:#2563eb;font-weight:600;margin-bottom:10px;">
        明細 - ${escapeHtml(log.log_id || "")}
      </div>
      <table class="data-table" style="margin-bottom:12px;">
        <tbody>
          <tr><td style="width:120px;font-weight:600;">資料表</td><td><span title="${escapeHtml(String(log.table_name || ""))}">${escapeHtml(getLogTableZh_(log.table_name))}</span></td></tr>
          <tr><td style="font-weight:600;">參考 ID</td><td>${escapeHtml(log.reference_id || "")}</td></tr>
          <tr><td style="font-weight:600;">操作類型</td><td><span title="${escapeHtml(String(log.action_type || ""))}">${escapeHtml(getLogActionZh_(log.action_type))}</span></td></tr>
          <tr><td style="font-weight:600;">操作人</td><td>${escapeHtml(logsOperatorLabel_(log.created_by))}</td></tr>
          <tr><td style="font-weight:600;">時間</td><td>${escapeHtml(formatLocalTime(log.created_at))}</td></tr>
        </tbody>
      </table>
  `;

  if(oldObj || newObj){
    const keys = new Set([
      ...Object.keys(oldObj || {}),
      ...Object.keys(newObj || {})
    ]);
    html += `
      <table class="data-table">
        <thead>
          <tr>
            <th>欄位</th>
            <th>舊值</th>
            <th>新值</th>
          </tr>
        </thead>
        <tbody>
    `;
    if(keys.size === 0){
      html += `<tr><td colspan="3" style="text-align:center;color:#64748b;">無欄位差異</td></tr>`;
    }else{
      keys.forEach(k=>{
        html += `
          <tr>
            <td>${escapeHtml(k)}</td>
            <td style="color:#dc2626;">${escapeHtml(formatLogDetailScalar_(oldObj && oldObj[k]))}</td>
            <td style="color:#16a34a;">${escapeHtml(formatLogDetailScalar_(newObj && newObj[k]))}</td>
          </tr>
        `;
      });
    }
    html += `</tbody></table>`;
  }else if(oldPlain || newPlain){
    html += `
      <table class="data-table">
        <thead>
          <tr>
            <th>摘要</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(newPlain || oldPlain)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }else{
    html += `<p style="color:#64748b;font-size:13px;margin:0;">此筆僅記錄操作類型，無附加內容。</p>`;
  }

  html += `</div>`;

  area.innerHTML = html;
  area.scrollIntoView({behavior:"smooth", block:"start"});
}