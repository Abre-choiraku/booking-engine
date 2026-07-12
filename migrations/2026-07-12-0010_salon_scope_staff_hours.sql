-- サロン拡張: リンクごとの対象メニュー/スタッフ絞り込み + スタッフ別営業時間
-- 冪等（if not exists）。既存行は null = 従来どおり（全メニュー/全スタッフ・店共通営業時間）。

-- 予約リンクごとに「このリンクで見せるメニュー/スタッフ」を限定する。
-- null または空配列 = 制限なし（全アクティブを表示）。
alter table booking_links add column if not exists salon_menu_ids uuid[];
alter table booking_links add column if not exists salon_staff_ids uuid[];

-- スタッフ別の営業時間（day_hours 形式）。null = 店共通（リンクの day_hours）を使用。
alter table staff add column if not exists day_hours jsonb;

notify pgrst, 'reload schema';
