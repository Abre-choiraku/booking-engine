# @sheals/booking-engine

予約・日程調整の**共有エンジン**。3つのアプリが共通で読み込む「核」。

- **SHEALS ops**（自社の統合業務管理）
- **単体予約アプリ**（SoeluMarketing 等・販売用）
- **VAILS / LINE システム**

> エンジンを1箇所直して push → 各アプリが取り込み直して再デプロイ → 3つ全部に反映。
> DB は各アプリの Supabase に `migrations/` を流す。

---

## 設計方針: チャネル非依存の核 + アダプタ

予約エンジンは**1つ**。アプリ固有の差分だけを「差し込み口（アダプタ）」で切り替える。

| 差し込み口 | standalone（メール） | line（VAILS 連携・Phase 3） | SHEALS ops |
|:--|:--|:--|:--|
| 認証（主催者特定） | Supabase Auth | LINE friend_id | 既存の app-users |
| 通知 | メール（Resend） | LINE プッシュ | メール |
| アプリ内カレンダー | なし（Google 直結のみ） | なし | calendar_events |
| 案件連携（project_id） | 使わない | 使わない | 使う |

**共有される核（書き換え不要）**: 空き計算（Google FreeBusy）/ 枠生成 / 予約の排他制御 / 定員（1対多）/ 手動枠ロック / カスタム入力項目 / 当日・週間・月間・調整さん風の表示 / キャンセル。

---

## 使い方（各アプリ側）

### 1. 依存に追加（git パッケージ方式）

```jsonc
// 各アプリの package.json
"dependencies": {
  "@sheals/booking-engine": "github:<owner>/booking-engine#main"
}
```

TypeScript ソースをそのまま配布するので、Next.js 側で transpile する:

```js
// next.config.js / next.config.ts
const nextConfig = {
  transpilePackages: ["@sheals/booking-engine"],
};
```

### 2. 起動時にアダプタを差し込む

アプリのサーバー初期化（各 route から import される共有モジュール）で一度だけ:

```ts
import { configureBookingEngine, createEmailNotifyAdapter } from "@sheals/booking-engine";

configureBookingEngine({
  // Supabase は未指定なら NEXT_PUBLIC_SUPABASE_URL / ANON_KEY を使う
  projectsEnabled: false,                 // 単体/LINE は false、SHEALS ops は true
  notify: createEmailNotifyAdapter({      // standalone = メール
    ownerDashboardUrl: "https://<app>/manage",
  }),
  // auth / calendar は必要に応じて差し込む（未設定なら安全に no-op）
});
```

### 3. エンジンを呼ぶ

```ts
import { computeAvailability, isSlotAvailable, bookingLinks } from "@sheals/booking-engine";
```

### 4. DB を用意

各アプリの Supabase に `migrations/*.sql` を流す（`migrate-all` 対象に含める）。

---

## 必要な環境変数

| 変数 | 用途 | 必須 |
|:--|:--|:--|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | DB 接続 | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | 主催者メール取得（メール通知） | 任意 |
| `RESEND_API_KEY` / `MAIL_FROM` | メール通知 | 任意（未設定ならログのみ） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google カレンダー連携 | 任意 |
| `TOOL_CREDENTIALS_KEY` | Google トークン暗号化（32バイト base64） | Google 連携時 |

---

## 構成

```
src/
  index.ts                公開エクスポート
  types.ts                共有型（チャネル非依存）
  config.ts               EngineConfig + アダプタ定義 + env 既定
  core/availability.ts    空き計算・排他制御（核）
  google/oauth.ts         Google OAuth / Calendar
  google/crypto.ts        トークン暗号化（AES-256-GCM）
  notify/index.ts         通知ディスパッチャ（差し込み口）
  notify/email.ts         メール通知アダプタ（Resend）
  repo/booking-links.ts   予約リンク管理
  repo/schedule-polls.ts  日程調整管理
migrations/               配布用 DB マイグレーション（冪等）
```

## フェーズ

- **Phase 1（現在）**: エンジンの核を切り出し（このリポジトリ）
- **Phase 2**: standalone 単体アプリを立ち上げ（API route / 公開ページ / 管理画面 / 複製配布）
- **Phase 3**: line モード（VAILS 連携）をアダプタで追加
- **Phase 4**: SHEALS ops 本体をこのエンジン利用に差し替え
