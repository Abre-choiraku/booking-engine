-- ============================================================
-- Zoom 連携: ミーティング ID の保持（キャンセル時に削除するため）
-- ============================================================
-- join_url は meet_url に保存（Google Meet と共用）。
-- zoom_meeting_id はキャンセル時の Zoom 側ミーティング削除に使う。
-- ============================================================

alter table booking_reservations add column if not exists zoom_meeting_id text;
alter table booking_slot_events add column if not exists zoom_meeting_id text;

notify pgrst, 'reload schema';
