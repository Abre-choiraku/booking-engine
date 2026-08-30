-- ============================================================
-- 予約の前後バッファ（準備・片付け時間）2026-08-30
-- ============================================================
-- buffer_before_min: 既存予約の「前」に確保する空き時間（分）
-- buffer_after_min:  既存予約の「後」に確保する空き時間（分）
-- 空き枠計算時、既存予約を [開始-前バッファ, 終了+後バッファ] に広げて衝突判定する。
-- null/0 = バッファなし（従来どおり）
-- ============================================================

alter table booking_links add column if not exists buffer_before_min int;
alter table booking_links add column if not exists buffer_after_min int;

notify pgrst, 'reload schema';
