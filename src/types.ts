// ============================================================
// 予約エンジン 共有型定義
// ============================================================
// SHEALS ops / 単体予約アプリ / VAILS が共通で使う型。
// チャネル（web / line）に依存しない核の型だけをここに置く。
// ============================================================

// ---- 予約フォームのカスタム項目 ----
export type FieldMode = "off" | "optional" | "required";

export type CustomField = {
  id: string;
  label: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  options?: string[]; // type=select のとき
};

// ---- チャネル（Phase 3 の line モードで使用。Phase 1 は 'web' 固定）----
export type SourceChannel = "web" | "line";

// ============================================================
// 予約リンク（TimeRex 風）
// ============================================================
// 空き計算エンジンが必要とする最小フィールドを持つ行。
// 管理 UI 用の追加フィールド（default_view 等）も含む統合型。
export type BookingLink = {
  id: string;
  token: string;
  title: string;
  description: string | null;
  location: string | null;
  // SHEALS ops の案件ひも付け（任意。単体/LINE では常に null）
  project_id: string | null;
  owner_user_id: string;
  duration_min: number;
  window_days: number;
  day_start: string; // "10:00"
  day_end: string; // "18:00"
  exclude_weekends: boolean;
  // 受付する曜日（0=日〜6=土）。null/空 = exclude_weekends に従う（後方互換）
  weekdays?: number[] | null;
  // 日本の祝日を除外するか
  exclude_holidays?: boolean;
  // 受付時間帯の配列。null/空 = day_start〜day_end 単一帯（後方互換）
  time_ranges?: { start: string; end: string }[] | null;
  buffer_min: number;
  min_notice_hours: number;
  status: "active" | "paused";
  // hours=営業時間グリッド / ranges=手動範囲 / both=併用 / anytime=終日（Google空きのみ）
  slot_mode: "hours" | "ranges" | "both" | "anytime";
  deadline_at: string | null;
  meeting_type: "none" | "meet" | "zoom";
  cancel_deadline_hours: number;
  // マッチングモード（定員から導出）
  mode: "one_to_one" | "one_to_many";
  capacity_per_slot: number;
  // 2本柱化（カレンダー予約 / イベント予約）
  link_type: "calendar" | "event";
  period_start: string | null; // YYYY-MM-DD（イベント型の期間指定）
  period_end: string | null;
  sync_google_busy: boolean | null; // null = 旧挙動（1対1のみ連動）
  show_guest_names: boolean;
  // 予約フォームのカスタマイズ
  email_mode: FieldMode;
  phone_mode: FieldMode;
  custom_fields: CustomField[];
  default_view: "day" | "week" | "month";
  created_at?: string;
};

// 空き計算エンジンが受け取る形（BookingLink の必須サブセット）。
// 後方互換のため email_mode / phone_mode / custom_fields は optional。
export type BookingLinkRow = Omit<
  BookingLink,
  "email_mode" | "phone_mode" | "custom_fields" | "default_view" | "created_at" | "status"
> & {
  status: string;
  email_mode?: FieldMode;
  phone_mode?: FieldMode;
  custom_fields?: CustomField[];
};

export type BookingWindow = { start_at: string; end_at: string };

// ---- 空き枠 ----
export type Slot = {
  start_at: string;
  end_at: string;
  remaining?: number; // 定員>1 のみ: 残席数
  full?: boolean; // 満席・受付不可（show_guest_names のとき ✕ 表示用）
};
export type DaySlots = { date: string; weekday: string; slots: Slot[] };

// ---- 内部で使う busy 区間（ms）----
export type Busy = { start: number; end: number };

// ---- 手動枠ロック ----
export type SlotLock = {
  id: string;
  link_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
};

// ---- 管理用: 状態付き枠列挙 ----
export type ManagedSlot = {
  start_at: string;
  end_at: string;
  state: "free" | "booked" | "locked" | "busy";
  guests: string[]; // 予約者名（booked のとき）
  remaining?: number; // 1対多数のみ
  lock_reason?: string | null;
};
export type ManagedDay = { date: string; weekday: string; slots: ManagedSlot[] };

// ---- 予約 ----
export type BookingReservation = {
  id: string;
  link_id: string;
  start_at: string;
  end_at: string;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  guest_note: string | null;
  custom_answers: Record<string, string>;
  status: "confirmed" | "cancelled";
  meet_url: string | null;
  event_id: string | null;
  created_at: string;
  cancelled_at: string | null;
};

// ============================================================
// 日程調整（調整さん風）
// ============================================================
export type SchedulePollStatus = "open" | "confirmed" | "closed";

export type SchedulePoll = {
  id: string;
  token: string;
  title: string;
  description: string | null;
  location: string | null;
  project_id: string | null;
  created_by: string | null;
  status: SchedulePollStatus;
  confirmed_slot_id: string | null;
  created_at?: string;
  updated_at?: string;
};

export type SchedulePollSlot = {
  id: string;
  poll_id: string;
  start_at: string; // ISO
  end_at: string; // ISO
  display_order: number;
};

export type SchedulePollResponse = {
  id: string;
  poll_id: string;
  respondent_name: string;
  comment: string | null;
  answers: Record<string, "ok" | "maybe" | "ng">;
  created_at?: string;
  updated_at?: string;
};
