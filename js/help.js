/*********************************
 * ERP Global Help Component v1
 * Inline (藍底展開式)
 *********************************/

/* ===============================
   Help Content 集中管理
   鍵名 ↔ 模組對照（data-help）：
   主檔 products/suppliers/customers/warehouses/users/company_settings
   進銷 receive/import/purchase | 庫存 lots/movements/warehouse_stock | 委外 outsource
   銷售 sales/shipping | 商業 commercialDealer/consignmentPromo
   寄賣 consignmentCaseMain/Detail/Settle/Return
   財務 ar | 發票 invoice/invoiceBlank | 追溯 trace | 紀錄 logs
================================ */

const HelpConfig = {

  productEdit: `
    <strong>流程：</strong><br>
    • 填寫欄位後按「建立」新增產品；已建立的產品可從列表「Load」帶入下方「產品明細」後再「更新」<br>
    • 投料與回收單位不同時：展開「多單位換算」→ 選投料單位，填「每〇〇的投料可產生」幾個回收單位<br>
    <strong>規則：</strong><br>
    • 產品 ID（product_id）可由系統自動產生，建立並儲存後不可修改<br>
    • ID 最長 30 字元，只能用 A–Z／0–9／_／-<br>
    • 產品類型僅允許：RM（原料）/ WIP（半成品）/ FG（成品）<br>
    • 單位必填（收貨／加工／出貨／庫存異動都會使用到）<br>
    • <strong>牌價</strong>：選填；標準零售參考價（寄賣出貨經銷價＝牌價×等級折數）<br>
    • <strong>英文品名（CI）</strong>：出口 Commercial Invoice 報關用；未填時 CI 會改用中文品名並提示<br>
    • <strong>稅則號 HS Code（CI）</strong>：選填；任一明細有填時 PDF 才會出現 HS Code 欄<br>
    • 委外若投料（原料）單位與回收（成品／半成品）單位不同：在<strong>產出產品</strong>設定多單位換算<br>
    • 停用（INACTIVE 停用）前若已有被使用，系統會提醒你確認（保留歷史、不破壞追溯）<br>
    • 狀態（ACTIVE/INACTIVE）屬高風險：僅 CEO／GA／ADMIN 可修改<br>
    <strong>常見提示：</strong><br>
    • 缺少必填：產品名稱／單位／類型<br>
    • ID 長度/格式不合法（最多 30；僅 A–Z 0–9 _ -）<br>
    • 名稱過長（最多 100）／規格過長（最多 200）／備註過長（最多 500）<br>
    • 產品 ID 已存在／找不到產品<br>
    • 委外回收若提示單位無法換算：請先在本產品完成多單位換算並更新<br>
    • 建立成功／更新成功
  `,

  productList: `
    <strong>流程：</strong><br>
    • 點欄位標題可排序；點「Load」會展開下方明細區；按「新增」可開空白明細；「重設」會收合明細回到列表<br>
    <strong>規則：</strong><br>
    • 篩選條件：關鍵字／類型／狀態<br>
    • 關鍵字比對：產品ID／名稱／規格／備註<br>
    • 狀態：ACTIVE（使用中）/ INACTIVE（停用保留歷史）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認關鍵字／類型／狀態條件<br>
    • 建立／修改資訊請到 Logs 查
  `,
  supplierEdit: `
    <strong>流程：</strong><br>
    • 填寫後按「建立」新增供應商；點列表「Load」後可帶入下方「供應商明細」再「更新」<br>
    • 供應商可設定「類型(可複選)」與「可用流程(可複選)」，用於下游模組下拉篩選/限制<br>
    • 稽核/修改紀錄請到 Logs 查<br>
    <strong>規則：</strong><br>
    • 供應商 ID（supplier_id）可由系統自動產生，建立並儲存後不可修改<br>
    • ID 最長 30 字元，只能用 A–Z／0–9／_／-<br>
    • 名稱必填（supplier_name）<br>
    • 供應商類型與可用流程為必填（用於下游模組下拉篩選/限制）<br>
    • 「國家」選「其他」或「供應商類型」勾選「其他」時：備註／原因必填<br>
    • 停用（INACTIVE 停用）前若已有被使用，系統會提醒你確認<br>
    • 狀態（ACTIVE/INACTIVE）屬高風險：僅 CEO／GA／ADMIN 可修改<br>
    <strong>常見提示：</strong><br>
    • 缺少必填：供應商ID／供應商名稱／供應商類型／可用流程<br>
    • 國家／供應商類型 選「其他」時，請填寫備註／原因<br>
    • ID 長度/格式不合法<br>
    • 供應商 ID 已存在／找不到供應商<br>
    • 建立成功／更新成功
  `,

  supplierList: `
    <strong>流程：</strong><br>
    • 點欄位標題可排序；點「Load」會展開下方明細區；按「新增」可開空白明細；「重設」會收合明細回到列表<br>
    <strong>規則：</strong><br>
    • 篩選條件：關鍵字／狀態<br>
    • 關鍵字比對：供應商ID／名稱／聯絡人／電話／Email／備註<br>
    • 狀態：ACTIVE（使用中）/ INACTIVE（停用保留歷史）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認關鍵字／狀態條件<br>
    • 建立／修改資訊請到 Logs 查
  `,

  customerEdit: `
    <strong>流程：</strong><br>
    • 填寫後按「建立」新增客戶；點列表「Load」後可帶入下方「客戶設定」再「更新」<br>
    • 「分類」可用來標記客群（例如：經銷/門市/電商…），方便後續查詢與報表<br>
    • 稽核/修改紀錄請到 Logs 查<br>
    <strong>規則：</strong><br>
    • 客戶 ID（customer_id）可由系統自動產生，建立並儲存後不可修改<br>
    • ID 最長 30 字元，只能用 A–Z／0–9／_／-<br>
    • 名稱必填（customer_name）<br>
    • 分類必填（用於標記客群與後續查詢/報表）<br>
    • 「分類」或「國家」選「其他」時：備註／原因必填<br>
    • 停用（INACTIVE 停用）前若已有被使用，系統會提醒你確認<br>
    • 狀態（ACTIVE/INACTIVE）屬高風險：僅 CEO／GA／ADMIN 可修改<br>
    <strong>常見提示：</strong><br>
    • 缺少必填：客戶ID／客戶名稱／分類<br>
    • 分類／國家 選「其他」時，請填寫備註／原因<br>
    • ID 長度/格式不合法<br>
    • 客戶 ID 已存在／找不到客戶<br>
    • 建立成功／更新成功
  `,

  customerList: `
    <strong>流程：</strong><br>
    • 點欄位標題可排序；點「Load」會展開下方明細區；按「新增」可開空白明細；「重設」會收合明細回到列表<br>
    <strong>規則：</strong><br>
    • 篩選條件：關鍵字／分類／狀態<br>
    • 關鍵字比對：客戶ID／名稱／分類／聯絡人／電話／Email／備註<br>
    • 狀態：ACTIVE（使用中）/ INACTIVE（停用保留歷史）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認關鍵字／分類／狀態條件<br>
    • 建立／修改資訊請到 Logs 查
  `,

  usersMain: `
    <strong>流程：</strong><br>
    • 使用者建立/更新後，系統會記錄操作者（created_by/updated_by）為「目前登入的帳號」<br>
    • 需要調整姓名/角色/狀態/可用模組時：先載入再更新<br>
    <strong>規則：</strong><br>
    • 可用模組：未勾選任何模組＝預設只能使用「Dashboard 儀表板、Lot Traceability 批次追溯、Company 公司設定」<br>
    • <strong>COMMERCIAL</strong> 分兩項：<strong>Promo 促銷方案</strong>、<strong>Dealer 經銷方案</strong>（可只開其中一項）<br>
    • 建議用 INACTIVE（停用）保留歷史帳號，不建議刪除（避免稽核斷裂）<br>
    • 停用後不得再登入；歷史操作紀錄仍保留可查<br>
    • 狀態（ACTIVE/INACTIVE）屬高風險：僅 CEO／GA／ADMIN 可修改<br>
    <strong>常見提示：</strong><br>
    • 缺少必填：User ID／姓名／Email／角色<br>
    • User ID 已存在<br>
    • 建立成功／更新成功（更新前需先載入）
  `,

  purchaseHeader: `
    <strong>流程：</strong><br>
    • 採購單號由系統自動產生（欄位唯讀）；先填主檔再到下方新增品項，最後按下方「建立」開單<br>
    • 需要入庫時請到「收貨入庫（Goods Receipt）」收貨，才會產生 Lot（批次）<br>
    <strong>規則：</strong><br>
    • 採購單（PO, Purchase Order）本身不產生庫存；收貨入庫才產生 Lot<br>
    • 文件連結：可貼 URL 方便追資料<br>
    • 點「Load」會先檢查收貨狀態（未載入／檢查中／已收貨／未收貨等）<br>
    • 已收貨後：整張採購單會鎖定不可改（避免破壞追溯）<br>
    • 狀態 CLOSED（結案）不可再修改<br>
    <strong>常見提示：</strong><br>
    • 請選擇供應商／請填寫下單日期<br>
    • 請至少新增 1 筆品項／請至少保留 1 筆品項<br>
    • 採購單號已存在／找不到採購單／請先載入再更新<br>
    • 已收貨：整張採購單不可修改<br>
    • CLOSED：不可再修改<br>
    • 更新成功
  `,
  purchaseItems: `
    <strong>流程：</strong><br>
    • 在採購單中新增品項（產品/數量）；明細表以「#」對齊列<br>
    • 只改備註：點列帶回上方後按「儲存備註」<br>
    • 完成後按下方「建立」建立採購單；已建立的採購單可按下方「更新」更新主檔/明細<br>
    <strong>規則：</strong><br>
    • 明細表「狀態」：草稿；已存檔列則依已收／訂購顯示未收貨、部分收貨、已收畢；品項備註僅在上方表單編輯<br>
    • 明細的 產品／數量／單位 會決定後續「可收上限」<br>
    • 已收貨後不建議改明細（避免追溯與帳務不一致）<br>
    • 已收貨時：新增/刪除/更新會鎖定<br>
    <strong>常見提示：</strong><br>
    • 請選擇產品<br>
    • 訂購數量需大於 0<br>
    • 找不到產品單位：請先確認產品主檔
  `,
  purchaseList: `
    <strong>流程：</strong><br>
    • 「Load」：帶到上方編輯區；收貨：跳到收貨入庫並預選該 PO<br>
    <strong>規則：</strong><br>
    • 關鍵字比對：採購單號、供應商 ID<br>
    • 有填文件連結才會顯示「連結」<br>
    • 狀態：OPEN（開單中）/ PARTIAL（部分收貨）/ CLOSED（已結案）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認範圍/狀態條件
  `,

  importHeader: `
    <strong>流程：</strong><br>
    • 報單 ID 由系統自動產生（欄位唯讀）；先填主檔再到下方新增品項，最後按下方「建立」建立報單（主檔+明細一併送出）<br>
    • 需要入庫時到「收貨入庫」選該報單收貨，才會產生 Lot（批次）<br>
    <strong>規則：</strong><br>
    • 進口報單（Import Document）是來源文件：收貨入庫會以報單明細計算可收上限<br>
    • 批號（Inv No）必填（請依文件填）<br>
    • 點「Load」會先檢查收貨狀態（未載入／檢查中／已收貨／未收貨等）<br>
    • 已收貨後：整張報單會鎖定不可改（避免追溯風險）<br>
    • 若需調整：請以「沖銷/補單」處理<br>
    &nbsp;&nbsp;沖銷：多收/收錯要減量 → 到「庫存異動」選 Lot 扣回數量<br>
    &nbsp;&nbsp;補單：原報單不動；新建一張報單，再到「收貨入庫」收貨<br>
    <strong>常見提示：</strong><br>
    • CLOSED/CANCELLED：不可再修改<br>
    • 已有進口收貨：不可修改明細（請用沖銷/補單）<br>
    • 建立／更新成功或失敗會以 Toast 顯示<br>
    • 找不到報單／請先載入或建立一張報單<br>
    • 請至少新增 1 筆報單品項
  `,
  importItems: `
    <strong>流程：</strong><br>
    • 新增品項並寫入報單；明細表以「#」對齊列<br>
    • 只改備註：點列帶回上方後按「儲存備註」<br>
    • 完成後按下方「建立」建立報單；已建立的報單可按下方「更新」更新主檔/明細<br>
    <strong>規則：</strong><br>
    • 明細表「狀態」為簡版：草稿／已存檔（與出貨明細「草稿／已過帳」同類）；品項備註僅在上方表單編輯<br>
    • 已收貨時：新增品項/刪除/更新會鎖定（避免追溯風險）<br>
    • Inv No 必填，建議全大寫一致<br>
    <strong>常見提示：</strong><br>
    • 請選擇產品<br>
    • Inv No 必填（請依文件發票號填寫）<br>
    • 數量需大於 0<br>
    • 找不到產品單位：請先確認產品主檔
  `,
  importList: `
    <strong>流程：</strong><br>
    • 「Load」：帶到上方編輯區；收貨：跳到收貨入庫並預選該報單<br>
    <strong>規則：</strong><br>
    • 列表不顯示備註（避免太擠），編輯區仍可填寫<br>
    • 狀態：OPEN（開單中）/ CLOSED（已結案）/ CANCELLED（已取消）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認狀態/關鍵字條件
  `,

  receiveHeader: `
    <strong>流程：</strong><br>
    • 先選「來源類型」（PO／IMPORT）→ 再選來源單號<br>
    • 填「收貨日期」（含時間）與「倉別」，再到下方明細逐列輸入「本次收貨」與日期，最後按「產生批次」建立 Lot<br>
    • 同卡下方「已收列表」需要點開才載入；作廢規則與限制請看列表提示<br>
    <strong>規則：</strong><br>
    • 收貨單 ID 自動產生（唯讀）<br>
    • 「剩餘可收」由系統計算；已作廢之收貨不計入彙總與判斷<br>
    • 建立的 Lot 預設 PENDING（待 QA）<br>
    <strong>常見提示：</strong><br>
    • 收貨日期 必填（含時間）／請先選擇來源類型與單號<br>
    • 請至少輸入一筆本次收貨<br>
    • 找不到報單或載入失敗：依畫面提示重試<br>
    • 收貨完成：已產生 X 個 Lot（PENDING 待QA）
  `,
  receiveLines: `
    <strong>流程：</strong><br>
    • 依「#」對應來源明細逐列輸入「本次收貨」，並視需要填「加工廠 Lot／製造日／有效期」<br>
    • 按「產生批次」後才會真正建立 Lot（批次）；成功會以提示顯示產生數量<br>
    • 「已收列表」點開才載入；<strong>點收貨列</strong>展開品項明細（產品對齊收貨單／製造有效對齊收貨日期／Lot 對齊倉別／數量對齊總量），再點一次收合<br>
    <strong>規則：</strong><br>
    • 本次收貨不可超過剩餘可收；加工廠 Lot／製造日／有效期寫入新 Lot（加工廠 Lot 選填）<br>
    • 作廢：若已被出庫、加工或調整扣減，導致可用量不足以沖銷入庫，則無法作廢。<br>
    <strong>常見提示：</strong><br>
    • 品項超過剩餘可收／本次無可收量，將不產生 Lot
  `,

  lotsMain: `
    <strong>流程：</strong><br>
    • 先用關鍵字與下拉篩選（庫存狀態／品檢狀態）找批次<br>
    • 勾選一筆批次 → 上方按鈕執行 QA 放行／退回、補登資料、Log、追溯<br>
    • 批次若為 PENDING：可執行 QA 放行／退回（仍會跳出確認）<br>
    • 「補登資料」可填製造日、有效期；<strong>委外加工產出</strong>另須填加工廠 Lot<br>
    <strong>規則：</strong><br>
    • <strong>加工廠 Lot</strong>：標籤批號，寄賣收回會用到；<strong>收貨入庫</strong>可選填，<strong>委外加工回收</strong>必填<br>
    • 採購／進口收貨批次 QA 放行<strong>不強制</strong>加工廠 Lot；委外加工產出未填則無法 QA 放行<br>
    • 庫存狀態：ACTIVE／CLOSED／VOID；品檢狀態：PENDING／APPROVED／REJECTED<br>
    • 日期規則：有效期不可早於製造日<br>
    <strong>常見提示：</strong><br>
    • 委外加工 Lot 無法 QA 放行 → 請先補登加工廠 Lot（或回到委外加工回收時填入）
  `,

  movementsMain: `
    <strong>流程：</strong><br>
    • 先選「Lot」→ 選用途與「給誰」→ 填「扣庫數量」與「原因」→ 按「確認扣庫」建立異動<br>
    • 轉倉：先勾選「轉倉」（系統才會啟用/載入可轉倉 Lot 下拉）→ 選「轉倉到」目標倉並輸入數量後按「轉倉」；可按「轉全部」一鍵帶入全部可用量<br>
    • 下方列表可用關鍵字與「異動類型」篩選，必要時按「重新整理」刷新資料<br>
    <strong>規則：</strong><br>
    • 庫存異動為庫存帳本來源；手動扣庫預設僅 APPROVED 且 ACTIVE 的 Lot<br>
    • 不允許負庫存；扣庫／轉出量不可超過可用量<br>
    • 轉倉（QA 規則）：<br>
      - 待 QA（PENDING）：僅允許「全部轉倉」（轉倉數量必須 = 可用量）<br>
      - 部分轉倉：來源 Lot 必須 QA 已放行（APPROVED）<br>
      - 已退回（REJECTED）：不可轉倉（建議改用報廢或其他處置）<br>
    • 轉倉會沖帳並於目標倉產生新批號，追溯與備註與人為填寫分離<br>
    <strong>常見提示：</strong><br>
    • 請選擇 Lot／找不到 Lot／數量需大於 0<br>
    • 扣庫數量不可超過可用量／轉倉須選目標倉／原因必填<br>
    • 異動或轉倉已建立
  `,

  shippingHeader: `
    <strong>流程：</strong><br>
    • 先填主檔（出貨單ID／銷售單／收件人／出貨日期）；銷售單會帶入訂購人（客戶），收件人請至客戶主檔事先維護<br>
    • 下載 PDF 會印出：訂購人、收件人、收件地址、電話<br>
    • 完成後按下方「建立並過帳出貨（扣庫）」才會扣庫<br>
    • 作廢：按上方「作廢出貨單（反沖庫存）」；僅限 POSTED（已過帳）出貨單<br>
    • 若已開立商業發票（CI）且尚未作廢，須先到 <strong>Invoice 商業發票</strong> 作廢 CI，才能作廢出貨<br>
    • 寄賣出貨須選<strong>寄賣案</strong>；過帳後品項進入該案池子<br>
    • 寄賣出貨若所掛案件已有<strong>結算</strong>或<strong>收回</strong>，不可作廢出貨（須先處理 AR／案件紀錄）<br>
    <strong>規則：</strong><br>
    • 出貨會產生庫存扣庫異動<br>
    • 只允許使用 QA 已放行批次，且不允許負庫存<br>
    <strong>常見提示：</strong><br>
    • 出貨單ID 必填／請選擇客戶／出貨日期必填<br>
    • 請至少新增 1 筆出貨明細<br>
    • 找不到出貨單／請先載入出貨單<br>
    • 僅 POSTED 出貨單可作廢／作廢完成：已反沖庫存並回寫 SO<br>
    • 「已有商業發票尚未作廢」→ 請先到 Invoice 商業發票作廢該張 CI
  `,
  shippingItems: `
    <strong>流程：</strong><br>
    • 先選「銷售品項」（可選），再指定 Lot 與出貨數量後按「新增明細」加入草稿<br>
    • 「Lot 自動分配（FEFO）」預設開啟：依效期先到期先出，可自動拆成多筆明細；系統自動分配帶出的數量為唯讀<br>
    • 關閉 FEFO 後改用「選擇 Lot」手動指定（也可先自動分配，再手動覆寫/調整）<br>
    • 「選擇 Lot」視窗可搜尋；可切換「flat（一般清單）／group_source（依來源分組）」；可勾「顯示不可選 Lot」查看被擋原因<br>
    • 只改備註：用「儲存備註」；完成後按下方「建立並過帳出貨（扣庫）」<br>
    <strong>規則：</strong><br>
    • Lot 與銷售品項的產品需一致（有綁品項時）<br>
    • 出貨不可超過可用量，亦不可超過銷售單剩餘未出貨量（若有綁 SO）<br>
    • 明細「狀態」：草稿／已過帳；備註僅在上方表單編輯<br>
    <strong>常見提示：</strong><br>
    • 找不到 Lot／Lot 單位缺失／出貨數量需大於 0<br>
    • 超過可用量或剩餘未出貨量／Lot 與銷售品項產品不一致<br>
    • FEFO 開啟時若效期資料不足：改手動選批或先補齊 Lot 日期
  `,
  shippingList: `
    <strong>流程：</strong><br>
    • 「Load」帶回上方檢視；作廢前請確認（會反沖庫存）<br>
    <strong>規則：</strong><br>
    • 關鍵字比對：出貨單／客戶／銷售單<br>
    • 只能作廢 POSTED（已過帳）出貨單<br>
    • 狀態：OPEN（開單中）/ POSTED（已過帳）/ CANCELLED（已取消）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認狀態/關鍵字條件
  `,

  invoiceMain: `
    <strong>這是什麼？</strong><br>
    • <strong>Commercial Invoice（商業發票）</strong>：出貨寄往<strong>國外</strong>時使用的<strong>英文報關／對外發票</strong>，可列印成 PDF 給快遞、海關或客戶<br>
    • 與台灣「電子發票」不同；本模組<strong>不開立台灣發票號碼</strong>，只產出英文 CI 單據<br>
    <strong>前置條件：</strong><br>
    • 出貨單須為 <strong>POSTED（已過帳）</strong>（Shipment 出貨管理完成扣庫後）<br>
    • <strong>主檔 → Company 公司設定</strong>：填好英文公司名、地址、電話、Email、Tax ID（PDF 賣方／Exporter 與公司章由此帶入）<br>
    • <strong>Products 產品</strong>：建議填「<strong>英文品名（CI）</strong>」；缺英文時開立／列印會橘色提示<br>
    • <strong>Customers 客戶</strong>：建議填英文姓名／地址／國家；大陸清關可填 Consignee ID No.<br>
    <strong>操作流程：</strong><br>
    1. 上方列表找 <strong>POSTED 出貨單</strong>（可搜出貨單／CI 號／客戶／銷售單；可篩 CI 狀態）<br>
    • 已開立 CI：先勾選列表 → 工具列「<strong>PDF</strong>」（2 筆以上打包 ZIP；1 筆開列印視窗）<br>
    2. 按「<strong>開立／編輯</strong>」進入編輯區<br>
    3. 確認發票號（Invoice No.）、日期、<strong>幣別（連出貨單時鎖定跟銷售單 SO）</strong>、原產地、Incoterms／Payment Terms（下拉中英文，PDF 僅英文）、買方英文資料；<strong>Waybill</strong>／<strong>HS Code</strong>／<strong>Unit</strong> 等選填欄位：<strong>有填才出現在 PDF</strong>（HS Code 在產品主檔維護）<br>
    4. 明細：由出貨帶入品名／數量（唯讀）；<strong>僅單價可改</strong>（報關價）；按「重算明細」從出貨重帶<br>
    • 買方／收件人由<strong>出貨收件人</strong>帶入（唯讀）；要改請回 Shipment／Customers<br>
    5. 按「<strong>儲存</strong>」或「<strong>儲存至雲端</strong>」寫入資料庫；已開立者可按「<strong>作廢</strong>」，作廢後再進編輯會<strong>自動帶入當日下一號</strong>，確認後儲存即重開<br>
    6. 按「<strong>列印 PDF</strong>」（預設版型）或「<strong>PDF V2</strong>」（舊版型）預覽／另存 PDF<br>
    • <strong>列印 PDF</strong>：頁首左 Logo、右 COMMERCIAL INVOICE；表頭英文；頁尾 Exporter＋章<br>
    • <strong>PDF V2</strong>：標題置中；Logo 在頁尾三欄<br>
    <strong>規則：</strong><br>
    • 一張出貨單對一張 CI；儲存後可再修訂覆寫；<strong>VOID 已作廢</strong>、未開立者不可勾選 PDF<br>
    • 發票號建議格式 <strong>CI-YYYYMMDD-001</strong>；改日期後可按「重選」產生當日下一號<br>
    • 金額預設來自銷售單單價 × 出貨數量；Subtotal／Total 由明細加總<br>
    • 買方地址與國家：PDF 合併為「地址, 國家」；若地址已含國家則不重複<br>
    • PDF 表頭為英文（Qty、Unit Price、Total 等）；品名請用英文，勿寫 Gift／Sample 等模糊字<br>
    • 出貨模組僅提示「CI 請至 Invoice 商業發票」；開立／PDF 都在本頁完成<br>
    <strong>常見提示：</strong><br>
    • 「僅 POSTED 出貨單可開立」→ 請先到 Shipment 完成過帳<br>
    • 「請先到公司設定填寫 English…」→ 主檔 Company 公司設定補英文資料後 Ctrl+F5<br>
    • 列印前出貨單 CI 請先儲存；工具列 PDF 讀已儲存資料。PDF 空白或缺 Logo／章 → 確認 assets 與 Ctrl+F5<br>
    • 直接開啟後端 /exec 網址若顯示 Unknown action 屬正常（需帶 action 參數）
  `,

  invoiceBlankMain: `
    <strong>這是什麼？</strong><br>
    • <strong>過渡應急用</strong>：手填空白 Commercial Invoice，儲存後列印 PDF<br>
    • <strong>與出貨無關</strong>：不連結出貨單／銷售單；資料存於獨立表 commercial_invoice_blank<br>
    <strong>操作流程：</strong><br>
    1. 列表可搜發票號／買方、篩狀態；按「<strong>新增</strong>」開立<br>
    2. 發票號 <strong>CI-日期-201</strong> 起編（例 CI-20260524-201）；可按「重選」依日期重產<br>
    3. 填買方、明細後按「<strong>儲存至雲端</strong>」；可「本機暫存」備份草稿<br>
    4. 列表先勾選 → 工具列「<strong>複製</strong>」或「<strong>PDF</strong>」（勾 2 筆以上打包 ZIP；勾 1 筆開列印視窗）<br>
    5. 列表可<strong>編輯</strong>；複製會自動產生新發票號<br>
    <strong>規則：</strong><br>
    • 賣方英文資料來自「公司設定」；與 Invoice 商業發票（出貨 CI）分開管理<br>
    • 正式出貨請用左側「Invoice 商業發票」模組
  `,

  logsMain: `
    <strong>流程：</strong><br>
    • 先用上方分頁（ALL / MASTER / INBOUND / INVENTORY / PROCESS / SALES / SHIPMENT）縮小範圍<br>
    • <strong>公司設定</strong>在 MASTER；<strong>商業發票</strong>在 SHIPMENT（或 ALL 全部）<br>
    • 再用篩選器（資料表／時間範圍／動作／關鍵字）精準查詢<br>
    • 點「明細（View）」可在下方展開差異內容<br>
    <strong>規則：</strong><br>
    • 動作代碼：CREATE（建立）/ UPDATE（更新）/ DELETE（刪除）<br>
    • 關鍵字可搜：ID／參考ID／舊值／新值<br>
    <strong>常見提示：</strong><br>
    • 若儲存/查詢失敗：畫面可能直接顯示後端錯誤訊息（err.message）
  `,

  salesHeader: `
    <strong>流程：</strong><br>
    • 先填主檔（客戶／銷售人員／下單日期／幣別／類型），再到下方新增明細，最後按下方「建立」建立銷售單（主檔+明細一併寫入）<br>
    • 需要出貨：到「Shipment 出貨管理」建立出貨單，按「建立並過帳出貨（扣庫）」後才會扣庫<br>
    • 類型選「補寄（RESHIP）」時：需填「補寄參考（原 SO／原出貨）」以便稽核對照<br>
    • 類型選「<strong>寄賣（CONSIGNMENT）</strong>」：出貨時須選寄賣案；應收於 Consignment 結算產生，非出貨當下建 AR<br>
    <strong>規則：</strong><br>
    • Sales Orders（銷售單，SO）不直接扣庫；實際扣庫發生在 Shipment 出貨管理<br>
    • 幣別：選客戶時自動建議（台灣客戶 TWD、其餘 USD），可手改；開立 Commercial Invoice 時預設帶入銷售單幣別<br>
    • 已有出貨或單據已結束（SHIPPED/CANCELLED）：不可「編輯主檔／儲存主檔」整批欄位；主檔備註隨時可用「儲存備註」<br>
    <strong>常見提示：</strong><br>
    • 銷售單ID 必填／請選擇客戶／下單日期必填<br>
    • 請至少新增 1 筆品項<br>
    • 銷售單ID 已存在／找不到銷售單／請先載入再更新<br>
    • 類型「其他」：備註必填（含僅存備註時）
  `,
  salesItems: `
    <strong>流程：</strong><br>
    • 新單：選產品、數量、牌價／折數（一般為單價；寄賣為經銷價）後按「新增明細」加入草稿，最後按「建立」<br>
    • <strong>可用量</strong>：選產品後顯示全倉可出貨合計（ACTIVE＋QA已放行＋未過期）；寄賣單顯示「—」<br>
    • <strong>灰底欄位</strong>＝系統帶入或不可手改（牌價、金額、可用量、鎖住的折數）；白底可編輯<br>
    • 已載入且<strong>全部未出貨</strong>：按「編輯明細」→ 點列帶入 → 改數量／價格後「套用至本列」→「儲存明細」；草稿列點列可帶入修改<br>
    • 只改備註（已存檔列）：點列後按「儲存備註」（不必先按「編輯明細」；有出貨或已結束單亦可）<br>
    • <strong>牌價</strong>：選產品後自產品主檔帶入（唯讀）；<strong>折數(%)</strong>：填 85 表示牌價 85 折，會自動算價格<br>
    • <strong>一般</strong>：表單／明細表欄位為「單價」，可手改；若客戶在有效期內有<strong>一般管道促銷</strong>，選品項後會顯示「促銷預覽」（計價量／贈送），金額依<strong>計價量</strong>×單價；儲存明細時寫入促銷快照<br>
    • <strong>寄賣</strong>：折數依客戶經銷等級自動帶入且不可手改；表單／明細表欄位為「<strong>經銷價</strong>」＝牌價×折數（如 2800×80%＝2240）<br>
    • 價格變更會即時計算金額<br>
    <strong>規則：</strong><br>
    • 明細決定後續可出貨的品項與上限<br>
    • 明細表「狀態」欄對齊委外投料列表：草稿／已存檔列則依已出貨量顯示未出貨、部分出貨、已出畢；品項備註僅在上方表單編輯<br>
    <strong>常見提示：</strong><br>
    • 請選擇產品<br>
    • 訂購數量需大於 0<br>
    • 產品單位缺失
  `,
  salesList: `
    <strong>流程：</strong><br>
    • 「Load」帶到上方編輯區；「出貨」可捷徑帶單至出貨模組<br>
    <strong>規則：</strong><br>
    • 關鍵字比對：銷售單 ID／客戶／業務等（與列表欄位一致）<br>
    • 狀態：OPEN（開單中）/ PARTIAL（部分出貨）/ SHIPPED（全數出貨）/ CANCELLED（已取消）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認狀態/關鍵字條件
  `,

  usersList: `
    <strong>流程：</strong><br>
    • 點欄位標題可排序；點「Load」會展開下方明細區；按「新增」可開空白明細；「重設」會收合明細回到列表<br>
    <strong>規則：</strong><br>
    • 篩選條件：關鍵字／角色／狀態<br>
    • 關鍵字比對：User ID／姓名／Email／角色／備註<br>
    • 狀態：ACTIVE（使用中）/ INACTIVE（停用保留歷史）<br>
    • 建議用 INACTIVE（停用）保留歷史使用者，不建議刪除（避免稽核斷裂）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認關鍵字／角色／狀態條件<br>
    • 建立／修改資訊請到 Logs 查
  `,

  outsourceHeader: `
    <strong>流程：</strong><br>
    • 先填主檔後按「1) 建立加工單」建立（或從列表 Load 載入既有加工單）<br>
    • 投料：在投料區新增草稿後按「2) 送加工（扣庫）」可分批、多次扣庫<br>
    • 回收：在回收區新增草稿後按「3) 回收加工品」入庫；每次有效回收會產生新 Lot（預設 PENDING）<br>
    • 需要修改主檔：用「更新備註／預計到貨日期」；取消加工單用「取消加工單（回沖）」<br>
    <strong>規則：</strong><br>
    • 投料只允許 QA已放行 且庫存 ACTIVE、可用量 &gt; 0 的批次（選 Lot 視窗已過濾）<br>
    • 回收中通常維持 OPEN；回收完畢會轉 POSTED（已結案）<br>
    • 取消加工單為整張回沖；若產出 Lot 已被下游使用會被阻擋；多筆原因時畫面會顯示可展開的阻擋明細<br>
    • 投料與產出若單位不同，需先在「產出產品」主檔設定多單位換算，系統才會換算到同一基準後比較總量<br>
    • 加工類型代碼：PROCESS / PACKING / REPACK / REWORK / SPLIT / MERGE<br>
    • 來源類別：RM（原料）/ WIP（半成品）/ FG（成品）供管理與篩選<br>
    <strong>常見提示：</strong><br>
    • 加工單ID 必填／請選擇加工類型／請選擇加工廠<br>
    • 找不到加工單／請先載入加工單<br>
    • 加工單主檔已更新
  `,
  outsourceInputs: `
    <strong>流程：</strong><br>
    • 按「選擇 Lot」開啟視窗（僅 ACTIVE + QA已放行 + 可用量&gt;0），可搜尋並切換 flat／group_source；點選列帶回 Lot<br>
    • 填投料數量後按「新增投料」加入草稿；可重複新增多筆草稿<br>
    • 按「2) 送加工（扣庫）」會把草稿投料過帳為扣庫（可分批多次送加工）<br>
    • 點選某一列後可更新備註；「儲存備註」只改備註、不影響已扣庫數量<br>
    <strong>規則：</strong><br>
    • 選單／列表僅顯示 QA已放行、庫存 ACTIVE、可用量 &gt; 0 的 Lot<br>
    • 系統會檢查可用量（不可超投）；可用量以 inventory_movement 加總為準<br>
    <strong>常見提示：</strong><br>
    • 請選擇 Lot／找不到符合條件的 Lot／Lot 單位缺失<br>
    • 投料數量需大於 0／投料不可超過可用量<br>
    • 送加工時若無新草稿投料：請先新增投料再按 2)
  `,
  outsourceOutputs: `
    <strong>流程：</strong><br>
    • 選產出產品後，「預計可收」僅供參考；回收數量、回收入庫倉庫需自行填選<br>
    • 選產出產品、填<strong>加工廠 Lot</strong>、可選填<strong>加工廠 EXP</strong>、輸入回收數量後按「新增產出」；可累積多筆草稿再按「3) 回收加工品」<br>
    • 加工廠 Lot 為標籤批號，回收入庫時必填（新 Lot 預設 PENDING，須至 Lots QA 放行）<br>
    • 「預估損耗」主要依「尚未入帳的草稿產出」與已送加工總量（換算後）即時估算<br>
    • 可勾選「本次回收後結案（允許耗損）」：仍有合理耗損、總量未完全對齊時，回收後可結案；新增產出或按 3) 回收時，若仍有耗損會提示是否需勾選<br>
    <strong>規則：</strong><br>
    • 新 Lot 預設 PENDING；<strong>委外加工產出</strong>須有加工廠 Lot 才能 QA 放行<br>
    • 回收總量（換算後）不可超過已送加工<br>
    <strong>常見提示：</strong><br>
    • 請填加工廠 Lot／請選擇產出產品／回收數量需大於 0
  `,
  outsourceList: `
    <strong>流程：</strong><br>
    • 在加工單列表點「Load」：帶回主檔並刷新投料／回收明細<br>
    • 最下方「已載入加工單明細」以文字區摘要投料、產出與 lot_relation 關聯（核對用）<br>
    • 需要稽核單筆異動時可用主檔卡片的「Log」<br>
    <strong>規則：</strong><br>
    • 列表可依狀態等條件篩選（與畫面上方條件一致）<br>
    • 明細操作以「投料／回收」兩張卡片內的表格為準；摘要區僅供閱讀、不提供按鈕<br>
    <strong>常見提示：</strong><br>
    • 若載入後表格仍空：請確認是否已按 2) 送加工／3) 回收，或加工單ID是否正確
  `,

  traceMain: `
    <strong>流程：</strong><br>
    • 輸入 Lot ID 後按「查詢」取得追溯結果<br>
    • 結果分三區：批次摘要／向上追（來源）／向下追（流向）<br>
    <strong>規則：</strong><br>
    • 向上追（來源）主要依 lot_relation<br>
    • 向下追（流向）包含加工產出與出貨扣庫<br>
    <strong>常見提示：</strong><br>
    • 請輸入 Lot ID
  `,

  traceTx: `
    <strong>流程：</strong><br>
    • 貼上 transaction_id（格式：TX-時間戳-隨機碼）後按「查詢交易鏈」<br>
    • 結果會依資料表分類顯示（例如：SO / Shipment / Receipt / Process / Movement / lot_relation）<br>
    <strong>規則：</strong><br>
    • 用來追同一次「過帳/交易 bundle」寫入了哪些表與庫存異動，常用於稽核、對帳與除錯<br>
    <strong>常見提示：</strong><br>
    • 查不到資料：先確認該單據/異動是否已過帳，或後端是否有寫入 transaction_id
  `,

  splitMain: `
    <strong>流程：</strong><br>
    • 先選「來源 Lot」後，於下方新增 1 筆或多筆「新 Lot」草稿<br>
    • 確認草稿無誤後按「確認拆批（過帳）」送出，系統會建立新批次並扣減來源可用量<br>
    <strong>規則：</strong><br>
    • 拆批（SPLIT）會用 inventory_movement 調整可用量<br>
    • 會寫入 lot_relation（SPLIT）供追溯（來源 → 新批次）<br>
    • 新批次預設沿用原批次 QA 狀態（PENDING/APPROVED/REJECTED）<br>
    <strong>常見提示：</strong><br>
    • 請先選擇來源 Lot／找不到來源 Lot<br>
    • 新 Lot ID 必填／新 Lot ID 重複<br>
    • 數量需大於 0／單位缺失／拆出總量不可超過可用量<br>
    • 拆批完成
  `,
  mergeMain: `
    <strong>流程：</strong><br>
    • 上方先填「新 Lot ID」與備註<br>
    • 於來源區加入至少 2 個來源 Lot（僅限 QA已放行）與取用數量，加入草稿後按「確認合批（過帳）」送出<br>
    <strong>規則：</strong><br>
    • 合批（MERGE）會用 inventory_movement 調整可用量<br>
    • 會寫入 lot_relation（MERGE）供追溯（來源 → 新批次）<br>
    • 合批必須同一產品、同一單位<br>
    <strong>常見提示：</strong><br>
    • 請選擇來源 Lot／找不到 Lot／同一 Lot 不可重複加入<br>
    • 取用數量需大於 0／取用不可超過可用量<br>
    • 新 Lot ID 必填／新 Lot ID 已存在<br>
    • 合批至少需要 2 個來源 Lot<br>
    • 合批完成
  `,

  warehouseMain: `
    <strong>流程：</strong><br>
    • 填倉庫名稱、溫層類別（常溫／冷藏／冷凍）、地址等後按「建立」；已存在倉庫可從列表載入後「更新」或停用<br>
    • 倉庫 ID 可由系統自動產生，建立前仍可手動調整；儲存後作為全站收貨、出貨、庫存異動、挑 Lot 之下拉依據<br>
    <strong>規則：</strong><br>
    • 收貨、出貨、加工、拆併、手動異動等倉別皆連倉庫主檔；下拉顯示「名稱＋溫層」，避免手打錯倉<br>
    • 類別（溫層）必填（用於下游流程顯示與判斷）<br>
    • 停用（INACTIVE）前若已有被使用，系統會提醒確認（保留歷史）<br>
    • 狀態（ACTIVE/INACTIVE）屬高風險：僅 CEO／GA／ADMIN 可修改<br>
    <strong>常見提示：</strong><br>
    • 缺少必填：倉庫ID／倉庫名稱／類別（常溫/冷藏/冷凍）<br>
    • 倉庫 ID 已存在／找不到倉庫／建立或更新成功<br>
    • 變更紀錄可到 Logs 查
  `,

  warehouseList: `
    <strong>流程：</strong><br>
    • 點欄位標題可排序；點「Load」會展開下方明細區；按「新增」可開空白明細；「重設」會收合明細回到列表<br>
    <strong>規則：</strong><br>
    • 篩選條件：關鍵字／類別／狀態<br>
    • 關鍵字比對：倉庫 ID／名稱／備註<br>
    • 狀態：ACTIVE（使用中）/ INACTIVE（停用保留歷史）<br>
    <strong>常見提示：</strong><br>
    • 若找不到資料：請確認關鍵字／類別／狀態條件<br>
    • 建立／修改資訊請到 Logs 查
  `,

  warehouseStockHeader: `
    <strong>流程：</strong><br>
    • 先選倉別，再選檢視「產品彙總」或「Lot 明細」；可輸入關鍵字並用「到期視窗」篩選（例如 30／60／90 天內到期）<br>
    • 按「更新」重新彙總<br>
    <strong>規則：</strong><br>
    • 可用量以 inventory_movement 加總為準；畫面會標示即將到期與已過期，利於先進先出規劃<br>
    • 到期判斷以 expiry_date 當日 23:59:59 為截止<br>
    <strong>常見提示：</strong><br>
    • 請先選擇倉別再查詢<br>
    • 若數字與預期不符：確認是否剛完成轉倉／扣庫，可按「更新」或切換視圖核對
  `,

  companyProfile: `
    <strong>用途：</strong><br>
    • 維護公司中英名稱、地址、聯絡方式與 CI（Commercial Invoice）預設欄位<br>
    • 出貨開立 CI／空白 CI 時會帶入此處資料<br>
    <strong>規則：</strong><br>
    • English 公司名稱、English 地址為 CI 必填（儲存時會檢查）<br>
    • 所有登入者皆可檢視；僅 CEO／GA／ADMIN 可修改<br>
    • 變更紀錄可到 Logs 查<br>
    • <strong>財務／收款提醒</strong>：一般／寄賣「逾期門檻」；「到期前提醒」＝距離逾期尚餘 N 天內列入提醒（0＝關閉）<br>
    <strong>常見提示：</strong><br>
    • 請填 English 公司名稱／English 地址<br>
    • 儲存成功／無法載入公司設定
  `,

  supabaseBackup: `
    <strong>用途：</strong><br>
    • 匯出 Supabase 資料庫為 .dump，存於主機（預設 D:\\ERP-Backup\\supabase）<br>
    • 「立即備份」＝手動；每日 00:00 排程＝自動（檔名無 manual）<br>
    <strong>還原：</strong><br>
    • 列表「還原」→ 輸入 RESTORE；僅還原 public（ERP 業務表）<br>
    • 還原前建議先備份；PROD 請極度謹慎<br>
    <strong>規則：</strong><br>
    • 僅 CEO／GA／ADMIN 可看見與操作<br>
    • 需 IT 先安裝 pg_dump 並設定 server/.env 的 BACKUP_DB_*<br>
    • 完整安裝步驟見主機 Supabase每日備份-說明.txt（zip 根目錄）
  `,

  consignmentMain: `
    <strong>這是什麼？</strong><br>
    • <strong>寄賣（Consignment）</strong>：貨先出給客戶，售出後再結算收款；出貨仍會扣庫，但<strong>不立刻建應收</strong><br>
    • v4.2.2 起以<strong>寄賣案件</strong>為中心：手動開案 → 多次出貨累加品項池 → 結算／收回<br>
    • v4.2.3 起可維護<strong>促銷方案</strong>，於結算時自動套用（見 COMMERCIAL 區 Promo 頁）<br>
    <strong>左側選單（寄賣）：</strong><br>
    • <strong>Case 案件管理</strong>：開案、列表、品項池、歷史；可捷徑到結算／收回<br>
    • <strong>Settlement 結算</strong>：填結算量 → 產生 AR；含結算歷史與作廢<br>
    • <strong>Return 收回</strong>：依加工廠 Lot 收回 → 入庫；含收回歷史與作廢<br>
    <strong>COMMERCIAL 區：</strong><br>
    • <strong>Promo 促銷方案(寄賣)</strong>：維護促銷條件（本版套用點為寄賣結算）<br>
    • <strong>Dealer 經銷方案</strong>：月結回饋級距（COMMERCIAL 區維護；月結作業見 FINANCE 財務 → 月結統計）<br>
    <strong>前置條件：</strong><br>
    • 銷售單類型須為 <strong>CONSIGNMENT（寄賣）</strong>；出貨時<strong>必選寄賣案</strong>，過帳後品項進入該案池子<br>
    <strong>規則：</strong><br>
    • 可操作：會計（FN）／CEO／GA／ADMIN；Users 須勾選 consignment 模組<br>
    • 收回改倉：退回倉與原出貨倉不同時<strong>備註必填</strong><br>
    • 寄賣案下拉格式：<code>案件ID｜客戶名稱｜開案日YYYY-MM-DD</code>（財務摘要在選案後顯示）
  `,

  consignmentCaseMain: `
    <strong>Case 案件管理</strong><br>
    <strong>流程：</strong><br>
    • 列表上方「開新寄賣案」→ 案件 ID 自動產生（如 <code>CC260616-A3</code>）<br>
    • 列表<strong>點整列</strong>展開下方品項池／歷史；再點同一列收回；點其他列切換案件<br>
    • 「結算／收回」會帶入同一寄賣案到對應頁面<br>
    <strong>列表欄：</strong><br>
    • <strong>已收/預估應收(%)</strong>：分母＝淨額−促銷折讓；百分比＝已收÷預估應收<br>
    <strong>案件摘要金額：</strong><br>
    • <strong>收款</strong>＝有效結算 AR 已收合計<br>
    • <strong>結算</strong>＝有效結算實際應收（POSTED 結算 AR 合計）<br>
    • <strong>促銷</strong>＝經銷價結算額−結算（促銷折讓；無則 0）<br>
    • <strong>淨額</strong>＝出貨經銷價−已收回經銷價<br>
    • <strong>出貨</strong>＝出貨量×經銷價<br>
    • 提示：（預估應收＝淨額−促銷）<br>
    <strong>歷史區：</strong>結算／收回合併；點列展開明細；作廢／AR 請至<strong>結算／收回</strong>頁<br>
    <strong>出貨：</strong>Shipment 出貨管理 → 寄賣銷售單＋<strong>寄賣案</strong> → 過帳
  `,

  consignmentCaseDetail: `
    <strong>品項池</strong><br>
    • 每次寄賣出貨過帳累加一筆（含加工廠 Lot）<br>
    • <strong>經銷價</strong>＝出貨單價（牌價×等級折數）<br>
    • <strong>未售剩餘</strong>＝出貨量−已結算−已收回<br>
    • 全部結算＋收回完畢 → 案件「已結案」<br>
    <strong>金額（與摘要相同）：</strong>收款｜結算｜促銷｜淨額｜出貨；預估應收＝淨額−促銷
  `,

  consignmentDetail: `
    <strong>（舊版單頁說明，已改為案件三頁）</strong><br>
    請使用左側「Case 案件管理／Settlement 結算／Return 收回／Promo 促銷方案(寄賣)」。
  `,

  consignmentReturn: `
    <strong>Return 收回</strong><br>
    <strong>流程：</strong><br>
    • 選寄賣案 → 填收回原因、日期、<strong>退回倉庫</strong><br>
    • 明細從下拉選<strong>加工廠 Lot</strong>（或無 Lot 品項）→ 填<strong>收回數量</strong>（不可超過選項上的未售）→ 按「確認收回」<br>
    • 過帳後計入品項池<strong>已收回</strong>並入庫；Movements 顯示「寄賣案件收回-入庫」<br>
    • 誤收回：本頁<strong>收回歷史</strong>按「作廢」（沖銷入庫、還原池子；Lot 可用量須足夠）<br>
    <strong>現場作業：</strong><br>
    • 倉管只需認<strong>產品／加工廠 Lot／數量</strong>；下拉中的經銷價為系統內部對帳用，不必現場區分<br>
    • <strong>收回數量 ≤ 未售</strong>；超過時欄位<strong>紅字</strong>並提示，數字維持不變，<strong>送出才擋</strong>；後端亦會再檢查<br>
    <strong>收回原因：</strong>未售收回、效期不足、商品瑕疵、出貨寄錯、合約終止、其他原因 — 皆從<strong>未售池</strong>扣減<br>
    <strong>備註分開填：</strong><br>
    • 選「其他原因」→ 填<strong>其他原因說明</strong><br>
    • 退回倉≠原出貨倉 → 須填<strong>改倉說明</strong>（系統在退回倉入庫，必要時建立新 Lot）<br>
    • <strong>備註</strong>為選填業務補充<br>
  `,

  consignmentSettle: `
    <strong>Settlement 結算</strong><br>
    <strong>流程：</strong><br>
    • 選寄賣案 → 上方顯示案件摘要與<strong>適用促銷</strong><br>
    • 品項池填「本次結算量」→ 自動預覽<strong>贈送／折扣%／促銷單價／計價量／小計</strong>（僅顯示本案有用到的促銷欄）<br>
    • 填結算日、備註 →「提交結算（產生 AR）」；結算單自動配號（如 <code>CS-…</code>）<br>
    • 每次結算產生 <strong>1 張 AR</strong>；同一案件可多次部分結算<br>
    • 客戶若有<strong>經銷折抵餘額</strong>，僅<strong>回饋月份次月（含）起</strong>的寄賣結算提交時才自動抵扣 AR（作廢結算會還原餘額）<br>
    • 按「<strong>月結回饋</strong>」可帶入本案客戶至 FINANCE 財務 → <strong>月結統計</strong>頁<br>
    <strong>促銷（v4.4）：</strong><br>
    • 依<strong>結算日</strong>＋方案有效期＋適用範圍（寄賣案／客戶／全站）自動套用<br>
    • 同品項多方案衝突時，結算頁上方手選一個<br>
    • 買N送M：同產品跨池列合併計算；免費件從<strong>單價較高</strong>的池列先扣；池子扣<strong>全部結算量</strong>，計價量＝結算量−贈送<br>
    • 結算當下寫入<strong>促銷快照</strong>（方案 ID／名稱／條件）；之後改方案不影響歷史<br>
    <strong>結算歷史：</strong><br>
    • 欄<strong>結算ID/促銷ID</strong>：上為結算單號，下為套用方案 ID（灰字）<br>
    • 點列展開明細：產品下灰字為「方案名：條件」（如 618促銷：70%）<br>
    • 明細依方案類型動態顯示欄：<strong>贈送</strong>（買N送M）／<strong>折扣%</strong>／<strong>促銷單價</strong>（固定價）— 無促銷不出現多餘欄<br>
    • <strong>單價</strong>欄：有促銷時顯示<strong>結算單價</strong>，經銷價以灰字對照<br>
    <strong>作廢：</strong>誤結算且 AR<strong>尚未收款</strong> → 結算歷史「作廢」還原池子；<strong>已有收款</strong> → 至 AR 調整<br>
    <strong>規則：</strong><br>
    • 結算量不可超過未售剩餘<br>
    • 金額＝計價量×結算單價加總（贈送件不計價）<br>
    • 案件全部結算＋收回完畢 → 自動「已結案」
  `,

  consignmentPromo: `
    <strong>Promo 促銷方案</strong>（COMMERCIAL 商業方案）<br>
    <strong>流程：</strong><br>
    • 填方案名稱、狀態、有效期、<strong>適用管道</strong>、<strong>適用價格</strong>、適用範圍 → 新增明細（品項＋促銷類型）→「建立」<br>
    • 方案編號自動產生（如 <code>CP-260627-01</code>）；列表「載入」可檢視／更新<br>
    <strong>適用管道：</strong><br>
    • <strong>寄賣</strong>：於寄賣<strong>結算</strong>過帳套用<br>
    • <strong>一般銷售</strong>：於<strong>銷售單建明細</strong>與<strong>出貨過帳</strong>套用（買N送M 每批出貨各自計算）<br>
    • <strong>全部</strong>：兩者皆可<br>
    <strong>適用價格（v4.2.10）：</strong><br>
    • <strong>經銷價</strong>（預設）：依客戶當下經銷等級 × 建議售價<br>
    • <strong>牌價</strong>：產品建議售價；買N送M 與折扣％ 皆以此為底<br>
    <strong>促銷類型：</strong><br>
    • <strong>固定促銷價</strong>：填促銷單價<br>
    • <strong>折扣％</strong>：填 1～100（結算頁明細「折扣%」欄）<br>
    • <strong>買N送M</strong>：填買／送（結算頁明細「贈送」欄；同產品合併計算）<br>
    <strong>適用範圍：</strong>寄賣案 ／ 客戶 ／ 全站（優先：案 &gt; 客戶 &gt; 全站；<strong>一般管道</strong>不可選寄賣案）<br>
    <strong>狀態：</strong>草稿／生效／結束 — 僅<strong>生效</strong>且結算日在有效期內才會於結算頁套用<br>
    <strong>鎖定規則（重要）：</strong><br>
    • 方案若已有<strong>有效結算</strong>（POSTED）引用 → <strong>明細不可改</strong>（僅可檢視）；列表狀態顯示「｜已結算」<br>
    • 若要<strong>提前停止套用</strong>：載入該方案 → 按<strong>「提前結束」</strong>（狀態改結束、有效期迄改為今天；已結算快照保留）<br>
    • 結算作廢（VOID）不計入鎖定<br>
    • 結算明細保存促銷快照，避免事後改方案導致歷史顯示錯誤<br>
    <strong>方案列表：</strong>狀態中文顯示；有效期、範圍、明細數、載入<br>
    • 經銷級距見 <strong>Dealer 經銷方案</strong>；月結作業見 FINANCE 財務 → <strong>月結統計</strong>（結算頁亦有捷徑）
  `,

  consignmentPromoList: `
    <strong>方案列表</strong><br>
    • 顯示方案 ID、名稱、狀態（中文）、有效期、範圍、管道、明細數<br>
    • <strong>客戶篩選</strong>：選客戶後顯示「全站」＋該客戶專屬＋其寄賣案專屬方案<br>
    • 狀態「生效｜已結算」＝已有有效結算引用，載入後<strong>僅可檢視</strong>不可更新<br>
    • 按「載入」帶回上方表單編輯（未鎖定方案可更新）
  `,

  commercialDealer: `
    <strong>Dealer 經銷方案</strong>（級距設定）<br>
    • <strong>月結回饋</strong>：依月請款淨額給回饋％（預設 3 萬／10 萬／30 萬級距）→ 產生回饋請至 FINANCE 財務 → <strong>月結統計</strong>（第二步）<br>
    • <strong>統計來源</strong>：寄賣／一般銷售／合併（決定月結請款淨額從哪些 AR 加總）<br>
    • <strong>累積金額制</strong>：依<strong>月結累積</strong>門檻給等級折數；寄賣<strong>出貨</strong>、一般<strong>銷售訂單</strong>可帶入經銷價，結算／出貨建 AR 時無促銷則以訂單經銷價計價<br>
    • <strong>客戶綁定</strong>請至 COMMERCIAL → <strong>Dealer 方案客戶</strong>（客戶主檔僅唯讀摘要）<br>
    • <strong>權限</strong>：檢視須 Users 勾選 commercial_dealer；建立／更新須<strong>會計／CEO／GA／ADMIN</strong>
  `,

  commercialDealerCustomer: `
    <strong>方案明細</strong><br>
    • 綁定<strong>月結回饋方案</strong>、<strong>經銷等級方案</strong>、回饋方式、排除、累積起算日<br>
    • 月結累積、目前／次月等級、次月折抵為唯讀（一般出貨過帳即累加；寄賣於 FINANCE 財務 → <strong>月結統計</strong> 過帳時累加）<br>
    • <strong>本月預覽</strong>：展開當月請款摘要；純一般出貨顯示精簡一行；有寄賣顯示完整明細<br>
    • <strong>月結統計</strong>：帶入目前客戶與當月，跳至 FINANCE 財務 → 月結統計<br>
    • 取消方案：下拉改（未設定）→ 更新<br>
    • <strong>權限</strong>：Users 勾選 commercial_dealer_customer 即可編輯
  `,

  commercialDealerCustomerList: `
    <strong>Dealer 方案客戶列表</strong><br>
    • 點列開啟下方方案明細<br>
    • <strong>次月折抵</strong>（緊鄰月結回饋方案）：次月結算折抵可用餘額（無則 0.00）<br>
    • <strong>次月等級／經銷價</strong>（緊鄰累積等級）：有升級待生效顯示新等級（<span style="color:#15803d;font-weight:600;">綠色</span>）；未升級則與「目前等級」相同<br>
    • 新增客戶請至 MASTER → 客戶；月結作業請至 FINANCE 財務 → <strong>月結統計</strong>
  `,

  commercialDealerList: `
    <strong>方案列表</strong><br>
    • 顯示方案 ID、名稱、<strong>統計來源</strong>（寄賣／一般／合併）、類型、狀態、有效期、級距數<br>
    • 點列載入方案與級距；已有月結回饋紀錄的方案不可再更新（僅檢視）
  `,

  dealerMonthlyStat: `
    <strong>月結統計</strong><br>
    • 每月<strong>第一步</strong>：選客戶 + 月份 → <strong>預覽統計</strong> → <strong>過帳統計</strong><br>
    • 統計本月請款淨額（寄賣結算 + 一般出貨）；<strong>寄賣部分</strong>計入月結累積；一般出貨已於出貨過帳時累加、不重複<br>
    • 等級升級：達標當月寫「次月待生效」，<strong>次月</strong>才套用新經銷價<br>
    • 有寄賣請款淨額時，須先完成月結統計，才能產生下方「月結回饋」<br>
    • <strong>權限</strong>：檢視須 dealer_rebate 或 commercial_dealer；過帳須會計／CEO／GA／ADMIN
  `,

  dealerRebate: `
    <strong>月結回饋（可選）</strong><br>
    • 須客戶綁定<strong>月結回饋方案</strong>；有寄賣請款時須先完成上方<strong>月結統計</strong><br>
    • 選回饋方式 → <strong>預覽回饋</strong> → <strong>產生回饋</strong>（與 COMMERCIAL 經銷級距搭配）<br>
    • 下方列表<strong>點任一列</strong>：列表下方顯示該筆<strong>產生時快照</strong>（方案、請款淨額、級距、回饋、月結累積）；不必先作廢也能查看<br>
    • <strong>折讓</strong>：調降應收「應收金額」；AR 列表會顯示「已調降」，點應收單號可開 AR 看調整歷程<br>
    • <strong>次月結算折抵</strong>：累加客戶折抵餘額；僅<strong>回饋月份次月（含）起</strong>的寄賣結算提交時才自動抵扣 AR（同月結算不扣）<br>
    • <strong>作廢</strong>：列表「已產生」列可作廢；折讓會還原應收、折抵會扣回餘額；作廢後同月可再預覽產生<br>
    • 計算順序：寄賣結算先 Promo → 月結再加總請款淨額套 Dealer<br>
    • <strong>權限</strong>：檢視須 Users 勾選 dealer_rebate 或 commercial_dealer；產生／作廢須<strong>會計／CEO／GA／ADMIN</strong>
  `,

  commercialDealerRebate: `
    <strong>月結回饋</strong><br>
    • 選客戶 + 月份 → <strong>預覽</strong> → <strong>產生回饋</strong><br>
    • 列表<strong>點列</strong>可查看該筆產生時快照；「預覽」僅用於尚未產生或作廢後重算<br>
    • <strong>折讓</strong>：系統調降該月寄賣應收的「應收金額」（原始金額不變）；AR 列表應收欄會顯示「已調降」；點回饋列表的應收單號可開 AR 看「調整歷程」<br>
    • <strong>次月結算折抵</strong>：累加客戶折抵餘額；僅<strong>回饋月份次月（含）起</strong>的寄賣結算提交時才自動抵扣 AR（同月結算不扣）<br>
    • <strong>作廢</strong>：還原折讓或扣回折抵餘額後，同月可再產生
  `,

  arMain: `
    <strong>這是什麼？</strong><br>
    • <strong>應收帳款（AR）</strong>：記錄客戶未收多少、已收多少；可<strong>多次收款</strong>直到結清<br>
    <strong>AR 從哪來？</strong><br>
    • <strong>一般銷售</strong>：Shipment 出貨<strong>過帳</strong>後自動建立 1 張 AR<br>
    • <strong>寄賣</strong>：Consignment 寄賣<strong>每次結算</strong>產生 1 張 AR<br>
    <strong>流程：</strong><br>
    • 列表：客戶選「全部客戶」時<strong>一客戶一列</strong>（合計＋筆數），點開明細各張 AR；篩選單一客戶時維持逐張列表<br>
    • 可按<strong>起算日區間</strong>篩選（起～迄）；與客戶、狀態篩選可併用<br>
    • 列表按「明細」→ 登記收款（可多次）→ 收滿自動 SETTLED（結清）<br>
    • <strong>批次收款</strong>：勾選同客戶多張未結清 AR → 填一筆匯款總額 → 系統依起算日由舊到新分配（總額可小於未收合計，不可大於）<br>
    • <strong>批次收款紀錄</strong>：工具列「批次收款紀錄」可查歷史批次、點列看分配明細；明細內 AR 單號可跳回應收列表<br>
    • 收不滿或需改應收金額：展開「例外處理」調整或手動沖銷結案<br>
    <strong>規則：</strong><br>
    • <strong>原始金額</strong>：建立 AR 時，依銷售明細<strong>單價 × 出貨／結算數量</strong>加總；僅供對照、不可手改<br>
    • <strong>應收金額</strong>：實際向客戶收取的目標；預設等於原始金額，可經「例外處理」調整，不可小於已收<br>
    • 狀態：OPEN（未收）/ PARTIAL（部分收）/ SETTLED（已結清）<br>
    • 逾期天數依「起算日 + 公司設定門檻」；一般銷售／寄賣門檻可在 Company 公司設定調整<br>
    • 「到期前提醒」：尚未逾期、但距離逾期門檻 ≤ 公司設定天數時，列表顯示「還有 N 天」（黃底）；Dashboard 有「即將逾期 AR」<br>
    • 可操作：會計（FN）／CEO／GA／ADMIN；Users 須勾選 ar 模組<br>
    • FINANCE 選單：上述角色 + 模組權限（CEO/GA/ADMIN 例外一律可見）<br>
    <strong>常見提示：</strong><br>
    • 「已收 &lt; 應收金額」→ 未收差額，請再收款、調整應收金額或手動沖銷結案<br>
    • 列表「逾期」欄 &gt; 0 表示超過門檻，優先追款；「還有 N 天」表示即將逾期
  `,

  arBatch: `
    <strong>何時使用？</strong><br>
    • 客戶每月匯一筆總額、對應多張結算 AR 時<br>
    <strong>流程：</strong><br>
    • 列表勾選同客戶的未結清 AR → 顯示「批次收款」區；<strong>與 AR 明細互斥</strong>（有勾選時不顯示明細，點列開明細會清除勾選）<br>
    • 可「全選未結清」或「<strong>本月起算日</strong>」（起算日落在當月；多客戶時請先篩選單一客戶）<br>
    • 填收款日、本次匯款總額、末五碼／帳戶名（選填）、備註 → 看分配預覽 →「確認批次收款」<br>
    <strong>規則：</strong><br>
    • 僅限<strong>同一客戶、同一幣別</strong><br>
    • 分配順序：<strong>起算日由舊到新</strong>；同日再比<strong>建立時間</strong>（較早結算先收）<br>
    • 總額可<strong>小於</strong>未收合計（先付舊單／部分入帳）；不可<strong>大於</strong>未收合計<br>
    • 底層仍寫入各 AR 的收款紀錄，不另建合併 AR
  `,

  arBatchHistory: `
    <strong>這是什麼？</strong><br>
    • 每次「確認批次收款」會產生一個<strong>批次編號</strong>（ARB…），底下各 AR 的收款明細共用此編號<br>
    <strong>怎麼用？</strong><br>
    • AR 模組工具列按「<strong>批次收款紀錄</strong>」→ 列表顯示歷史批次；可按客戶篩選<br>
    • <strong>點列</strong>展開下方「批次收款明細」：匯款總額、備註、末五碼／帳戶名，以及各 AR 分配金額<br>
    • 明細中點 <strong>AR 單號</strong> 可跳回應收列表並開啟該 AR（查單筆收款／作廢）<br>
    • 點列開啟明細 → 看分配後按右上角「<strong>作廢</strong>」一次作廢整批尚未作廢的分配收款<br>
    • 再按同一列可收合明細；按「應收列表」切回 AR 主列表<br>
    <strong>備註：</strong><br>
    • 若批次內某筆收款已作廢，列表匯款總額會顯示有效金額，並標示作廢筆數
  `,

  arDetail: `
    <strong>流程：</strong><br>
    • 填收款日、金額 →「登記收款」；可重複登記多筆<br>
    • <strong>沖銷差額（未收≤ 100 可選）</strong>（備註左側）：登記收款時順便把小額未收調掉並結清；本質是<strong>調降應收到已收</strong>（會寫入調整歷程），但僅限未收 ≤ 100，且原因限匯費／手續費／尾數；大額或折讓議價仍用例外處理<br>
    • 收款紀錄可按「修改」→ 上方表單改為編輯模式 →「儲存修改」（已結案 AR 也可改舊收款；若改<strong>金額</strong>後未收滿會自動重開）<br>
    • 登錯可按收款紀錄「<strong>作廢</strong>」；紀錄<strong>仍保留</strong>並標示已作廢，已收會重算（已結清 AR 可能重開）<br>
    • 若本 AR <strong>已有調整歷程</strong>（含手動沖銷結案）：修改收款時<strong>僅可改日期／備註</strong>，金額鎖定；改應收請用「重開調整」<br>
    • 已收合計 ≥ 應收金額時，系統<strong>自動結清</strong>（SETTLED），無需另按「正常結案」<br>
    • 按「Log」可跳到 Logs 查此 AR 的操作紀錄<br>
    <strong>欄位：</strong><br>
    • <strong>原始金額</strong>：建立 AR 時明細加總（一般銷售＝銷售單價×出貨量；寄賣＝經銷價×本次結算量）。僅供對照，調整應收後可能與應收金額不同<br>
    • <strong>應收金額</strong>：實際催收目標；預設 = 原始金額。折讓／議價請用「例外處理 → 調整應收金額」，不可小於已收<br>
    • <strong>已收</strong>：本 AR 所有收款紀錄加總<br>
    • <strong>未收</strong>：應收金額 − 已收（摘要區可見）<br>
    • 「調整應收金額」：未結案時預填<strong>已收金額</strong>（尾差／去零頭）；已結案時預填<strong>目前應收</strong>，改大即可重開追款<br>
    <strong>常見提示：</strong><br>
    • AR 已 SETTLED → 不可再<strong>新增</strong>收款，但可修改既有收款或「重開調整」<br>
    • 登記成功後列表狀態會更新；請 Ctrl+F5 若畫面未刷新
  `,

  arException: `
    <strong>何時使用？</strong><br>
    • 折讓、議價、金額更正 →「調整應收金額」（<strong>折讓／議價僅可減少</strong>應收；增減請用<strong>金額更正</strong>）<br>
    • 已結案（SETTLED）若調錯：展開「重開調整」→ 新應收改大（如 5500→5600）→ 原因選「金額更正」；AR 會重開，舊調整歷程保留<br>
    • 呆帳、爭議款、老闆決定不追 →「手動沖銷結案」：若有未收差額，系統<strong>自動把應收金額調至已收</strong>並寫入調整歷程，再結案<br>
    <strong>規則：</strong><br>
    • 原因必選；選「其他」須填說明<br>
    • 未結案：「調整應收金額」預填<strong>已收金額</strong>，方便去零頭／尾差<br>
    • 已結案：僅顯示「重開調整」（隱藏手動沖銷結案）；調整歷程不可刪，以新調整更正<br>
    • 新應收金額不可小於已收金額<br>
    • <strong>折讓／議價</strong>：新應收須<strong>小於</strong>調整前；<strong>金額更正／其他</strong>：可增可減<br>
    • 曾<strong>手動沖銷結案</strong>後若<strong>調高</strong>應收，須二次確認「重開追款」<br>
    • 已有調整歷程後，<strong>不可再改收款金額</strong>（僅日期／備註）<br>
    • 調整／手動沖銷結案／修改收款會寫入 Logs<br>
    • 手動沖銷結案僅未結案 AR 可用<br>
    <strong>常見提示：</strong><br>
    • 手動沖銷結案前請確認已無法再收款；結案後若需改應收，請用「重開調整」
  `,
};


