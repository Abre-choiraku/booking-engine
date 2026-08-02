-- スタッフのシフトブロック（2026-08-03）
-- 日付単位の休み・時間帯ブロックを直接登録する（Googleカレンダー無しでもシフト管理できるように）。
-- 空き枠計算（collectBusy の staff 分岐）で busy として扱われる。
create table if not exists staff_time_blocks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  staff_id uuid not null references staff(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_time_blocks_staff on staff_time_blocks(staff_id, start_at);
