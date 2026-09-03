-- ============================================================
-- スタッフごとの Google カレンダー連携
-- ============================================================
-- これまで: google_auth_tokens は user_id 1件＝主催者（オーナー）のみ想定。
--           スタッフは「staff.id を user_id にしてトークンを保存する」暗黙ルールだった。
-- これから: staff.google_auth_user_id で「どのGoogle連携を使うか」を明示的に持つ。
--           未連携のスタッフはオーナーのカレンダーにフォールバックする。
-- あわせて、連携が切れた（トークン失効・アクセス取り消し）ことを
-- 管理画面で表示できるよう、google_auth_tokens に状態列を足す。
-- ============================================================

alter table staff
  add column if not exists google_auth_user_id uuid;

create index if not exists idx_staff_google_auth_user
  on staff(google_auth_user_id);

alter table google_auth_tokens
  add column if not exists last_error text;
alter table google_auth_tokens
  add column if not exists last_error_at timestamptz;
alter table google_auth_tokens
  add column if not exists last_success_at timestamptz;

-- 既に staff.id をキーにトークンを保存済みのスタッフを、新しい列へ写す（移行）
update staff s
   set google_auth_user_id = s.id
 where s.google_auth_user_id is null
   and exists (select 1 from google_auth_tokens t where t.user_id = s.id);

notify pgrst, 'reload schema';
