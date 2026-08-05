-- ============================================================
-- イベント型予約リンクの追加項目
-- ============================================================
-- image_url … イベントを象徴する画像（公開予約ページに表示）
-- map_url   … 開催場所の Google マップ リンク（未設定なら location 文字列から自動検索）
-- どちらも全リンク種別で使えるが、主にイベント型で利用する。
-- ============================================================

alter table booking_links
  add column if not exists image_url text,
  add column if not exists map_url text;

notify pgrst, 'reload schema';
