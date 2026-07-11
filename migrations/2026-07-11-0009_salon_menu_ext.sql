-- ============================================================
-- サロン拡張: メニュー階層 / 画像 / オプション
-- ============================================================
-- menus.parent_id: 親カテゴリ（null=トップ）。子を持つメニュー=カテゴリ、
--   子を持たない末端=予約可能メニュー（duration/price あり）。
-- image_url: メニュー/スタッフの画像（salon-images バケット）。
-- menu_options: メニューごとの追加オプション（料金・追加時間）。
-- 予約に選択オプションと合計料金を記録。
-- ============================================================

alter table menus add column if not exists parent_id uuid;
alter table menus add column if not exists image_url text;
create index if not exists idx_menus_parent on menus(parent_id);

alter table staff add column if not exists image_url text;

create table if not exists menu_options (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  menu_id uuid not null references menus(id) on delete cascade,
  name text not null,
  price int,
  duration_min int not null default 0,
  display_order int not null default 0,
  created_at timestamptz default now()
);
create index if not exists idx_menu_options_menu on menu_options(menu_id);

alter table booking_reservations add column if not exists option_ids jsonb;
alter table booking_reservations add column if not exists total_price int;

alter table menu_options disable row level security;

-- 画像用の公開ストレージ
insert into storage.buckets (id, name, public)
values ('salon-images', 'salon-images', true)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
