-- ============================================================
-- 曜日別・祝日別の受付時間
-- ============================================================
-- day_hours (jsonb): {
--   days: { "0": {open, ranges:[{start,end}]}, ... "6": {...} },
--   holidayMode: "closed"|"weekday"|"custom",
--   holiday: [{start,end}]
-- }
-- あれば weekdays / time_ranges / exclude_holidays より優先。
-- null = 従来ロジック（後方互換）。
-- ============================================================

alter table booking_links add column if not exists day_hours jsonb;

notify pgrst, 'reload schema';
