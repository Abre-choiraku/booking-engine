import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BookingLinkRow, Busy } from "./types";

// ============================================================
// 予約エンジン 設定 & アダプタ（差し込み口）
// ============================================================
// エンジンの核（空き計算・排他制御・カスタム項目・DB定義）はチャネルに
// 依存しない。アプリ固有の 4 点だけをアダプタとして差し替える:
//
//   1. Supabase 接続        … env 既定（全アプリ共通）。上書き可
//   2. 認証（主催者特定）    … AuthAdapter（standalone=Supabase Auth / line=friend）
//   3. 通知                 … NotifyAdapter（standalone=メール / line=VAILSプッシュ）
//   4. アプリ内カレンダー連携 … CalendarAdapter（SHEALS=calendar_events / 単体=Google のみ）
//   +  予約フック           … ReservationHooks（ベル通知等・任意）
//
// 各アプリは起動時に一度 configureBookingEngine({...}) を呼ぶ。
// 未設定の項目は「何もしない / env 既定」で安全に動く。
// ============================================================

// ---- 認証アダプタ: 管理操作の主催者を特定 ----
export interface AuthAdapter {
  // ログイン中の主催者 user_id。取得できなければ null。
  getCurrentOwnerId(): Promise<string | null>;
}

// ---- 通知アダプタ: 予約確定 / キャンセルの通知 ----
// standalone = メール(Resend) / line = VAILS プッシュ に差し替える1点。
export interface NotifyPayload {
  link: BookingLinkRow;
  guestName: string;
  guestEmail: string | null;
  startIso: string;
  endIso: string;
  meetUrl: string | null;
  cancelUrl: string | null;
  // line モード用（Phase 3）: 予約者の LINE friend_id
  lineFriendId?: string | null;
}
export interface NotifyAdapter {
  reservationConfirmed(payload: NotifyPayload): Promise<void>;
  reservationCancelled(payload: NotifyPayload): Promise<void>;
}

// ---- カレンダーアダプタ: アプリ内カレンダーへの busy 反映・予定ミラー ----
// SHEALS ops は calendar_events テーブルを持ち、予約を自社予定に写す。
// 単体アプリ / LINE は内部カレンダーを持たない（Google 直結のみ）→ 既定は no-op。
export interface CalendarAdapter {
  // アプリ内カレンダーの busy 区間（Google とは別に塞ぐ予定）。既定 []。
  getInternalBusy(
    ownerUserId: string,
    fromIso: string,
    toIso: string,
    opts?: { excludeLinkId?: string },
  ): Promise<Busy[]>;

  // 予約確定時、アプリ内カレンダーにミラー予定を作る。作らないなら null を返す。
  // 返した event_id は booking_reservations.event_id / booking_slot_events.event_id に保存される。
  createMirrorEvent(input: {
    link: BookingLinkRow;
    title: string;
    description: string;
    startIso: string;
    endIso: string;
  }): Promise<{ id: string } | null>;

  // ミラー予定の Google イベント ID を後追いで保存（1対1の Meet 作成後など）。
  setMirrorGoogleEventId(eventId: string, googleEventId: string): Promise<void>;

  // グループ枠の参加者リスト更新（description 差し替え）。
  updateMirrorDescription(eventId: string, description: string): Promise<void>;
}

// ---- 予約フック（任意）: ベル通知など副作用の差し込み ----
export interface ReservationHooks {
  onReserved?(input: {
    link: BookingLinkRow;
    guestName: string;
    guestEmail: string | null;
    startIso: string;
    durationMin: number;
  }): Promise<void>;
  onCancelled?(input: {
    link: BookingLinkRow;
    guestName: string;
    startIso: string;
  }): Promise<void>;
}

// ---- エンジン設定全体 ----
export interface EngineConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  auth?: AuthAdapter;
  notify?: NotifyAdapter;
  calendar?: CalendarAdapter;
  hooks?: ReservationHooks;
  // 予約者向けの公開 URL のベース（キャンセルリンク生成用）。
  // 省略時は各 API が request origin から補う。
  publicBaseUrl?: string;
  // SHEALS ops のみ true。案件（projects）テーブルと project_id 連携を使う。
  // 単体アプリ / LINE では false（projects テーブルが存在しないため join しない）。
  projectsEnabled?: boolean;
}

// ---- 何もしないカレンダー（単体アプリ / LINE の既定）----
const noopCalendar: CalendarAdapter = {
  async getInternalBusy() {
    return [];
  },
  async createMirrorEvent() {
    return null;
  },
  async setMirrorGoogleEventId() {},
  async updateMirrorDescription() {},
};

let _config: EngineConfig = {};

// アプリ起動時に一度呼ぶ。複数回呼ぶとマージ上書き。
export function configureBookingEngine(config: EngineConfig): void {
  _config = { ..._config, ...config };
}

export function getEngineConfig(): EngineConfig {
  return _config;
}

// 解決済みアクセサ（未設定は安全な既定にフォールバック）
export function resolveCalendar(): CalendarAdapter {
  return _config.calendar ?? noopCalendar;
}
export function resolveHooks(): ReservationHooks {
  return _config.hooks ?? {};
}
export function resolveNotify(): NotifyAdapter | null {
  return _config.notify ?? null;
}
export function resolveAuth(): AuthAdapter | null {
  return _config.auth ?? null;
}
// 案件（projects）連携が有効か。SHEALS ops のみ true。
export function projectsEnabled(): boolean {
  return _config.projectsEnabled ?? false;
}

// ---- Supabase クライアント（env 既定・全アプリ共通）----
function url(): string {
  const v = _config.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v) throw new Error("Supabase URL が未設定です（NEXT_PUBLIC_SUPABASE_URL）");
  return v;
}
function anonKey(): string {
  const v = _config.supabaseAnonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v) throw new Error("Supabase Anon Key が未設定です（NEXT_PUBLIC_SUPABASE_ANON_KEY）");
  return v;
}

// サーバー用の匿名クライアント（RLS 無効化前提。読み書き用）。
export function anonClient(): SupabaseClient {
  return createClient(url(), anonKey());
}

// Service Role クライアント（主催者メール取得など admin 操作用。無ければ null）。
export function serviceClient(): SupabaseClient | null {
  const key = _config.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(url(), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
