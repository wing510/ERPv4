-- ERP v4.2.2.02 寄賣改倉收回補正（Supabase SQL Editor → Run）
-- 問題：Return 收回時「退回倉 ≠ 原 Lot 倉別」，舊版後端把 +IN 寫在原 Lot，
--       導致 Movements 倉別是新店、Warehouse 倉庫庫存卻查不到（Lot 主檔仍在萬華）。
-- 補正：為每筆異常明細在新退回倉建立 Lot，並將收回 IN 異動改掛新 Lot；重算 lot_balance。
--
-- 使用方式：
--   1. 只跑「步驟 1」確認異常列
--   2. 確認無誤後跑「步驟 2」（會改資料）
--   3. 跑「步驟 3」驗證
-- 可選：步驟 2 前設定單筆收回單（留 NULL = 全部異常一併補正）
--
-- 儲存查詢名建議：v4.2.2.02_寄賣改倉收回補正

-- ── 可選：只補正某一張收回單（例 'CR-260622-XXXX'）；NULL = 全部 ──
-- \set target_return_id NULL
-- Supabase 不支援 psql 變數時，請改用手動 WHERE：
--   AND r.return_id = 'CR-260622-XXXX'

-- ========== 步驟 1：查詢異常（只讀）==========
SELECT
  r.return_id,
  r.case_id,
  r.return_date,
  r.return_warehouse_id AS return_wh,
  ri.return_item_id,
  ri.factory_lot,
  ri.return_qty,
  ri.lot_id AS wrong_lot_id,
  l.warehouse_id AS lot_wh,
  mv.movement_id,
  mv.qty AS mv_qty,
  mv.warehouse_id AS mv_wh,
  mv.created_at AS mv_at
FROM consignment_case_return r
JOIN consignment_case_return_item ri ON ri.return_id = r.return_id
JOIN lot l ON l.lot_id = ri.lot_id
LEFT JOIN inventory_movement mv
  ON mv.ref_type = 'CONSIGNMENT_CASE_RETURN'
 AND mv.ref_id = r.return_id
 AND mv.lot_id = ri.lot_id
 AND upper(trim(mv.movement_type)) = 'IN'
 AND abs(coalesce(mv.qty, 0) - coalesce(ri.return_qty, 0)) < 0.001
WHERE coalesce(upper(trim(r.status)), 'POSTED') = 'POSTED'
  AND upper(trim(coalesce(l.warehouse_id, ''))) IS DISTINCT FROM upper(trim(coalesce(r.return_warehouse_id, '')))
-- AND r.return_id = 'CR-260622-XXXX'  -- 可選：單筆
ORDER BY r.return_id, ri.return_item_id;


-- ========== 步驟 2：補正（會改 lot / movement / return_item / lot_balance）==========
BEGIN;

DO $$
DECLARE
  rec RECORD;
  v_new_lot_id text;
  v_old_lot_id text;
  v_src lot%ROWTYPE;
  v_fix_tag text := 'v4.2.2.02_寄賣改倉收回補正';