/* ===============================
   Help Engine
================================ */

function initHelpComponent(){

  document.querySelectorAll("[data-help]").forEach(el=>{

    const key = el.getAttribute("data-help");
    const content = HelpConfig[key];
    if(!content) return;

    el.classList.add("info-icon");
    el.innerHTML = "!";
    el.setAttribute("title","注意事項");

    const header = el.closest(".card-header");
    if (!header) return;

    const box = document.createElement("div");
    box.className = "help-inline";
    box.innerHTML = content;

    header.insertAdjacentElement("afterend", box);

    el.addEventListener("click",()=>{
      box.classList.toggle("show");
    });

  });

  // 明細列表：展開時 summary 改為「隱藏明細列表」，收合時改為「顯示明細列表」
  const content = document.getElementById("content");
  if (content) {
    content.querySelectorAll(".items-list-details").forEach(function (details) {
      const summary = details.querySelector("summary");
      if (!summary) return;
      const showText = summary.getAttribute("data-summary-show") || "顯示明細列表";
      const hideText = summary.getAttribute("data-summary-hide") || "隱藏明細列表";
      details.addEventListener("toggle", function () {
        summary.textContent = details.open ? hideText : showText;
      });
      summary.textContent = details.open ? hideText : showText;
    });
  }
}

function ensureHelpBoundForEl_(el){
  if(!el) return null;
  const key = el.getAttribute && el.getAttribute("data-help");
  if(!key) return null;
  const content = HelpConfig[key];
  if(!content) return null;

  // 已建立過就直接回傳
  const existedId = el.getAttribute("data-help-box-id");
  if(existedId){
    const existed = document.getElementById(existedId);
    if(existed) return existed;
  }

  // 找對應卡片 header
  const header = (typeof el.closest === "function") ? el.closest(".card-header") : null;
  if(!header) return null;

  // 建立 icon 樣式（避免 initHelpComponent 沒跑到時是空白 span）
  try{
    el.classList.add("info-icon");
    if(!String(el.textContent || "").trim()) el.textContent = "!";
    el.setAttribute("title","注意事項");
  }catch(_e0){}

  const box = document.createElement("div");
  box.className = "help-inline";
  box.innerHTML = content;

  // 產生唯一 id 供後續快速定位
  const id = "helpBox-" + key + "-" + String(Date.now()) + "-" + String(Math.floor(Math.random()*1000));
  box.id = id;
  try{ el.setAttribute("data-help-box-id", id); }catch(_e1){}

  header.insertAdjacentElement("afterend", box);
  return box;
}

