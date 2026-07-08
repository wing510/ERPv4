/*********************************
 * 收貨入庫（統一：PO / 進口報單）v4
 * - 收貨單ID 自動產生（PO→GR、報單→IR）
 * - 選擇來源（PO 或 報單）→ 明細帶出，剩餘可收自動計算
 * - 填本次收貨數量 → 產生批次
 *********************************/

let rcvSourceType = "";
let rcvSourceId = "";
let rcvPostInFlight_ = false;
let rcvCancelInFlight_ = false;
let rcvLoadInFlight_ = false;
let rcvPendingSourceId_ = "";
let rcvLoadWarnToken_ = "";

function rcvSortReceiptRows_(rows, idField) {
  var idKey = idField || "gr_id";
  if (typeof erpSortRowsNewestFirst_ === "function") {
    return erpSortRowsNewestFirst_(rows, ["receipt_date", "created_at"], idKey);
  }
  return (rows || []).slice().sort(function (a, b) {
    return String(b.receipt_date || "").localeCompare(String(a.receipt_date || ""));
  });
}

function rcvSortSourceDocs_(rows, idField, dateFields) {
  var idKey = idField || "po_id";
  var dates = dateFields || ["order_date", "created_at"];
  if (typeof erpSortRowsNewestFirst_ === "function") {
    return erpSortRowsNewestFirst_(rows, dates, idKey);
  }
  var primary = dates[0] || "order_date";
  return (rows || []).slice().sort(function (a, b) {
    return String(b[primary] || "").localeCompare(String(a[primary] || ""));
  });
}

function rcvSetLoadActionLock_(on){
  const loading = !!on;
  const postBtn = document.getElementById("rcv_post_btn");
  const voidBtn = document.getElementById("rcv_void_btn");
  if(postBtn && loading){
    postBtn.disabled = true;
    postBtn.title = "來源載入中，請稍候…";
  }
  if(voidBtn && loading){
    voidBtn.disabled = true;
    voidBtn.title = "來源載入中，請稍候…";
  }
}

function rcvSetV_(id, v){
  try{
    if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(id, v);
  }catch(_e){}
  const el = document.getElementById(String(id || ""));
  if(el && "value" in el) el.value = v;
}

