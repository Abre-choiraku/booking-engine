-- ============================================================
-- 白ラベル: 主催者（テナント）ごとのブランド設定
-- ============================================================
-- 公開ページ（予約/調整/キャンセル）とメール差出人に表示する
-- 屋号・ロゴ・テーマ色。owner_user_id ごとに1件。
-- ============================================================

create table if not exists tenant_brands (
  owner_user_id uuid primary key,
  display_name text,        -- 屋号（表示名）
  logo_url text,            -- ロゴ画像の公開URL
  accent_color text,        -- テーマ色（例 #10b981）
  updated_at timestamptz default now()
);

alter table tenant_brands disable row level security;

-- ロゴ画像の公開ストレージバケット（サーバー[service role]からアップロード、閲覧は公開）
insert into storage.buckets (id, name, public)
values ('brand-logos', 'brand-logos', true)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
