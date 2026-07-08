/**
 * Shipment（API 版）
 * - 過帳時：shipment + shipment_item + inventory_movement(SHIP_OUT)
 * - 回寫 sales_order_item.shipped_qty 與 sales_order.status
 */

let shipDraft = [];
let shipLots = [];
let shipMovements = []; // legacy: 保留變數以避免其他函式引用報錯
let shipAvailableByLotId_ = {};
let shipCustomers = [];
let shipRecipientsAll = [];
let shipSalesOrders = [];
let shipSalesItems = [];
let shipSalesItemsBySoId_ = {};
let shipSalesItemsLoadingBySoId_ = {};
let shipProducts = [];
let shipWarehouses = [];
let shipUsers = [];
let shipEditing = false;
let shipReadOnlyDraft = false;
/** 主檔狀態由系統維護（過帳/作廢 bundle 回寫），前端僅顯示用 */
let shipLoadedStatus_ = "OPEN";
let shipGoodsReceiptIdToPoId = {};
let shipImportReceiptIdToDocId = {};
let shipImportDocIdToImportNo = {};
/** 點選明細列：草稿為 DRAFT-*；已載入出貨單為 shipment_item_id */
let shipSelectedLineId_ = "";
let shipPostInFlight_ = false;
let shipCancelInFlight_ = false;
let shipLoadInFlight_ = false;
let shipPendingLoadId_ = "";
let shipLoadToastHideTimer_ = null;
let shipLoadWarnToken_ = "";

function shipFormatRecipientLabel_(row){
  const zh = String(row?.recipient_name || "").trim();
  const en = String(row?.recipient_name_en || "").trim();
  const phone = String(row?.phone || "").trim();
  let label = zh && en ? `${zh} / ${en}` : (zh || en);
  if(phone) label = `${label}（${phone}）`;
  return label || String(row?.recipient_id || "").trim();
}

function shipFormatRecipientDisplay_(zh, en){
  const a = String(zh || "").trim();
  const b = String(en || "").trim();
  if(a && b) return `${a} / ${b}`;
  return a || b;
}

function shipNormStatus_(raw){
  const s0 = String(raw || "").trim().toUpperCase();
  if(!s0) return "";
  // 相容舊資料/人工資料：可能寫成 "POSTED（已過帳）"、"CANCELLED (...)"。
  const m = s0.match(/^([A-Z0-9_]+)/);
  return (m && m[1]) ? m[1] : s0;
}

/** 已載入出貨單時：僅主檔備註可另存（後端 update_shipment_remark） */
function shipAllowHeaderRemarkSave_(){
  return !!(shipEditing && shipReadOnlyDraft);
}

/** 已過帳出貨單：明細備註可寫回（與後端 update_shipment_item_remark 一致） */
function shipAllowSavedLineRemarkUpdate_(){
  return !!(shipEditing && shipReadOnlyDraft && shipNormStatus_(shipLoadedStatus_) === "POSTED");
}

/**
 * 載入後鎖主檔／明細輸入（主檔備註始終可編；明細備註僅 POSTED 可編）。
 */
function shipSyncLoadedFormLock_(){
  const loaded = !!(shipEditing && shipReadOnlyDraft);
  const canItemRemark = shipAllowSavedLineRemarkUpdate_();
  ["ship_so_id", "ship_date", "ship_shipper_id", "ship_recipient_id"].forEach(id => {
    const el = document.getElementById(id);
    if(el) try{ el.disabled = loaded; }catch(_e){}
  });
  const idEl = document.getElementById("ship_id");
  if(idEl) try{ idEl.disabled = loaded; }catch(_eId){}
  ["ship_so_item_id", "ship_qty"].forEach(id => {
    const el = document.getElementById(id);
    if(el) try{ el.disabled = loaded; }catch(_e2){}
  });
  const itemRm = document.getElementById("ship_item_remark");
  if(itemRm){
    try{ itemRm.disabled = loaded && !canItemRemark; }catch(_eRm){}
  }
  const hdrRm = document.getElementById("ship_remark");
  if(hdrRm){
    try{ hdrRm.disabled = false; }catch(_eH){}
  }
  const aa = document.getElementById("ship_auto_alloc");
  if(aa) try{ aa.disabled = loaded; }catch(_eAa){}
  const addBtn = document.getElementById("ship_add_item_btn");
  if(addBtn) try{ addBtn.disabled = loaded; }catch(_eAdd){}
  try{ shipUpdateAllocModeUI_(); }catch(_eU){}
  try{ setShipPickLotBtnState_(); }catch(_eP){}
  setShipButtons_();
}

async function saveShipHeaderRemarkOnly_(triggerEl){
  if(!shipAllowHeaderRemarkSave_()){
    return showToast("請先載入出貨單", "error");
  }
  const shipment_id = (document.getElementById("ship_id")?.value || "").trim().toUpperCase();
  if(!shipment_id) return;
  const remark = String(document.getElementById("ship_remark")?.value || "").trim();
  showSaveHint(triggerEl || document.getElementById("ship_save_remark_btn"));
  try{
    await callAPI({
      action: "update_shipment_remark",
      shipment_id,
      remark,
      updated_by: getCurrentUser(),
      updated_at: nowIsoTaipei()
    }, { method: "POST" });
    invalidateShipCaches_();
    showToast("備註已儲存");
    await renderShipments();
  }catch(_e){
    if(!(_e && _e.erpApiToastShown)){
      showToast("儲存備註失敗：請確認後端已部署 update_shipment_remark", "error");
    }
  }finally{
    hideSaveHint();
    setShipButtons_();
  }
}

