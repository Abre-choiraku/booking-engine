-- メニューオプションに「既存メニューへの参照」を持たせる。
-- linked_menu_id が入っているオプションは、名前・料金・所要をその参照先メニューから
-- 読み取り時に解決する（＝一元管理。参照先を変えるとオプションも連動）。
-- null なら従来どおりの手入力オプション。冪等。

alter table menu_options add column if not exists linked_menu_id uuid;

notify pgrst, 'reload schema';
