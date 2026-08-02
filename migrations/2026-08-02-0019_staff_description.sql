-- 担当者（スタッフ）の紹介文（2026-08-02）。サロン予約ページに表示
alter table staff add column if not exists description text;