function shipBuildIdempotencyKey_(scope, payload){
  const raw = String(scope || "") + "|" + String(payload || "");
  let h = 0;
  for(let i = 0; i < raw.length; i++){
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return "IDEM-" + String(scope || "SHIP") + "-" + String(Math.abs(h)).toUpperCase();
}

function shipResolveImageUrl_(raw){
  const u = String(raw || "").trim();
  if(!u) return "";
  if(/^data:image\//i.test(u)) return u;
  if(/^https?:\/\//i.test(u)) return u;
  try{ return new URL(u, String(location && location.href || "")).href; }catch(_e){ return u; }
}

function shipGetPdfLogoUrl_(){
  const cfg = (typeof window === "object" && window && window.__ERP_CONFIG__) ? window.__ERP_CONFIG__ : {};
  const ciLogo = String(cfg.COMPANY_LOGO_CI_URL || "").trim();
  const url = ciLogo || String(cfg.COMPANY_LOGO_URL || "").trim();
  return shipResolveImageUrl_(url);
}

/** PDF V2：左 Logo、右標題（比照 Commercial Invoice） */
function shipBuildPdfHeaderV2Html_(title){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : function(s){ return String(s || ""); };
  const logoUrl = shipGetPdfLogoUrl_();
  const safeLogo = logoUrl ? logoUrl.replace(/"/g, "%22") : "";
  const logoBlock = safeLogo
    ? `<img src="${safeLogo}" alt="Logo" style="height:76px;width:auto;max-width:260px;object-fit:contain;display:block;">`
    : "";
  const t = String(title || "出貨記錄表").trim();
  return `<div style="display:flex;align-items:center;justify-content:center;gap:24px;margin-bottom:20px;">
    <div style="flex:0 0 auto;min-width:0;">${logoBlock}</div>
    <h1 style="margin:0;font-size:28px;letter-spacing:2px;white-space:nowrap;">${esc(t)}</h1>
  </div>`;
}

function shipBuildPdfFillDateRow_(fillDate){
  return `<div style="text-align:right;font-size:12.5px;color:#111;margin-bottom:10px;">
    填寫日期：<span style="display:inline-block;min-width:110px;border-bottom:1px solid #111;padding:0 4px;">${erpEscapeHtml_(fillDate || "")}</span>
  </div>`;
}

/** PDF V2 左欄：訂購人（含客戶電話）／收件人／地址／收件人電話 */
function shipBuildPdfConsigneeHtml_(data){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : function(s){ return String(s || ""); };
  const d = data || {};
  const lines = [];
  const orderer = String(d.orderer || "").trim();
  const ordererPhone = String(d.ordererPhone || "").trim();
  const recipient = String(d.recipient || "").trim();
  const address = String(d.address || "").trim();
  const recipientPhone = String(d.recipientPhone || "").trim();
  if(orderer){
    const phonePart = ordererPhone ? `　${esc(ordererPhone)}` : "";
    lines.push(`<div><b>訂購人：</b> ${esc(orderer)}${phonePart}</div>`);
  }
  if(recipient) lines.push(`<div style="margin-top:4px;"><b>收件人：</b> ${esc(recipient)}</div>`);
  if(address) lines.push(`<div style="margin-top:4px;"><b>地址：</b> ${esc(address)}</div>`);
  if(recipientPhone) lines.push(`<div style="margin-top:4px;"><b>電話：</b> ${esc(recipientPhone)}</div>`);
  return `<div style="font-size:13px;line-height:1.55;">${lines.join("") || "<div>—</div>"}</div>`;
}

/** 右欄標籤補滿 4 字寬，讓「出」與冒號對齊 */
function shipPdfMetaLabelPad_(label){
  const s = String(label || "").trim();
  const len = 4;
  const n = [...s].length;
  if(n >= len) return s;
  return s + "\u3000".repeat(len - n);
}

/** PDF V2 右欄：出貨單號等（區塊靠右，標籤以四字寬對齊冒號） */
function shipBuildPdfMetaRightHtml_(data){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : function(s){ return String(s || ""); };
  const d = data || {};
  const rows = [
    ["出貨單號", d.shipmentId],
    ["出貨日期", d.shipDate],
    ["銷售單", d.soId],
    ["出貨人員", d.shipperName || d.shipperId],
    ["填寫日期", d.fillDate]
  ];
  const labelW = "4.5em";
  return `<div style="display:flex;justify-content:flex-end;font-size:13px;line-height:1.65;">
    <div>
      ${rows.map(([k, v]) =>
        `<div><span style="display:inline-block;min-width:${labelW};text-align:left;"><b>${esc(shipPdfMetaLabelPad_(k))}</b></span>： ${esc(String(v != null ? v : ""))}</div>`
      ).join("")}
    </div>
  </div>`;
}

function shipBuildPdfMetaTableV2Html_(consigneeData, metaData){
  const colL = "width:50%;vertical-align:top;padding:0 12px 0 0;border:none;";
  const colR = "width:50%;vertical-align:top;padding:0 0 0 12px;border:none;";
  return `<table class="ci-meta-table" style="width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:12px;font-size:13px;border:none;">
    <tr>
      <td style="${colL}">${shipBuildPdfConsigneeHtml_(consigneeData)}</td>
      <td style="${colR}">${shipBuildPdfMetaRightHtml_(metaData)}</td>
    </tr>
  </table>`;
}

/** PDF V2 明細欄寬（加總 100%） */
function shipPdfItemsColWidths_(){
  return [7, 42, 10, 12, 10, 19];
}

function shipBuildPdfItemsTableHtml_(items, soAggByProduct, v2){
  const esc = typeof erpEscapeHtml_ === "function" ? erpEscapeHtml_ : function(s){ return String(s || ""); };
  const th = v2
    ? "border:1px solid #333;padding:6px;text-align:center;background:#f1f5f9;"
    : "";
  const thNowrap = v2 ? th + "white-space:nowrap;" : "";
  const td = v2 ? "border:1px solid #333;padding:6px;text-align:center;" : "";
  const tdProd = v2 ? td + "text-align:left;" : "";
  const tdQty = v2 ? td + "white-space:nowrap;" : "";
  const tableCls = v2 ? "ci-lines-table" : "";
  const tableStyle = v2
    ? "margin-top:10px;width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;"
    : "margin-top:10px;font-size:13px;table-layout:fixed;width:100%;";
  const colgroup = v2
    ? `<colgroup>${shipPdfItemsColWidths_().map(w => `<col style="width:${w}%">`).join("")}</colgroup>`
    : `<colgroup>
          <col style="width:46px;">
          <col>
          <col style="width:85px;">
          <col style="width:85px;">
          <col style="width:85px;">
          <col style="width:84px;">
        </colgroup>`;
  const headCells = v2
    ? `<th style="${thNowrap}">#</th><th style="${th}">產品</th><th style="${thNowrap}">本次</th><th style="${thNowrap}">訂貨數量</th><th style="${thNowrap}">未出</th><th style="${th}">備註</th>`
    : `<th style="width:46px;">#</th><th>產品</th><th>本次</th><th>訂貨數量</th><th>未出</th><th>備註</th>`;
  const bodyRows = (items || []).map((it, idx) => {
    const u = String(it.unit || "").trim();
    const q = u ? `${it.ship_qty} ${u}` : String(it.ship_qty || "");
    const prod = formatShipProductDisplay_(it.product_id) || it.product_id || "";
    const rmk = String(it.remark || "");
    const pid = String(it.product_id || "").trim().toUpperCase();
    const agg = soAggByProduct[pid] || null;
    const soUnit = String((agg && agg.unit) || u || "").trim();
    const orderQty = agg ? Number(agg.order || 0) : 0;
    const shippedQty = agg ? Number(agg.shipped || 0) : 0;
    const remainQty = agg ? Math.max(0, orderQty - shippedQty) : 0;
    const orderDisp = agg ? (soUnit ? `${orderQty} ${soUnit}` : String(orderQty)) : "—";
    const remainDisp = agg ? (soUnit ? `${remainQty} ${soUnit}` : String(remainQty)) : "—";
    if(v2){
      return `<tr>
        <td style="${td}">${idx + 1}</td>
        <td style="${tdProd}">
          <div style="font-size:11px;color:#334155;line-height:1.1;">產品編號：${esc(String(it.product_id || ""))}</div>
          <div style="line-height:1.25;margin-top:2px;">${esc(String(prod || ""))}</div>
        </td>
        <td style="${tdQty}">${esc(q)}</td>
        <td style="${tdQty}">${esc(orderDisp)}</td>
        <td style="${tdQty}">${esc(remainDisp)}</td>
        <td style="${td}">${esc(rmk)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${idx + 1}</td>
      <td>
        <div style="font-size:11px;color:#334155;line-height:1.1;">產品編號：${esc(String(it.product_id || ""))}</div>
        <div style="line-height:1.25;margin-top:2px;">${esc(String(prod || ""))}</div>
      </td>
      <td>${esc(q)}</td>
      <td>${esc(orderDisp)}</td>
      <td>${esc(remainDisp)}</td>
      <td>${esc(rmk)}</td>
    </tr>`;
  }).join("");
  return `<table class="${tableCls}" style="${tableStyle}">
    ${colgroup}
    <thead><tr>${headCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

async function downloadShipmentPdf(pdfVersion){
  try{
    const shipment_id = (document.getElementById("ship_id")?.value || "").trim().toUpperCase();
    if(!shipment_id) return showToast("請先載入一張出貨單再下載 PDF", "error");
    const soId = String(document.getElementById("ship_so_id")?.value || "").trim().toUpperCase();
    const shipDate = String(document.getElementById("ship_date")?.value || "").trim();
    const shipperId = String(document.getElementById("ship_shipper_id")?.value || "").trim();
    const remark = String(document.getElementById("ship_remark")?.value || "").trim();
    const fillDate = (function(){
      try{ return String(nowIso16() || "").slice(0,10); }catch(_e){ return ""; }
    })();

    const so = (shipSalesOrders || []).find(x => String(x?.so_id || "").trim().toUpperCase() === soId) || null;
    const custId = String(so?.customer_id || document.getElementById("ship_customer_id")?.value || "").trim();
    const cust = (shipCustomers || []).find(x => String(x?.customer_id || "") === custId) || null;
    const ordererName = cust ? (String(cust.customer_name || "").trim() || custId) : custId;

    let recipientName = String(document.getElementById("ship_recipient_name")?.value || "").trim();
    let recipientNameEn = String(document.getElementById("ship_recipient_name_en")?.value || "").trim();
    let recipientAddress = String(document.getElementById("ship_recipient_address")?.value || "").trim();
    let recipientPhone = String(document.getElementById("ship_recipient_phone")?.value || "").trim();
    try{
      const shRec = await getOne("shipment", "shipment_id", shipment_id);
      if(shRec){
        if(shRec.recipient_name) recipientName = String(shRec.recipient_name || "").trim();
        if(shRec.recipient_name_en) recipientNameEn = String(shRec.recipient_name_en || "").trim();
        if(shRec.recipient_address) recipientAddress = String(shRec.recipient_address || "").trim();
        if(shRec.recipient_phone) recipientPhone = String(shRec.recipient_phone || "").trim();
        if((!recipientName && !recipientNameEn) && shRec.recipient_id){
          const row = (shipRecipientsAll || []).find(r => String(r.recipient_id || "") === String(shRec.recipient_id || ""));
          if(row){
            recipientName = String(row.recipient_name || "").trim();
            recipientNameEn = recipientNameEn || String(row.recipient_name_en || "").trim();
            recipientAddress = recipientAddress || String(row.address || "").trim();
            recipientPhone = recipientPhone || String(row.phone || "").trim();
          }
        }
      }
    }catch(_eSh){}
    const recipientDisplay = shipFormatRecipientDisplay_(recipientName, recipientNameEn);

    const shipper = (shipUsers || []).find(x => String(x?.user_id || "") === shipperId) || null;
    const shipperName = shipper ? (String(shipper.user_name || "").trim() || shipperId) : shipperId;

    const items = Array.isArray(shipDraft) ? shipDraft.slice() : [];
    if(items.length === 0) return showToast("此出貨單沒有明細，無法下載 PDF", "error");

    // 依銷售單明細彙總：訂貨數量 / 剩餘（與畫面明細表同一套 API／快取）
    let soItems = [];
    if(soId){
      try{
        soItems = await shipLoadSalesItemsBySo_(soId);
      }catch(_eSoItems){
        soItems = [];
      }
    }
    const soAggByProduct = {};
    (soItems || []).forEach(it=>{
      const pid = String(it?.product_id || "").trim().toUpperCase();
      if(!pid) return;
      if(!soAggByProduct[pid]) soAggByProduct[pid] = { order: 0, shipped: 0, unit: String(it?.unit || "").trim() };
      soAggByProduct[pid].order += Number(it?.order_qty || 0);
      soAggByProduct[pid].shipped += Number(it?.shipped_qty || 0);
      if(!soAggByProduct[pid].unit) soAggByProduct[pid].unit = String(it?.unit || "").trim();
    });

    const v2 = String(pdfVersion || "1").trim() === "2";
    const ordererRecipientRow = `<tr>
            <td><b>收件人</b></td>
            <td>${erpEscapeHtml_(recipientDisplay || "")}</td>
            <td><b>訂購人</b></td>
            <td>${erpEscapeHtml_(ordererName || custId || "")}</td>
          </tr>`;
    const headerBlock = `<div style="display:flex;align-items:flex-end;justify-content:center;position:relative;margin:2px 0 10px;">
          <h1 style="margin:0;text-align:center;font-size:20px;letter-spacing:1px;">出貨紀錄表</h1>
          <div style="position:absolute;right:0;bottom:2px;font-size:12.5px;color:#111;">
            填寫日期：<span style="display:inline-block;min-width:110px;border-bottom:1px solid #111;padding:0 4px;">${erpEscapeHtml_(fillDate || "")}</span>
          </div>
        </div>`;
    const metaTableV1 = `<table style="font-size:13px;table-layout:fixed;width:100%;">
        <tbody>
          <tr>
            <td style="width:110px;"><b>出貨單號</b></td>
            <td style="width:260px;">${erpEscapeHtml_(shipment_id)}</td>
            <td style="width:110px;"><b>出貨日期</b></td>
            <td>${erpEscapeHtml_(shipDate || "")}</td>
          </tr>
          <tr>
            <td><b>銷售單</b></td>
            <td>${erpEscapeHtml_(soId || "")}</td>
            <td><b>出貨人員</b></td>
            <td>${erpEscapeHtml_(shipperName || shipperId || "")}</td>
          </tr>
          ${ordererRecipientRow}
          <tr>
            <td><b>收件地址</b></td>
            <td colspan="3">${erpEscapeHtml_(recipientAddress || "")}</td>
          </tr>
          <tr>
            <td><b>電話</b></td>
            <td colspan="3">${erpEscapeHtml_(recipientPhone || "")}</td>
          </tr>
        </tbody>
      </table>`;
    const itemsTableHtml = shipBuildPdfItemsTableHtml_(items, soAggByProduct, v2);
    const remarkBlock = v2
      ? `<p style="margin:12px 0 4px;font-size:13px;line-height:1.5;"><b>其他備註：</b> ${erpEscapeHtml_(remark || "")}</p>`
      : `<table style="margin-top:12px;font-size:13px;">
        <tbody>
          <tr>
            <td style="width:110px;"><b>其他備註</b></td>
            <td style="height:56px;">${erpEscapeHtml_(remark || "")}</td>
          </tr>
        </tbody>
      </table>`;
    const signatureBlock = `<div style="height:36px;"></div>
      <div style="margin-top:0;font-size:13px;text-align:right;">
        <span style="font-weight:700;">簽收人：</span>＿＿＿＿＿＿＿＿＿＿
        <span style="display:inline-block;width:14px;"></span>
        <span style="font-weight:700;">簽收日期：</span>＿＿＿＿＿＿＿＿＿＿
      </div>`;

    const body = v2
      ? `<div class="ci-invoice" style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:13px;">
          ${shipBuildPdfHeaderV2Html_("出貨記錄表")}
          ${shipBuildPdfMetaTableV2Html_({
            orderer: ordererName || custId || "",
            ordererPhone: String(cust?.phone || "").trim(),
            recipient: recipientDisplay || "",
            address: recipientAddress || "",
            recipientPhone: recipientPhone || ""
          }, {
            shipmentId: shipment_id,
            shipDate: shipDate || "",
            soId: soId || "",
            shipperName: shipperName || "",
            shipperId: shipperId || "",
            fillDate: fillDate || ""
          })}
          ${itemsTableHtml}
          ${remarkBlock}
          ${signatureBlock}
        </div>`
      : `${headerBlock}
      ${metaTableV1}
      ${itemsTableHtml}
      ${remarkBlock}
      ${signatureBlock}`;

    erpOpenPrintWindow_(`${shipment_id}-${fillDate || ""}`, body, v2 ? { skipBrandHeader: true, minimalPrintChrome: true } : undefined);
  }catch(_e){
    showToast("無法產生 PDF：請確認瀏覽器未阻擋彈出視窗", "error");
  }
}

function downloadShipmentPdfV2(){
  return downloadShipmentPdf("2");
}

function shipShouldAutoReloadAfterError_(err){
  const code = String(err && err.erpErrorCode || "").trim().toUpperCase();
  if(code === "ERR_SOURCE_CHANGED" || code === "ERR_DUPLICATE_REQUEST" || code === "ERR_ALREADY_PROCESSED") return true;
  const msg = String(err && err.message != null ? err.message : err || "");
  const backendErrors = err && Array.isArray(err.backendErrors) ? err.backendErrors : [];
  const full = (msg + " " + backendErrors.join(" ")).toLowerCase();
  return (
    /(shipment|so)\s+source\s+changed/.test(full) ||
    /please\s+reload\s+and\s+try\s+again/.test(full) ||
    /duplicate\s+request\s+detected/.test(full) ||
    /already\s+(posted|cancelled|canceled)/.test(full) ||
    /狀態.*(已過帳|已作廢|不可重做)/.test(full) ||
    /此單據已被處理|狀態已變更/.test(full)
  );
}

function invalidateShipCaches_(){
  try{
    if(typeof invalidateCache === "function"){
      invalidateCache("shipment");
      invalidateCache("shipment_item");
      invalidateCache("inventory_movement");
      invalidateCache("lot");
      invalidateCache("sales_order_item");
      invalidateCache("sales_order");
      invalidateCache("customer");
    }
  }catch(_e){}
}

async function shipAutoReloadAfterConflict_(shipmentId){
  try{
    // 避免網路不穩/後端短暫錯誤造成重載迴圈：同單號短時間最多自動重載 2 次
    try{
      const id = String(shipmentId || "").trim().toUpperCase() || "(unknown)";
      const now = Date.now();
      const w = (typeof window !== "undefined" && window) ? window : {};
      if(!w.__erpAutoReloadGuardShip__) w.__erpAutoReloadGuardShip__ = {};
      const g = w.__erpAutoReloadGuardShip__;
      const prev = g[id] || { at: 0, n: 0 };
      const withinMs = 15000;
      const n = (now - prev.at) < withinMs ? (prev.n + 1) : 1;
      g[id] = { at: now, n };
      if(n > 2){
        showToast("自動重新載入次數過多，請手動按 Load 再試", "error");
        return false;
      }
    }catch(_eGuard){}
    showToast("資料已更新，系統正在為你重新載入…", "warn", 6000);
    invalidateShipCaches_();
    await loadShipMasterData();
    await renderShipments();
    if(String(shipmentId || "").trim()) await loadShipment(shipmentId);
    showToast("已重新載入最新資料，請確認後再送出", "warn", 6000);
    return true;
  }catch(_eReload){
    showToast("自動重新載入失敗，請手動重新載入後再送出", "error");
    return false;
  }
}

function shipShowLoadProgressToast_(shipmentId){
  // 對齊規則：載入中進度不要用 Toast（避免覆蓋錯誤/提醒造成一閃而過）
  // 進度改用狀態列（shipStatusHint / shipInvState）顯示
  try{
    const id = String(shipmentId || "");
    const stEl = document.getElementById("shipStatusHint");
    if(stEl) stEl.textContent = `出貨流程：載入中 — ${id}`;
    const invEl = document.getElementById("shipInvState");
    if(invEl) invEl.textContent = "扣庫狀態：載入中…";
  }catch(_e){}
}

function shipShowLoadDoneToast_(shipmentId){
  // 完成提示：略長一點；狀態列也會保留「已載入」文字
  try{
    showToast("已載入完成：" + String(shipmentId || ""), "success", 8000);
  }catch(_e){}
}

function shipSetV_(id, v){
  try{
    if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(id, v);
  }catch(_e){}
  const el = document.getElementById(String(id || ""));
  if(el && "value" in el) el.value = v;
}

function shipClear_(ids){
  try{
    if(typeof window.erpClearIds_ === "function") return window.erpClearIds_(ids);
  }catch(_e){}
  const list = Array.isArray(ids) ? ids : [ids];
  for(let i = 0; i < list.length; i++){
    const el = document.getElementById(String(list[i] || ""));
    if(el && "value" in el) el.value = "";
  }
}

function updateShipStatusHint_(){
  const el = document.getElementById("shipStatusHint");
  const invEl = document.getElementById("shipInvState");
  if(!el) return;
  if(shipEditing && shipReadOnlyDraft){
    const st = shipNormStatus_(shipLoadedStatus_);
    const zh = shipStatusZh_(st) || st;
    const hint =
      st === "POSTED" ? ["已載入 · " + zh, "主檔／明細備註可改 · CI 請至 Invoice 商業發票"] :
      st === "CANCELLED" ? ["已載入 · " + zh, "僅主檔備註可改"] :
      ["已載入 · " + zh, "整批已鎖"];
    el.textContent =
      (typeof window.erpFlowHintText_ === "function")
        ? window.erpFlowHintText_("出貨", hint[0], hint[1])
        : ("出貨：" + hint[0] + " · " + hint[1]);
    if(invEl){
      const invHint =
        st === "POSTED" ? ["已過帳", "已扣庫"] :
        st === "CANCELLED" ? ["已作廢", "已反沖"] :
        ["未過帳", "未扣庫"];
      invEl.textContent =
        (typeof window.erpFlowHintText_ === "function")
          ? window.erpFlowHintText_("扣庫", invHint[0], invHint[1])
          : ("扣庫：" + invHint[0] + " · " + invHint[1]);
      invEl.style.color =
        st === "POSTED" ? "#166534" :
        st === "CANCELLED" ? "#991b1b" :
        "#92400e";
    }
  }else{
    el.textContent =
      (typeof window.erpFlowHintText_ === "function")
        ? window.erpFlowHintText_("出貨", "新單", "填主檔與明細後按「建立並過帳出貨」扣庫")
        : "出貨：新單 · 填主檔與明細後按「建立並過帳出貨」扣庫";
    if(invEl){
      invEl.textContent =
        (typeof window.erpFlowHintText_ === "function")
          ? window.erpFlowHintText_("扣庫", "未過帳", "過帳後才扣庫")
          : "扣庫：未過帳 · 過帳後才扣庫";
      invEl.style.color = "#92400e";
    }
  }
}

function setShipButtons_(){
  const postBtn = document.getElementById("ship_post_btn");
  const cancelBtn = document.getElementById("ship_cancel_btn");
  const saveHdr = document.getElementById("ship_save_remark_btn");
  const saveLine = document.getElementById("ship_save_line_remark_btn");
  const st = shipNormStatus_(shipLoadedStatus_ || "OPEN");

  if(postBtn){
    // 建單（並過帳）只在「新單草稿」可用
    postBtn.disabled = !!shipEditing;
    postBtn.title = shipEditing ? "請先清除回到新單，才能建立並過帳" : "建立並過帳出貨（扣庫）";
  }
  if(cancelBtn){
    if(!shipEditing){
      cancelBtn.disabled = true;
      cancelBtn.title = "請先載入出貨單";
    }else if(st === "CANCELLED"){
      cancelBtn.disabled = true;
      cancelBtn.title = "此出貨單已作廢";
    }else if(st !== "POSTED"){
      cancelBtn.disabled = true;
      cancelBtn.title = "僅 POSTED 出貨單可作廢";
    }else{
      cancelBtn.disabled = false;
      cancelBtn.title = "作廢此出貨單（將反沖庫存並回寫 SO）";
    }
  }
  if(saveHdr){
    saveHdr.disabled = !shipAllowHeaderRemarkSave_();
    saveHdr.title = shipAllowHeaderRemarkSave_()
      ? "只更新主檔備註（不變更銷售單／日期／出貨人員等）"
      : "請先載入出貨單";
  }
  if(saveLine){
    const ro = !!shipReadOnlyDraft;
    const canPostedLine = ro && st === "POSTED";
    saveLine.disabled = ro && !canPostedLine;
    saveLine.title = !ro
      ? "更新草稿列備註（請先點選草稿列）"
      : canPostedLine
        ? "寫回已出貨明細備註（請先點選明細列）"
        : "僅「已出貨」可儲存明細備註；已作廢僅可改主檔備註";
  }
}

function formatShipProductDisplay_(productId){
  const p = (shipProducts || []).find(x => x.product_id === productId) || {};
  const name = p.product_name || productId || "";
  const spec = p.spec || "";
  return spec ? `${name}（${spec}）` : name;
}

function shipFindProduct_(productId){
  const id = String(productId || "").trim();
  if(!id) return null;
  return (shipProducts || []).find(p => String(p.product_id || "").trim() === id) || null;
}

async function shippingInit(){
  await loadShipMasterData();
  const lotKw = document.getElementById("ship_lot_picker_keyword");
  if(lotKw && !lotKw.dataset.bound){
    lotKw.dataset.bound = "1";
    lotKw.addEventListener("input", () => renderShipLotPicker_(getShipLotsForPicker_()));
  }
  const lotView = document.getElementById("ship_lot_picker_viewmode");
  if(lotView && !lotView.dataset.bound){
    lotView.dataset.bound = "1";
    lotView.addEventListener("change", () => renderShipLotPicker_(getShipLotsForPicker_()));
  }
  const showInel = document.getElementById("ship_show_ineligible_lots");
  if(showInel && !showInel.dataset.bound){
    showInel.dataset.bound = "1";
    showInel.addEventListener("change", () => renderShipLotPicker_(getShipLotsForPicker_()));
  }
  resetShipForm();
  setShipButtons_();
  try{ shipUpdateAllocModeUI_(); }catch(_e){}
  // 從銷售單跳轉：預先選擇銷售單
  try{
    const preSo = window.__ERP_PREFILL_SHIP_SO_ID__;
    if(preSo){
      const soSel = document.getElementById("ship_so_id");
      if(soSel){
        soSel.value = String(preSo || "");
        onSelectShipSO();
      }
      delete window.__ERP_PREFILL_SHIP_SO_ID__;
    }
  }catch(_e){}
  bindAutoSearchToolbar_([
    ["ship_search_keyword", "input"],
    ["ship_search_status", "change"]
  ], () => renderShipments());
  await renderShipments();
}

function shipIsAutoAlloc_(){
  return !!document.getElementById("ship_auto_alloc")?.checked;
}

function shipUpdateAllocModeUI_(){
  const auto = shipIsAutoAlloc_();
  const pickBtn = document.getElementById("ship_pick_lot_btn");
  const lotDisp = document.getElementById("ship_lot_display");
  const lotId = document.getElementById("ship_lot_id");
  if(pickBtn){
    pickBtn.disabled = !!shipReadOnlyDraft || auto;
    pickBtn.title =
      shipReadOnlyDraft ? "此出貨單已結束（POSTED/CANCELLED），不可再選擇 Lot" :
      auto ? "已勾選自動分配（依效期 FEFO），不需手動選擇 Lot" :
      "選擇要出貨的 Lot";
  }
  if(lotDisp){
    lotDisp.placeholder = auto ? "自動分配（依效期 FEFO）" : "請在下方按「選擇 Lot」帶入";
    lotDisp.style.background = auto ? "#f8fafc" : "";
  }
  if(auto){
    shipClear_(["ship_lot_id","ship_lot_display"]);
  }
}

function shipParseYMD_(s){
  const raw = String(s || "").trim();
  if(!raw) return null;
  const m = raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if(!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if(!y || !mo || !d) return null;
  return { y, mo, d };
}

function shipExpirySortKey_(lot){
  const ymd = shipParseYMD_(lot?.expiry_date);
  if(!ymd) return "9999-12-31";
  const pad2 = (n)=>String(n).padStart(2,"0");
  return `${ymd.y}-${pad2(ymd.mo)}-${pad2(ymd.d)}`;
}

function shipIsLotEligibleForShip_(lot){
  if(!lot) return false;
  const whitelist = shipGetProductWhitelistForPicker_();
  const pid = String(lot?.product_id || "").trim();
  if(whitelist && !whitelist.has(pid)) return false;
  if(String(lot.inventory_status || "ACTIVE").toUpperCase() !== "ACTIVE") return false;
  if(String(lot.status || "PENDING").toUpperCase() !== "APPROVED") return false;
  try{
    if(typeof invIsExpired_ === "function" && invIsExpired_(lot.expiry_date)) return false;
  }catch(_e){}
  const av = shipGetAvailable(lot.lot_id);
  if(typeof invIsMissingMovement_ === "function" && invIsMissingMovement_(av)) return false;
  return Number(av || 0) > 1e-9;
}

function shipAutoAllocateLots_(productId, qtyNeeded){
  const pid = String(productId || "").trim();
  let need = Number(qtyNeeded || 0);
  if(!pid || !(need > 0)) return { lines: [], shortage: need };

  const candidates = (shipLots || [])
    .filter(l => String(l?.product_id || "").trim() === pid)
    .filter(l => shipIsLotEligibleForShip_(l));

  candidates.sort((a,b)=>{
    const ea = shipExpirySortKey_(a);
    const eb = shipExpirySortKey_(b);
    if(ea !== eb) return ea.localeCompare(eb);
    const ca = String(a?.created_at || "");
    const cb = String(b?.created_at || "");
    if(ca !== cb) return ca.localeCompare(cb);
    return String(a?.lot_id || "").localeCompare(String(b?.lot_id || ""));
  });

  const lines = [];
  for(const lot of candidates){
    if(!(need > 1e-9)) break;
    const raw = shipGetAvailable(lot.lot_id);
    if(typeof invIsMissingMovement_ === "function" && invIsMissingMovement_(raw)) continue;
    const av = Number(raw || 0);
    if(!(av > 1e-9)) continue;
    const take = Math.min(av, need);
    lines.push({ lot, qty: take });
    need -= take;
  }
  return { lines, shortage: need };
}

async function loadShipMasterData(){
  const [lots, avail, customersRaw, recipientsRaw, salesOrders, products, warehouses, usersRaw, importReceipts, goodsReceipts, importDocs] = await Promise.all([
    getAll("lot"),
    loadInventoryMovementAvailableMap_().catch(() => ({ map:{}, failed:true })),
    getAll("customer"),
    getAll("customer_recipient").catch(() => []),
    getAll("sales_order").catch(() => []),
    getAll("product").catch(() => []),
    getAll("warehouse").catch(() => []),
    getAll("user").catch(() => []),
    getAll("import_receipt").catch(() => []),
    getAll("goods_receipt").catch(() => []),
    getAll("import_document").catch(() => [])
  ]);
  shipLots = lots || [];
  shipAvailableByLotId_ = avail?.map || {};
  shipCustomers = (customersRaw || []).filter(c => c.status === "ACTIVE");
  shipRecipientsAll = (recipientsRaw || []).filter(r => String(r.status || "ACTIVE").toUpperCase() !== "VOID");
  shipSalesOrders = salesOrders || [];
  shipSalesItems = [];
  shipSalesItemsBySoId_ = {};
  shipSalesItemsLoadingBySoId_ = {};
  shipProducts = products || [];
  shipWarehouses = (warehouses || []).filter(w => String(w.status || "ACTIVE").toUpperCase() === "ACTIVE");
  shipUsers = usersRaw || [];

  shipImportReceiptIdToDocId = {};
  (importReceipts || []).forEach(r => {
    if(r && r.import_receipt_id){
      shipImportReceiptIdToDocId[r.import_receipt_id] = r.import_doc_id || "";
    }
  });
  shipGoodsReceiptIdToPoId = {};
  (goodsReceipts || []).forEach(r => {
    if(r && r.gr_id){
      shipGoodsReceiptIdToPoId[r.gr_id] = r.po_id || "";
    }
  });
  shipImportDocIdToImportNo = {};
  (importDocs || []).forEach(d => {
    if(d && d.import_doc_id){
      shipImportDocIdToImportNo[d.import_doc_id] = d.import_no || "";
    }
  });

  initShipDropdowns();
}

async function shipLoadSalesItemsBySo_(soId){
  const id = String(soId || "").trim().toUpperCase();
  if(!id) return [];
  if(Array.isArray(shipSalesItemsBySoId_?.[id])) return shipSalesItemsBySoId_[id];
  if(shipSalesItemsLoadingBySoId_?.[id]) return await shipSalesItemsLoadingBySoId_[id];

  const p = (async ()=>{
    try{
      const r = await callAPI({ action: "list_sales_order_item_by_so", so_id: id }, { method: "GET" });
      const rows = (r && r.data) ? r.data : [];
      shipSalesItemsBySoId_[id] = Array.isArray(rows) ? rows : [];
      return shipSalesItemsBySoId_[id];
    }catch(_e){
      // fallback：舊版後端未支援時才退回全表
      const all = await getAll("sales_order_item").catch(() => []);
      const rows = (all || []).filter(it => String(it.so_id || "").trim().toUpperCase() === id);
      shipSalesItemsBySoId_[id] = rows;
      return rows;
    }finally{
      try{ delete shipSalesItemsLoadingBySoId_[id]; }catch(_e2){}
    }
  })();
  shipSalesItemsLoadingBySoId_[id] = p;
  return await p;
}

async function shipRefreshSoItemDropdown_(soId){
  const id = String(soId || "").trim().toUpperCase();
  const soiSel = document.getElementById("ship_so_item_id");
  if(!soiSel) return;
  if(!id){
    soiSel.innerHTML = `<option value="">請先選擇銷售單</option>`;
    try{ shipUpdateAllocModeUI_(); }catch(_e){}
    return;
  }

  const items = await shipLoadSalesItemsBySo_(id);
  shipSalesItems = Array.isArray(items) ? items : [];

  soiSel.innerHTML =
    `<option value="">請選擇</option>` +
    (shipSalesItems || []).map(it => {
      const ordered = Number(it.order_qty || 0);
      const shipped = Number(it.shipped_qty || 0);
      const remain = Math.max(0, ordered - shipped);
      const p = shipFindProduct_(it.product_id);
      const name = String(p?.product_name || it.product_id || "").trim();
      const spec = String(p?.spec || "").trim();
      const prodText = spec ? `${name}（${spec}）` : name;
      const unit = String(it.unit || "").trim();
      const u = unit ? unit.replace(/</g, "") : "";
      const ordText = u ? `訂購${ordered}${u}` : `訂購${ordered}`;
      const shipText = u ? `已出${shipped}` : `已出${shipped}`;
      const remText = u ? `未出${remain}` : `未出${remain}`;
      const label = `${prodText}│${ordText}│${shipText}│${remText}`;
      return `<option value="${it.so_item_id}" data-product="${it.product_id}" data-unit="${it.unit}" data-remain="${remain}">${escapeHtml_(label)}</option>`;
    }).join("");
  // 若目前明細表已有列，補上 訂購/已出/未出 的即時顯示
  try{
    const cur = String(document.getElementById("ship_so_id")?.value || "").trim().toUpperCase();
    if(cur && cur === id && Array.isArray(shipDraft) && shipDraft.length){
      renderShipDraft();
    }
  }catch(_eRe){}
  try{ shipUpdateAllocModeUI_(); }catch(_e2){}
}

function shipWarehouseLabelById_(warehouseId){
  const id = String(warehouseId || "").trim().toUpperCase();
  if(!id) return "";
  const w = (shipWarehouses || []).find(x => String(x.warehouse_id || "").toUpperCase() === id) || null;
  if(!w) return id;
  const name = String(w.warehouse_name || "").trim();
  const cat = String(w.category || "").trim().toUpperCase();
  const catLabel = (typeof termShortZh_ === "function" ? termShortZh_(cat) : ((typeof termLabel === "function" ? termLabel(cat) : "") || cat));
  const namePart = name || id;
  return catLabel ? `${namePart}-${catLabel}` : namePart;
}

function shipWarehouseLabelByLot_(lot){
  return shipWarehouseLabelById_(lot?.warehouse_id || "");
}

function shipGetAvailable(lotId){
  const id = String(lotId || "");
  if(!id) return null;
  const hit = shipAvailableByLotId_?.[id];
  // 缺 movement：map 會是 null（顯示 --，且禁止用於扣庫/出貨）
  if(hit !== undefined) return hit;
  return null;
}

function formatShipLotOptionLabel_(lot, available){
  const lotId = String(lot?.lot_id || "");
  const productText = formatShipProductDisplay_(lot?.product_id || "") || "";
  const prodPart = productText ? ` ${productText}` : "";
  const avText = (typeof invFormatAvailableText_ === "function") ? invFormatAvailableText_(available) : String(available ?? "--");
  return `${lotId}${prodPart} 可用:${avText}`;
}

function formatShipLotSourceText_(lot){
  const sourceType = String(lot?.source_type || "").toUpperCase();
  const sourceId = String(lot?.source_id || "");
  if(sourceType === "PURCHASE"){
    const poId = shipGoodsReceiptIdToPoId[sourceId] || "";
    return poId ? `採購單:${poId}（收貨:${sourceId}）` : `採購:${sourceId}`;
  }
  if(sourceType === "IMPORT"){
    const docId = shipImportReceiptIdToDocId[sourceId] || "";
    const impNo = docId ? (shipImportDocIdToImportNo[docId] || "") : "";
    if(impNo || docId){
      return `報單:${impNo || "—"}（ID:${docId || "—"} / 收貨:${sourceId}）`;
    }
    return `進口:${sourceId}`;
  }
  if(sourceType === "PROCESS") return `加工:${sourceId}`;
  return sourceType ? `${sourceType}:${sourceId}` : sourceId;
}

/** 有選銷售單／品項時：限制 Lot 產品；未選則 null 表示不限制 */
function shipGetProductWhitelistForPicker_(){
  const soId = String(document.getElementById("ship_so_id")?.value || "").trim();
  const soItemId = String(document.getElementById("ship_so_item_id")?.value || "").trim();
  const soItems = (shipSalesItems || []);
  if(soItemId){
    const soi = soItems.find(x => String(x.so_item_id || "").trim() === soItemId) || null;
    const pid = String(soi?.product_id || "").trim();
    return pid ? new Set([pid]) : null;
  }
  if(soId){
    const pids = new Set();
    soItems.filter(x => String(x.so_id || "").trim() === soId).forEach(x=>{
      const pid = String(x?.product_id || "").trim();
      if(pid) pids.add(pid);
    });
    return pids.size ? pids : null;
  }
  return null;
}

function getShipEligibleLots_(){
  return (shipLots || []).filter(l => shipIsLotEligibleForShip_(l));
}

/** 手動選 Lot：顯示白名單內全部（含不可選與原因）；FEFO：僅可出貨批次 */
function getShipLotsForPicker_(){
  if(shipIsAutoAlloc_()) return getShipEligibleLots_();
  const showInel = !!document.getElementById("ship_show_ineligible_lots")?.checked;
  if(!showInel) return getShipEligibleLots_();
  const productWhitelist = shipGetProductWhitelistForPicker_();
  return (shipLots || []).filter(l => {
    if(productWhitelist && !productWhitelist.has(String(l?.product_id || "").trim())) return false;
    return true;
  });
}

/** 空字串 = 可出貨；否則為不可選原因（給手動模式列示） */
function shipIneligibleReasonForShip_(lot){
  if(!lot) return "無 Lot 資料";
  const whitelist = shipGetProductWhitelistForPicker_();
  const pid = String(lot?.product_id || "").trim();
  if(whitelist && !whitelist.has(pid)) return "非銷售單指定品項";
  if(String(lot.inventory_status || "ACTIVE").toUpperCase() !== "ACTIVE"){
    return "庫存非使用中（非 ACTIVE）";
  }
  const qa = String(lot.status || "PENDING").toUpperCase();
  if(qa === "REJECTED") return "QA已退回";
  if(qa !== "APPROVED") return "待QA（須先放行）";
  try{
    if(typeof invIsExpired_ === "function" && invIsExpired_(lot.expiry_date)) return "已過期";
  }catch(_e){}
  const av = shipGetAvailable(lot.lot_id);
  if(typeof invIsMissingMovement_ === "function" && invIsMissingMovement_(av)) return "缺 movement（需先補齊入庫/異動紀錄）";
  if(!(Number(av || 0) > 1e-9)) return "可用量為 0";
  return "";
}

function renderShipLotPicker_(lots){
  const tbody = document.getElementById("shipLotPickBody");
  if(!tbody) return;
  const kw = (document.getElementById("ship_lot_picker_keyword")?.value || "").trim().toLowerCase();
  const viewMode = document.getElementById("ship_lot_picker_viewmode")?.value || "flat";
  const source = Array.isArray(lots) ? lots : [];
  const list = source.filter(l => {
    if(!kw) return true;
    const lotId = String(l.lot_id || "").toLowerCase();
    const pname = String(formatShipProductDisplay_(l.product_id || "") || "").toLowerCase();
    const src = String(formatShipLotSourceText_(l) || "").toLowerCase();
    const wh = String(shipWarehouseLabelByLot_(l) || "").toLowerCase();
    return lotId.includes(kw) || pname.includes(kw) || src.includes(kw) || wh.includes(kw);
  });

  // 排序：可出貨在上；同類內依效期 ASC、Lot ID ASC
  function shipSortLotsForPicker_(arr){
    const a = Array.isArray(arr) ? arr.slice() : [];
    a.sort((x, y) => {
      const rx = shipIneligibleReasonForShip_(x);
      const ry = shipIneligibleReasonForShip_(y);
      const okx = !rx;
      const oky = !ry;
      if(okx !== oky) return okx ? -1 : 1;
      const ex = shipExpirySortKey_(x);
      const ey = shipExpirySortKey_(y);
      if(ex !== ey) return ex.localeCompare(ey);
      return String(x?.lot_id || "").localeCompare(String(y?.lot_id || ""));
    });
    return a;
  }
  tbody.innerHTML = "";
  if(!list.length){
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#64748b;">目前無符合的 Lot（請調整銷售單／品項或關鍵字）</td></tr>`;
    return;
  }

  function renderLotRow_(l){
    const av = shipGetAvailable(l.lot_id);
    const lotId = String(l.lot_id || "");
    const productText = formatShipProductDisplay_(l.product_id || "");
    const whText = shipWarehouseLabelByLot_(l) || (l.warehouse_id ? String(l.warehouse_id) : "");
    const expiry = String(l.expiry_date || "") || "—";
    const safeId = lotId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const reason = shipIneligibleReasonForShip_(l);
    const ok = !reason;
    const hint = ok ? "可出貨" : reason;
    const rowStyle = ok ? "cursor:pointer;" : "cursor:default;opacity:0.72;background:#f8fafc;";
    const onRow = ok ? `onclick="pickShipLineLot('${safeId}')"` : "";
    const btnDisabled = ok ? "" : " disabled";
    tbody.innerHTML += `
      <tr style="${rowStyle}" ${onRow}>
        <td>${lotId}</td>
        <td>${productText}</td>
        <td>${whText || "—"}</td>
        <td>${av}</td>
        <td>${expiry}</td>
        <td style="font-size:12px;color:${ok ? "#166534" : "#92400e"};max-width:200px;">${hint}</td>
        <td><button type="button" class="btn-secondary"${btnDisabled} ${ok ? `onclick="event.stopPropagation();pickShipLineLot('${safeId}')"` : ""}>帶入</button></td>
      </tr>
    `;
  }
  if(viewMode === "group_source"){
    const groups = {};
    list.forEach(l => {
      const key = formatShipLotSourceText_(l) || "未分類來源";
      if(!groups[key]) groups[key] = [];
      groups[key].push(l);
    });
    Object.keys(groups).sort().forEach(k => {
      tbody.innerHTML += `
        <tr style="background:#f8fafc;">
          <td colspan="7" style="font-weight:600;color:#334155;padding:8px 10px;">來源：${k}（${groups[k].length}）</td>
        </tr>
      `;
      shipSortLotsForPicker_(groups[k]).forEach(renderLotRow_);
    });
  }else{
    shipSortLotsForPicker_(list).forEach(renderLotRow_);
  }
}

function openShipLotPicker(){
  if(shipReadOnlyDraft) return;
  const modal = document.getElementById("shipLotPickerModal");
  if(!modal) return;
  const titleEl = document.getElementById("ship_lot_picker_title");
  const showInel = document.getElementById("ship_show_ineligible_lots");
  if(showInel) showInel.checked = false; // 預設隱藏不可選 Lot
  if(titleEl){
    titleEl.textContent = shipIsAutoAlloc_()
      ? "選擇 Lot（FEFO：僅顯示可出貨批次）"
      : "選擇 Lot（手動：僅顯示可出貨批次）";
  }
  modal.style.display = "flex";
  const kw = document.getElementById("ship_lot_picker_keyword");
  if(kw){
    shipClear_("ship_lot_picker_keyword");
    kw.focus();
  }
  renderShipLotPicker_(getShipLotsForPicker_());
}

function closeShipLotPicker(){
  const modal = document.getElementById("shipLotPickerModal");
  if(modal) modal.style.display = "none";
}

function pickShipLineLot(lotId){
  const lot = (shipLots || []).find(l => String(l.lot_id || "") === String(lotId || ""));
  if(!shipIsLotEligibleForShip_(lot)){
    const r = shipIneligibleReasonForShip_(lot) || "不符合出貨條件";
    if(typeof showToast === "function") showToast("無法選擇此 Lot：" + r, "error");
    return;
  }
  const input = document.getElementById("ship_lot_id");
  const display = document.getElementById("ship_lot_display");
  if(!input) return;
  input.value = lotId || "";
  if(display){
    const av = lot ? shipGetAvailable(lot.lot_id) : "";
    const whText = lot ? (shipWarehouseLabelByLot_(lot) || "") : "";
    display.value = lot ? (formatShipLotOptionLabel_(lot, av) + (whText ? ` | ${whText}` : "")) : (lotId || "");
  }
  const uHid = document.getElementById("ship_line_unit");
  if(uHid) uHid.value = lot ? String(lot.unit || "").trim() : "";
  syncErpQtyUnitSuffix_("ship_line_unit", "ship_qty_unit_suffix");
  onSelectShipLot();
  closeShipLotPicker();
}

function setShipPickLotBtnState_(){
  const btn = document.getElementById("ship_pick_lot_btn");
  if(btn) btn.disabled = !!shipReadOnlyDraft || shipIsAutoAlloc_();
}

function shipSoOptLabel_(so, customerMap){
  const sid = String(so?.so_id || "").trim();
  const cid = String(so?.customer_id || "").trim();
  const cn = String((customerMap && customerMap[cid]?.customer_name) || "").trim();
  const custText = cn || cid;
  const sp = String(so?.salesperson_id || "").trim();
  const useText = (typeof termLabelZhOnly === "function" ? termLabelZhOnly(so?.so_type || "NORMAL") : String(so?.so_type || "NORMAL")) || String(so?.so_type || "NORMAL");
  const od = String(so?.order_date || "").trim();
  const st = (typeof termLabelZhOnly === "function" ? termLabelZhOnly(so?.status || "") : String(so?.status || "")) || String(so?.status || "");
  return [sid, custText, sp, useText, od, st].filter(Boolean).join("│");
}

/** 載入已過帳出貨單時，銷售單可能已是 SHIPPED，需補進下拉選單 */
async function shipEnsureSoInDropdown_(soId){
  const soSel = document.getElementById("ship_so_id");
  if(!soSel) return;
  const id = String(soId || "").trim().toUpperCase();
  if(!id) return;
  const has = Array.from(soSel.options).some(o => String(o.value || "").trim().toUpperCase() === id);
  if(has) return;

  let so = (shipSalesOrders || []).find(x => String(x?.so_id || "").trim().toUpperCase() === id) || null;
  if(!so){
    try{ so = await getOne("sales_order", "so_id", id); }catch(_e){ so = null; }
    if(so && !shipSalesOrders.some(x => String(x?.so_id || "").trim().toUpperCase() === id)){
      shipSalesOrders.push(so);
    }
  }
  if(!so) return;

  const customerMap = {};
  (shipCustomers || []).forEach(c => { if(c && c.customer_id) customerMap[c.customer_id] = c; });
  const opt = document.createElement("option");
  opt.value = so.so_id;
  opt.textContent = shipSoOptLabel_(so, customerMap);
  soSel.appendChild(opt);
}

function shipResolveCurSoId_(){
  let curSoId = String(document.getElementById("ship_so_id")?.value || "").trim().toUpperCase();
  if(curSoId) return curSoId;
  if(Array.isArray(shipDraft) && shipDraft.length){
    curSoId = String(shipDraft[0].so_id || "").trim().toUpperCase();
  }
  return curSoId;
}

function initShipDropdowns(){
  const soSel = document.getElementById("ship_so_id");
  if(soSel){
    const open = shipSalesOrders.filter(so => ["OPEN", "PARTIAL"].includes(String(so.status || "").trim().toUpperCase()));
    const customerMap = {};
    (shipCustomers || []).forEach(c => { if(c && c.customer_id) customerMap[c.customer_id] = c; });
    soSel.innerHTML =
      `<option value="">請選擇</option>` +
      open.map(so => `<option value="${so.so_id}">${escapeHtml_(shipSoOptLabel_(so, customerMap))}</option>`).join("");
  }

  // 客戶欄位已改為 hidden（由選擇 SO 自動帶出）；保留此處不再渲染下拉

  const soiSel = document.getElementById("ship_so_item_id");
  if(soiSel){
    soiSel.innerHTML = `<option value="">請先選擇銷售單</option>`;
  }

  const shipperSel = document.getElementById("ship_shipper_id");
  if(shipperSel){
    const roleZh = function(role){
      const r = String(role || "").trim().toUpperCase();
      if(r === "ADMIN") return "管理員";
      if(r === "CEO") return "CEO";
      if(r === "QA") return "品保";
      if(r === "OP") return "作業";
      if(r === "SL" || r === "SALES") return "業務";
      if(r === "WH" || r === "WAREHOUSE") return "倉管";
      if(r === "FN" || r === "FINANCE") return "財務";
      if(r === "GA" || r === "GENERAL_AFFAIRS") return "總務";
      return r || "—";
    };
    const act = (shipUsers || []).filter(u => String(u.status || "").toUpperCase() === "ACTIVE");
    act.sort((a,b)=>{
      const an = String(a.user_name || "").trim();
      const bn = String(b.user_name || "").trim();
      if(an && bn && an !== bn) return an.localeCompare(bn);
      return String(a.user_id || "").localeCompare(String(b.user_id || ""));
    });
    shipperSel.innerHTML =
      `<option value="">請選擇</option>` +
      act.map(u => {
        const name = String(u.user_name || "").trim();
        const rz = roleZh(u.role);
        const id = String(u.user_id || "").trim();
        const label = name ? `${rz}-${name}(${id})` : `${rz}(${id})`;
        return `<option value="${u.user_id}">${escapeHtml_(label)}</option>`;
      }).join("");
  }
}

function resetShipForm(){
  shipEditing = false;
  shipReadOnlyDraft = false;
  shipDraft = [];
  shipLoadedStatus_ = "OPEN";
  renderShipDraft();

  const idEl = document.getElementById("ship_id");
  if(idEl){
    // reset/清除：強制產生新單號（避免沿用剛載入的 shipment_id）
    erpInitAutoId_("ship_id", { gen: () => (typeof generateId === "function" ? generateId("SHIP") : ""), force: true });
    idEl.disabled = false;
  }

  const dateEl = document.getElementById("ship_date");
  if(dateEl) dateEl.value = nowIso16().slice(0, 10);

  shipClear_(["ship_remark", "ship_so_id", "ship_customer_id", "ship_shipper_id", "ship_recipient_id", "ship_recipient_name", "ship_recipient_name_en", "ship_recipient_address", "ship_recipient_phone", "ship_orderer_display", "ship_consignment_case_id"]);
  try{
    const shipperSel = document.getElementById("ship_shipper_id");
    const me = typeof getCurrentUser === "function" ? String(getCurrentUser() || "").trim() : "";
    if(shipperSel && me) shipperSel.value = me;
  }catch(_eShipper){}

  onSelectShipSO();
  clearShipItemEntry();
  syncErpQtyUnitSuffix_("ship_line_unit", "ship_qty_unit_suffix");
  updateShipStatusHint_();
  shipSyncLoadedFormLock_();
}

function clearShipItemEntry(){
  shipSelectedLineId_ = "";
  shipClear_([
    "ship_so_item_id",
    "ship_lot_id",
    "ship_lot_display",
    "ship_qty",
    "ship_line_unit",
    "ship_item_remark"
  ]);
  syncErpQtyUnitSuffix_("ship_line_unit", "ship_qty_unit_suffix");
  try{ shipUpdatePromoShipHint_(); }catch(_eHint){}
}

/** 從銷售明細快照推算買 N 送 M（舊單可能未存 promo_buy_qty） */
function shipInferPromoBuyFreeFromSoItem_(soi){
  if(!soi) return null;
  let buy = Number(soi.promo_buy_qty || 0);
  let free = Number(soi.promo_scheme_free_qty || 0);
  if(buy > 0 && free > 0) return { buy, free };

  const orderQty = Number(soi.order_qty || 0);
  const billable = soi.billable_qty != null ? Number(soi.billable_qty) : null;
  const freeQty = soi.free_qty != null ? Number(soi.free_qty) : null;
  if(!(orderQty > 0) || billable == null || freeQty == null || !(freeQty > 0)) return null;

  let best = null;
  for(let d = 1; d <= freeQty; d++){
    if(freeQty % d !== 0) continue;
    const freePerBundle = freeQty / d;
    const numBundles = d;
    if(billable % numBundles !== 0) continue;
    const buyPerBundle = billable / numBundles;
    if(!(buyPerBundle > 0)) continue;
    const bundle = buyPerBundle + freePerBundle;
    if(Math.abs(orderQty - numBundles * bundle) > 1e-9) continue;
    if(!best || bundle < best.bundle){
      best = { buy: buyPerBundle, free: freePerBundle, bundle };
    }
  }
  return best ? { buy: best.buy, free: best.free } : null;
}

function isShipDraftLineRow_(it){
  return String(it?.draft_id || "").startsWith("DRAFT-");
}

/** 明細列表「狀態」欄：草稿／已過帳／已作廢 */
function formatShipLineStatus_(it){
  if(isShipDraftLineRow_(it)) return "草稿";
  if(shipNormStatus_(shipLoadedStatus_) === "CANCELLED") return "已作廢";
  return "已過帳";
}

function shipIsVoidLoaded_(){
  return shipNormStatus_(shipLoadedStatus_) === "CANCELLED";
}

function selectShipDraftRow_(draftId){
  if(shipReadOnlyDraft) return;
  const id = String(draftId || "");
  const it = shipDraft.find(x => x.draft_id === id);
  if(!it) return;
  shipSelectedLineId_ = id;
  const soSel = document.getElementById("ship_so_id");
  if(soSel) soSel.value = it.so_id || "";
  onSelectShipSO();
  const soiSel = document.getElementById("ship_so_item_id");
  if(soiSel) soiSel.value = it.so_item_id || "";
  pickShipLineLot(it.lot_id);
  const qEl = document.getElementById("ship_qty");
  if(qEl) qEl.value = String(it.ship_qty ?? "");
  const rm = document.getElementById("ship_item_remark");
  if(rm) rm.value = String(it.remark || "");
  const hint =
    (typeof window.erpHintPickedLineText_ === "function")
      ? window.erpHintPickedLineText_({
          canEditStructure: true,
          needsEditItemsFirst: false,
          extraStructureHint: "改數量／Lot 請用「編輯」"
        })
      : "已帶入明細（僅改備註請按「儲存備註」；改數量／Lot 請用「編輯」）";
  showToast(hint);
}

function selectShipSavedRow_(shipmentItemId){
  if(!shipReadOnlyDraft) return;
  const id = String(shipmentItemId || "");
  const it = shipDraft.find(x => x.draft_id === id);
  if(!it) return;
  shipSelectedLineId_ = id;
  const rm = document.getElementById("ship_item_remark");
  if(rm) rm.value = String(it.remark || "");
  const pst = shipNormStatus_(shipLoadedStatus_) === "POSTED";
  if(pst){
    const hint2 =
      (typeof window.erpHintPickedLineText_ === "function")
        ? window.erpHintPickedLineText_({ canEditStructure: false })
        : "已帶入明細（僅改備註請按「儲存備註」）";
    showToast(hint2);
  }else{
    showToast("已帶入備註（此單非已出貨狀態，明細備註無法寫回；可改主檔備註）");
  }
}

function beginEditShipDraft_(draftId){
  if(shipReadOnlyDraft) return;
  const id = String(draftId || "");
  const it = shipDraft.find(x => x.draft_id === id);
  if(!it || !isShipDraftLineRow_(it)) return;
  shipDraft = shipDraft.filter(x => x.draft_id !== id);
  shipSelectedLineId_ = "";
  const soSel = document.getElementById("ship_so_id");
  if(soSel) soSel.value = it.so_id || "";
  onSelectShipSO();
  const soiSel = document.getElementById("ship_so_item_id");
  if(soiSel) soiSel.value = it.so_item_id || "";
  pickShipLineLot(it.lot_id);
  const qEl = document.getElementById("ship_qty");
  if(qEl) qEl.value = String(it.ship_qty ?? "");
  const rm = document.getElementById("ship_item_remark");
  if(rm) rm.value = String(it.remark || "");
  renderShipDraft();
}

async function updateSelectedShipItemRemark(triggerEl){
  const selId = String(shipSelectedLineId_ || "").trim();
  if(!selId) return showToast("請先點選一筆明細列", "error");
  const remark = (document.getElementById("ship_item_remark")?.value || "").trim();

  if(shipReadOnlyDraft){
    if(shipNormStatus_(shipLoadedStatus_) !== "POSTED"){
      return showToast("僅「已出貨」狀態可儲存明細備註；已作廢請僅使用主檔「儲存備註」。", "error");
    }
    showSaveHint(triggerEl || document.getElementById("shipPostButtonGroup"));
    try{
      await callAPI({
        action: "update_shipment_item_remark",
        shipment_item_id: selId,
        remark: remark,
        updated_by: getCurrentUser(),
        updated_at: nowIsoTaipei()
      }, { method: "POST" });
      const row = shipDraft.find(x => x.draft_id === selId);
      if(row) row.remark = remark;
      renderShipDraft();
      showToast("明細備註已儲存");
    }finally{
      hideSaveHint();
      setShipPickLotBtnState_();
    }
    return;
  }

  if(!isShipDraftLineRow_({ draft_id: selId })){
    return showToast("請點選草稿列（DRAFT-）", "error");
  }
  const row = shipDraft.find(x => x.draft_id === selId);
  if(!row) return showToast("找不到該筆草稿", "error");
  row.remark = remark;
  renderShipDraft();
  showToast("已更新草稿備註");
}

function clearShipLotEntryOnly_(){
  shipClear_(["ship_lot_id","ship_lot_display","ship_qty","ship_line_unit","ship_item_remark"]);
  syncErpQtyUnitSuffix_("ship_line_unit", "ship_qty_unit_suffix");
}

function shipSyncOrdererDisplay_(customerId){
  const el = document.getElementById("ship_orderer_display");
  if(!el) return;
  const cid = String(customerId || document.getElementById("ship_customer_id")?.value || "").trim();
  if(!cid){
    el.value = "";
    return;
  }
  const cust = (shipCustomers || []).find(c => String(c?.customer_id || "") === cid);
  el.value = cust ? (String(cust.customer_name || "").trim() || cid) : cid;
}

function shipRefreshRecipientDropdown_(customerId, selectedId){
  const sel = document.getElementById("ship_recipient_id");
  if(!sel) return;
  const cid = String(customerId || "").trim();
  const keep = String(selectedId || sel.value || "").trim().toUpperCase();
  if(!cid){
    sel.innerHTML = `<option value="">請先選擇銷售單</option>`;
    shipClear_(["ship_recipient_name", "ship_recipient_name_en", "ship_recipient_address", "ship_recipient_phone"]);
    return;
  }
  const cidU = cid.toUpperCase();
  const rows = (shipRecipientsAll || []).filter(r => String(r.customer_id || "").trim().toUpperCase() === cidU);
  if(!rows.length){
    sel.innerHTML = `<option value="">（此客戶尚無收件人，請至客戶主檔新增）</option>`;
    shipClear_(["ship_recipient_name", "ship_recipient_name_en", "ship_recipient_address", "ship_recipient_phone"]);
    return;
  }
  sel.innerHTML = `<option value="">請選擇收件人</option>` + rows.map(r => {
    const rid = String(r.recipient_id || "").trim();
    const label = shipFormatRecipientLabel_(r) || rid;
    return `<option value="${rid}">${label}</option>`;
  }).join("");
  if(keep && rows.some(r => String(r.recipient_id || "").trim().toUpperCase() === keep)){
    sel.value = rows.find(r => String(r.recipient_id || "").trim().toUpperCase() === keep).recipient_id;
  }else if(rows.length === 1){
    sel.value = rows[0].recipient_id || "";
  }
  onSelectShipRecipient_();
}

function onSelectShipRecipient_(){
  const rid = String(document.getElementById("ship_recipient_id")?.value || "").trim();
  if(!rid){
    shipClear_(["ship_recipient_name", "ship_recipient_name_en", "ship_recipient_address", "ship_recipient_phone"]);
    return;
  }
  const row = (shipRecipientsAll || []).find(r => String(r.recipient_id || "").trim() === rid);
  shipSetV_("ship_recipient_name", row?.recipient_name || "");
  shipSetV_("ship_recipient_name_en", row?.recipient_name_en || "");
  shipSetV_("ship_recipient_address", row?.address || "");
  shipSetV_("ship_recipient_phone", row?.phone || "");
}

function shipIsConsignmentSoSelected_(){
  const soId = shipResolveCurSoId_();
  if(!soId) return false;
  const so = (shipSalesOrders || []).find(x => String(x?.so_id || "").trim().toUpperCase() === soId);
  return String(so?.so_type || "").trim().toUpperCase() === "CONSIGNMENT";
}

async function shipRefreshConsignmentCaseDropdown_(customerId, presetCaseId){
  const row = document.getElementById("ship_consignment_case_row");
  const sel = document.getElementById("ship_consignment_case_id");
  if(!row || !sel) return;

  const isConsignment = shipIsConsignmentSoSelected_();
  if(!isConsignment){
    row.style.display = "none";
    sel.innerHTML = `<option value="">—</option>`;
    sel.value = "";
    return;
  }

  row.style.display = "";
  const cid = String(customerId || document.getElementById("ship_customer_id")?.value || "").trim().toUpperCase();
  if(!cid){
    sel.innerHTML = `<option value="">請先選擇銷售單</option>`;
    return;
  }

  sel.innerHTML = `<option value="">載入中…</option>`;
  try{
    if(typeof ccLoadMasterData_ === "function") await ccLoadMasterData_();
    const cases = (await ccListCasesForDropdown_({ status: "OPEN", customer_id: cid, limit: "200" })).filter(function (c) {
      return String(c.status || "").trim().toUpperCase() !== "CLOSED";
    });
    const preset = String(presetCaseId || "").trim().toUpperCase();
    if(!cases.length){
      sel.innerHTML = `<option value="">（此客戶尚無進行中寄賣案，請先到「案件」開案）</option>`;
      return;
    }
    sel.innerHTML =
      `<option value="">請選擇</option>` +
      cases.map(c => {
        const id = String(c.case_id || "").trim();
        const label = typeof ccFormatCaseDropdownLabel_ === "function" ? ccFormatCaseDropdownLabel_(c) : id;
        return `<option value="${escapeHtml_(id)}">${escapeHtml_(label)}</option>`;
      }).join("");
    if(preset && cases.some(c => String(c.case_id || "").trim().toUpperCase() === preset)){
      sel.value = preset;
    }
  }catch(_e){
    sel.innerHTML = `<option value="">載入失敗</option>`;
  }
}

function onSelectShipSO(){
  const soIdRaw = document.getElementById("ship_so_id")?.value || "";
  const soId = String(soIdRaw || "").trim().toUpperCase();
  const cSel = document.getElementById("ship_customer_id");
  const soiSel = document.getElementById("ship_so_item_id");
  if(!soiSel) return;

  if(!soId){
    soiSel.innerHTML = `<option value="">請先選擇銷售單</option>`;
    // 關鍵欄位變更：SO 清空時，同步清空依賴欄位，避免殘留不相容資料
    clearShipLotEntryOnly_();
    shipRefreshRecipientDropdown_("");
    shipSyncOrdererDisplay_("");
    shipRefreshConsignmentCaseDropdown_("").catch(function(){});
    return;
  }

  const so = shipSalesOrders.find(x => String(x?.so_id || "").trim().toUpperCase() === soId);
  if(so && cSel){
    cSel.value = so.customer_id || "";
  }
  shipSyncOrdererDisplay_(so?.customer_id || "");
  shipRefreshRecipientDropdown_(so?.customer_id || "");

  // 關鍵欄位變更：SO 改變時，清空「品項/Lot/數量」避免殘留不相容資料
  shipClear_("ship_so_item_id");
  clearShipLotEntryOnly_();
  try{ shipUpdatePromoShipHint_(); }catch(_eHint){}

  // 銷售品項改為按 SO 載入（非同步更新 dropdown）
  shipRefreshSoItemDropdown_(soId).catch(() => {
    soiSel.innerHTML = `<option value="">請先選擇銷售單</option>`;
  });
  shipRefreshConsignmentCaseDropdown_(so?.customer_id || "").catch(function(){});
}

function onSelectShipSOItem(){
  const soiSel = document.getElementById("ship_so_item_id");
  const opt = soiSel?.selectedOptions?.[0];
  if(!opt) return;
  // 此處不強制鎖 Lot，因為可能多批次出貨；但可用 remain 當提示
  // 關鍵欄位變更：品項改變時，清空 Lot/數量，避免舊 Lot 與新產品不一致
  clearShipLotEntryOnly_();
  try{ shipUpdateAllocModeUI_(); }catch(_e){}
  try{ shipUpdatePromoShipHint_(); }catch(_eHint){}
}

function onSelectShipLot(){
  const lotId = document.getElementById("ship_lot_id")?.value || "";
  const lot = (shipLots || []).find(l => String(l.lot_id || "") === String(lotId || ""));
  if(!lot){
    return;
  }
  // UX：Lot 切換時清空數量（避免殘留上一筆 qty）
  try{
    shipClear_("ship_qty");
  }catch(_e){}
  try{ shipUpdatePromoShipHint_(); }catch(_eHint){}
}

function shipOnShipQtyInput_(){
  try{ shipUpdatePromoShipHint_(); }catch(_e){}
}

function shipFmtPromoQtyUnit_(qty, unitSafe){
  const u = String(unitSafe || "").trim();
  return u ? `${qty} ${u}` : String(qty);
}

function shipFmtPromoMoney_(amount){
  const v = Math.round(Number(amount || 0) * 100) / 100;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function shipPromoBatchWarnText_(){
  return "※ 提醒：分批出貨將各批獨立計算買送，不跨出貨單累計，因此 AR 金額可能與銷售單不同。";
}

function shipShouldShowPromoBatchWarn_(qty, bundle){
  const q = Number(qty || 0);
  const b = Number(bundle || 0);
  if(!(q > 0) || !(b > 0)) return false;
  return (q % b) > 1e-9;
}

function shipUpdatePromoShipHint_(){
  const hintEl = document.getElementById("ship_promo_ship_hint");
  if(!hintEl) return;

  const soItemId = String(document.getElementById("ship_so_item_id")?.value || "").trim();
  const qty = Number(document.getElementById("ship_qty")?.value || 0);
  if(!soItemId){
    hintEl.style.display = "none";
    hintEl.textContent = "";
    return;
  }
  const soi = (shipSalesItems || []).find(x => String(x?.so_item_id || "").trim() === soItemId) || null;
  const promoType = String(soi?.promo_type || "").trim().toUpperCase();
  if(promoType !== "BUY_N_GET_M"){
    hintEl.style.display = "none";
    hintEl.textContent = "";
    return;
  }

  const inferred = shipInferPromoBuyFreeFromSoItem_(soi);
  const buy = inferred ? inferred.buy : 0;
  const free = inferred ? inferred.free : 0;
  const unit = String(soi?.unit || "").trim();
  const unitSafe = unit ? unit.replace(/</g, "") : "";
  const schemeName = String(soi?.promo_scheme_name || "").trim();
  const orderQty = Number(soi?.order_qty || 0);
  const soBillable = soi?.billable_qty != null ? Number(soi.billable_qty) : null;
  const soFree = soi?.free_qty != null ? Number(soi.free_qty) : null;
  const remain = Math.max(0, orderQty - Number(soi?.shipped_qty || 0));
  const lines = [];

  if(!(buy > 0 && free > 0)){
    const snapParts = [];
    if(schemeName) snapParts.push(schemeName);
    if(soBillable != null && soFree != null && orderQty > 0){
      snapParts.push(`整單計價 ${shipFmtPromoQtyUnit_(soBillable, unitSafe)}、贈送 ${shipFmtPromoQtyUnit_(soFree, unitSafe)}`);
    }
    if(remain > 0 && remain < orderQty){
      snapParts.push(`尚餘未出 ${shipFmtPromoQtyUnit_(remain, unitSafe)}`);
    }
    lines.push(snapParts.length ? snapParts.join("｜") : "此品項為買送促銷。");
    lines.push(shipPromoBatchWarnText_());
    hintEl.style.display = "block";
    hintEl.textContent = lines.join("\n");
    return;
  }

  const bundle = buy + free;
  const q = Number.isFinite(qty) ? qty : 0;
  const head = [schemeName, `買${buy}送${free}（${shipFmtPromoQtyUnit_(bundle, unitSafe)}一組）`].filter(Boolean).join("｜");
  lines.push(head);

  if(!(q > 0)){
    hintEl.style.display = "block";
    hintEl.textContent = lines.join("\n");
    return;
  }

  const freeQty = Math.floor(q / bundle + 1e-9) * free;
  const billableQty = q - freeQty;
  const up = Number(soi?.unit_price || 0);
  const amount = (up > 0) ? Math.round(billableQty * up * 100) / 100 : null;
  let batchLine = `本批出貨 ${shipFmtPromoQtyUnit_(q, unitSafe)}：計價 ${shipFmtPromoQtyUnit_(billableQty, unitSafe)}、贈送 ${shipFmtPromoQtyUnit_(freeQty, unitSafe)}`;
  if(amount != null) batchLine += `，預估金額 ${shipFmtPromoMoney_(amount)}`;
  batchLine += "。";
  lines.push(batchLine);

  if(shipShouldShowPromoBatchWarn_(q, bundle)){
    lines.push(shipPromoBatchWarnText_());
  }

  hintEl.style.display = "block";
  hintEl.textContent = lines.join("\n");
}

async function addShipItemDraft(){
  if(shipReadOnlyDraft) return showToast("已載入出貨單，明細僅供檢視","error");
  const so_id = document.getElementById("ship_so_id")?.value || "";
  const so_item_id = document.getElementById("ship_so_item_id")?.value || "";
  const lot_id = document.getElementById("ship_lot_id")?.value || "";
  const qty = Number(document.getElementById("ship_qty")?.value || 0);
  const remark = (document.getElementById("ship_item_remark")?.value || "").trim();

  if(!String(so_id || "").trim()) return showToast("請選擇 銷售單", "error");
  if(!String(so_item_id || "").trim()) return showToast("請選擇 銷售品項", "error");
  if(!qty || qty <= 0) return showToast("出貨數量需大於 0","error");
  const auto = shipIsAutoAlloc_();
  if(so_id){
    try{
      await shipLoadSalesItemsBySo_(so_id);
      const id = String(so_id || "").trim().toUpperCase();
      if(Array.isArray(shipSalesItemsBySoId_?.[id])) shipSalesItems = shipSalesItemsBySoId_[id];
    }catch(_e){}
  }
  const soi = (shipSalesItems || []).find(x => x.so_item_id === so_item_id) || null;
  if(!soi) return showToast("找不到該銷售品項（請重新選擇銷售單/品項）", "error");

  if(auto){
    const pid = String(soi.product_id || "").trim();
    if(!pid) return showToast("銷售品項缺少 product_id", "error");
    const remain = Math.max(0, Number(soi.order_qty||0) - Number(soi.shipped_qty||0));
    if(qty > remain) return showToast("出貨不可超過銷售單剩餘未出貨量","error");

    const alloc = shipAutoAllocateLots_(pid, qty);
    if(alloc.shortage > 1e-9){
      return showToast(`可用量不足，尚缺 ${Math.round(Number(alloc.shortage||0)*10000)/10000}`, "error");
    }
    if(!alloc.lines.length){
      return showToast("查無可用 Lot（需 ACTIVE + QA放行 + 可用量>0，且未過期）", "error");
    }

    for(const x of alloc.lines){
      const lot = x.lot;
      shipDraft.push({
        draft_id: "DRAFT-" + Date.now() + "-" + Math.floor(Math.random()*1000),
        so_id,
        so_item_id,
        lot_id: lot.lot_id,
        product_id: lot.product_id,
        warehouse_id: String(lot.warehouse_id || "").trim().toUpperCase(),
        ship_qty: x.qty,
        unit: lot.unit || "",
        remark
      });
    }
    clearShipItemEntry();
    renderShipDraft();
    showToast(`已自動分配 ${alloc.lines.length} 筆 Lot（FEFO）`);
    return;
  }

  // 手動 override
  if(!lot_id) return showToast("請選擇 Lot","error");
  const lot = shipLots.find(l => l.lot_id === lot_id);
  if(!lot) return showToast("找不到 Lot","error");
  const av = shipGetAvailable(lot_id);
  if(typeof invIsMissingMovement_ === "function" && invIsMissingMovement_(av)){
    return showToast("此 Lot 缺 movement（請先補齊入庫/異動紀錄）", "error");
  }
  if(qty > av) return showToast("出貨不可超過可用量","error");
  if(so_id && so_item_id && soi){
    const remain = Math.max(0, Number(soi.order_qty||0) - Number(soi.shipped_qty||0));
    if(qty > remain) return showToast("出貨不可超過銷售單剩餘未出貨量","error");
    if(lot.product_id !== soi.product_id) return showToast("Lot 產品與銷售品項不一致","error");
  }
  shipDraft.push({
    draft_id: "DRAFT-" + Date.now() + "-" + Math.floor(Math.random()*1000),
    so_id,
    so_item_id,
    lot_id,
    product_id: lot.product_id,
    warehouse_id: String(lot.warehouse_id || "").trim().toUpperCase(),
    ship_qty: qty,
    unit: lot.unit || "",
    remark
  });

  clearShipItemEntry();
  renderShipDraft();
}

function removeShipDraft(draftId){
  if(shipReadOnlyDraft) return;
  shipDraft = shipDraft.filter(x => x.draft_id !== draftId);
  renderShipDraft();
}

function renderShipDraft(){
  const tbody = document.getElementById("shipItemsBody");
  if(!tbody) return;
  tbody.innerHTML = "";

  // 依銷售單明細彙總：訂購 / 已出 / 未出（草稿：出貨前；過帳：出貨後，因 shipped_qty 已回寫）
  const curSoId = shipResolveCurSoId_();
  const soItems =
    (curSoId && shipSalesItemsBySoId_ && Array.isArray(shipSalesItemsBySoId_[curSoId])) ? shipSalesItemsBySoId_[curSoId] :
    (Array.isArray(shipSalesItems) ? shipSalesItems.filter(x => String(x?.so_id || "").trim().toUpperCase() === curSoId) : []);
  const soAggByProduct = {};
  (soItems || []).forEach(it=>{
    const pid = String(it?.product_id || "").trim().toUpperCase();
    if(!pid) return;
    if(!soAggByProduct[pid]) soAggByProduct[pid] = { order: 0, shipped: 0, unit: String(it?.unit || "").trim() };
    soAggByProduct[pid].order += Number(it?.order_qty || 0);
    soAggByProduct[pid].shipped += Number(it?.shipped_qty || 0);
    if(!soAggByProduct[pid].unit) soAggByProduct[pid].unit = String(it?.unit || "").trim();
  });
  const soAggBySoItem = {};
  (soItems || []).forEach(it=>{
    const sid = String(it?.so_item_id || "").trim().toUpperCase();
    if(!sid) return;
    soAggBySoItem[sid] = it;
  });

  shipDraft.forEach((it, idx) => {
    const lot = (shipLots || []).find(l => String(l?.lot_id || "") === String(it?.lot_id || "")) || null;
    const safeId = String(it.draft_id || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const isDraft = isShipDraftLineRow_(it);
    let rowClick = "";
    let actionBtn = "";
    if(shipReadOnlyDraft){
      rowClick = `onclick="selectShipSavedRow_('${safeId}')"`;
      actionBtn = "—";
    }else if(isDraft){
      rowClick = `onclick="selectShipDraftRow_('${safeId}')"`;
      actionBtn =
        `<button type="button" class="btn-secondary" onclick="event.stopPropagation(); beginEditShipDraft_('${safeId}')">編輯</button> ` +
        `<button type="button" class="btn-secondary" onclick="event.stopPropagation(); removeShipDraft('${safeId}')">刪除</button>`;
    }else{
      actionBtn = `<button type="button" class="btn-secondary" onclick="removeShipDraft('${safeId}')">刪除</button>`;
    }
    const u = String(it.unit || "").trim();
    const shipQtyCell = u ? `${it.ship_qty} ${u.replace(/</g, "")}` : String(it.ship_qty);
    const pid = String(it.product_id || "").trim().toUpperCase();
    const soItem = soAggBySoItem[String(it.so_item_id || "").trim().toUpperCase()] || null;
    let agg = soAggByProduct[pid] || null;
    if(!agg && soItem){
      agg = {
        order: Number(soItem.order_qty || 0),
        shipped: Number(soItem.shipped_qty || 0),
        unit: String(soItem.unit || u || "").trim()
      };
    }
    const whId = String(it.warehouse_id || lot?.warehouse_id || "").trim().toUpperCase();
    const soUnit = String((agg && agg.unit) || u || "").trim();
    const orderQty = agg ? Number(agg.order || 0) : 0;
    const shippedQty = agg ? Number(agg.shipped || 0) : 0;
    const remainQty = agg ? Math.max(0, orderQty - shippedQty) : 0;
    const orderDisp = agg ? (soUnit ? `${orderQty} ${soUnit}` : String(orderQty)) : "—";
    const shippedDisp = agg ? (soUnit ? `${shippedQty} ${soUnit}` : String(shippedQty)) : "—";
    const remainDisp = agg ? (soUnit ? `${remainQty} ${soUnit}` : String(remainQty)) : "—";
    const lineStatus = formatShipLineStatus_(it);
    const voidRow = shipIsVoidLoaded_();
    const rowClass = voidRow ? " ship-item-row-void" : "";
    const statusClass = voidRow ? " ship-line-status-void" : "";
    tbody.innerHTML += `
      <tr class="${rowClass.trim()}" style="${rowClick ? "cursor:pointer;" : ""}" ${rowClick}>
        <td>${idx+1}</td>
        <td>
          <div style="font-size:12px; font-weight:700; line-height:1.1;">${escapeHtml_(String(it.lot_id || ""))}</div>
          <div style="font-size:12px; color:#334155; line-height:1.2; margin-top:2px;">${escapeHtml_(String(formatShipProductDisplay_(it.product_id) || ""))}</div>
        </td>
        <td>${shipWarehouseLabelById_(whId) || "—"}</td>
        <td>${escapeHtml_(orderDisp)}</td>
        <td>${escapeHtml_(shippedDisp)}</td>
        <td>${escapeHtml_(remainDisp)}</td>
        <td>${shipQtyCell}</td>
        <td class="${statusClass.trim()}">${escapeHtml_(lineStatus)}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  });
}

function resetShipmentSearch(){
  shipClear_(["ship_search_keyword","ship_search_status"]);
  renderShipments();
}

function shipStatusZh_(status){
  const s = String(status || "").trim().toUpperCase();
  if(s === "POSTED") return "已出貨";
  if(s === "CANCELLED") return "已作廢";
  return (typeof termLabelZhOnly === "function" ? termLabelZhOnly(s) : s) || s;
}

function shipSoTypeLabelZh_(soType){
  const t = String(soType || "NORMAL").trim().toUpperCase();
  if(t === "CONSIGNMENT") return "寄賣";
  if(t === "NORMAL") return "一般";
  return (typeof termLabelZhOnly === "function" ? termLabelZhOnly(t) : t) || t || "—";
}

async function renderShipments(){
  const tbody = document.getElementById("shipTableBody");
  if(!tbody) return;

  setTbodyLoading_(tbody, 7);
  const qKw = (document.getElementById("ship_search_keyword")?.value || "").trim().toUpperCase();
  const qSt = (document.getElementById("ship_search_status")?.value || "").trim().toUpperCase();

  let list = [];
  try{
    const r = await callAPI({ action: "list_shipment_recent", days: 180, _ts: String(Date.now()) }, { method: "POST" });
    list = (r && r.data) ? r.data : [];
  }catch(_e){
    list = await getAll("shipment").catch(()=>[]);
  }
  const customerMap = {};
  (shipCustomers || []).forEach(c => { if(c && c.customer_id) customerMap[c.customer_id] = c; });
  const soMap = {};
  (shipSalesOrders || []).forEach(so => { if(so && so.so_id) soMap[String(so.so_id)] = so; });
  const userMap = {};
  (shipUsers || []).forEach(u => { if(u && u.user_id) userMap[String(u.user_id)] = u; });
  const filtered = typeof erpSortRowsNewestFirst_ === "function"
    ? erpSortRowsNewestFirst_(
        (list || []).filter(s => {
          const stOk = !qSt || String(s.status||"").toUpperCase() === qSt;
          if(!stOk) return false;
          if(!qKw) return true;
          const sid = String(s.shipment_id||"").toUpperCase();
          const cid = String(s.customer_id||"").toUpperCase();
          const soid = String(s.so_id||"").toUpperCase();
          const cn = String(customerMap[s.customer_id]?.customer_name || "").toUpperCase();
          return sid.includes(qKw) || cid.includes(qKw) || (cn && cn.includes(qKw)) || soid.includes(qKw);
        }),
        ["ship_date", "created_at"],
        "shipment_id"
      )
    : (list || []).filter(s => {
        const stOk = !qSt || String(s.status||"").toUpperCase() === qSt;
        if(!stOk) return false;
        if(!qKw) return true;
        const sid = String(s.shipment_id||"").toUpperCase();
        const cid = String(s.customer_id||"").toUpperCase();
        const soid = String(s.so_id||"").toUpperCase();
        const cn = String(customerMap[s.customer_id]?.customer_name || "").toUpperCase();
        return sid.includes(qKw) || cid.includes(qKw) || (cn && cn.includes(qKw)) || soid.includes(qKw);
      }).sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||"")));

  if(typeof invRefreshCiMap_ === "function") await invRefreshCiMap_();

  const showActionsCol = filtered.some(s => {
    const st = String(s.status || "").trim().toUpperCase();
    if(st !== "POSTED") return false;
    const c = customerMap[s.customer_id] || null;
    const needsCi = typeof invShipmentNeedsCi_ === "function"
      ? invShipmentNeedsCi_(c)
      : !(String(c?.country || "").trim() === "台灣" || String(c?.country || "").trim() === "Taiwan" || String(c?.country || "").trim() === "TW");
    return needsCi;
  });
  const listTable = document.getElementById("ship_list_table");
  if(listTable){
    listTable.classList.toggle("ship-list-hide-actions", !showActionsCol);
  }

  tbody.innerHTML = "";
  filtered.forEach(s => {
    const c = customerMap[s.customer_id] || null;
    const customerNameOnly = (c && c.customer_name) ? c.customer_name : (s.customer_id || "");
    const so = soMap[String(s.so_id || "")] || null;
    const spId = String(so?.salesperson_id || "").trim();
    const spUser = spId ? (userMap[spId] || null) : null;
    const sp = spUser ? (String(spUser.user_name || "").trim() || spId) : (spId || "—");
    const shipperId = String(s?.shipper_id || "").trim();
    const shipperUser = shipperId ? (userMap[shipperId] || null) : null;
    const shipper = shipperUser ? (String(shipperUser.user_name || "").trim() || shipperId) : (shipperId || "—");
    const st = String(s.status || "").trim().toUpperCase();
    const sid = String(s.shipment_id || "");
    const soId = String(s.so_id || "");
    const typeLabel = shipSoTypeLabelZh_(so?.so_type);
    const ciLabel = typeof invCiListLabel_ === "function" ? invCiListLabel_(s) : "—";
    const needsCi = typeof invShipmentNeedsCi_ === "function"
      ? invShipmentNeedsCi_(c)
      : !(String(c?.country || "").trim() === "台灣" || String(c?.country || "").trim() === "Taiwan" || String(c?.country || "").trim() === "TW");
    const ciBtn = showActionsCol && st === "POSTED" && needsCi
      ? `<button class="btn-secondary" type="button" onclick="navigateOpenInvoice_('${sid.replace(/'/g, "\\'")}')">CI</button>`
      : "";
    const selId = String(document.getElementById("ship_id")?.value || "").trim().toUpperCase();
    const open = typeof erpListRowOpenInRender_ === "function"
      ? erpListRowOpenInRender_("shipping", selId, sid.trim().toUpperCase())
      : selId === sid.trim().toUpperCase();
    const voidRow = st === "CANCELLED";
    tbody.innerHTML += `
      <tr class="erp-list-row-selectable${open ? " erp-list-row-open" : ""}${voidRow ? " erp-list-row-void" : ""}" data-row-id="${sid.replace(/"/g, "&quot;")}" onclick="loadShipment('${sid.replace(/'/g, "\\'")}')">
        <td class="logs-stack-cell">
          <div class="logs-stack-main ship-list-id">${escapeHtml_(sid)}</div>
          <div class="logs-stack-sub">${escapeHtml_(soId || "—")}</div>
        </td>
        <td>${escapeHtml_(customerNameOnly)}</td>
        <td>${escapeHtml_(sp)}</td>
        <td class="logs-stack-cell">
          <div class="logs-stack-main">${escapeHtml_(dateInputValue_(s.ship_date) || "—")}</div>
          <div class="logs-stack-sub">${escapeHtml_(shipper)}</div>
        </td>
        <td class="logs-stack-cell">
          <div class="logs-stack-main${voidRow ? " ship-status-void" : ""}">${escapeHtml_(shipStatusZh_(s.status))}</div>
          <div class="logs-stack-sub">${escapeHtml_(typeLabel)}</div>
        </td>
        <td>${escapeHtml_(ciLabel)}</td>
        ${showActionsCol ? `<td class="ship-col-actions" onclick="event.stopPropagation()">
          <span class="ship-list-actions">${ciBtn}</span>
        </td>` : ""}
      </tr>
    `;
  });
}

async function loadShipment(shipmentId, triggerEl){
  const id = String(shipmentId || "").trim().toUpperCase();
  if(!id) return;
  const curShip = String(document.getElementById("ship_id")?.value || "").trim().toUpperCase();
  if(shipEditing && typeof erpListRowToggleClose_ === "function" && erpListRowToggleClose_(curShip, id)){
    if(typeof erpTryToggleCloseTxnListRow_ === "function" && erpTryToggleCloseTxnListRow_("shipping", curShip, id, "shipTableBody")) return;
  }else if(typeof erpClearTxnListRowCollapsed_ === "function"){
    erpClearTxnListRowCollapsed_("shipping");
  }
  if(shipLoadInFlight_){
    shipPendingLoadId_ = id;
    // 避免 Toast 被「載入中」進度提示蓋掉造成一閃而過：改用狀態列提示
    try{
      const stEl = document.getElementById("shipStatusHint");
      if(stEl) stEl.textContent = `出貨流程：載入中 — 已排隊 ${id}（完成後自動載入）`;
    }catch(_eHint){}
    return;
  }
  shipLoadInFlight_ = true;
  try{
    if(typeof erpBeginLoadWarnToast_ === "function"){
      shipLoadWarnToken_ = erpBeginLoadWarnToast_(`載入中...請稍等（${id}）`);
    }
  }catch(_eWarn){}
  try{
    const postBtn = document.getElementById("ship_post_btn");
    const cancelBtn = document.getElementById("ship_cancel_btn");
    if(postBtn){
      postBtn.disabled = true;
      postBtn.title = "載入中，請稍候…";
    }
    if(cancelBtn){
      cancelBtn.disabled = true;
      cancelBtn.title = "載入中，請稍候…";
    }
  }catch(_eLock){}
  try{
    if(triggerEl) triggerEl.disabled = true;
    shipShowLoadProgressToast_(id);
  }catch(_e){}
  try{
    const stEl = document.getElementById("shipStatusHint");
    const invEl = document.getElementById("shipInvState");
    if(stEl) stEl.textContent = `出貨流程：載入中 — ${id}`;
    if(invEl){
      invEl.textContent = "扣庫狀態：載入中…";
      invEl.style.color = "#92400e";
    }
  }catch(_eHint){}
  if(typeof scrollToEditorTop === "function") scrollToEditorTop();
  let loadedOk_ = false;
  try{
    await loadShipMasterData();

    const sh = await getOne("shipment","shipment_id",id).catch(()=>null);
    if(!sh) return showToast("找不到出貨單","error");

  let items = [];
  try{
    const r = await callAPI({ action: "list_shipment_item_by_shipment", shipment_id: id });
    items = (r && r.data) ? r.data : [];
  }catch(_e){
    // fallback：舊版後端尚未支援時，退回全表抓取（但只取該出貨單相關資料）
    const itemsAll = await getAll("shipment_item").catch(()=>[]);
    items = (itemsAll || []).filter(x => String(x.shipment_id || "").trim().toUpperCase() === id);
  }

  shipEditing = true;
  shipReadOnlyDraft = true;
  shipLoadedStatus_ = shipNormStatus_(sh.status || "OPEN");

  const idEl = document.getElementById("ship_id");
  if(idEl){
    idEl.value = sh.shipment_id || id;
    idEl.disabled = true;
  }
  await shipEnsureSoInDropdown_(sh.so_id);
  document.getElementById("ship_so_id").value = sh.so_id || "";
  onSelectShipSO();
  document.getElementById("ship_customer_id").value = sh.customer_id || "";
  shipSyncOrdererDisplay_(sh.customer_id || "");
  shipRefreshRecipientDropdown_(sh.customer_id || "", sh.recipient_id || "");
  shipSetV_("ship_recipient_name", sh.recipient_name || "");
  shipSetV_("ship_recipient_name_en", sh.recipient_name_en || "");
  shipSetV_("ship_recipient_address", sh.recipient_address || "");
  shipSetV_("ship_recipient_phone", sh.recipient_phone || "");
    document.getElementById("ship_date").value = dateInputValue_(sh.ship_date);
    shipSetV_("ship_shipper_id", sh.shipper_id || "");
  document.getElementById("ship_remark").value = sh.remark || "";
  await shipRefreshConsignmentCaseDropdown_(sh.customer_id || "", sh.consignment_case_id || "");

  clearShipLotEntryOnly_();
  shipSelectedLineId_ = "";
  shipDraft = items.map(it => ({
    draft_id: it.shipment_item_id,
    so_id: it.so_id || "",
    so_item_id: it.so_item_id || "",
    lot_id: it.lot_id,
    product_id: it.product_id,
    ship_qty: Number(it.ship_qty || 0),
    unit: it.unit || "",
    remark: it.remark || ""
  }));
  renderShipDraft();
  // 補抓 SO 明細（用於 訂購/已出/未出 欄位），避免只載入出貨單時顯示「—」
  try{
    const soId = String(sh.so_id || "").trim().toUpperCase();
    if(soId){
      const loaded = await shipLoadSalesItemsBySo_(soId).catch(()=>[]);
      shipSalesItems = Array.isArray(loaded) ? loaded : [];
      renderShipDraft();
    }
  }catch(_eSoItems){}

    // Load 採單一進度提示（由 shipStatusHint/shipInvState 顯示），這裡不再額外跳 Toast
    updateShipStatusHint_();
    shipSyncLoadedFormLock_();
    shipShowLoadDoneToast_(id);
    loadedOk_ = true;
  } catch(err){
    try{
      shipClearToast_();
      if(!(err && err.erpApiToastShown) && typeof showToast === "function"){
        showToast("載入失敗：請稍後重試", "error");
      }
    }catch(_eToast){}
    // 失敗也要收尾，避免狀態文字卡在「載入中」
    try{
      updateShipStatusHint_();
      setShipButtons_();
    }catch(_eRecover){}
  }finally{
    try{
      if(typeof erpEndLoadWarnToast_ === "function"){
        erpEndLoadWarnToast_(shipLoadWarnToken_);
      }
      shipLoadWarnToken_ = "";
    }catch(_eWarnEnd){}
    try{ if(triggerEl) triggerEl.disabled = false; }catch(_e2){}
    // Load 不使用「儲存中」提示；最後再依目前單據狀態重算按鈕狀態
    try{ setShipButtons_(); }catch(_e3){}
    if(loadedOk_ && typeof erpSyncListRowHighlight_ === "function"){
      erpSyncListRowHighlight_("shipTableBody", "data-row-id", id);
    }
    try{
      if(!loadedOk_){
        updateShipStatusHint_();
      }
    }catch(_e4){}
    shipLoadInFlight_ = false;

    // 若載入期間又點了其他單號，完成後自動載入最後一次點選的單號
    try{
      const nextId = String(shipPendingLoadId_ || "").trim().toUpperCase();
      shipPendingLoadId_ = "";
      if(nextId && nextId !== id){
        // 避免同步遞迴造成 UI 卡住，讓事件迴圈先跑完
        setTimeout(function(){
          try{ loadShipment(nextId); }catch(_e){}
        }, 0);
      }
    }catch(_eNext){}
  }
}

async function cancelShipment(triggerEl){
  if(shipLoadInFlight_){
    return showToast("單據載入中，暫時不可作廢", "error");
  }
  if(shipCancelInFlight_){
    return showToast("作廢處理中，請稍候…","error");
  }
  const shipment_id = (document.getElementById("ship_id")?.value || "").trim().toUpperCase();
  if(!shipment_id) return showToast("請先載入出貨單","error");

  const sh = await getOne("shipment","shipment_id",shipment_id).catch(()=>null);
  if(!sh) return showToast("找不到出貨單","error");

  const st = shipNormStatus_(sh.status || "");
  if(st === "CANCELLED") return showToast("此出貨單已作廢","error");
  if(st !== "POSTED") return showToast("僅 POSTED 出貨單可作廢","error");

  const ciBlockMsg = await shipCiVoidBlockMessage_(shipment_id);
  if(ciBlockMsg) return showToast(ciBlockMsg, "error", 9000);

  const ok = window.erpConfirmActionKey_("confirm.cancel.shipment", {
    fallback: "確定要作廢這張出貨單？\n\n作廢後系統會：\n- 把已扣掉的庫存加回來\n- 同步更新銷售單的「已出貨量」\n\n作廢後此出貨單會顯示為「已作廢」。"
  });
  if(!ok) return;

  shipCancelInFlight_ = true;
  showSaveHint(triggerEl || document.getElementById("shipPostButtonGroup"));
  try{
    await callAPI({
      action: "cancel_shipment_bundle",
      shipment_id: shipment_id,
      idempotency_key: shipBuildIdempotencyKey_("SHIP_CANCEL", [shipment_id]),
      updated_by: getCurrentUser(),
      updated_at: nowIsoTaipei()
    }, { method: "POST" });

    invalidateShipCaches_();

    showToast("作廢完成：這筆出貨已取消，畫面資料已同步更新", "success", 6000);
    await loadShipMasterData();
    await renderShipments();
    await loadShipment(shipment_id);
  } catch(err){
    if (shipShouldAutoReloadAfterError_(err)) {
      await shipAutoReloadAfterConflict_(shipment_id);
      return;
    }
    if(!(err && err.erpApiToastShown)){
      const em = String(err && err.message || "");
      if(em.includes("ERR_CI_NOT_VOID")){
        showToast(shipCiVoidBlockMessageFromApi_(em), "error", 9000);
      }else if(/ERR_CONSIGNMENT_CASE_SETTLED/i.test(em)){
        showToast(typeof formatCallApiUserMessage_ === "function" ? formatCallApiUserMessage_(err) : em, "error", 9000);
      }else if(/ERR_CONSIGNMENT_CASE_RETURNED/i.test(em)){
        showToast(typeof formatCallApiUserMessage_ === "function" ? formatCallApiUserMessage_(err) : em, "error", 9000);
      }else{
        showToast("作廢失敗：請稍後重試；若仍失敗請重新載入後再試", "error");
      }
    }
  } finally {
    shipCancelInFlight_ = false;
    hideSaveHint();
  }
}

async function shipCiVoidBlockMessage_(shipmentId){
  const id = String(shipmentId || "").trim().toUpperCase();
  if(!id) return "";
  try{
    const r = await callAPI({ action: "list_commercial_invoice_by_shipment", shipment_id: id }, { method: "GET" });
    const ci = r?.data || null;
    if(!ci) return "";
    const ciSt = String(ci.status || "").trim().toUpperCase();
    if(ciSt === "VOID") return "";
    const ciNo = String(ci.ci_no || "").trim();
    return ciNo
      ? "此出貨單已有商業發票「" + ciNo + "」尚未作廢，請先到 Invoice 商業發票作廢 CI 後再作廢出貨"
      : "此出貨單已有商業發票尚未作廢，請先到 Invoice 商業發票作廢 CI 後再作廢出貨";
  }catch(_e){
    return "";
  }
}

function shipCiVoidBlockMessageFromApi_(errMsg){
  const m = String(errMsg || "");
  const match = m.match(/Commercial Invoice\s+(\S+)\s+must be voided/i);
  if(match && match[1]){
    return "此出貨單已有商業發票「" + match[1] + "」尚未作廢，請先到 Invoice 商業發票作廢 CI 後再作廢出貨";
  }
  return "此出貨單已有商業發票尚未作廢，請先到 Invoice 商業發票作廢 CI 後再作廢出貨";
}

async function postShipment(triggerEl){
  if(shipPostInFlight_){
    return showToast("過帳處理中，請稍候…","error");
  }
  const shipment_id = (document.getElementById("ship_id")?.value || "").trim().toUpperCase();
  document.getElementById("ship_id").value = shipment_id;

  const so_id = document.getElementById("ship_so_id")?.value || "";
  const customer_id = document.getElementById("ship_customer_id")?.value || "";
  const ship_date = document.getElementById("ship_date")?.value || "";
  const shipper_id = document.getElementById("ship_shipper_id")?.value || "";
  const remark = (document.getElementById("ship_remark")?.value || "").trim();
  const recipient_id = String(document.getElementById("ship_recipient_id")?.value || "").trim().toUpperCase();
  const recipient_name = String(document.getElementById("ship_recipient_name")?.value || "").trim();
  const recipient_name_en = String(document.getElementById("ship_recipient_name_en")?.value || "").trim();
  const recipient_address = String(document.getElementById("ship_recipient_address")?.value || "").trim();
  const recipient_phone = String(document.getElementById("ship_recipient_phone")?.value || "").trim();

  const missing = [];
  if(!shipment_id) missing.push("出貨單ID");
  if(!String(so_id || "").trim()) missing.push("銷售單");
  if(!customer_id) missing.push("客戶");
  if(!recipient_id) missing.push("收件人");
  if(!ship_date) missing.push("出貨日期");
  if(!String(shipper_id || "").trim()) missing.push("出貨人員");
  if(shipDraft.length === 0) missing.push("出貨明細（至少 1 筆）");
  if(missing.length) return showToast("缺少必填：" + missing.join("、"), "error");

  if(shipIsConsignmentSoSelected_()){
    const ccId = String(document.getElementById("ship_consignment_case_id")?.value || "").trim().toUpperCase();
    if(!ccId) return showToast("寄賣出貨須選擇寄賣案", "error");
  }

  shipPostInFlight_ = true;
  showSaveHint(triggerEl || document.getElementById("shipPostButtonGroup"));
  try {
  // refresh（避免用舊 lot/可用量 做前置檢查）
  await loadShipMasterData();

  const payloadItems = (shipDraft || []).map((it) => ({
    so_id: it.so_id || so_id || "",
    so_item_id: it.so_item_id || "",
    lot_id: it.lot_id,
    product_id: it.product_id,
    ship_qty: String(it.ship_qty),
    unit: it.unit,
    remark: it.remark || ""
  }));

  await callAPI({
    action: "post_shipment_bundle",
    shipment_id,
    so_id,
    customer_id,
    ship_date,
    shipper_id,
    remark,
    recipient_id,
    recipient_name,
    recipient_name_en,
    recipient_address,
    recipient_phone,
    consignment_case_id: String(document.getElementById("ship_consignment_case_id")?.value || "").trim().toUpperCase(),
    expected_existed_shipment_item_count: "0",
    idempotency_key: shipBuildIdempotencyKey_("SHIP_POST", [shipment_id, so_id, ship_date, shipper_id, payloadItems]),
    created_by: getCurrentUser(),
    created_at: nowIsoTaipei(),
    items_json: JSON.stringify(payloadItems)
  }, { method: "POST" });

  // bundle 會更新：shipment/shipment_item/inventory_movement/sales_order_item/sales_order/lot.inventory_status
  invalidateShipCaches_();

  showToast("出貨完成：已建立出貨紀錄，畫面資料已同步更新", "success", 6000);
  resetShipForm();
  await loadShipMasterData();
  await renderShipments();
  } catch(err){
    if (shipShouldAutoReloadAfterError_(err)) {
      await shipAutoReloadAfterConflict_(shipment_id);
      return;
    }
    if(!(err && err.erpApiToastShown)){
      showToast("出貨失敗：請稍後重試；若仍失敗請重新載入後再試", "error");
    }
  } finally {
    shipPostInFlight_ = false;
    hideSaveHint();
  }
}

