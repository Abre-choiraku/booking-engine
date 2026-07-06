-- ============================================================
-- 予約エンジン 統合ベースライン（配布用・冪等）
-- ============================================================
-- SHEALS ops の 0002〜0010 を最終形に統合したもの。
-- 新規テナント（単体予約アプリ / VAILS）にこれ1本で全テーブルが揃う。
-- 既存の SHEALS ops に流しても `if not exists` / `add column if not exists`
-- により安全（冪等）。
--
-- 移植元との差分:
--   * project_id は「外部キーなしの uuid（任意）」にして可搬化
--     （projects テーブルを持たない単体/LINE でも動く。KICKOFF §4・§8-2 で
--      「任意項目として残す」と確定）
--   * booking_reservations.google_event_id を新設
--     （1対1予約の Google イベント ID をエンジン側で保持。SHEALS では
--      calendar_events 側に持っていたが、内部カレンダーを持たない単体/LINE
--      でも自リンク由来の Google 予定を busy 計算から除外できるようにする）
--   * SHEALS 固有テーブル（calendar_events / notifications）は含めない
--     （アダプタ経由。エンジンには不要）
-- ============================================================

-- ---------- 予約リンク（TimeRex 風） ----------
create table if not exists booking_links (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  title text not null,
  description text,
  location text,
  project_id uuid,               -- 任意（SHEALS の案件ひも付け。単体/LINE では null）
  owner_user_id uuid not null,
  duration_min int not null default 60,
  window_days int not null default 14,
  day_start text not null default '10:00',
  day_end text not null default '18:00',
  exclude_weekends boolean not null default true,
  buffer_min int not null default 0,
  min_notice_hours int not null default 24,
  status text not null default 'active',       -- active | paused
  slot_mode text not null default 'hours',     -- hours | ranges | both | anytime
  deadline_at timestamptz,
  meeting_type text not null default 'none',   -- none | meet
  cancel_deadline_hours int not null default 24,
  mode text not null default 'one_to_one',     -- one_to_one | one_to_many
  capacity_per_slot int not null default 1,
  link_type text not null default 'calendar',  -- calendar | event
  period_start date,
  period_end date,
  sync_google_busy boolean,                    -- null=旧挙動（1対1のみ連動）
  show_guest_names boolean not null default false,
  email_mode text not null default 'optional', -- off | optional | required
  phone_mode text not null default 'optional',
  custom_fields jsonb not null default '[]'::jsonb,
  default_view text not null default 'week',   -- day | week | month
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 手動指定の候補日時範囲（slot_mode = ranges / both で使用）
create table if not exists booking_link_windows (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references booking_links(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null
);
create index if not exists idx_booking_link_windows_link on booking_link_windows(link_id);

-- 予約
create table if not exists booking_reservations (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references booking_links(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  guest_name text not null,
  guest_email text,
  guest_phone text,
  guest_note text,
  custom_answers jsonb not null default '{}'::jsonb,
  status text not null default 'confirmed',   -- confirmed | cancelled
  slot_seq int not null default 0,
  cancel_token text,
  event_id uuid,                              -- アプリ内カレンダーのミラー予定 ID（任意）
  google_event_id text,                       -- 1対1予約の Google イベント ID
  meet_url text,
  created_at timestamptz default now(),
  cancelled_at timestamptz
);
-- 既存テーブルに後付けする列（SHEALS ops など既に booking_reservations がある DB 用）。
-- create table if not exists は既存テーブルに列を足さないため、明示的に補う。
alter table booking_reservations add column if not exists google_event_id text;
alter table booking_reservations add column if not exists custom_answers jsonb not null default '{}'::jsonb;

create index if not exists idx_booking_reservations_link on booking_reservations(link_id);
create index if not exists idx_booking_reservations_cancel_token on booking_reservations(cancel_token);
-- ★二重予約の構造的排除: 同一リンク×同一開始時刻×seq の confirmed は1件のみ
create unique index if not exists uq_booking_slot_seq
  on booking_reservations(link_id, start_at, slot_seq) where status = 'confirmed';

-- グループ枠の共有予定（1対多数: 枠につき1つの予定/Google イベント/Meet を共有）
create table if not exists booking_slot_events (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references booking_links(id) on delete cascade,
  start_at timestamptz not null,
  event_id uuid,
  google_event_id text,
  meet_url text,
  created_at timestamptz default now(),
  unique (link_id, start_at)
);

-- 手動の枠ロック（電話予約分を手で塞ぐ等。両モード共通）
create table if not exists booking_slot_locks (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references booking_links(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_at timestamptz default now(),
  unique (link_id, start_at)
);

-- ---------- 日程調整（調整さん風） ----------
create table if not exists schedule_polls (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  title text not null,
  description text,
  location text,
  project_id uuid,               -- 任意
  created_by uuid,
  status text not null default 'open', -- open | confirmed | closed
  confirmed_slot_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists schedule_poll_slots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references schedule_polls(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  display_order int default 0
);
create index if not exists idx_schedule_poll_slots_poll on schedule_poll_slots(poll_id);

create table if not exists schedule_poll_responses (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references schedule_polls(id) on delete cascade,
  respondent_name text not null,
  comment text,
  answers jsonb not null default '{}'::jsonb, -- { "<slot_id>": "ok" | "maybe" | "ng" }
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (poll_id, respondent_name)
);
create index if not exists idx_schedule_poll_responses_poll on schedule_poll_responses(poll_id);

-- ---------- Google OAuth トークン ----------
create table if not exists google_auth_tokens (
  user_id uuid primary key,
  google_email text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  calendar_id text default 'primary',
  scope text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- RLS 無効化（RLS 無効運用。Anon Key で読み書き） ----------
alter table booking_links disable row level security;
alter table booking_link_windows disable row level security;
alter table booking_reservations disable row level security;
alter table booking_slot_events disable row level security;
alter table booking_slot_locks disable row level security;
alter table schedule_polls disable row level security;
alter table schedule_poll_slots disable row level security;
alter table schedule_poll_responses disable row level security;
alter table google_auth_tokens disable row level security;

notify pgrst, 'reload schema';
