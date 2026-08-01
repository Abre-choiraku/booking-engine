-- LINE連携（VAILS）: 予約者の LINE userId を保持する
-- 予約リンクを LINE 配信から ?lu={userId} 付きで開いた場合に保存され、
-- 予約確定/キャンセル/リマインドを VAILS 経由の LINE プッシュに切り替える判定に使う
alter table booking_reservations add column if not exists line_user_id text;
create index if not exists idx_booking_reservations_line_user on booking_reservations (line_user_id) where line_user_id is not null;
