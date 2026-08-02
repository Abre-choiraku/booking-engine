-- イベント予約の見栄え改善（2026-08-02）: 予約ページ上部に表示するヘッダー画像
alter table booking_links add column if not exists header_image_url text;
