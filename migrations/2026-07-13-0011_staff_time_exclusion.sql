-- サロン: 同一スタッフの「確定」予約が時間帯で重ならないよう DB で排他する。
-- （同時実行の競合レース、および 開始間隔<所要 で枠が重なる設定での重複予約を根本防止）
-- 冪等。キャンセル(status<>'confirmed')は対象外なので、取消後は再予約できる。

create extension if not exists btree_gist;

alter table booking_reservations
  drop constraint if exists no_staff_time_overlap;

alter table booking_reservations
  add constraint no_staff_time_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(start_at, end_at) with &&
  )
  where (status = 'confirmed' and staff_id is not null);

notify pgrst, 'reload schema';
