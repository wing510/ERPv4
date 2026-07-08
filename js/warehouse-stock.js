/**
 * Warehouse 倉庫庫存（含有效期限）
 * - 依倉別查看產品彙總 / Lot 明細
 * - 可用量：inventory_movement 依 lot_id 加總
 * - 到期：expiry_date 當天 23:59:59 視為有效期限截止
 */

let wsWarehouses = [];
let wsLots = [];
let wsProducts = [];
let wsMovementLoadFailed = false;
let wsAvailableByLotIdMap_ = {};
let wsLoadedAt_ = 0;
let wsReloading_ = false;
let wsExpandedDetailId_ = "";

function wsSetV_(id, v){
  try{
    if(typeof window.erpSetVById_ === "function") return window.erpSetVById_(id, v);
  }catch(_e){}
  const el = document.getElementById(String(id || ""));
  if(el && "value" in el) el.value = v;
}

function wsClear_(ids){
  try{
    if(typeof window.erpClearIds_ === "function") return window.erpClearIds_(ids);
  }catch(_e){}
  const list = Array.isArray(ids) ? ids : [ids];
  for(let i = 0; i < list.length; i++){
    const el = document.getElementById(String(list[i] || ""));
    if(el && "value" in el) el.value = "";
  }
}

async function wsLoadFreshAvailableMap_(){
  // 與 dashboard / lots 相同：優先後端彙總 API，避免每次全表 list_inventory_movement
  const pack =
    typeof loadInventoryMovementAvailableMap_ === "function"
      ? await loadInventoryMovementAvailableMap_()
      : { map: {}, failed: true };
  return pack && pack.map ? pack.map : {};
}

