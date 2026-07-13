-- 予約リマインドメール: リンクごとに「◯時間前に送る」を設定できるようにする。
-- reminder_hours = null/0 なら送らない。reminder_sent_at で二重送信を防ぐ。冪等。

alter table booking_links add column if not exists reminder_hours int;
alter table booking_reservations add column if not exists reminder_sent_at timestamptz;

notify pgrst, 'reload schema';
