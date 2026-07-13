/*********************************
 * API 後端錯誤 → 繁中白話（全系統共用）
 *********************************/

(function (global) {
  var FIELD_LABELS_ = {
    case_id: "寄賣案",
    customer_id: "客戶",
    open_date: "開案日",
    return_id: "收回單號",
    return_reason: "收回原因",
    return_date: "收回日期",
    return_warehouse_id: "退回倉庫",
    settlement_id: "結算單號",
    shipment_id: "出貨單號",
    process_order_id: "加工單號",
    import_doc_id: "進口單號",
    import_receipt_id: "進口收貨單號",
    import_item_id: "進口明細",
    ar_id: "應收單號",
    lot_id: "批號 Lot",
    product_id: "產品",
    warehouse_id: "倉庫",
    supplier_id: "供應商",
    created_by: "操作人員",
    updated_by: "操作人員",
    void_reason: "作廢原因",
    amount_due: "應收金額",
    payment_date: "收款日期",
    session_token: "登入狀態",
    items_json: "明細資料",
    lines_json: "明細資料",
    movement_type: "異動類型",
    qty: "數量",
    unit: "單位",
    factory_lot: "加工廠 Lot",
    pool_item_id: "品項池編號"
  };

  function fieldLabel_(key) {
    var k = String(key || "").trim().toLowerCase();
    return FIELD_LABELS_[k] || String(key || "欄位");
  }

  function hasCjk_(s) {
    return /[\u4e00-\u9fff]/.test(String(s || ""));
  }

  function rule_(re, zh) {
    return { re: re, zh: zh };
  }

  var RULES_ = [
    rule_(/session_token\s+required|err_session_required/i, "登入狀態已過期或尚未完成登入。\n\n建議：請重新登入或 Ctrl+F5 後再試。"),
    rule_(/permission\s+denied|err_permission_denied/i, "您沒有權限執行此操作，或登入已失效。\n\n建議：請重新登入；並確認 Users 已勾選對應模組權限。"),
    rule_(/unknown\s+or\s+missing\s+action/i, "系統無法判斷要執行的操作。\n\n建議：Ctrl+F5 強刷；確認 API 已啟動且網址正確。"),
    rule_(/forbidden\s*\(transactional\s+table\)/i, "此資料不可直接改刪，請使用對應的「過帳／作廢」流程。"),

    rule_(/err_consignment_case_returned|err_consignment_returned/i, "此出貨所掛寄賣案已有收回紀錄，無法作廢出貨。\n\n建議：到 Case 寄賣客戶查看收回；誤操作請先作廢收回。"),
    rule_(/err_consignment_case_settled|err_consignment_settled/i, "此出貨所掛寄賣案已有結算，無法作廢出貨。\n\n建議：到 Case 歷史作廢結算（AR 須未收款）。"),
    rule_(/err_consignment_case_stl_has_payment|ar has payments.*consignment settlement/i, "此結算對應 AR 已有收款，無法作廢結算。\n\n建議：在 AR 以折讓或調整處理。"),
    rule_(/err_consignment_case_delete_has_pool/i, "此寄賣案已有出貨品項池，無法刪除。\n\n建議：若為誤開案且尚未出貨，請確認品項池為空；已有出貨請勿刪案。"),
    rule_(/err_consignment_case_delete_has_settlement/i, "此寄賣案已有結算紀錄，無法刪除。\n\n建議：請至結算頁作廢結算；空案才可刪除。"),
    rule_(/err_consignment_case_delete_has_return/i, "此寄賣案已有收回紀錄，無法刪除。\n\n建議：請至收回頁作廢收回；空案才可刪除。"),
    rule_(/err_consignment_case_delete_has_shipment/i, "此寄賣案仍有有效寄賣出貨，無法刪除。\n\n建議：請先至出貨管理作廢出貨。"),
    rule_(/無法確認客戶或結算月份.*月結回饋護欄/i, "無法確認此結算對應的客戶或月份，系統為安全起見不允許作廢。\n\n建議：請聯絡管理員檢查結算資料。"),
    rule_(/已產生月結回饋.*請先到.*月結統計/i, "此筆結算已計入月結回饋，無法直接作廢。\n\n建議：先到「月結回饋」作廢該筆，再回來作廢結算。"),
    rule_(/已產生月結統計.*請先到.*月結統計/i, "此筆結算已計入月結統計，無法直接作廢。\n\n建議：先到「月結統計」作廢該筆，再回來作廢結算。"),
    rule_(/月結統計已過帳.*不建議直接新增請款/i, function (m) {
      const ym = String(m || "").match(/\d{4}-\d{2}/);
      const period = ym ? ym[0] : "該月";
      return (
        "此客戶 " +
        period +
        " 月結統計已過帳，不建議直接新增請款。\n\n請先至 FINANCE 財務 → 月結統計作廢後方可補單。"
      );
    }),
    rule_(/月結統計已過帳.*不可再新增請款/i, function (m) {
      const ym = String(m || "").match(/\d{4}-\d{2}/);
      const period = ym ? ym[0] : "該月";
      return (
        "此客戶 " +
        period +
        " 月結統計已過帳，不建議直接新增請款。\n\n請先至 FINANCE 財務 → 月結統計作廢後方可補單。"
      );
    }),
    rule_(/月結統計已過帳.*過帳後又有新請款/i, "本月月結統計已過帳，但過帳後又有新結算或出貨。\n\n建議：先到「月結統計」作廢後重新過帳；若已產生「月結回饋」亦須一併作廢。"),
    rule_(/可重試「作廢本月月結」續作/i, "本月月結作廢未完成。\n\n建議：直接再按一次「作廢本月月結」，系統會從未完成步驟續作（已完成的步驟會自動跳過）。"),
    rule_(/無法確認月結狀態/i, "無法確認月結狀態（可能後端暫時無法連線）。\n\n建議：稍後重試；請勿在月結已過帳月份強行補單。"),
    rule_(/err_consignment_pool_conflict|pool item changed/i, "品項池已被更新（可能與他人同時操作）。\n\n建議：重新整理頁面後再試。"),
    rule_(/remark\s+required\s+when\s+return\s+warehouse/i, "退回倉庫與原出貨倉不同，請填寫改倉說明。"),
    rule_(/remark\s+required\s+when\s+return\s+reason\s+is\s+OTHER/i, "選擇「其他原因」時，請填寫其他原因說明。"),
    rule_(/settle_qty\s+exceeds\s+unsold\s+remaining/i, "結算量超過未售剩餘。\n\n建議：重新整理確認未售量；誤結算請作廢後重結。"),
    rule_(/return_qty\s+exceeds\s+unsold\s+remaining/i, "收回量超過未售剩餘。\n\n建議：重新整理品項池後再試。"),
    rule_(/no pool item matches factory lot/i, "找不到此加工廠 Lot 對應的品項池。\n\n建議：重新整理頁面後再試；仍失敗請聯絡管理員。"),
    rule_(/return_qty\s+exceeds\s+settled\s+remaining/i, "收回量超過可收回的已結算量。\n\n建議：重新整理後再試。"),
    rule_(/cannot revert more returned qty/i, "作廢收回失敗：品項池「已收回」與單據不符。\n\n建議：重啟 API 後再試；仍失敗請回報收回單號。"),
    rule_(/insufficient\s+available\s+qty.*cancel\s+consignment\s+return/i, "作廢收回失敗：退回倉 Lot 可用量不足（可能已出貨或扣庫）。"),
    rule_(/return already has cancel reversal movements/i, "此收回單已作廢過，不可重複作廢。"),
    rule_(/consignment case is closed/i, "寄賣案已結案，不可再結算或收回。"),
    rule_(
      /dealer_cumulative|could not find the .*column.*consignment_case_settlement/i,
      "資料庫尚未部署「結算經銷價快照」欄位。\n\n建議：請管理員在 Supabase 執行 server/sql/v4.2.5.05_結算經銷價快照.sql。"
    ),
    rule_(/erp_cc_void_return_tx\s+not\s+found/i, "資料庫尚未部署寄賣作廢功能。\n\n建議：請管理員執行 server/sql/v4.2.2.03_寄賣作廢與交易RPC.sql。"),
    rule_(/in movement not found for lot/i, "找不到對應的入庫異動，無法作廢收回。\n\n建議：請聯絡管理員檢查庫存異動。"),

    rule_(/err_ar_exists|shipment has ar with payments/i, "此出貨已有應收或收款，無法作廢出貨。\n\n建議：先處理 AR。"),
    rule_(/cannot settle:.*amount_received/i, "收款金額不足，無法結清 AR。"),
    rule_(/ar already settled/i, "此 AR 已結清。"),
    rule_(/批次收款僅限同一客戶/i, "批次收款只能勾選同一客戶的 AR。"),
    rule_(/批次收款僅限同一幣別/i, "批次收款只能勾選同一幣別的 AR。"),
    rule_(/匯款總額不可大於未收合計/i, "匯款總額不可大於勾選 AR 的未收合計。\n\n請改小總額或減少勾選。"),
    rule_(/此收款已作廢/i, "此收款已作廢。"),
    rule_(/payment not found/i, "找不到收款紀錄。"),
    rule_(/ar not found/i, "找不到應收單（AR）。"),
    rule_(/新應收金額不可小於已收|amount_due unchanged/i, "應收調整不符合規則（不可高於已收或金額未變）。"),
    rule_(/折讓／議價調整僅可減少應收/i, function () { return "折讓／議價僅可減少應收金額。"; }),

    rule_(/process\s+order\s+already\s+exists/i, "此加工單編號已存在。\n\n建議：按 Load 載入原單，或清除後產生新編號。"),
    rule_(/process order is cancelled/i, "加工單已作廢。"),
    rule_(/process order already posted/i, "加工單已過帳。"),
    rule_(/process order not found/i, "找不到加工單。"),
    rule_(/no inputs\. please issue/i, "尚未投料，請先執行投料。"),
    rule_(/cannot retract: outputs exist/i, "已有回收產出，無法撤回投料。"),
    rule_(/input lot used in shipment/i, "投料批號已用於出貨，無法撤回。"),
    rule_(/output lot used in shipment/i, "產出批號已用於出貨，無法作廢產出。"),
    rule_(/factory_lot required/i, "加工回收須填「加工廠 Lot」。"),
    rule_(/warehouse is not active/i, "所選倉庫未啟用。"),

    rule_(/import receipt already posted/i, "進口收貨單已過帳。"),
    rule_(/import receipt already cancelled/i, "進口收貨單已作廢。"),
    rule_(/import receipt not found/i, "找不到進口收貨單。"),
    rule_(/import document is cancelled/i, "進口單已作廢。"),
    rule_(/import document not found/i, "找不到進口單。"),
    rule_(/import source changed|please reload and try again/i, "進口資料已變更。\n\n建議：按 Load 重新載入後再送。"),
    rule_(/insufficient available qty for lot.*cancel import/i, "作廢進口收貨失敗：Lot 可用量不足。"),

    rule_(/shipment already posted/i, "出貨單已過帳。"),
    rule_(/shipment already cancelled|already canceled/i, "出貨單已作廢。"),
    rule_(/shipment not found/i, "找不到出貨單。"),
    rule_(/sales order.*cancelled|sales order.*canceled/i, "銷售單已作廢。"),
    rule_(/sales order already has shipment records.*reset items is not allowed/i, "此銷售單已有出貨紀錄，明細不可修改。僅可改備註。"),
    rule_(/already has shipment records.*reset items is not allowed/i, "此單已有出貨紀錄，明細不可修改。僅可改備註。"),
    rule_(/already has receipt records.*reset items is not allowed/i, "此單已有收貨紀錄，明細不可修改。僅可改備註。"),

    rule_(/negative inventory is not allowed/i, "庫存不可為負數。"),
    rule_(/only approved lot can be used/i, "僅 QA 放行（APPROVED）的批號可出庫。"),
    rule_(/lot is closed|inventory_status is not active/i, "批號已關閉或不可用。"),
    rule_(/expired lot.*void/i, "批號已過期作廢，不可出庫。"),
    rule_(/lot not found/i, "找不到批號 Lot。"),
    rule_(/lot has no inventory movement/i, "此批號尚無庫存異動紀錄。"),

    rule_(/has receipts\.\s+only\s+remark/i, "單據已有下游收貨紀錄，僅可改備註。"),
    rule_(/already received\.\s+only\s+remark/i, "已收貨，僅可改備註。"),
    rule_(/already shipped\.\s+only\s+remark/i, "已出貨，僅可改備註。"),
    rule_(/creating\s+new\s+items\s+is\s+not\s+allowed/i, "已有下游紀錄，不可新增明細。"),
    rule_(/is\s+(cancelled|closed|posted|shipped)\.\s+only\s+remark/i, "單據已結案，僅可改備註。"),

    rule_(/record not found/i, "找不到資料。"),
    rule_(/already exists/i, "資料已存在，請勿重複建立。"),
    rule_(/duplicate key|unique constraint/i, "資料重複，請更換編號後再試。"),
    rule_(/dev_clear.*prod|prod.*refus/i, "正式環境禁止一鍵刪除測試資料。"),

    rule_(/please\s+reload\s+and\s+try\s+again|changed\.\s+please\s+reload/i, "資料已被其他人更新。\n\n建議：按 Load／重新整理後再送。"),
    rule_(/already void|already_void/i, "單據已是作廢狀態。"),
    rule_(/cannot be voided/i, "此單據狀態不可作廢。"),
    rule_(/settlement cannot be voided/i, "此結算單不可作廢。"),
    rule_(/return cannot be voided/i, "此收回單不可作廢。"),

    rule_(/insufficient\s+available\s+qty/i, "Lot 可用量不足。"),
    rule_(/cannot revert/i, "無法還原數量（與系統紀錄不符）。"),
    rule_(/exceeds\s+.*remaining/i, "數量超過剩餘可用量。"),
    rule_(/must be\s*>\s*0/i, "數量須大於 0。"),
    rule_(/must be\s*>=\s*0/i, "金額或數量不可為負。"),

    rule_(/builtin admin/i, "內建管理員帳號不可刪除。"),
    rule_(/reserved user_id/i, "此使用者 ID 為系統保留。")
  ];

  function matchRule_(text) {
    var raw = String(text || "").trim();
    if (!raw) return "";
    var i;
    for (i = 0; i < RULES_.length; i++) {
      var r = RULES_[i];
      if (r.re.test(raw)) {
        return typeof r.zh === "function" ? r.zh(raw) : r.zh;
      }
    }
    return null;
  }

  function translateRequired_(text) {
    var m = String(text || "").trim().match(/^([a-z0-9_]+)\s+required$/i);
    if (m) return "請填寫「" + fieldLabel_(m[1]) + "」。";
    m = String(text || "").trim().match(/^([a-z0-9_]+)\s+required\s*\(/i);
    if (m) return "請填寫「" + fieldLabel_(m[1]) + "」。";
    return null;
  }

  function translateNotFound_(text) {
    var m = String(text || "").match(/^(.+?)\s+not found(?::\s*(.+))?$/i);
    if (!m) return null;
    var subject = String(m[1] || "").replace(/_/g, " ");
    var id = m[2] ? String(m[2]).trim() : "";
    if (/consignment case/i.test(subject)) return "找不到寄賣案" + (id ? "：" + id : "") + "。";
    if (/pool item/i.test(subject)) return "找不到品項池列" + (id ? "：" + id : "") + "。";
    if (/settlement/i.test(subject)) return "找不到結算單" + (id ? "：" + id : "") + "。";
    if (/return/i.test(subject)) return "找不到收回單" + (id ? "：" + id : "") + "。";
    if (/shipment/i.test(subject)) return "找不到出貨單" + (id ? "：" + id : "") + "。";
    if (/process order/i.test(subject)) return "找不到加工單" + (id ? "：" + id : "") + "。";
    if (/import/i.test(subject)) return "找不到進口相關單據" + (id ? "：" + id : "") + "。";
    if (/lot/i.test(subject)) return "找不到批號" + (id ? "：" + id : "") + "。";
    if (/ar/i.test(subject)) return "找不到應收單" + (id ? "：" + id : "") + "。";
    return "找不到資料" + (id ? "：" + id : "") + "。";
  }

  function translateAlready_(text) {
    var m = String(text || "").match(/^(.+?)\s+already\s+(.+)$/i);
    if (!m) return null;
    var thing = String(m[1] || "");
    var state = String(m[2] || "").toLowerCase();
    if (/posted/i.test(state)) return "單據已過帳，不可重複操作。";
    if (/cancelled|canceled|void/i.test(state)) return "單據已作廢。";
    if (/exists/i.test(state)) return "編號已存在，請改用其他編號。";
    if (/settled/i.test(state)) return "已結清或已結算。";
    if (/received/i.test(state)) return "已完成收貨。";
    if (/shipped/i.test(state)) return "已完成出貨。";
    return "狀態不允許此操作（" + thing.replace(/_/g, " ") + "）。";
  }

  function genericZh_(text) {
    var lower = String(text || "").toLowerCase();
    if (/not found|missing/.test(lower)) return "找不到必要資料，請確認編號是否正確。";
    if (/permission|forbidden|denied/.test(lower)) return "沒有權限或登入已失效。";
    if (/insufficient|exceeds|cannot|not allowed|invalid/.test(lower)) {
      return "資料或數量不符合系統規則。\n\n建議：重新整理頁面後再試；若重複發生請聯絡管理員。";
    }
    if (/required/.test(lower)) return "有必填欄位未填，請檢查表單。";
    if (/already/.test(lower)) return "單據狀態不允許重複操作。";
    return (
      "操作未成功（系統規則限制）。\n\n" +
      "建議：重新整理後再試；請記下操作步驟與單據編號，聯絡管理員協助。"
    );
  }

  function translateBackendErrorLine_(raw) {
    var text = String(raw || "").trim();
    if (!text) return "";

    if (hasCjk_(text) && !/^[A-Z0-9_]+:/.test(text)) {
      return text;
    }

    var hit = matchRule_(text);
    if (hit) return hit;

    hit = translateRequired_(text);
    if (hit) return hit;

    hit = translateNotFound_(text);
    if (hit) return hit;

    hit = translateAlready_(text);
    if (hit) return hit;

    if (/^err_[a-z0-9_]+/i.test(text)) {
      hit = matchRule_(text);
      if (hit) return hit;
    }

    return genericZh_(text);
  }

  function translateBackendErrorText_(text) {
    var raw = String(text || "").trim();
    if (!raw) return null;

    var hit = matchRule_(raw);
    if (hit) return hit;

    var parts = raw.split(/\s*;\s*|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length <= 1) {
      return translateBackendErrorLine_(raw);
    }

    var out = [];
    var seen = {};
    parts.forEach(function (p) {
      var zh = translateBackendErrorLine_(p);
      if (zh && !seen[zh]) {
        seen[zh] = 1;
        out.push(zh);
      }
    });
    return out.length ? out.join("\n\n") : translateBackendErrorLine_(raw);
  }

  global.translateBackendErrorLine_ = translateBackendErrorLine_;
  global.translateBackendErrorText_ = translateBackendErrorText_;
})(typeof window !== "undefined" ? window : globalThis);
