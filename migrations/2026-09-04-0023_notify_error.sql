-- ============================================================
-- 通知（LINE / メール）が届かなかった理由を予約に残す（2026-09-04）
-- ============================================================
-- これまで通知の失敗は console.error に出るだけで、予約システム側には
-- 何も残らなかった。VAILS が「送信元アカウントが決まらないので送りません
-- でした」と 502 を返しても、主催者の画面は完全な成功に見えていた。
--
-- 新しい台帳は作らず、既に全画面が読んでいる booking_reservations に
-- nullable の列を1つだけ足す（null = 問題なし）。
-- 既存行は触らない（既存の予約はすべて null のまま＝これまでどおり）。

alter table booking_reservations add column if not exists notify_error text;

comment on column booking_reservations.notify_error is
  '通知が届かなかったときの理由（null=問題なし）。予約一覧に「お知らせが届いていません」と出すためのもの';