function rcvClear_(ids){
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
 * 並行載入異動明細與依 lot 彙總可用量（作廢預檢／執行用）。
 * 彙總成功時可用量以 map 為準，省去對整張 movements 逐 lot 加總。
 * @param {{ refreshMovements?: boolean }} [options] 作廢送出前建議 refreshMovements:true
 */
async function rcvFetchVoidData_(options) {
  const refreshMovements = options && options.refreshMovements === true;
  const availPack = await (typeof loadInventoryMovementAvailableMap_ === "function"
    ? loadInventoryMovementAvailableMap_()
    : Promise.resolve({ map: {}, failed: true }));
  return {
    // movements 改為按需查詢（renderRcvPostedReceipts_ 依本次顯示的 receipt ids 批次查）
    movements: [],
    availMap: (availPack && availPack.map) || {},
    availOk: !!(availPack && !availPack.failed)
  };
}

async function rcvFetchMovementsByRefs_(refType, refIds, options){
  const rt = String(refType || "").trim().toUpperCase();
  const ids = Array.isArray(refIds) ? refIds.map(x => String(x || "").trim()).filter(Boolean) : [];
  const refresh = !!(options && options.refresh === true);
  if(!rt || ids.length === 0) return [];
  try{
    const r = await callAPI({
      action: "list_inventory_movement_by_refs",
      ref_type: rt,
      ref_ids_json: JSON.stringify(ids),
      _ts: refresh ? String(Date.now()) : ""
    }, { method: "POST" });
    return (r && r.data) ? r.data : [];
  }catch(_e){
    // fallback：若後端尚未部署，優先用「近 N 天 movements」避免全表下載；
    // 僅在這也失敗時才退回全表。
    try{
      const r = await callAPI(
        { action: "list_inventory_movement_recent", days: 365, _ts: String(Date.now()) },
        { method: "POST" }
      );
      const mvRecent = typeof erpParseArrayDataResponse_ === "function" ? erpParseArrayDataResponse_(r) : [];
      if(Array.isArray(mvRecent)){
        return mvRecent.filter(m => String(m.ref_type || "").toUpperCase() === rt && ids.includes(String(m.ref_id || "")));
      }
    }catch(_e2){}

    const mvAll = await getAll("inventory_movement", refresh ? { refresh: true } : undefined).catch(() => []);
    return (mvAll || []).filter(m => String(m.ref_type || "").toUpperCase() === rt && ids.includes(String(m.ref_id || "")));
  }
}
/** 明細行：{ item_no（畫面項次 1,2,3…）, product_id, order_qty, received_qty, remaining, unit, po_id?, po_item_id?, import_doc_id?, import_item_id? } */
let rcvLines = [];
let rcvProducts = [];
let rcvWarehouses = [];

function setRcvPostBtnState_(){
  const postBtn = document.getElementById("rcv_post_btn");
  if(!postBtn) return;
  if(rcvLoadInFlight_){
    postBtn.disabled = true;
    postBtn.title = "來源載入中，請稍候…";
    return;
  }

  if(!rcvSourceType){
    postBtn.disabled = true;
    postBtn.title = "請先選擇來源類型";
    return;
  }
  if(!rcvSourceId){
    postBtn.disabled = true;
    postBtn.title = "請先選擇" + (rcvSourceType === "PO" ? "PO" : "報單");
    return;
  }
  if(!Array.isArray(rcvLines) || rcvLines.length === 0){
    postBtn.disabled = true;
    postBtn.title = "尚無可收貨明細";
    return;
  }

  const anyRemaining = (rcvLines || []).some(r => Number(r?.remaining || 0) > 0);
  if(!anyRemaining){
    postBtn.disabled = true;
    postBtn.title = "所有品項剩餘可收皆為 0，無法產生批次";
    return;
  }

  // 尚未輸入任何本次收貨數量時，先禁用（避免按了才跳錯）
  const qtys = getRcvInputQtys();
  const hasQty = (qtys || []).some(q => Number(q || 0) > 0);
  if(!hasQty){
    postBtn.disabled = true;
    postBtn.title = "請至少輸入一筆本次收貨";
    return;
  }

  postBtn.disabled = false;
  postBtn.title = "產生批次";
}

function rcvWarehouseLabelById_(warehouseId){
  const id = String(warehouseId || "").trim().toUpperCase();
  if(!id) return "—";
  const w = (rcvWarehouses || []).find(x => String(x.warehouse_id || "").trim().toUpperCase() === id) || null;
  if(!w) return id;
  const name = String(w.warehouse_name || "").trim();
  const cat = String(w.category || "").trim().toUpperCase();
  const catLabel = (typeof termShortZh_ === "function" ? termShortZh_(cat) : ((typeof termLabel === "function" ? termLabel(cat) : "") || cat));
  const namePart = name || id;
  return catLabel ? `${namePart}-${catLabel}` : namePart;
}
let rcvSuppliers = [];
let rcvPostedExpandedId_ = "";
let rcvPostedRenderCache_ = null;

const RCV_OPT_SEP = "│";

function rcvEscOptAttr_(s){
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function rcvEscOptText_(s){
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
}

function rcvSyncSourceSelectTitle_(sel){
  if(!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const raw = opt ? String(opt.getAttribute("title") || opt.textContent || "").trim() : "";
  sel.title = raw;
}

function rcvSupplierDisplay_(supplierId){
  const id = String(supplierId || "").trim();
  if(!id) return "—";
  const s = (rcvSuppliers || []).find(x => String(x.supplier_id || "").trim() === id) || null;
  const name = String(s?.supplier_name || "").trim();
  return name || id;
}

/** 採購單號│供應商│下單日期│預計到貨日 */
function rcvFormatPoOptionLabel_(p){
  const po = String(p?.po_id || "").trim() || "—";
  const sup = rcvSupplierDisplay_(p?.supplier_id);
  const od = String(p?.order_date || "").trim() || "—";
  const ea = String(p?.expected_arrival_date || "").trim() || "—";
  const stRaw = String(p?.status || "").trim();
  const st = (function(){
    const s = String(stRaw || "").trim().toUpperCase();
    if(s === "OPEN") return "未收貨";
    if(s === "PARTIAL") return "部分收貨";
    if(s === "CANCELLED") return "已作廢";
    return (typeof termLabelZhOnly === "function" ? termLabelZhOnly(s) : s) || s || "—";
  })();
  return [
    po,
    "供應商：" + sup,
    "下單日：" + od,
    "預計到貨：" + ea,
    "狀態：" + st
  ].join(RCV_OPT_SEP);
}

/** 報單ID│報單號│供應商│放行日 */
function rcvFormatImportOptionLabel_(d){
  const docId = String(d?.import_doc_id || "").trim() || "—";
  const no = String(d?.import_no || "").trim() || "—";
  const sup = rcvSupplierDisplay_(d?.supplier_id);
  const rel = String(d?.release_date || "").trim() || "—";
  const stRaw = String(d?.status || "").trim();
  const st = (function(){
    const s = String(stRaw || "").trim().toUpperCase();
    if(s === "OPEN") return "未收貨";
    if(s === "PARTIAL") return "部分收貨";
    if(s === "CANCELLED") return "已作廢";
    return (typeof termLabelZhOnly === "function" ? termLabelZhOnly(s) : s) || s || "—";
  })();
  return [
    docId,
    "報單號：" + no,
    "供應商：" + sup,
    "放行日：" + rel,
    "狀態：" + st
  ].join(RCV_OPT_SEP);
}

function setRcvLotState_(text, type = ""){
  const el = document.getElementById("rcvLotState");
  if(!el) return;
  el.textContent = text || "";
  el.style.color =
    type === "ok" ? "#166534" :
    type === "warn" ? "#92400e" :
    type === "error" ? "#991b1b" :
    "#64748b";
}

function setRcvReceiptState_(text, type = ""){
  const el = document.getElementById("rcvReceiptState");
  if(!el) return;
  el.textContent = text || "";
  el.style.color =
    type === "ok" ? "#166534" :
    type === "warn" ? "#92400e" :
    type === "error" ? "#991b1b" :
    "#64748b";
}

function formatRcvProductDisplay_(productId){
  const p = (rcvProducts || []).find(x => x.product_id === productId) || {};
  const name = p.product_name || productId || "";
  const spec = p.spec || "";
  return spec ? `${name}（${spec}）` : name;
}

function rcvPostedReceiptId_(row, sourceType){
  if(sourceType === "PO") return String(row.gr_id || "").trim();
  return String(row.import_receipt_id || "").trim();
}

function rcvTogglePostedDetail_(receiptId){
  const id = String(receiptId || "").trim();
  rcvPostedExpandedId_ = (rcvPostedExpandedId_ === id) ? "" : id;
  rcvPaintPostedReceipts_();
}

function rcvBuildLotMap_(lotsAll){
  const lotById = {};
  (lotsAll || []).forEach((l) => {
    const lid = String(l.lot_id || "").trim();
    if(lid) lotById[lid] = l;
  });
  return lotById;
}

function rcvPostedDetailHeadCellStyle_() {
  return "padding:8px 12px 4px;background:#f8fafc;border-top:none;font-size:11px;color:#64748b;font-weight:600;";
}

function rcvPostedDetailLineCellStyle_() {
  return "padding:4px 12px 6px;background:#f8fafc;border-top:none;font-size:12px;line-height:1.45;";
}

function rcvBuildPostedDetailRowsHtml_(receiptId, items, lotById, expanded) {
  const idAttr = rcvEscOptAttr_(receiptId);
  const detailStyle = expanded ? "" : ' style="display:none;"';
  const rows = Array.isArray(items) ? items : [];
  const cellBg = "background:#f8fafc;border-top:none;";
  if (!rows.length) {
    return (
      '<tr class="rcv-posted-detail" data-rcv-receipt-detail="' +
      idAttr +
      '"' +
      detailStyle +
      '><td colspan="6" style="padding:8px 12px 10px;' +
      cellBg +
      'color:#94a3b8;font-size:12px;">無明細</td></tr>'
    );
  }
  const headStyle = rcvPostedDetailHeadCellStyle_();
  const head =
    '<tr class="rcv-posted-detail rcv-posted-detail-head" data-rcv-receipt-detail="' +
    idAttr +
    '"' +
    detailStyle +
    ">" +
    '<td style="' +
    headStyle +
    '">產品</td>' +
    '<td style="' +
    headStyle +
    '">製造／有效</td>' +
    '<td style="' +
    headStyle +
    '">加工廠 Lot</td>' +
    '<td style="' +
    headStyle +
    '">數量</td>' +
    '<td style="' +
    headStyle +
    '"></td>' +
    '<td style="' +
    headStyle +
    '"></td>' +
    "</tr>";
  const lineStyle = rcvPostedDetailLineCellStyle_();
  const lines = rows
    .map(function (it) {
      const lot = lotById[String(it.lot_id || "").trim()] || {};
      const prod = formatRcvProductDisplay_(it.product_id);
      const qty = Math.round(Number(it.received_qty || 0) * 10000) / 10000;
      const unit = String(it.unit || "").trim();
      const qtyTxt = qty + (unit ? " " + unit : "");
      const fl = String(lot.factory_lot || "").trim();
      const mfg = String(lot.manufacture_date || "").trim();
      const exp = String(lot.expiry_date || "").trim();
      const dates = [mfg ? "製 " + mfg : "", exp ? "效 " + exp : ""].filter(Boolean).join(" ") || "—";
      return (
        '<tr class="rcv-posted-detail rcv-posted-detail-line" data-rcv-receipt-detail="' +
        idAttr +
        '"' +
        detailStyle +
        ">" +
        '<td style="' +
        lineStyle +
        '">' +
        rcvEscOptText_(prod) +
        "</td>" +
        '<td style="' +
        lineStyle +
        'color:#64748b;font-size:11px;">' +
        rcvEscOptText_(dates) +
        "</td>" +
        '<td style="' +
        lineStyle +
        '">' +
        (fl ? rcvEscOptText_(fl) : "—") +
        "</td>" +
        '<td style="' +
        lineStyle +
        '">' +
        rcvEscOptText_(qtyTxt) +
        "</td>" +
        '<td style="' +
        lineStyle +
        '"></td>' +
        '<td style="' +
        lineStyle +
        '"></td>' +
        "</tr>"
      );
    })
    .join("");
  return head + lines;
}

function rcvBuildPostedReceiptRowsHtml_(row, ctx){
  const sourceType = ctx.sourceType;
  const id = rcvPostedReceiptId_(row, sourceType);
  const items = (ctx.items || []).filter((x) => {
    if(sourceType === "PO") return String(x.gr_id || "") === id;
    return String(x.import_receipt_id || "") === id;
  });
  const totalQty = items.reduce((s, x) => s + Number(x.received_qty || 0), 0);
  const wh = rcvWarehouseLabelById_(row.warehouse || row.warehouse_id || "");
  const st = String(row.status || "").toUpperCase() || "OPEN";
  const stLabel = (typeof termLabelZhOnly === "function" ? termLabelZhOnly(st) : (typeof termLabel === "function" ? termLabel(st) : st));
  const ev = sourceType === "PO"
    ? rcvVoidEligibilityForGr_(id, row, ctx.sourceId, ctx.items, ctx.movements, ctx.availOpts)
    : rcvVoidEligibilityForIr_(id, row, ctx.sourceId, ctx.items, ctx.movements, ctx.availOpts);
  const canVoid = ev.ok;
  const disabled = canVoid ? "" : "disabled";
  const tip = canVoid ? "作廢此張收貨單（需選擇原因）" : ev.reason;
  const tipAttr = rcvEscOptAttr_(tip);
  const idAttr = rcvEscOptAttr_(id);
  const expanded = rcvPostedExpandedId_ === id;
  const summaryCls = "rcv-posted-summary erp-list-row-selectable" + (expanded ? " erp-list-row-open" : "");

  return `
    <tr class="${summaryCls}" data-rcv-receipt-id="${idAttr}" onclick="rcvTogglePostedDetail_(this.getAttribute('data-rcv-receipt-id'))" title="點擊展開／收合明細">
      <td>${rcvEscOptText_(id)}</td>
      <td>${rcvEscOptText_(row.receipt_date || "")}</td>
      <td>${rcvEscOptText_(wh)}</td>
      <td>${Math.round(totalQty * 10000) / 10000}</td>
      <td>${rcvEscOptText_(stLabel)}</td>
      <td onclick="event.stopPropagation()">
        <button type="button" class="btn-secondary btn-sm" ${disabled} title="${tipAttr}" data-rcv-receipt-id="${idAttr}" onclick="event.stopPropagation(); voidPostedReceiptFromListBtn(this)">${canVoid ? "作廢" : "無法作廢"}</button>
      </td>
    </tr>
    ${rcvBuildPostedDetailRowsHtml_(id, items, ctx.lotById || {}, expanded)}
  `;
}

function rcvPaintPostedReceipts_(){
  const tbody = document.getElementById("rcvPostedBody");
  const cache = rcvPostedRenderCache_;
  if(!tbody || !cache) return;
  const rows = Array.isArray(cache.rows) ? cache.rows : [];
  if(!rows.length){
    const emptyMsg = cache.sourceType === "PO" ? "此 PO 尚無收貨單" : "此報單尚無收貨單";
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:18px;">${emptyMsg}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => rcvBuildPostedReceiptRowsHtml_(r, cache)).join("");
}

/**
 * 從其他列表跳轉到「收貨入庫」時使用（預先選好來源與單號）
 * sourceType: "PO" | "IMPORT"
 */
function gotoReceive(sourceType, sourceId){
  try{
    window.__ERP_RCV_PREFILL__ = {
      sourceType: (sourceType === "IMPORT" ? "IMPORT" : "PO"),
      sourceId: String(sourceId || "")
    };
  }catch(_e){}
  if(typeof navigate === "function") navigate("receive");
}

function generateRcvId() {
  if(rcvSourceType === "PO") return generateId("GR");
  if(rcvSourceType === "IMPORT") return generateId("IR");
  return "";
}

async function rcvInitWarehouseDropdown_(){
  try{
    const list = await getAll("warehouse").catch(()=>[]);
    const rows = (list || []).filter(w => String(w.status || "ACTIVE").toUpperCase() === "ACTIVE");
    rcvWarehouses = rows.slice();
  }catch(_e){
    rcvWarehouses = [];
  }
  // 上方不再顯示「倉別」：倉別改由每列明細選擇（一次收貨單僅支援單一倉別）
}

async function renderRcvPostedReceipts_(){
  const tbody = document.getElementById("rcvPostedBody");
  if(!tbody) return;
  if(!rcvSourceType || !rcvSourceId){
    rcvPostedRenderCache_ = null;
    rcvPostedExpandedId_ = "";
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:18px;">請先選擇 PO／報單</td></tr>`;
    return;
  }
  setTbodyLoading_(tbody, 6);
  rcvPostedExpandedId_ = "";
  try{
    const lotsAll = await getAll("lot").catch(() => []);
    const lotById = rcvBuildLotMap_(lotsAll);
    if(rcvSourceType === "PO"){
      const [grAll, griAll, voidData] = await Promise.all([
        getAll("goods_receipt").catch(()=>[]),
        getAll("goods_receipt_item").catch(()=>[]),
        rcvFetchVoidData_()
      ]);
      const rows = rcvSortReceiptRows_(
        (grAll || []).filter(r => String(r.po_id || "") === String(rcvSourceId)),
        "gr_id"
      );
      const movements = rows.length
        ? await rcvFetchMovementsByRefs_("GOODS_RECEIPT", rows.map(r => String(r.gr_id || "")), { refresh: false })
        : [];
      rcvPostedRenderCache_ = {
        sourceType: "PO",
        sourceId: rcvSourceId,
        rows,
        items: Array.isArray(griAll) ? griAll : [],
        movements: Array.isArray(movements) ? movements : [],
        lotById,
        availOpts: { availMap: voidData.availMap, availOk: voidData.availOk }
      };
    }else{
      const [irAll, iriAll, voidData] = await Promise.all([
        getAll("import_receipt").catch(()=>[]),
        getAll("import_receipt_item").catch(()=>[]),
        rcvFetchVoidData_()
      ]);
      const rows = rcvSortReceiptRows_(
        (irAll || []).filter(r => String(r.import_doc_id || "") === String(rcvSourceId)),
        "import_receipt_id"
      );
      const movements = rows.length
        ? await rcvFetchMovementsByRefs_("IMPORT_RECEIPT", rows.map(r => String(r.import_receipt_id || "")), { refresh: false })
        : [];
      rcvPostedRenderCache_ = {
        sourceType: "IMPORT",
        sourceId: rcvSourceId,
        rows,
        items: Array.isArray(iriAll) ? iriAll : [],
        movements: Array.isArray(movements) ? movements : [],
        lotById,
        availOpts: { availMap: voidData.availMap, availOk: voidData.availOk }
      };
    }
    rcvPaintPostedReceipts_();
  }catch(e){
    console.error(e);
    rcvPostedRenderCache_ = null;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#991b1b;padding:18px;">已收列表載入失敗</td></tr>`;
  }
}

/** 來源類型／單號變更時同步已收列表（避免仍顯示上一種來源的收貨單） */
async function rcvRefreshPostedList_(){
  const panel = document.getElementById("rcvPostedPanel");
  const tbody = document.getElementById("rcvPostedBody");
  if(!tbody) return;
  if(panel && panel.open){
    await renderRcvPostedReceipts_();
    return;
  }
  if(!rcvSourceType || !rcvSourceId){
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;padding:18px;">請先選擇 PO／報單</td></tr>`;
  }
}

async function receiveInit() {
  const dateEl = document.getElementById("rcv_receipt_date");
  if (dateEl) dateEl.value = nowIso16();
  await rcvInitWarehouseDropdown_();
  // 並行預取 product / PO / 報單，後續選來源時會走快取
  const [products, suppliers] = await Promise.all([
    getAll("product").catch(() => []),
    getAll("supplier").catch(() => [])
  ]);
  rcvProducts = products || [];
  rcvSuppliers = (suppliers || []).filter((s) => String(s.status || "ACTIVE").toUpperCase() === "ACTIVE");
  // 預熱快取：選來源時較快
  Promise.all([getAll("purchase_order").catch(() => []), getAll("import_document").catch(() => [])]).catch(() => {});
  // 用 addEventListener 綁定，避免 inline onchange 找不到全域函數
  const srcType = document.getElementById("rcv_source_type");
  if (srcType) {
    if(typeof window.erpBindGuardedValueChangeByKey === "function"){
      window.erpBindGuardedValueChangeByKey(srcType, {
        key: "rcvSourceType",
        messageKey: "rcv.source_type",
        hasBlocking: function(){
          const hasAnyQty = (typeof getRcvInputQtys === "function")
            ? (getRcvInputQtys() || []).some(q => Number(q || 0) > 0)
            : false;
          const hasSelectedSource = !!String(rcvSourceId || "").trim();
          return hasAnyQty || hasSelectedSource;
        },
        onClear: function(){
          rcvClear_(["rcv_source_id","rcv_receipt_id"]);
          rcvSourceId = "";
          rcvLines = [];
          renderRcvLines();
          setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
          setRcvLotState_("批次狀態：未產生", "warn");
          try{ Promise.resolve(rcvRefreshPostedList_()); }catch(_ePosted){}
        },
        onAfter: function(){
          try{ Promise.resolve(onRcvSourceTypeChange()); }catch(_e){}
        }
      });
    }else{
      srcType.onchange = onRcvSourceTypeChange;
    }
  }
  const srcId = document.getElementById("rcv_source_id");
  if (srcId) {
    if(typeof window.erpBindGuardedValueChangeByKey === "function"){
      window.erpBindGuardedValueChangeByKey(srcId, {
        key: "rcvSourceId",
        messageKey: "rcv.source_id",
        hasBlocking: function(){
          return (typeof getRcvInputQtys === "function")
            ? (getRcvInputQtys() || []).some(q => Number(q || 0) > 0)
            : false;
        },
        onClear: function(){
          rcvLines = [];
          renderRcvLines();
          setRcvLotState_("批次狀態：未產生", "warn");
        },
        onAfter: function(){
          try{ Promise.resolve(onRcvSourceSelect()); }catch(_e){}
        }
      });
    }else{
      srcId.onchange = onRcvSourceSelect;
    }
  }
  const showClosed = document.getElementById("rcv_show_closed");
  if(showClosed && !showClosed.dataset.bound){
    showClosed.dataset.bound = "1";
    showClosed.addEventListener("change", async () => {
      const cur = String(document.getElementById("rcv_source_id")?.value || "");
      const curType = String(document.getElementById("rcv_source_type")?.value || "");
      if(!curType) return;
      await onRcvSourceTypeChange();
      if(cur){
        const sel = document.getElementById("rcv_source_id");
        if(sel && Array.from(sel.options || []).some(o => String(o.value || "") === cur)){
          sel.value = cur;
          await onRcvSourceSelect();
        }
      }
    });
  }
  const postBtn = document.getElementById("rcv_post_btn");
  if (postBtn) postBtn.onclick = function(){ return postReceipt(postBtn); };
  const resetBtn = document.getElementById("rcv_reset_btn");
  if (resetBtn) resetBtn.onclick = resetRcvForm;
  const logBtn = document.getElementById("rcv_log_btn");
  if (logBtn) logBtn.onclick = openRcvLog;
  const voidBtn = document.getElementById("rcv_void_btn");
  if (voidBtn && !voidBtn.dataset.bound) {
    voidBtn.dataset.bound = "1";
    voidBtn.onclick = function(){ return voidPostedReceipt(voidBtn); };
  }
  const postedPanel = document.getElementById("rcvPostedPanel");
  if(postedPanel && !postedPanel.dataset.bound){
    postedPanel.dataset.bound = "1";
    postedPanel.addEventListener("toggle", function(){
      if(postedPanel.open){
        renderRcvPostedReceipts_();
      }
    });
  }
  rcvInitVoidModal_();

  // 其他列表跳轉進來：自動選好來源與單號
  let prefill = null;
  try{ prefill = window.__ERP_RCV_PREFILL__ || null; }catch(_e){ prefill = null; }
  if(prefill && prefill.sourceId){
    const srcType = document.getElementById("rcv_source_type");
    const nextType = (prefill.sourceType === "IMPORT" ? "IMPORT" : "PO");
    if(srcType) srcType.value = nextType;

    // 預填跳轉：避免先載入整份 PO/報單清單（有時會因全表過大而卡住/超時）
    // 直接把來源下拉改成「單一選項」後，立刻載入明細。
    try{ rcvSourceType = nextType; }catch(_e0){}
    try{
      const label = document.getElementById("rcv_source_label");
      if(label) label.textContent = nextType === "PO" ? "選擇 PO *" : "選擇報單 *";
      const sel = document.getElementById("rcv_source_id");
      if(sel){
        const v = rcvEscOptAttr_(prefill.sourceId);
        // 預填也要顯示完整格式（PO│供應商│下單日│預計到貨 / 報單ID│報單號│供應商│放行日）
        let t = String(prefill.sourceId || "");
        try{
          if(nextType === "PO"){
            const po = await getOne("purchase_order","po_id",String(prefill.sourceId||"").trim().toUpperCase()).catch(()=>null);
            if(po) t = rcvFormatPoOptionLabel_(po);
          }else{
            const doc = await getOne("import_document","import_doc_id",String(prefill.sourceId||"").trim().toUpperCase()).catch(()=>null);
            if(doc) t = rcvFormatImportOptionLabel_(doc);
          }
        }catch(_eFmt){}
        t = rcvEscOptText_(t);
        sel.innerHTML = `<option value="${v}">${t}</option>`;
        sel.value = String(prefill.sourceId || "");
      }
      rcvSetV_("rcv_receipt_id", erpInitAutoId_("rcv_receipt_id", { gen: () => generateRcvId(), force: true }));
    }catch(_e1){}

    const srcId = document.getElementById("rcv_source_id");
    if(srcId) srcId.value = String(prefill.sourceId || "");
    await onRcvSourceSelect();

    try{ delete window.__ERP_RCV_PREFILL__; }catch(_e){}
  }else{
    await onRcvSourceTypeChange();
    resetRcvForm();
  }
  setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
  setRcvLotState_("批次狀態：未產生", "warn");
}

async function onRcvSourceTypeChange(forceRefresh) {
  const force = !!forceRefresh;
  rcvSourceType = document.getElementById("rcv_source_type")?.value || "";
  const label = document.getElementById("rcv_source_label");
  const sel = document.getElementById("rcv_source_id");
  if (!sel) return;
  const showClosed = !!document.getElementById("rcv_show_closed")?.checked;
  const normStatus_ = (raw) => {
    const s0 = String(raw || "").trim().toUpperCase();
    // 相容舊/人工資料：可能寫成 "CLOSED（已關閉）"、"OPEN (..)" 等
    const m = s0.match(/^([A-Z0-9_]+)/);
    return (m && m[1]) ? m[1] : s0;
  };

  if(!rcvSourceType){
    if(label) label.textContent = "選擇來源 *";
    sel.innerHTML = '<option value="">請先選擇來源類型</option>';
    rcvSourceId = "";
    rcvLines = [];
    renderRcvLines();
    rcvClear_("rcv_receipt_id");
    setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
    setRcvLotState_("批次狀態：未產生", "warn");
    await refreshRcvVoidReceiptOptions(force);
    setRcvPostBtnState_();
    await rcvRefreshPostedList_();
    return;
  }

  label.textContent = rcvSourceType === "PO" ? "選擇 PO *" : "選擇報單 *";
  sel.innerHTML = '<option value="">載入中…</option>';
  rcvSourceId = "";
  rcvLines = [];
  const rcvTbType = document.getElementById("rcvLinesBody");
  if (rcvTbType) setTbodyLoading_(rcvTbType, 10);
  rcvSetV_("rcv_receipt_id", erpInitAutoId_("rcv_receipt_id", { gen: () => generateRcvId(), force: true }));
  setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
  setRcvLotState_("批次狀態：未產生", "warn");

  try {
    if (rcvSourceType === "PO") {
      const pos = await getAll("purchase_order");
      const allItems = await getAll("purchase_order_item").catch(() => []);
      const itemsByPo = {};
      (allItems || []).forEach(function (it) {
        const pid = String(it && it.po_id || "").trim().toUpperCase();
        if (!pid) return;
        if (!itemsByPo[pid]) itemsByPo[pid] = [];
        itemsByPo[pid].push(it);
      });
      function poHasRemaining_(poId) {
        const pid = String(poId || "").trim().toUpperCase();
        const rows = itemsByPo[pid] || [];
        if (!rows.length) return true; // 找不到明細時不擋（避免誤判）
        return rows.some(function (x) {
          const ordered = Number(x.order_qty || 0);
          const received = Number(x.received_qty || 0);
          return ordered + 1e-9 > received;
        });
      }
      // 允許分批收貨：
      // - OPEN / PARTIAL：可再收
      // - CLOSED：預設不顯示（可勾選「顯示已收完（CLOSED）」）
      const openPOs = rcvSortSourceDocs_((pos || []).filter((p) => {
        const st = normStatus_(p && p.status);
        if (st === "CANCELLED") return false;
        if (st === "CLOSED") return !!showClosed;
        return true;
      }), "po_id");
      sel.innerHTML =
        '<option value="">請選擇 PO</option>' +
        openPOs
          .map((p) => {
            const v = rcvEscOptAttr_(p.po_id);
            const label = rcvFormatPoOptionLabel_(p);
            const t = rcvEscOptText_(label);
            return `<option value="${v}" title="${rcvEscOptAttr_(label)}">${t}</option>`;
          })
          .join("");
      if (openPOs.length === 0) sel.innerHTML = `<option value="">${showClosed ? "尚無 PO" : "尚無可收 PO（OPEN／PARTIAL）"}</option>`;
    } else {
      const docs = await getAll("import_document");
      const list = rcvSortSourceDocs_((docs || []).filter((d) => {
        const st = normStatus_(d && d.status);
        if (st === "CANCELLED") return false;
        if (!showClosed && st === "CLOSED") return false;
        return true;
      }), "import_doc_id", ["import_date", "created_at"]);
      sel.innerHTML =
        '<option value="">請選擇報單</option>' +
        list
          .map((d) => {
            const v = rcvEscOptAttr_(d.import_doc_id);
            const label = rcvFormatImportOptionLabel_(d);
            const t = rcvEscOptText_(label);
            return `<option value="${v}" title="${rcvEscOptAttr_(label)}">${t}</option>`;
          })
          .join("");
      if (list.length === 0) sel.innerHTML = `<option value="">${showClosed ? "尚無報單，請先至「進口報單」建立" : "尚無可收報單（OPEN／PARTIAL）"}</option>`;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">載入失敗</option>';
    console.error(e);
  }
  rcvSyncSourceSelectTitle_(sel);
  renderRcvLines();
  setRcvPostBtnState_();
  await refreshRcvVoidReceiptOptions(force);
  await rcvRefreshPostedList_();
}

async function onRcvSourceSelect(forceRefresh) {
  if(rcvLoadInFlight_){
    const next = document.getElementById("rcv_source_id")?.value || "";
    if(next){
      rcvPendingSourceId_ = next;
      setRcvReceiptState_(`收庫流程：載入中 — 已排隊 ${next}（完成後自動載入）`, "warn");
    }
    return;
  }
  const force = !!forceRefresh;
  rcvSourceId = document.getElementById("rcv_source_id")?.value || "";
  rcvSyncSourceSelectTitle_(document.getElementById("rcv_source_id"));
  rcvLines = [];
  const tbody = document.getElementById("rcvLinesBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if(!rcvSourceType){
    rcvClear_("rcv_receipt_id");
    setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
    setRcvLotState_("批次狀態：未產生", "warn");
    await refreshRcvVoidReceiptOptions(force);
    setRcvPostBtnState_();
    await rcvRefreshPostedList_();
    return;
  }

  if (!rcvSourceId) {
    rcvSetV_("rcv_receipt_id", generateRcvId());
    setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
    setRcvLotState_("批次狀態：未產生", "warn");
    await refreshRcvVoidReceiptOptions(force);
    setRcvPostBtnState_();
    await rcvRefreshPostedList_();
    return;
  }

  setTbodyLoading_(tbody, 9);
  rcvLoadInFlight_ = true;
  rcvSetLoadActionLock_(true);
  try{
    const id = String(rcvSourceId || "").trim().toUpperCase();
    if(typeof erpBeginLoadWarnToast_ === "function"){
      rcvLoadWarnToken_ = erpBeginLoadWarnToast_(`載入中...請稍等（${id || "收貨"}）`);
    }
  }catch(_eWarn){}

  try {
    const getAllMaybeFresh = (type) => getAll(type, force ? { refresh: true } : undefined);
    if(force && typeof invalidateCache === "function"){
      try{
        invalidateRcvCaches_(rcvSourceType);
      }catch(_eInv){}
    }
    if (rcvSourceType === "PO") {
      // 可能偶發：網路/後端短暫超時、session 過期、或 API 中斷。
      // 這裡做一次重試（refresh + 延長 timeout），避免「有時正常、有時載入失敗」。
      let allItems = null;
      let allReceipts = null;
      let allReceiptItems = null;
      try{
        [allItems, allReceipts, allReceiptItems] = await Promise.all([
          getAllMaybeFresh("purchase_order_item").catch(() => null),
          getAllMaybeFresh("goods_receipt").catch(() => null),
          getAllMaybeFresh("goods_receipt_item").catch(() => null),
        ]);
      }catch(_e0){
        allItems = null;
        allReceipts = null;
        allReceiptItems = null;
      }
      if(!allItems || !allReceipts || !allReceiptItems){
        try{
          const fetchOne = async (type) => {
            const r = await callAPI(
              { action: "list_" + type, _ts: String(Date.now()) },
              { method: "GET", timeout_ms: 120000, silent: true }
            );
            return (r && r.data) ? r.data : null;
          };
          allItems = allItems || await fetchOne("purchase_order_item").catch(() => null);
          allReceipts = allReceipts || await fetchOne("goods_receipt").catch(() => null);
          allReceiptItems = allReceiptItems || await fetchOne("goods_receipt_item").catch(() => null);
        }catch(_e1){
          allItems = null;
          allReceipts = null;
          allReceiptItems = null;
        }
      }
      if(!allItems || !allReceipts || !allReceiptItems){
        throw new Error("收貨明細載入失敗：無法取得 PO 收貨資料");
      }
      const items = (allItems || []).filter((it) => it.po_id === rcvSourceId);
      const activeReceiptIds = new Set(
        (allReceipts || [])
          .filter((r) => r.po_id === rcvSourceId && String(r.status || "").toUpperCase() !== "CANCELLED")
          .map((r) => String(r.goods_receipt_id || ""))
          .filter(Boolean)
      );
      const receivedByPoItemId = {};
      (allReceiptItems || []).forEach((ri) => {
        const rid = String(ri.goods_receipt_id || "");
        if (!activeReceiptIds.has(rid)) return;
        const itemId = String(ri.po_item_id || "");
        if (!itemId) return;
        receivedByPoItemId[itemId] = (receivedByPoItemId[itemId] || 0) + Number(ri.received_qty || 0);
      });
      items.sort((a, b) => {
        const ca = String(a.created_at || "");
        const cb = String(b.created_at || "");
        if (ca && cb && ca !== cb) return ca.localeCompare(cb);
        return String(a.po_item_id || "").localeCompare(String(b.po_item_id || ""));
      });
      rcvLines = items.map((it, idx) => {
        const orderQty = Number(it.order_qty || 0);
        const poItemId = String(it.po_item_id || "");
        const received = Number(receivedByPoItemId[poItemId] != null ? receivedByPoItemId[poItemId] : (it.received_qty || 0));
        const remaining = Math.max(0, orderQty - received);
        return {
          item_no: idx + 1,
          product_id: it.product_id || "",
          order_qty: orderQty,
          received_qty: received,
          remaining,
          unit: it.unit || "",
          po_id: rcvSourceId,
          po_item_id: it.po_item_id,
        };
      });
    } else {
      // IMPORT：同上，做容錯重試（避免偶發全表/快取卡住造成載入失敗）
      let [importItems, importReceipts, receiptItems] = await Promise.all([
        getAllMaybeFresh("import_item").catch(() => null),
        getAllMaybeFresh("import_receipt").catch(() => null),
        getAllMaybeFresh("import_receipt_item").catch(() => null),
      ]);
      if(!importItems || !importReceipts || !receiptItems){
        // 只對缺的補抓一次（延長 timeout，並避開快取）
        const need = {
          import_item: !importItems,
          import_receipt: !importReceipts,
          import_receipt_item: !receiptItems
        };
        const fetchOne = async (type) => {
          const action = "list_" + type;
          const r = await callAPI({ action: action, _ts: String(Date.now()) }, { method: "GET", timeout_ms: 120000, silent: true });
          return (r && r.data) ? r.data : [];
        };
        importItems = need.import_item ? await fetchOne("import_item") : importItems;
        importReceipts = need.import_receipt ? await fetchOne("import_receipt") : importReceipts;
        receiptItems = need.import_receipt_item ? await fetchOne("import_receipt_item") : receiptItems;
      }
      const items = (importItems || []).filter((it) => it.import_doc_id === rcvSourceId);
      items.sort((a, b) => {
        const ca = String(a.created_at || "");
        const cb = String(b.created_at || "");
        if (ca && cb && ca !== cb) return ca.localeCompare(cb);
        return String(a.import_item_id || "").localeCompare(String(b.import_item_id || ""));
      });
      const receiptIds = (importReceipts || [])
        .filter(
          (r) =>
            r.import_doc_id === rcvSourceId && String(r.status || "").toUpperCase() !== "CANCELLED"
        )
        .map((r) => r.import_receipt_id);
      const receivedByItemId = {};
      (receiptItems || []).forEach((iri) => {
        if (receiptIds.includes(iri.import_receipt_id)) {
          const k = iri.import_item_id || iri.product_id;
          receivedByItemId[k] = (receivedByItemId[k] || 0) + Number(iri.received_qty || 0);
        }
      });
      rcvLines = items.map((it, idx) => {
        const orderQty = Number(it.declared_qty || 0);
        const received = receivedByItemId[it.import_item_id] || 0;
        const remaining = Math.max(0, orderQty - received);
        return {
          /* 進口：優先報單上的項次（item_no），無則依排序為 1,2,3；過帳仍用 import_item_id */
          item_no: it.item_no != null ? it.item_no : idx + 1,
          product_id: it.product_id || "",
          order_qty: orderQty,
          received_qty: received,
          remaining,
          unit: it.declared_unit || it.unit || "",
          import_doc_id: rcvSourceId,
          import_item_id: it.import_item_id,
        };
      });
    }

    renderRcvLines();
    rcvSetV_("rcv_receipt_id", generateRcvId());
    setRcvReceiptState_(`收庫流程：已載入 — 明細 ${rcvLines.length} 筆`, "ok");
    setRcvLotState_("批次狀態：未產生", "warn");
  } catch (e) {
    console.error(e);
    try{
      // 讓使用者看到真正原因（session/權限/連線/超時）
      const msg = (typeof formatCallApiUserMessage_ === "function") ? formatCallApiUserMessage_(e) : (e && e.message ? e.message : String(e || ""));
      if(typeof showToast === "function") showToast(msg, "error");
    }catch(_eToast){}
    rcvLines = [];
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#991b1b;padding:18px;">收貨明細載入失敗</td></tr>`;
    setRcvReceiptState_("收庫流程：明細載入失敗", "error");
  } finally {
    try{
      if(typeof erpEndLoadWarnToast_ === "function"){
        erpEndLoadWarnToast_(rcvLoadWarnToken_);
      }
      rcvLoadWarnToken_ = "";
    }catch(_eWarnEnd){}
    rcvLoadInFlight_ = false;
    rcvSetLoadActionLock_(false);
    setRcvPostBtnState_();
    // 若載入期間又選了其他來源，完成後自動載入最後一次選擇
    try{
      const nextId = String(rcvPendingSourceId_ || "").trim();
      rcvPendingSourceId_ = "";
      if(nextId && nextId !== rcvSourceId){
        const sel = document.getElementById("rcv_source_id");
        if(sel) sel.value = nextId;
        setTimeout(function(){
          try{ onRcvSourceSelect(true); }catch(_e){}
        }, 0);
      }
    }catch(_eNext){}
  }
  await refreshRcvVoidReceiptOptions(false);
  await rcvRefreshPostedList_();
}

function rcvSumMovementQtyForLot_(movements, lotId) {
  return (movements || [])
    .filter((m) => m.lot_id === lotId)
    .reduce((sum, m) => sum + Number(m.qty || 0), 0);
}

/**
 * 優先用後端彙總 map；無 key = 缺 movement（null）
 * 彙總失敗則退回 movements 加總；完全無列亦為 null
 */
function rcvNetQtyForLot_(movements, lotId, availMap, availOk) {
  const id = String(lotId || "");
  if (!id) return null;
  if (availOk && availMap) {
    if (!Object.prototype.hasOwnProperty.call(availMap, id)) return null;
    return Number(availMap[id] || 0);
  }
  const rows = (movements || []).filter((m) => m.lot_id === id);
  if (!rows.length) return null;
  return rcvSumMovementQtyForLot_(movements, id);
}

/** 作廢原因（原因碼 + 畫面標籤）；OTHER 須填補充說明 */
const RCV_VOID_REASONS = [
  { code: "WRONG_GOODS", label: "收錯貨／退貨" },
  { code: "WRONG_QTY", label: "收貨數量錯誤（已產生 Lot）" },
  { code: "WRONG_SOURCE", label: "來源單據選錯（PO／報單）" },
  { code: "DUPLICATE", label: "重複收貨" },
  { code: "WRONG_MASTER", label: "倉別／日期／效期等主檔錯誤" },
  { code: "SOURCE_CHANGE", label: "來源單取消或變更須回滾" },
  { code: "TEST", label: "測試或誤建單據" },
  { code: "OTHER", label: "其他（請填寫補充說明）" },
];

function rcvBuildVoidAuditLine_(voidCtx) {
  if (!voidCtx) return "";
  const note = String(voidCtx.reasonNote || "").trim();
  let s = `原因：${voidCtx.reasonLabel || voidCtx.reasonCode || ""}`;
  if (note) s += `；說明：${note}`;
  return s;
}

function rcvFormatVoidRemarkForReceipt_(voidCtx) {
  if (!voidCtx) return "";
  const u = typeof getCurrentUser === "function" ? getCurrentUser() : "";
  const t = typeof nowIso16 === "function" ? nowIso16() : "";
  return `[作廢 ${t}${u ? " " + u : ""}] ${rcvBuildVoidAuditLine_(voidCtx)}`;
}

/** 預檢：可否整張作廢（與 cancel* 邏輯一致） */
function rcvVoidEligibilityForGr_(gr_id, grRow, po_id_expected, griAll, movements, availOpts) {
  const av = availOpts || {};
  const availMap = av.availMap;
  const availOk = !!av.availOk;
  if (!grRow) return { ok: false, reason: "找不到收貨單" };
  if (String(grRow.status || "").toUpperCase() === "CANCELLED") return { ok: false, reason: "此收貨單已作廢" };
  if (String(grRow.po_id || "") !== String(po_id_expected || "")) return { ok: false, reason: "與目前選擇的 PO 不符" };
  const items = (griAll || []).filter((x) => String(x.gr_id || "") === String(gr_id));
  if (items.length === 0) return { ok: false, reason: "無收貨明細，無法作廢" };
  const dup = (movements || []).some(
    (m) => String(m.ref_type || "") === "GOODS_RECEIPT_CANCEL" && String(m.ref_id || "") === String(gr_id)
  );
  if (dup) return { ok: false, reason: "已有作廢沖銷紀錄" };
  for (const it of items) {
    const lotId = it.lot_id || "";
    const inMv = (movements || []).find(
      (m) =>
        m.lot_id === lotId &&
        String(m.movement_type || "").toUpperCase() === "IN" &&
        String(m.ref_type || "").toUpperCase() === "GOODS_RECEIPT" &&
        String(m.ref_id || "") === String(gr_id)
    );
    if (!inMv) return { ok: false, reason: `批號 ${lotId}：找不到對應入庫異動，無法作廢` };
    const inQty = Math.abs(Number(inMv.qty || 0));
    const net = rcvNetQtyForLot_(movements, lotId, availMap, availOk);
    if (net === null) return { ok: false, reason: `批號 ${lotId}：缺 inventory movement，無法作廢` };
    if (net + 1e-9 < inQty) return { ok: false, reason: `可用量不足（批號 ${lotId}）` };
  }
  return { ok: true, reason: "" };
}

function rcvVoidEligibilityForIr_(import_receipt_id, irRow, doc_id_expected, iriAll, movements, availOpts) {
  const av = availOpts || {};
  const availMap = av.availMap;
  const availOk = !!av.availOk;
  if (!irRow) return { ok: false, reason: "找不到進口收貨單" };
  if (String(irRow.status || "").toUpperCase() === "CANCELLED") return { ok: false, reason: "此收貨單已作廢" };
  if (String(irRow.import_doc_id || "") !== String(doc_id_expected || "")) {
    return { ok: false, reason: "與目前選擇的報單不符" };
  }
  const items = (iriAll || []).filter((x) => String(x.import_receipt_id || "") === String(import_receipt_id));
  if (items.length === 0) return { ok: false, reason: "無收貨明細，無法作廢" };
  const dup = (movements || []).some(
    (m) =>
      String(m.ref_type || "") === "IMPORT_RECEIPT_CANCEL" && String(m.ref_id || "") === String(import_receipt_id)
  );
  if (dup) return { ok: false, reason: "已有作廢沖銷紀錄" };
  for (const it of items) {
    const lotId = it.lot_id || "";
    const inMv = (movements || []).find(
      (m) =>
        m.lot_id === lotId &&
        String(m.movement_type || "").toUpperCase() === "IN" &&
        String(m.ref_type || "").toUpperCase() === "IMPORT_RECEIPT" &&
        String(m.ref_id || "") === String(import_receipt_id)
    );
    if (!inMv) return { ok: false, reason: `批號 ${lotId}：找不到對應入庫異動，無法作廢` };
    const inQty = Math.abs(Number(inMv.qty || 0));
    const net = rcvNetQtyForLot_(movements, lotId, availMap, availOk);
    if (net === null) return { ok: false, reason: `批號 ${lotId}：缺 inventory movement，無法作廢` };
    if (net + 1e-9 < inQty) return { ok: false, reason: `可用量不足（批號 ${lotId}）` };
  }
  return { ok: true, reason: "" };
}

async function refreshRcvVoidReceiptOptions(forceRefresh) {
  const sel = document.getElementById("rcv_void_receipt_id");
  if (!sel) return;
  if (!rcvSourceId) {
    sel.innerHTML = '<option value="">請先選擇 PO／報單</option>';
    return;
  }
  const force = !!forceRefresh;
  try {
    if (rcvSourceType === "PO") {
      const all = await getAll("goods_receipt", force ? { refresh: true } : undefined).catch(() => []);
      const rows = rcvSortReceiptRows_(
        (all || []).filter(
          (r) => r.po_id === rcvSourceId && String(r.status || "").toUpperCase() !== "CANCELLED"
        ),
        "gr_id"
      );
      sel.innerHTML =
        '<option value="">請選擇要作廢的採購收貨單（GR）</option>' +
        rows.map((r) => `<option value="${r.gr_id}">${r.gr_id} — ${r.receipt_date || ""}</option>`).join("");
    } else {
      const all = await getAll("import_receipt", force ? { refresh: true } : undefined).catch(() => []);
      const rows = rcvSortReceiptRows_(
        (all || []).filter(
          (r) =>
            r.import_doc_id === rcvSourceId && String(r.status || "").toUpperCase() !== "CANCELLED"
        ),
        "import_receipt_id"
      );
      sel.innerHTML =
        '<option value="">請選擇要作廢的進口收貨單（IR）</option>' +
        rows
          .map((r) => `<option value="${r.import_receipt_id}">${r.import_receipt_id} — ${r.receipt_date || ""}</option>`)
          .join("");
    }
  } catch (e) {
    sel.innerHTML = '<option value="">載入收貨單列表失敗</option>';
    console.error(e);
  }
}

function rcvBindQtyIntInput_(el, maxVal) {
  if (!el) return;
  const max = Math.max(0, Math.floor(Number(maxVal || 0)));
  const clamp = function () {
    let raw = String(el.value || "").replace(/\D/g, "");
    if (!raw) {
      el.value = "";
      return;
    }
    let n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (max > 0 && n > max) n = max;
    el.value = String(n);
  };
  el.addEventListener("input", function () {
    clamp();
    setRcvPostBtnState_();
  });
  el.addEventListener("change", clamp);
}

function renderRcvLines() {
  const tbody = document.getElementById("rcvLinesBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const whIdDefault = "";
  const whOptHtml = (function(){
    const rows = Array.isArray(rcvWarehouses) ? rcvWarehouses : [];
    if(!rows.length) return '<option value="">尚無倉庫</option>';
    const sorted = rows.slice().sort((a,b)=>String(a.warehouse_id||"").localeCompare(String(b.warehouse_id||"")));
    return '<option value="">請選擇</option>' + sorted.map(function(w){
      const id = String(w.warehouse_id || "").trim().toUpperCase();
      const label = rcvWarehouseLabelById_(id);
      return `<option value="${rcvEscOptAttr_(id)}">${rcvEscOptText_(label)}</option>`;
    }).join("");
  })();
  rcvLines.forEach((row, idx) => {
    const orderLabel = rcvSourceType === "PO" ? "訂購數量" : "申報數量";
    const canReceive = Number(row.remaining || 0) > 0;
    const maxVal = canReceive ? row.remaining : 0;
    const placeholder = canReceive ? "0" : "剩餘=0";
    const disabledAttr = canReceive ? "" : 'disabled value="0"';
    const ru = String(row.unit || "").trim().replace(/</g, "");
    // 每列倉別：若尚未指定，預設 MAIN（若不存在 MAIN，則留空讓使用者選）
    const hasMain = (Array.isArray(rcvWarehouses) ? rcvWarehouses : []).some(w => String(w?.warehouse_id || "").trim().toUpperCase() === "MAIN");
    const whRow = String(row.warehouse_id || (hasMain ? "MAIN" : "") || whIdDefault || "").trim().toUpperCase();
    try{ row.warehouse_id = whRow; }catch(_e){}
    const qtyCell = ru
      ? `${row.order_qty}<span class="rcv-qty-unit">${ru}</span>`
      : String(row.order_qty);
    tbody.innerHTML += `
      <tr>
        <td class="col-rcv-item-no" title="${String(row.item_no ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${row.item_no}</td>
        <td>${formatRcvProductDisplay_(row.product_id)}</td>
        <td class="col-rcv-order-qty">${qtyCell}</td>
        <td class="col-rcv-num">${row.received_qty}</td>
        <td class="col-rcv-num">${row.remaining}</td>
        <td class="col-rcv-qty-cell"><input type="text" class="rcv-qty-int" id="rcv_qty_${idx}" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="${placeholder}" ${disabledAttr}></td>
        <td>
          <select id="rcv_wh_${idx}" class="rcv-line-wh" ${canReceive ? "" : "disabled"}>
            ${whOptHtml}
          </select>
        </td>
        <td><input type="text" class="rcv-input-factory-lot" id="rcv_factory_lot_${idx}" placeholder="選填" ${canReceive ? "" : "disabled"}></td>
        <td><input type="date" class="rcv-input-date" id="rcv_mfg_${idx}" ${canReceive ? "" : "disabled"}></td>
        <td><input type="date" class="rcv-input-date" id="rcv_exp_${idx}" ${canReceive ? "" : "disabled"}></td>
      </tr>
    `;
  });

  // 綁定輸入事件：即時更新「產生批次」按鈕狀態/提示
  rcvLines.forEach((row, idx) => {
    const q = document.getElementById(`rcv_qty_${idx}`);
    if (q) {
      const canReceive = Number(row.remaining || 0) > 0;
      rcvBindQtyIntInput_(q, canReceive ? row.remaining : 0);
    }
    const wh = document.getElementById(`rcv_wh_${idx}`);
    if(wh){
      // 先回填目前值（避免 innerHTML 覆蓋後失去 selected）
      try{ wh.value = String(row.warehouse_id || whIdDefault || "").trim().toUpperCase(); }catch(_e0){}
      wh.onchange = function(){
        try{ row.warehouse_id = String(wh.value || "").trim().toUpperCase(); }catch(_e1){}
      };
    }
  });
  setRcvPostBtnState_();
}

function getRcvInputQtys() {
  return rcvLines.map((_, idx) => {
    const el = document.getElementById(`rcv_qty_${idx}`);
    const raw = String(el?.value || "").trim();
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function getRcvLineWarehouses(){
  return rcvLines.map((row, idx) => {
    const el = document.getElementById(`rcv_wh_${idx}`);
    const v = String((el && el.value) || row.warehouse_id || "").trim().toUpperCase();
    return v;
  });
}

function getRcvLotDates() {
  return rcvLines.map((_, idx) => {
    const mfg = (document.getElementById(`rcv_mfg_${idx}`)?.value || "").trim();
    const exp = (document.getElementById(`rcv_exp_${idx}`)?.value || "").trim();
    const factoryLot = (document.getElementById(`rcv_factory_lot_${idx}`)?.value || "").trim().toUpperCase();
    return { manufacture_date: mfg, expiry_date: exp, factory_lot: factoryLot };
  });
}

function resetRcvForm() {
  rcvLines = [];
  renderRcvLines();
  rcvSetV_("rcv_receipt_id", erpInitAutoId_("rcv_receipt_id", { gen: () => generateRcvId(), force: true }));
  const dateEl = document.getElementById("rcv_receipt_date");
  if (dateEl) dateEl.value = nowIso16();
  rcvInitWarehouseDropdown_().catch(()=>{});
  rcvClear_(["rcv_remark", "rcv_source_id"]);
  rcvSourceId = "";
  refreshRcvVoidReceiptOptions(false).catch(() => {});
  setRcvReceiptState_("收庫流程：未載入 — 請先選擇來源類型與單號", "warn");
  setRcvPostBtnState_();
}

function openRcvLog() {
  const id = document.getElementById("rcv_receipt_id")?.value || "";
  const type = rcvSourceType === "PO" ? "goods_receipt" : "import_receipt";
  if (typeof openLogs === "function") openLogs(type, id, "inbound");
}

function rcvIsSourceChangedError_(err){
  const msg = String(err && err.message != null ? err.message : err || "");
  const backendErrors = err && Array.isArray(err.backendErrors) ? err.backendErrors : [];
  const full = (msg + " " + backendErrors.join(" ")).toLowerCase();
  return (
    /(po|import)\s+source\s+changed/.test(full) ||
    /please\s+reload\s+and\s+try\s+again/.test(full) ||
    /來源.*(已被更新|已更新)|請重新載入再試/.test(full)
  );
}

function rcvShouldAutoReloadAfterError_(err){
  if (rcvIsSourceChangedError_(err)) return true;
  const code = String(err && err.erpErrorCode || "").trim().toUpperCase();
  if(code === "ERR_SOURCE_CHANGED" || code === "ERR_DUPLICATE_REQUEST" || code === "ERR_ALREADY_PROCESSED") return true;
  const msg = String(err && err.message != null ? err.message : err || "");
  const backendErrors = err && Array.isArray(err.backendErrors) ? err.backendErrors : [];
  const full = (msg + " " + backendErrors.join(" ")).toLowerCase();
  return (
    /duplicate\s+request\s+detected/.test(full) ||
    /already\s+(cancelled|canceled|posted)/.test(full) ||
    /狀態.*(已作廢|已過帳|不可重做)/.test(full) ||
    /此單據已被處理|狀態已變更/.test(full)
  );
}

function invalidateRcvCaches_(sourceType){
  try{
    if(typeof invalidateCache !== "function") return;
    // 收貨本體
    invalidateCache("goods_receipt");
    invalidateCache("goods_receipt_item");
    invalidateCache("import_receipt");
    invalidateCache("import_receipt_item");
    // 來源本體
    const st = String(sourceType || rcvSourceType || "").toUpperCase();
    if(st === "PO"){
      invalidateCache("purchase_order");
      invalidateCache("purchase_order_item");
    }else if(st){
      invalidateCache("import_document");
      invalidateCache("import_item");
    }
    // 庫存關聯
    invalidateCache("lot");
    invalidateCache("inventory_movement");
  }catch(_e){}
}

function rcvBuildIdempotencyKey_(scope, payload){
  const raw = String(scope || "") + "|" + String(payload || "");
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return "IDEM-" + String(scope || "RCV") + "-" + String(Math.abs(h)).toUpperCase();
}

async function rcvAutoReloadAfterSourceChanged_(){
  try{
    // 避免網路不穩/後端短暫錯誤造成重載迴圈：同來源短時間最多自動重載 2 次
    try{
      const id = String(rcvSourceType || "") + ":" + String(rcvSourceId || "").trim().toUpperCase();
      const key = id || "(unknown)";
      const now = Date.now();
      const w = (typeof window !== "undefined" && window) ? window : {};
      if(!w.__erpAutoReloadGuardRcv__) w.__erpAutoReloadGuardRcv__ = {};
      const g = w.__erpAutoReloadGuardRcv__;
      const prev = g[key] || { at: 0, n: 0 };
      const withinMs = 15000;
      const n = (now - prev.at) < withinMs ? (prev.n + 1) : 1;
      g[key] = { at: now, n };
      if(n > 2){
        showToast("自動重新載入次數過多，請手動重新載入後再送出", "error");
        return false;
      }
    }catch(_eGuard){}
    showToast("來源資料已更新，系統正在為你重新載入…", "warn", 6000);
    await onRcvSourceSelect(true);
    await refreshRcvVoidReceiptOptions(true);
    try{
      const pp = document.getElementById("rcvPostedPanel");
      if (pp && pp.open) await renderRcvPostedReceipts_();
    }catch(_ePanel){}
    showToast("已重新載入最新資料，請確認後再送出", "warn", 6000);
    return true;
  }catch(_eReload){
    showToast("自動重新載入失敗，請手動重新載入後再送出", "error");
    return false;
  }
}

async function postReceipt(triggerEl) {
  if(rcvLoadInFlight_){
    return showToast("來源載入中，請稍候…", "error");
  }
  if(rcvPostInFlight_){
    return showToast("收貨過帳處理中，請稍候…", "error");
  }
  const receiptId = (document.getElementById("rcv_receipt_id")?.value || "").trim().toUpperCase();
  const receiptDate = document.getElementById("rcv_receipt_date")?.value || "";
  const remark = (document.getElementById("rcv_remark")?.value || "").trim();

  const missing = [];
  if (!rcvSourceType) missing.push("來源類型");
  if (!receiptId) missing.push("收貨單ID");
  if (!rcvSourceId) missing.push(rcvSourceType === "PO" ? "PO" : "進口報單");
  if (!receiptDate) missing.push("收貨日期");
  if (missing.length) return showToast("缺少必填：" + missing.join("、"), "error");

  const qtys = getRcvInputQtys();
  const lineWhs = getRcvLineWarehouses();
  const lotDates = getRcvLotDates();
  const hasQty = qtys.some((q) => q > 0);
  if (!hasQty) return showToast("請至少輸入一筆本次收貨", "error");

  // 倉別規則：有填數量的列必須選倉別，且同一張收貨單僅支援一個倉別（不同倉別請分開收貨）
  let warehouse = "";
  try{
    const used = {};
    for(let i=0;i<qtys.length;i++){
      if(!(Number(qtys[i] || 0) > 0)) continue;
      const w = String(lineWhs[i] || "").trim().toUpperCase();
      if(!w) return showToast("有填本次收貨的明細列必須選倉別", "error");
      used[w] = true;
    }
    const uniq = Object.keys(used);
    if(uniq.length > 1){
      return showToast("本次收貨明細包含多個倉別，請分開收貨（一次收貨單僅支援一個倉別）","error");
    }
    warehouse = uniq[0] || "";
  }catch(_eWhGuard){}
  if(!warehouse) return showToast("請先在本次收貨明細選擇倉別", "error");

  for(let i = 0; i < qtys.length; i++){
    if((qtys[i] || 0) <= 0) continue;
    const d = lotDates[i] || {};
    const mfg = d.manufacture_date || "";
    const exp = d.expiry_date || "";
    if(mfg && exp && exp < mfg){
      return showToast(`第 ${i + 1} 筆：有效期不可早於製造日`, "error");
    }
  }

  rcvPostInFlight_ = true;
  showSaveHint(triggerEl);
  try {
    const created =
      rcvSourceType === "PO"
        ? await postGoodsReceiptUnified(receiptId, receiptDate, warehouse, remark, qtys, lotDates)
        : await postImportReceiptUnified(receiptId, receiptDate, warehouse, remark, qtys, lotDates);

    // 只有真的有產生 Lot 才自動跳到 Lots（避免「未產生 Lot」卻導頁造成誤解）
    if (Number(created || 0) > 0) {
      try{
        window.__ERP_PREFILL_LOTS_KEYWORD__ = receiptId;
      }catch(_e){}
      if(typeof navigate === "function") navigate("lots");
    }
  } catch(err){
    if (rcvIsSourceChangedError_(err)) {
      await rcvAutoReloadAfterSourceChanged_();
      return;
    }
    if(!(err && err.erpApiToastShown)){
      showToast("收貨失敗：請稍後重試；若仍失敗請重新載入後再試", "error");
    }
  } finally {
    rcvPostInFlight_ = false;
    hideSaveHint();
  }
}

async function postGoodsReceiptUnified(gr_id, receipt_date, warehouse, remark, qtys, lotDates) {
  const po_id = rcvSourceId;
  const lines = [];
  const expectedReceivedByPoItem = {};
  for (let idx = 0; idx < rcvLines.length; idx++) {
    const row = rcvLines[idx];
    if(row && row.po_item_id){
      expectedReceivedByPoItem[String(row.po_item_id)] = Number(row.received_qty || 0);
    }
    const qty = qtys[idx] || 0;
    if (qty <= 0) continue;
    const dates = lotDates?.[idx] || {};
    lines.push({
      po_item_id: row.po_item_id,
      received_qty: String(qty),
      unit: row.unit,
      manufacture_date: dates.manufacture_date || "",
      expiry_date: dates.expiry_date || "",
      factory_lot: dates.factory_lot || ""
    });
  }
  const res = await callAPI({
    action: "post_goods_receipt_bundle",
    gr_id,
    po_id,
    receipt_date,
    warehouse,
    remark,
    idempotency_key: rcvBuildIdempotencyKey_("GR", [gr_id, po_id, receipt_date, warehouse, lines]),
    expected_received_by_po_item_json: JSON.stringify(expectedReceivedByPoItem),
    expected_existed_goods_receipt_item_count: "0",
    lines_json: JSON.stringify(lines),
    created_by: getCurrentUser(),
    created_at: nowIsoTaipei()
  }, { method: "POST" });

  // 建立批次後：立即清掉相關快取，避免列表仍顯示舊的已收/剩餘
  try{
    invalidateRcvCaches_("PO");
  }catch(_eCache){}

  const createdRaw = (res && res.created_lots != null) ? res.created_lots : (res && res.data && res.data.created_lots != null ? res.data.created_lots : 0);
  const created =
    Array.isArray(createdRaw) ? createdRaw.length : Number(createdRaw || 0);
  const poMsg = created === 0
    ? "本次沒有可收數量，未產生 Lot。"
    : `收貨完成：已產生 ${created} 個 Lot（待QA）`;
  showToast(poMsg);
  setRcvLotState_(created === 0 ? "批次狀態：未產生" : `批次狀態：已產生 — ${created} 個（待QA）`, created === 0 ? "warn" : "ok");
  resetRcvForm();
  await onRcvSourceTypeChange();
  return created;
}

async function postImportReceiptUnified(import_receipt_id, receipt_date, warehouse, remark, qtys, lotDates) {
  const import_doc_id = rcvSourceId;
  const lines = [];
  const expectedReceivedByImportItem = {};
  for (let idx = 0; idx < rcvLines.length; idx++) {
    const row = rcvLines[idx];
    if(row && row.import_item_id){
      expectedReceivedByImportItem[String(row.import_item_id)] = Number(row.received_qty || 0);
    }
    const qty = qtys[idx] || 0;
    if (qty <= 0) continue;
    const dates = lotDates?.[idx] || {};
    lines.push({
      import_item_id: row.import_item_id || "",
      received_qty: String(qty),
      unit: row.unit,
      manufacture_date: dates.manufacture_date || "",
      expiry_date: dates.expiry_date || "",
      factory_lot: dates.factory_lot || ""
    });
  }
  const res = await callAPI({
    action: "post_import_receipt_bundle",
    import_receipt_id,
    import_doc_id,
    receipt_date,
    warehouse,
    remark,
    idempotency_key: rcvBuildIdempotencyKey_("IR", [import_receipt_id, import_doc_id, receipt_date, warehouse, lines]),
    expected_received_by_import_item_json: JSON.stringify(expectedReceivedByImportItem),
    expected_existed_import_receipt_item_count: "0",
    lines_json: JSON.stringify(lines),
    created_by: getCurrentUser(),
    created_at: nowIsoTaipei()
  }, { method: "POST" });

  // 建立批次後：立即清掉相關快取，避免列表仍顯示舊的已收/剩餘
  try{
    invalidateRcvCaches_("IMPORT");
  }catch(_eCache){}

  const createdRaw = (res && res.created_lots != null) ? res.created_lots : (res && res.data && res.data.created_lots != null ? res.data.created_lots : 0);
  const created =
    Array.isArray(createdRaw) ? createdRaw.length : Number(createdRaw || 0);
  const irMsg = created === 0
    ? "本次沒有可收數量，未產生 Lot。"
    : `進口收貨完成：已產生 ${created} 個 Lot（待QA）`;
  showToast(irMsg);
  resetRcvForm();
  await onRcvSourceTypeChange();
  return created;
}

function voidPostedReceiptFromListBtn(triggerEl) {
  if (!triggerEl || triggerEl.disabled) return;
  const rid = (triggerEl.getAttribute("data-rcv-receipt-id") || "").trim();
  if (!rid) return showToast("請選擇要作廢的收貨單", "error");
  rcvOpenVoidModal_(rid);
}

function rcvCloseVoidModal() {
  const modal = document.getElementById("rcvVoidModal");
  if (!modal) return;
  modal.classList.remove("rcv-void-modal-open");
  delete modal.dataset.rcvReceiptId;
  rcvClear_(["rcv_void_reason_note","rcv_void_reason_code"]);
}

function rcvOpenVoidModal_(receiptId) {
  const id = String(receiptId || "").trim();
  if (!id) return showToast("請選擇要作廢的收貨單", "error");
  if (!rcvSourceId) return showToast("請先選擇 PO 或進口報單", "error");
  const modal = document.getElementById("rcvVoidModal");
  const label = document.getElementById("rcvVoidModalReceiptLabel");
  const note = document.getElementById("rcv_void_reason_note");
  const code = document.getElementById("rcv_void_reason_code");
  if (!modal || !label) return;
  modal.dataset.rcvReceiptId = id;
  label.textContent =
    rcvSourceType === "PO"
      ? `採購收貨單（GR）：${id}`
      : `進口收貨單（IR）：${id}`;
  rcvClear_(["rcv_void_reason_note","rcv_void_reason_code"]);
  modal.classList.add("rcv-void-modal-open");
}

function rcvInitVoidModal_() {
  const sel = document.getElementById("rcv_void_reason_code");
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = "1";
    sel.innerHTML =
      '<option value="">請選擇</option>' +
      RCV_VOID_REASONS.map(
        (r) =>
          `<option value="${rcvEscOptAttr_(r.code)}">${rcvEscOptText_(r.label)}</option>`
      ).join("");
  }
  const conf = document.getElementById("rcv_void_modal_confirm");
  if (conf && !conf.dataset.bound) {
    conf.dataset.bound = "1";
    conf.onclick = function () {
      rcvConfirmVoidModal_();
    };
  }
}

async function rcvConfirmVoidModal_() {
  const modal = document.getElementById("rcvVoidModal");
  const receiptId = (modal && modal.dataset.rcvReceiptId) || "";
  if (!receiptId.trim()) return showToast("缺少收貨單 ID", "error");
  const codeEl = document.getElementById("rcv_void_reason_code");
  const noteEl = document.getElementById("rcv_void_reason_note");
  const code = (codeEl && codeEl.value) || "";
  const note = (noteEl && noteEl.value) || "";
  if (!code) return showToast("請選擇作廢原因", "error");
  if (code === "OTHER" && !String(note).trim()) {
    return showToast("選擇「其他」請填寫補充說明", "error");
  }
  const meta = RCV_VOID_REASONS.find((x) => x.code === code);
  const reasonLabel = meta ? meta.label : code;
  const voidCtx = {
    reasonCode: code,
    reasonLabel,
    reasonNote: String(note).trim(),
  };
  const triggerEl = document.getElementById("rcv_void_modal_confirm");
  rcvCloseVoidModal();
  if (rcvSourceType === "PO") {
    await cancelGoodsReceiptUnified(receiptId, triggerEl, voidCtx);
  } else {
    await cancelImportReceiptUnified(receiptId, triggerEl, voidCtx);
  }
}

async function voidPostedReceipt(triggerEl, explicitReceiptId) {
  if(rcvLoadInFlight_){
    return showToast("來源載入中，請稍候…", "error");
  }
  let receiptId = String(explicitReceiptId || "").trim();
  if (!receiptId) {
    receiptId = (document.getElementById("rcv_void_receipt_id")?.value || "").trim();
  }
  if (!receiptId) return showToast("請選擇要作廢的收貨單", "error");
  if (!rcvSourceId) return showToast("請先選擇 PO 或進口報單", "error");
  rcvOpenVoidModal_(receiptId);
}

/**
 * 作廢採購收貨：ADJUST 沖銷原 IN、Lot→VOID／QA REJECTED、goods_receipt→CANCELLED、回退 PO 已收。
 * 僅當各 Lot 之 movements 加總仍 ≥ 該筆入庫量（未被下游扣用）時允許。
 */
async function cancelGoodsReceiptUnified(gr_id, triggerEl, voidCtx) {
  if(rcvCancelInFlight_){
    return showToast("作廢處理中，請稍候…", "error");
  }
  rcvCancelInFlight_ = true;
  showSaveHint(triggerEl);
  try{
    showToast("作廢處理中，正在更新資料…", "warn", 6000);
    await callAPI({
      action: "cancel_goods_receipt_bundle",
      gr_id: gr_id,
      idempotency_key: rcvBuildIdempotencyKey_("CANCEL_GR", [gr_id, voidCtx?.reasonCode || "", voidCtx?.reasonLabel || "", voidCtx?.reasonNote || ""]),
      void_reason_code: voidCtx?.reasonCode || "",
      void_reason_label: voidCtx?.reasonLabel || "",
      void_reason_note: voidCtx?.reasonNote || "",
      updated_by: getCurrentUser()
    }, { method: "POST" });
    showToast("作廢完成：這筆收貨已取消，畫面資料已同步更新", "success", 6000);
    await onRcvSourceSelect(true);
    await refreshRcvVoidReceiptOptions(true);
    const ppGr = document.getElementById("rcvPostedPanel");
    if (ppGr && ppGr.open) await renderRcvPostedReceipts_();
  } catch(err){
    if (rcvShouldAutoReloadAfterError_(err)) {
      await rcvAutoReloadAfterSourceChanged_();
      return;
    }
    if(!(err && err.erpApiToastShown)){
      showToast("作廢失敗：請稍後重試；若仍失敗請重新載入後再試", "error");
    }
  } finally {
    rcvCancelInFlight_ = false;
    hideSaveHint();
  }
}

/**
 * 作廢進口收貨：同上，但不涉及 PO（進口已收由 import_receipt_item 匯總）。
 */
async function cancelImportReceiptUnified(import_receipt_id, triggerEl, voidCtx) {
  if(rcvCancelInFlight_){
    return showToast("作廢處理中，請稍候…", "error");
  }
  rcvCancelInFlight_ = true;
  showSaveHint(triggerEl);
  try{
    showToast("作廢處理中，正在更新資料…", "warn", 6000);
    await callAPI({
      action: "cancel_import_receipt_bundle",
      import_receipt_id: import_receipt_id,
      idempotency_key: rcvBuildIdempotencyKey_("CANCEL_IR", [import_receipt_id, voidCtx?.reasonCode || "", voidCtx?.reasonLabel || "", voidCtx?.reasonNote || ""]),
      void_reason_code: voidCtx?.reasonCode || "",
      void_reason_label: voidCtx?.reasonLabel || "",
      void_reason_note: voidCtx?.reasonNote || "",
      updated_by: getCurrentUser()
    }, { method: "POST" });
    showToast("作廢完成：這筆收貨已取消，畫面資料已同步更新", "success", 6000);
    await onRcvSourceSelect(true);
    await refreshRcvVoidReceiptOptions(true);
    const ppIr = document.getElementById("rcvPostedPanel");
    if (ppIr && ppIr.open) await renderRcvPostedReceipts_();
  } catch(err){
    if (rcvShouldAutoReloadAfterError_(err)) {
      await rcvAutoReloadAfterSourceChanged_();
      return;
    }
    if(!(err && err.erpApiToastShown)){
      showToast("作廢失敗：請稍後重試；若仍失敗請重新載入後再試", "error");
    }
  } finally {
    rcvCancelInFlight_ = false;
    hideSaveHint();
  }
}