/**
 * 兼容：部分環境可能讓 initHelpComponent 未執行到，
 * 這裡用事件委派確保「藍色驚嘆號」永遠可點。
 */
function bindHelpDelegated_(){
  try{
    if(document.documentElement && document.documentElement.getAttribute("data-erp-helpbind") === "1") return;
    if(document.documentElement) document.documentElement.setAttribute("data-erp-helpbind","1");
  }catch(_e){}

  document.addEventListener("click", function(ev){
    const t = ev && ev.target;
    if(!t) return;
    const icon = (typeof t.closest === "function") ? t.closest("[data-help], .info-icon") : null;
    if(!icon) return;

    // 只處理有 data-help 的元素（避免誤傷別的 .info-icon）
    const key = icon.getAttribute && icon.getAttribute("data-help");
    if(!key) return;

    const box = ensureHelpBoundForEl_(icon);
    if(!box) return;

    try{
      ev.preventDefault();
      ev.stopPropagation();
    }catch(_e2){}

    box.classList.toggle("show");
  }, true);
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", bindHelpDelegated_);
}else{
  bindHelpDelegated_();
}

/*********************************
 * Global Sort Engine v1
 *********************************/

function applySorting(list, field, sortState){

  if(sortState.field === field){
    sortState.asc = !sortState.asc;
  }else{
    sortState.field = field;
    sortState.asc = true;
  }

  const sorted = [...list].sort((a,b)=>{
    if(a[field] > b[field]) return sortState.asc ? 1 : -1;
    if(a[field] < b[field]) return sortState.asc ? -1 : 1;
    return 0;
  });

  updateSortIcons(sortState.field, sortState.asc);

  return sorted;
}


function updateSortIcons(field, asc){

  document.querySelectorAll("th span[id^='sort-']")
    .forEach(el=>el.innerHTML="");

  if(!field) return;

  const icon = asc ? " ▲" : " ▼";
  const target = document.getElementById("sort-"+field);

  if(target) target.innerHTML = icon;
}

/*********************************
 * Global Deactivate Engine v1
 *********************************/

function canDeactivate(recordId, relationConfig){

  for(const config of relationConfig){

    const moduleData = erpData[config.module] || [];

    if(moduleData.some(r => r[config.field] === recordId)){
      return false;
    }
  }

  return true;
}