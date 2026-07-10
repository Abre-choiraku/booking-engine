-- ============================================================
-- 予約の詳細スケジュール設定
-- ============================================================
-- weekdays        : 受付する曜日（0=日〜6=土）の配列。null/空 = 従来の
--                   exclude_weekends に従う（後方互換）
-- exclude_holidays: 日本の祝日を除外するか
-- time_ranges     : 受付時間帯の配列 [{start:"HH:MM", end:"HH:MM"}, ...]。
--                   null/空 = 従来の day_start〜day_end 単一帯（後方互換）
-- ============================================================

alter table booking_links add column if not exists weekdays jsonb;
alter table booking_links add column if not exists exclude_holidays boolean not null default false;
alter table booking_links add column if not exists time_ranges jsonb;

notify pgrst, 'reload schema';
