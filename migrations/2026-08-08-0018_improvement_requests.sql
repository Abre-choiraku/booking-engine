-- ============================================================
-- 改善要望（利用者からのフィードバック受け皿）
-- ============================================================
-- 管理画面の「改善要望を送る」から投稿される。
-- ClaudeCode が定期的に新着を仕分けして CEO に提案一覧を出すための元データ。
--
-- status: new（新着）/ triaged（仕分け済）/ planned（対応予定）
--         / done（対応済）/ rejected（見送り）
-- ============================================================

create table if not exists improvement_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid,
  submitter_email text,
  body text not null,
  page_path text,
  category text not null default 'other',
  status text not null default 'new',
  admin_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists improvement_requests_status_idx
  on improvement_requests (status, created_at desc);
create index if not exists improvement_requests_owner_idx
  on improvement_requests (owner_user_id, created_at desc);

alter table improvement_requests disable row level security;

notify pgrst, 'reload schema';
