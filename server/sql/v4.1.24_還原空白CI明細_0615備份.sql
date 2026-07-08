-- =============================================================================
-- 檔名：v4.1.24_還原空白CI明細_0615備份.sql
-- 來源：erp_supabase_20260615-0843.dump（DEV 備份）
-- 用途：還原 CI-20260609-201～207 共 15 筆明細至 commercial_invoice_blank_line
-- 用法：Supabase SQL Editor → ERP_DB_DEV → Run
-- =============================================================================

insert into commercial_invoice_blank_line (
  ci_line_id, ci_id, line_no, product_id, description_en, hs_code,
  qty, unit, unit_price, amount, remark, created_by, created_at, updated_by, updated_at
) values
  ('CIL-1780933445095-0NLEY7', 'CI-1780933445094-MGD0YF', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:19:39+00', 'admin', '2026-06-09 10:19:39+00'),
  ('CIL-1780933445095-71NYBL', 'CI-1780933445094-MGD0YF', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:19:39+00', 'admin', '2026-06-09 10:19:39+00'),
  ('CIL-1780933464544-AIW5HK', 'CI-1780933464544-JQVWN7', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:20:03+00', 'admin', '2026-06-09 10:20:03+00'),
  ('CIL-1780933464545-5RNDPP', 'CI-1780933464544-JQVWN7', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:20:03+00', 'admin', '2026-06-09 10:20:03+00'),
  ('CIL-1780933856351-CG6PYO', 'CI-1780933856351-EHDXDC', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:20:19+00', 'admin', '2026-06-09 10:20:19+00'),
  ('CIL-1780933856351-IKQFGB', 'CI-1780933856351-EHDXDC', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:20:19+00', 'admin', '2026-06-09 10:20:19+00'),
  ('CIL-1780933856351-YX6DHA', 'CI-1780933856351-EHDXDC', 3, '', 'DINGLI SLIMCORE 66(鼎立纖活66)', '', 6, 'Box', 80, 480, '', 'admin', '2026-06-09 10:20:19+00', 'admin', '2026-06-09 10:20:19+00'),
  ('CIL-1780934097034-7YMN89', 'CI-1780934097034-P7QOKW', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:21:46+00', 'admin', '2026-06-09 10:21:46+00'),
  ('CIL-1780934097034-HF2CSB', 'CI-1780934097034-P7QOKW', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:21:46+00', 'admin', '2026-06-09 10:21:46+00'),
  ('CIL-1780934099970-HLQZYI', 'CI-1780934099970-CWZ7OS', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:22:01+00', 'admin', '2026-06-09 10:22:01+00'),
  ('CIL-1780934099970-3E9SS0', 'CI-1780934099970-CWZ7OS', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:22:01+00', 'admin', '2026-06-09 10:22:01+00'),
  ('CIL-1780934118803-JB94U5', 'CI-1780934118803-UOB1P2', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:22:14+00', 'admin', '2026-06-09 10:22:14+00'),
  ('CIL-1780934118803-3VONMZ', 'CI-1780934118803-UOB1P2', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:22:14+00', 'admin', '2026-06-09 10:22:14+00'),
  ('CIL-1780934122197-B1SD4U', 'CI-1780934122197-SA8GL9', 1, '', 'DINGLI FLEXUP(鼎立關固)', '', 10, 'Box', 50, 500, '', 'admin', '2026-06-09 10:22:32+00', 'admin', '2026-06-09 10:22:32+00'),
  ('CIL-1780934122197-M361JG', 'CI-1780934122197-SA8GL9', 2, '', 'DINGLI CHROMIUM BALANCE(鼎立醣鉻穩)', '', 10, 'Box', 65, 650, '', 'admin', '2026-06-09 10:22:32+00', 'admin', '2026-06-09 10:22:32+00')
on conflict (ci_line_id) do nothing;

-- 驗證（應為 15）
select count(*) as blank_line_count from commercial_invoice_blank_line;
