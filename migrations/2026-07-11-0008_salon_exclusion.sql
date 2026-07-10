-- ============================================================
-- サロン型の排他制御: スタッフ×開始時刻で1件
-- ============================================================
-- 従来の (link_id, start_at, slot_seq) 一意制約は「スタッフなし」予約のみに限定し、
-- サロン型（staff_id あり）は (link_id, staff_id, start_at) で1件に。
-- これにより同一時刻でも別スタッフなら予約可能になる。
-- ============================================================

drop index if exists uq_booking_slot_seq;
create unique index if not exists uq_booking_slot_seq
  on booking_reservations(link_id, start_at, slot_seq)
  where status = 'confirmed' and staff_id is null;

create unique index if not exists uq_booking_salon
  on booking_reservations(link_id, staff_id, start_at)
  where status = 'confirmed' and staff_id is not null;

notify pgrst, 'reload schema';
