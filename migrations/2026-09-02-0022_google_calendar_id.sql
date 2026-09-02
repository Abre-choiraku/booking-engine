-- Google 連携先カレンダーの指定（カレンダーIDで紐づけ）
-- 既定は 'primary'（連携した Google アカウントのメインカレンダー）。
-- 仕事用の別カレンダーを使う場合は、そのカレンダーID
-- （例: xxxxxxxx@group.calendar.google.com）を保存する。
-- ※ 初期マイグレーション 0001 で作成済みの環境も想定し、存在しない場合のみ追加する。

alter table google_auth_tokens
  add column if not exists calendar_id text default 'primary';

update google_auth_tokens
  set calendar_id = 'primary'
  where calendar_id is null or btrim(calendar_id) = '';

notify pgrst, 'reload schema';
