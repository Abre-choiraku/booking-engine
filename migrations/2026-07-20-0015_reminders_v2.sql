-- ============================================================
-- リマインドメール 複数化・時刻指定対応
-- ============================================================
-- booking_links.reminders … リマインド設定の配列（JSONB）
--   [{ "kind": "before", "hours": 24 },
--    { "kind": "at", "days_before": 1, "time": "09:00" }]
-- 旧 booking_links.reminder_hours（単発）は後方互換で残す。
--
-- booking_reminder_sends … 送信済み記録（重複送信防止・原子的 claim）
--   (reservation_id, reminder_key) を主キーにして
--   ON CONFLICT DO NOTHING で1回だけ送る。
-- ============================================================

alter table booking_links
  add column if not exists reminders jsonb not null default '[]'::jsonb;

create table if not exists booking_reminder_sends (
  reservation_id uuid not null,
  reminder_key text not null,
  sent_at timestamptz default now(),
  primary key (reservation_id, reminder_key)
);

alter table booking_reminder_sends disable row level security;

notify pgrst, 'reload schema';
