-- ============================================================
-- Zoom ユーザーレベル OAuth トークン（事業者ごと連携）
-- ============================================================
-- Google カレンダー連携（google_auth_tokens）と対称。
-- user_id には owner の user.id を格納（Zoom は事業者単位で連携）。
-- access/refresh トークンは AES-256-GCM で暗号化して保存。
-- ============================================================

create table if not exists zoom_auth_tokens (
  user_id uuid primary key,
  zoom_email text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scope text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table zoom_auth_tokens disable row level security;

notify pgrst, 'reload schema';