BEGIN
  FOR rec IN
    SELECT
      r.return_id,
      r.case_id,
      r.return_warehouse_id,
      r.return_date,
      r.remark AS return_remark,
      r.created_by,
      r.created_at,
      ri.return_item_id,
      ri.lot_id AS wrong_lot_id,
      ri.return_qty,
      mv.movement_id
    FROM consignment_case_return r
    JOIN consignment_case_return_item ri ON ri.return_id = r.return_id
    JOIN lot l ON l.lot_id = ri.lot_id
    JOIN inventory_movement mv
      ON mv.ref_type = 'CONSIGNMENT_CASE_RETURN'
     AND mv.ref_id = r.return_id
     AND mv.lot_id = ri.lot_id
     AND upper(trim(mv.movement_type)) = 'IN'
     AND abs(coalesce(mv.qty, 0) - coalesce(ri.return_qty, 0)) < 0.001
    WHERE coalesce(upper(trim(r.status)), 'POSTED') = 'POSTED'
      AND upper(trim(coalesce(l.warehouse_id, ''))) IS DISTINCT FROM upper(trim(coalesce(r.return_warehouse_id, '')))
    -- AND r.return_id = 'CR-260622-XXXX'  -- 可選：單筆
    ORDER BY r.return_id, ri.return_item_id
  LOOP
    v_old_lot_id := rec.wrong_lot_id;
    v_new_lot_id := 'LOT-FIX-' || replace(rec.return_item_id, '-', '');

    IF exists (SELECT 1 FROM lot WHERE lot_id = v_new_lot_id) THEN
      RAISE EXCEPTION '新 Lot 已存在，請人工處理：%', v_new_lot_id;
    END IF;

    SELECT * INTO v_src FROM lot WHERE lot_id = v_old_lot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '找不到原 Lot：%', v_old_lot_id;
    END IF;

    INSERT INTO lot (
      lot_id,
      product_id,
      warehouse_id,
      source_type,
      source_id,
      qty,
      unit,
      type,
      status,
      inventory_status,
      received_date,
      manufacture_date,
      expiry_date,
      factory_lot,
      remark,
      created_by,
      created_at,
      updated_by,
      updated_at,
      system_remark
    ) VALUES (
      v_new_lot_id,
      v_src.product_id,
      upper(trim(rec.return_warehouse_id)),
      'CONSIGNMENT_CASE_RETURN',
      rec.return_id,
      rec.return_qty,
      v_src.unit,
      v_src.type,
      coalesce(v_src.status, 'APPROVED'),
      'ACTIVE',
      coalesce(rec.return_date, current_date),
      v_src.manufacture_date,
      v_src.expiry_date,
      v_src.factory_lot,
      '',
      coalesce(rec.created_by, 'SQL_FIX'),
      coalesce(rec.created_at, now()),
      'SQL_FIX',
      now(),
      v_fix_tag || ' from ' || v_old_lot_id || ' return ' || rec.return_id
    );

    UPDATE inventory_movement
    SET
      lot_id = v_new_lot_id,
      warehouse_id = upper(trim(rec.return_warehouse_id)),
      system_remark = trim(both ' ' FROM coalesce(system_remark, '') || ' | ' || v_fix_tag),
      updated_by = 'SQL_FIX',
      updated_at = now()
    WHERE movement_id = rec.movement_id;

    UPDATE consignment_case_return_item
    SET
      lot_id = v_new_lot_id,
      system_remark = trim(both ' ' FROM coalesce(system_remark, '') || ' | ' || v_fix_tag),
      updated_by = 'SQL_FIX',
      updated_at = now()
    WHERE return_item_id = rec.return_item_id;

    INSERT INTO lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
    SELECT
      x.lot_id,
      coalesce(sum(m.qty), 0),
      count(m.movement_id),
      (
        SELECT m2.movement_id
        FROM inventory_movement m2
        WHERE m2.lot_id = x.lot_id
        ORDER BY m2.created_at DESC, m2.movement_id DESC
        LIMIT 1
      ),
      now(),
      'SQL_FIX'
    FROM (VALUES (v_old_lot_id), (v_new_lot_id)) AS x(lot_id)
    LEFT JOIN inventory_movement m ON m.lot_id = x.lot_id
    GROUP BY x.lot_id
    ON CONFLICT (lot_id) DO UPDATE SET
      available_qty = EXCLUDED.available_qty,
      movement_count = EXCLUDED.movement_count,
      last_movement_id = EXCLUDED.last_movement_id,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

    RAISE NOTICE '補正完成 return_item=% old_lot=% new_lot=% qty=%',
      rec.return_item_id, v_old_lot_id, v_new_lot_id, rec.return_qty;
  END LOOP;
END $$;

COMMIT;


-- ========== 步驟 3：驗證（應無列；新店倉庫庫存應看得到新 Lot）==========
-- 3a. 不應再有「退回倉 ≠ Lot 倉別」的已過帳收回
SELECT count(*) AS remaining_bad_rows
FROM consignment_case_return r
JOIN consignment_case_return_item ri ON ri.return_id = r.return_id
JOIN lot l ON l.lot_id = ri.lot_id
WHERE coalesce(upper(trim(r.status)), 'POSTED') = 'POSTED'
  AND upper(trim(coalesce(l.warehouse_id, ''))) IS DISTINCT FROM upper(trim(coalesce(r.return_warehouse_id, '')));

-- 3b. 補正產生的 Lot（可查 Warehouse 倉庫庫存 → 新店）
SELECT lot_id, warehouse_id, product_id, factory_lot, qty, unit, system_remark
FROM lot
WHERE coalesce(system_remark, '') LIKE '%v4.2.2.02_寄賣改倉收回補正%'
   OR coalesce(system_remark, '') LIKE '%v4.3.02_寄賣改倉收回補正%'
ORDER BY created_at DESC;
