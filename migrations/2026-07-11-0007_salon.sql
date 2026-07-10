-- ============================================================
-- サロン型予約: スタッフ / メニュー / 紐づけ
-- ============================================================
-- スタッフの Google 連携は google_auth_tokens を staff.id をキー
-- （user_id 列に staff.id を格納）で再利用する。
-- ============================================================

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,       -- サロン（テナント）
  name text not null,
  display_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_staff_owner on staff(owner_user_id);

create table if not exists menus (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  name text not null,
  duration_min int not null default 60,
  price int,                          -- 税込想定・円。null 可
  description text,
  display_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_menus_owner on menus(owner_user_id);

-- スタッフ×メニュー（対応可能）
create table if not exists staff_menus (
  staff_id uuid not null references staff(id) on delete cascade,
  menu_id uuid not null references menus(id) on delete cascade,
  primary key (staff_id, menu_id)
);
create index if not exists idx_staff_menus_menu on staff_menus(menu_id);

-- 予約にスタッフ・メニューを記録（サロン型）
alter table booking_reservations add column if not exists staff_id uuid;
alter table booking_reservations add column if not exists menu_id uuid;
create index if not exists idx_booking_reservations_staff on booking_reservations(staff_id, start_at);

alter table staff disable row level security;
alter table menus disable row level security;
alter table staff_menus disable row level security;

notify pgrst, 'reload schema';
