-- ============================================================
-- 予約まわりの100アカウント耐性（2026-09-02）
-- ============================================================
-- ① どのアカウントの予約ページかを「予約ページ自身」に焼き付ける
--
-- これまで VAILS は、予約通知が来たときに「その人がどのアカウントの友だちか」を
-- 探して送信元の回線（LINEアカウント）を決めていた。
-- 同じ人が2つのアカウントの友だちになった瞬間に別のお店の回線から通知が出る。
-- 100アカウント運用では必ず起きるので、予約ページを作った時点で
-- 「どのアカウントのものか」を焼き付け、通知イベントにそのまま同梱する。
--
-- null = 焼き付け前の旧データ（VAILS 側は owner_user_id で解決する）。

alter table booking_links add column if not exists partner_client_id text;

-- ② リマインド走査を「全件なめ」にしない
--
-- sendDueReminders は「これから先60日以内の確定予約」を全オーナー横断で取っている。
-- 100アカウント×各100予約＝1万件になると、start_at 順の走査に索引が要る。
-- （索引が無いと毎回テーブル全体を読むため、アカウントが増えるほど直線的に遅くなる）

create index if not exists booking_reservations_due_idx
  on booking_reservations (status, start_at)
  where status = 'confirmed';

-- ③ 二重送信の claim を1件ずつではなく「まとめて」引けるようにする
--    （まとめ upsert が効くように複合ユニークを明示。既にあれば何もしない）

create unique index if not exists booking_reminder_sends_uniq
  on booking_reminder_sends (reservation_id, reminder_key);