function wsEscapeHtml_(s){
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function wsExpiryInfo_(expiryDateStr){
  return invExpiryInfo_(expiryDateStr);
}

function wsAvailableByLotId_(lotId){
  const id = String(lotId || "");
  if(!id) return null;
  const hit = wsAvailableByLotIdMap_?.[id];
  if(hit !== undefined) return hit;
  return null;
}

function wsProductDisplay_(productId){
  const p = (wsProducts || []).find(x => String(x.product_id||"") === String(productId||""));
  const name = p?.product_name || productId || "";
  const spec = String(p?.spec || "").trim();
  return spec ? `${name}（${spec}）` : name;
}

function wsExpiryLotReminder_(exp, windowDays, fontWeight) {
  const fw = fontWeight || 700;
  const win = windowDays || 30;
  if (exp.expired) return { text: "已過期", style: `color:#b91c1c;font-weight:${fw};` };
  if (exp.days != null && exp.days <= win) {
    return { text: `即將到期（${exp.days}天）`, style: `color:#b45309;font-weight:${fw};` };
  }
  return { text: "", style: "" };
}

function wsFormatLotCell_(lot) {
  const lotId = wsEscapeHtml_(String(lot?.lot_id || "").trim() || "—");
  const fl = String(lot?.factory_lot || "").trim();
  const flDisplay = fl ? wsEscapeHtml_(fl) : "—";
  return (
    '<div style="line-height:1.35;min-width:0;">' +
    '<div style="font-size:12px;color:#64748b;line-height:1.2;">' +
    lotId +
    "</div>" +
    '<div style="line-height:1.25;margin-top:2px;">' +
    flDisplay +
    "</div>" +
    "</div>"
  );
}

function wsFormatProductCell_(productId) {
  const pid = String(productId || "").trim();
  const prod = wsEscapeHtml_(wsProductDisplay_(pid));
  const pidEsc = wsEscapeHtml_(pid);
  return (
    '<div style="line-height:1.35;min-width:0;">' +
    '<div style="line-height:1.25;">' +
    prod +
    "</div>" +
    (pidEsc
      ? '<div style="font-size:12px;color:#64748b;margin-top:2px;">' + pidEsc + "</div>"
      : "") +
    "</div>"
  );
}

function wsWarehouseLabel_(w){
  const name = String(w?.warehouse_name || "").trim();
  const cat = String(w?.category || "").trim().toUpperCase();
  const catLabel = (typeof termShortZh_ === "function" ? termShortZh_(cat) : ((typeof termLabel === "function" ? termLabel(cat) : "") || cat));
  if(name && catLabel) return `${name}-${catLabel}`;
  return name || (w?.warehouse_id || "");
}

async function warehouseStockInit(){
  await wsLoadData_();
  wsInitWarehouseDropdown_();
  // UX：切換倉別時，若已有關鍵字，先確認並清空（避免誤以為仍在同倉別篩選）
  try{
    const wh = document.getElementById("ws_warehouse");
    const kw = document.getElementById("ws_keyword");
    if(wh && kw && typeof window.erpBindGuardedValueChangeByKey === "function"){
      window.erpBindGuardedValueChangeByKey(wh, {
        key: "wsWarehouse",
        hasBlocking: function(){ return !!String(kw.value || "").trim(); },
        messageKey: "ws.warehouse",
        onClear: function(){
          wsClear_("ws_keyword");
        }
      });
    }
  }catch(_eUx){}
  bindAutoSearchToolbar_([
    ["ws_warehouse","change"],
    ["ws_keyword","input"],
    ["ws_view","change"],
    ["ws_expiry_window","change"]
  ], ()=> wsRender_());
  wsRender_();
}

async function wsLoadData_(){
  const wsTb = document.getElementById("ws_tbody");
  if(wsTb) setTbodyLoading_(wsTb, 5);
  const core = await loadInventoryCoreData_({ needWarehouses: true, needMovementDetails: false });
  wsWarehouses = core.warehouses || [];
  wsLots = core.lots || [];
  wsProducts = core.products || [];
  wsMovementLoadFailed = !!core.movementLoadFailed;
  wsAvailableByLotIdMap_ = core.movementAvailableByLotId || {};
  wsLoadedAt_ = Date.now();
  if(wsMovementLoadFailed && typeof showToast === "function"){
    showToast("讀取庫存異動失敗，可用量可能不準。請重新整理頁面或稍後再試。", "error");
  }
}

function wsInitWarehouseDropdown_(){
  const sel = document.getElementById("ws_warehouse");
  if(!sel) return;
  const rows = (wsWarehouses || []).filter(w => String(w.status||"ACTIVE").toUpperCase() === "ACTIVE");
  rows.sort((a,b)=>String(a.warehouse_id||"").localeCompare(String(b.warehouse_id||"")));
  if(!rows.length){
    sel.innerHTML = '<option value="">尚無倉庫，請先至「Warehouses 倉庫」建立</option>';
    wsClear_("ws_warehouse");
    return;
  }
  sel.innerHTML =
    '<option value="">請選擇</option>' +
    rows.map(w=>{
      const id = String(w.warehouse_id||"").toUpperCase();
      return `<option value="${id}">${wsEscapeHtml_(wsWarehouseLabel_(w))}</option>`;
    }).join("");
  // 不預設帶第一個倉別：強制讓使用者「請選擇」
  if(!sel.value){
    wsClear_("ws_warehouse");
  }
}

function wsGetFilters_(){
  const warehouseId = (document.getElementById("ws_warehouse")?.value || "").trim().toUpperCase();
  const kw = (document.getElementById("ws_keyword")?.value || "").trim().toLowerCase();
  const view = document.getElementById("ws_view")?.value || "product";
  const windowDays = Number(document.getElementById("ws_expiry_window")?.value || 0);
  return { warehouseId, kw, view, windowDays, showZero: false };
}

function wsFilterLots_(){
  const { warehouseId, kw } = wsGetFilters_();
  const source = (wsLots || [])
    .filter(l => String(l.warehouse_id||"").toUpperCase() === warehouseId)
    // 預設只看可用的 lot；轉倉後來源 lot 會被關閉（CLOSED），不應繼續在庫存頁面誤導使用者
    .filter(l => String(l.inventory_status || "ACTIVE").toUpperCase() === "ACTIVE");
  if(!kw) return source;
  return source.filter(l=>{
    const lotId = String(l.lot_id||"").toLowerCase();
    const factoryLot = String(l.factory_lot||"").toLowerCase();
    const pid = String(l.product_id||"").toLowerCase();
    const prodText = String(wsProductDisplay_(l.product_id)||"").toLowerCase();
    const spec = String((wsProducts||[]).find(p=>p.product_id===l.product_id)?.spec || "").toLowerCase();
    return lotId.includes(kw) || factoryLot.includes(kw) || pid.includes(kw) || prodText.includes(kw) || spec.includes(kw);
  });
}

function wsRender_(){
  const thead = document.getElementById("ws_thead");
  const tbody = document.getElementById("ws_tbody");
  const summary = document.getElementById("ws_summary");
  if(!thead || !tbody || !summary) return;

  // 若剛做過轉倉/扣庫，且此頁資料是舊的，就自動重載（避免兩邊都像有量）
  try{
    const dirtyAt = Number(localStorage.getItem("erp_inventory_dirty_at") || 0);
    if(dirtyAt && dirtyAt > wsLoadedAt_ && !wsReloading_){
      wsReloading_ = true;
      // 先用最快的 core data 重載（主檔/lot/product）
      wsLoadData_()
        .then(async ()=>{
          // 再強制重抓可用量彙總（POST + cache bust，與庫存核心策略一致）
          try{
            if (typeof loadInventoryMovementAvailableMap_ === "function") {
              const pack = await loadInventoryMovementAvailableMap_();
              wsAvailableByLotIdMap_ = pack.map || {};
              wsMovementLoadFailed = !!pack.failed;
            } else {
              wsAvailableByLotIdMap_ = await wsLoadFreshAvailableMap_();
              wsMovementLoadFailed = false;
            }
          }catch(_e){
            // 保留 core 的 map（可能仍是舊的），但至少不會卡死
          }
          try{ localStorage.removeItem("erp_inventory_dirty_at"); }catch(_e){}
        })
        .then(()=> wsRender_())
        .finally(()=>{ wsReloading_ = false; });
      return;
    }
  }catch(_e){}

  const { view, windowDays, warehouseId, showZero } = wsGetFilters_();
  if(!warehouseId){
    thead.innerHTML = "";
    tbody.innerHTML = '<tr><td style="text-align:center;color:#64748b;padding:22px;">請先建立倉庫</td></tr>';
    summary.textContent = "";
    return;
  }

  const lots = wsFilterLots_();
  const rows = lots.map(l=>{
    const av = wsAvailableByLotId_(l.lot_id);
    const exp = wsExpiryInfo_(l.expiry_date);
    return { lot:l, av, exp };
  }).filter(x => showZero ? true : (Number(x.av || 0) > 1e-9)); // 預設只看有可用量

  const expWindowOn = windowDays > 0;
  const windowed = expWindowOn
    ? rows.filter(x => !x.exp.has || x.exp.expired || (x.exp.days != null && x.exp.days <= windowDays))
    : rows;

  const nearWindow = windowDays || 30;
  const expiredCount = windowed.filter(x => x.exp.expired).length;
  const nearCount = windowed.filter(x => !x.exp.expired && x.exp.days != null && x.exp.days <= nearWindow).length;
  const noDateCount = windowed.filter(x => !x.exp.has).length;
  summary.innerHTML =
    `倉別：<strong>${wsEscapeHtml_(wsWarehouseLabel_((wsWarehouses||[]).find(w=>String(w.warehouse_id||"").toUpperCase()===warehouseId)))}</strong>` +
    `　|　有可用量 Lot：<strong>${windowed.length}</strong>` +
    `　|　已過期：<strong style="color:#b91c1c;">${expiredCount}</strong>` +
    `　|　即將到期（${nearWindow}天內）：<strong style="color:#b45309;">${nearCount}</strong>` +
    `　|　未填到期：<strong>${noDateCount}</strong>`;

  if(view === "lot"){
    thead.innerHTML = `
      <tr>
        <th>Lot／加工廠 Lot</th>
        <th>產品（規格）</th>
        <th>可用量</th>
        <th>有效期</th>
        <th>狀態</th>
      </tr>
    `;
    const sorted = [...windowed].sort((a,b)=>{
      const ea = String(a.lot.expiry_date||"");
      const eb = String(b.lot.expiry_date||"");
      if(ea !== eb) return ea.localeCompare(eb);
      return String(a.lot.lot_id||"").localeCompare(String(b.lot.lot_id||""));
    });
    tbody.innerHTML = "";
    if(!sorted.length){
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:22px;">查無資料（可用量 > 0）</td></tr>';
      return;
    }
    sorted.forEach(x=>{
      const exp = x.exp;
      const rem = wsExpiryLotReminder_(exp, windowDays, 600);
      tbody.innerHTML += `
        <tr>
          <td>${wsFormatLotCell_(x.lot)}</td>
          <td>${wsFormatProductCell_(x.lot.product_id)}</td>
          <td>${wsEscapeHtml_(String(Math.round(Number(x.av||0)*10000)/10000))} ${wsEscapeHtml_(x.lot.unit || "")}</td>
          <td>${wsEscapeHtml_(x.lot.expiry_date || "—")}</td>
          <td style="${rem.style}">${wsEscapeHtml_(rem.text)}</td>
        </tr>
      `;
    });
    return;
  }

  // product summary
  thead.innerHTML = `
    <tr>
      <th>產品（規格）</th>
      <th>可用量合計</th>
      <th>最近到期日</th>
      <th>Lot 數</th>
      <th>提醒</th>
    </tr>
  `;

  const byProduct = {};
  windowed.forEach(x=>{
    const pid = String(x.lot.product_id || "");
    if(!pid) return;
    if(!byProduct[pid]) byProduct[pid] = [];
    byProduct[pid].push(x);
  });

  const pids = Object.keys(byProduct).sort((a,b)=>wsProductDisplay_(a).localeCompare(wsProductDisplay_(b)));
  tbody.innerHTML = "";
  if(!pids.length){
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:22px;">查無資料（可用量 > 0）</td></tr>';
    return;
  }

  pids.forEach(pid=>{
    const items = byProduct[pid] || [];
    const total = items.reduce((s,x)=>s+Number(x.av||0),0);
    const unit = items[0]?.lot?.unit || "";
    // nearest expiry (ignore empty)
    const withExpiry = items.filter(x=>String(x.lot.expiry_date||"").trim());
    withExpiry.sort((a,b)=>String(a.lot.expiry_date||"").localeCompare(String(b.lot.expiry_date||"")));
    const nearest = withExpiry[0]?.lot?.expiry_date || "—";
    const exp0 = wsExpiryInfo_(withExpiry[0]?.lot?.expiry_date || "");
    const expiredLots = items.filter(x=>x.exp.expired).length;
    const nearLots = items.filter(x=>!x.exp.expired && x.exp.days!=null && x.exp.days <= (windowDays||30)).length;
    const hint =
      expiredLots ? `已過期 ${expiredLots}` :
      nearLots ? `${expWindowOn ? windowDays : 30} 天內到期 ${nearLots}` :
      (withExpiry.length ? "" : "未填到期");
    const hintStyle =
      expiredLots ? "color:#b91c1c;font-weight:700;" :
      nearLots ? "color:#b45309;font-weight:700;" :
      (withExpiry.length ? "" : "color:#0f172a;font-weight:700;");

    const detailId = `ws_${pid.replace(/[^a-zA-Z0-9]/g,"_")}`;
    const safeDetailId = detailId.replace(/'/g, "\\'");
    const open = wsExpandedDetailId_ === detailId;
    const sortedItems = items
      .slice()
      .sort((a,b)=>String(a.lot.expiry_date||"").localeCompare(String(b.lot.expiry_date||"")));
    const detailRowsHtml = sortedItems
      .map(function(x){
        const rem = wsExpiryLotReminder_(x.exp, windowDays, 700);
        return (
          `<tr class="ws-detail-row" data-ws-detail="${detailId}" style="display:${open ? "table-row" : "none"};">` +
          `<td style="background:#fff;">${wsFormatLotCell_(x.lot)}</td>` +
          `<td style="background:#fff;">${wsEscapeHtml_(String(Math.round(Number(x.av||0)*10000)/10000))} ${wsEscapeHtml_(x.lot.unit||"")}</td>` +
          `<td style="background:#fff;">${wsEscapeHtml_(x.lot.expiry_date||"—")}</td>` +
          `<td style="background:#fff;"></td>` +
          `<td style="background:#fff;${rem.style}">${wsEscapeHtml_(rem.text)}</td>` +
          `</tr>`
        );
      })
      .join("");

    tbody.innerHTML += `
      <tr class="erp-list-row-selectable ws-product-summary${open ? " erp-list-row-open" : ""}" data-ws-summary="${detailId}" onclick="wsToggleDetail('${safeDetailId}')" title="點擊展開／收合 Lot 明細">
        <td>${wsFormatProductCell_(pid)}</td>
        <td style="font-weight:700;">${wsEscapeHtml_(String(Math.round(total*10000)/10000))} ${wsEscapeHtml_(unit)}</td>
        <td>${wsEscapeHtml_(nearest)}${exp0.days!=null && nearest!=="—" ? ` <span style="color:#64748b;font-size:12px;">(${exp0.expired ? "已過期" : exp0.days + "天"})</span>` : ""}</td>
        <td>${items.length}</td>
        <td style="${hintStyle}">${wsEscapeHtml_(hint)}</td>
      </tr>
      ${detailRowsHtml}
    `;
  });
}

function wsToggleDetail(id){
  const key = String(id || "").trim();
  if(!key) return;
  wsExpandedDetailId_ = wsExpandedDetailId_ === key ? "" : key;
  document.querySelectorAll("#ws_tbody tr.ws-product-summary").forEach(function(tr){
    const sid = String(tr.getAttribute("data-ws-summary") || "");
    const on = sid === wsExpandedDetailId_;
    tr.classList.toggle("erp-list-row-open", on);
  });
  document.querySelectorAll("#ws_tbody tr.ws-detail-row").forEach(function(r){
    const did = String(r.getAttribute("data-ws-detail") || "");
    r.style.display = did === wsExpandedDetailId_ ? "table-row" : "none";
  });
}

async function refreshWarehouseStock(triggerEl){
  if(window.__wsRefreshing__){
    try{
      const hint = document.getElementById("wsHeaderHint");
      if(hint) hint.textContent = "資料狀態：載入中…（已排隊更新）";
    }catch(_e){}
    window.__wsPendingRefresh__ = true;
    return;
  }
  window.__wsRefreshing__ = true;
  showSaveHint(triggerEl);
  try{
    await wsLoadData_();
    wsInitWarehouseDropdown_();
    wsRender_();
    showToast("倉庫庫存已更新");
  }finally{
    hideSaveHint();
    window.__wsRefreshing__ = false;
    if(window.__wsPendingRefresh__){
      window.__wsPendingRefresh__ = false;
      setTimeout(function(){ try{ refreshWarehouseStock(triggerEl); }catch(_e){} }, 0);
    }
  }
}

