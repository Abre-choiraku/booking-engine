import { anonClient, resolveAuth, projectsEnabled } from "../config";
import type {
  BookingLink,
  BookingReservation,
  CustomField,
  FieldMode,
  ReminderConfig,
  SlotLock,
} from "../types";

// ============================================================
// 予約リンク（TimeRex 風）管理側 repo
// ============================================================
// 主催者（ログインユーザー）が予約リンクを作成・管理する。
// 主催者の特定は AuthAdapter（resolveAuth）に委譲。
// ============================================================

export type { BookingLink, CustomField, FieldMode, BookingReservation } from "../types";

export type BookingSlotLock = SlotLock;

export type BookingLinkWithCounts = BookingLink & {
  reservation_count: number;
  project_name: string | null;
};

function generateToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function currentOwnerId(): Promise<string | null> {
  const auth = resolveAuth();
  if (!auth) return null;
  try {
    return await auth.getCurrentOwnerId();
  } catch {
    return null;
  }
}

// ownerId を渡すとその主催者のリンクだけに絞る（マルチテナントのデータ分離）。
// 省略時は全件（SHEALS ops のチーム全体表示など）。
export async function listBookingLinks(
  ownerId?: string,
): Promise<BookingLinkWithCounts[]> {
  const supabase = anonClient();
  // 案件連携が有効なとき（SHEALS ops）だけ projects を join する。
  const select = projectsEnabled()
    ? "*, project:projects(name), reservations:booking_reservations(count)"
    : "*, reservations:booking_reservations(count)";
  let query = supabase.from("booking_links").select(select);
  if (ownerId) query = query.eq("owner_user_id", ownerId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  type Row = BookingLink & {
    project?: { name: string } | null;
    reservations: { count: number }[];
  };
  // select は projectsEnabled() で動的に切り替わるため型付きパーサを通せない → unknown 経由でキャスト
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    project_name: r.project?.name ?? null,
    reservation_count: r.reservations?.[0]?.count ?? 0,
  }));
}

export async function createBookingLink(input: {
  title: string;
  description?: string | null;
  location?: string | null;
  project_id?: string | null;
  duration_min: number;
  slot_interval_min?: number | null;
  window_days: number;
  day_start: string;
  day_end: string;
  exclude_weekends: boolean;
  weekdays?: number[] | null;
  exclude_holidays?: boolean;
  time_ranges?: { start: string; end: string }[] | null;
  day_hours?: import("../types").DayHours | null;
  min_notice_hours: number;
  slot_mode: "hours" | "ranges" | "both" | "anytime";
  deadline_at?: string | null;
  meeting_type: "none" | "meet" | "zoom";
  cancel_deadline_hours: number;
  capacity_per_slot: number;
  link_type: "calendar" | "event" | "salon";
  salon_menu_ids?: string[] | null;
  salon_staff_ids?: string[] | null;
  period_start?: string | null;
  period_end?: string | null;
  sync_google_busy: boolean;
  show_guest_names: boolean;
  email_mode: FieldMode;
  phone_mode: FieldMode;
  custom_fields: CustomField[];
  default_view: "day" | "week" | "month";
  reminder_hours?: number | null;
  reminders?: ReminderConfig[] | null;
  reminder_message?: string | null;
  header_image_url?: string | null;
  // slot_mode = ranges / both のときの手動日時範囲
  windows?: { start_at: string; end_at: string }[];
  // ★パートナーAPI用: セッションではなく明示的に所有者を指定して作成する（VAILS連携）
  ownerUserId?: string;
}): Promise<BookingLink> {
  const supabase = anonClient();
  const ownerId = input.ownerUserId ?? (await currentOwnerId());
  if (!ownerId) throw new Error("ログインユーザーを特定できません");

  const { data, error } = await supabase
    .from("booking_links")
    .insert({
      token: generateToken(),
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      project_id: input.project_id ?? null,
      owner_user_id: ownerId,
      duration_min: input.duration_min,
      slot_interval_min: input.slot_interval_min ?? null,
      window_days: input.window_days,
      day_start: input.day_start,
      day_end: input.day_end,
      exclude_weekends: input.exclude_weekends,
      weekdays: input.weekdays ?? null,
      exclude_holidays: input.exclude_holidays ?? false,
      time_ranges: input.time_ranges ?? null,
      day_hours: input.day_hours ?? null,
      min_notice_hours: input.min_notice_hours,
      slot_mode: input.slot_mode,
      deadline_at: input.deadline_at ?? null,
      meeting_type: input.meeting_type,
      cancel_deadline_hours: input.cancel_deadline_hours,
      // mode は定員から導出（定員>1 なら共有予定方式）
      mode: input.capacity_per_slot > 1 ? "one_to_many" : "one_to_one",
      capacity_per_slot: Math.max(1, input.capacity_per_slot),
      link_type: input.link_type,
      salon_menu_ids: input.salon_menu_ids ?? null,
      salon_staff_ids: input.salon_staff_ids ?? null,
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      sync_google_busy: input.sync_google_busy,
      show_guest_names: input.show_guest_names,
      email_mode: input.email_mode,
      phone_mode: input.phone_mode,
      custom_fields: input.custom_fields,
      default_view: input.default_view,
      reminder_hours: input.reminder_hours ?? null,
      reminders: input.reminders ?? [],
      reminder_message: input.reminder_message ?? null,
      header_image_url: input.header_image_url ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  const link = data as BookingLink;

  const windows = (input.windows ?? []).filter((w) => w.start_at && w.end_at);
  if (windows.length > 0) {
    const { error: wErr } = await supabase.from("booking_link_windows").insert(
      windows.map((w) => ({
        link_id: link.id,
        start_at: w.start_at,
        end_at: w.end_at,
      })),
    );
    if (wErr) {
      // 範囲が入らなければ本体ごと消してエラーに
      await supabase.from("booking_links").delete().eq("id", link.id);
      throw wErr;
    }
  }
  return link;
}

// 1件取得。ownerId を渡すと所有者一致のときのみ返す（他テナントは null）。
export async function getBookingLink(
  id: string,
  ownerId?: string,
): Promise<BookingLink | null> {
  const supabase = anonClient();
  let query = supabase.from("booking_links").select("*").eq("id", id);
  if (ownerId) query = query.eq("owner_user_id", ownerId);
  const { data } = await query.maybeSingle();
  return (data as BookingLink) ?? null;
}

// 予約リンクを更新（作成と同じ項目を上書き。token/owner_user_id/project_id は変更しない）。
// ownerId を渡すと所有者一致のときのみ更新（他テナントは触れない）。
export async function updateBookingLink(
  id: string,
  input: {
    title: string;
    description?: string | null;
    location?: string | null;
    duration_min: number;
    slot_interval_min?: number | null;
    window_days: number;
    day_start: string;
    day_end: string;
    exclude_weekends: boolean;
    weekdays?: number[] | null;
    exclude_holidays?: boolean;
    time_ranges?: { start: string; end: string }[] | null;
    day_hours?: import("../types").DayHours | null;
    min_notice_hours: number;
    slot_mode: "hours" | "ranges" | "both" | "anytime";
    deadline_at?: string | null;
    meeting_type: "none" | "meet" | "zoom";
    cancel_deadline_hours: number;
    capacity_per_slot: number;
    link_type: "calendar" | "event" | "salon";
    salon_menu_ids?: string[] | null;
    salon_staff_ids?: string[] | null;
    period_start?: string | null;
    period_end?: string | null;
    sync_google_busy: boolean;
    show_guest_names: boolean;
    email_mode: FieldMode;
    phone_mode: FieldMode;
    custom_fields: CustomField[];
    default_view: "day" | "week" | "month";
    reminder_hours?: number | null;
    reminders?: ReminderConfig[] | null;
    reminder_message?: string | null;
    header_image_url?: string | null;
  },
  ownerId?: string,
): Promise<BookingLink> {
  const supabase = anonClient();
  let query = supabase
    .from("booking_links")
    .update({
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      duration_min: input.duration_min,
      slot_interval_min: input.slot_interval_min ?? null,
      window_days: input.window_days,
      day_start: input.day_start,
      day_end: input.day_end,
      exclude_weekends: input.exclude_weekends,
      weekdays: input.weekdays ?? null,
      exclude_holidays: input.exclude_holidays ?? false,
      time_ranges: input.time_ranges ?? null,
      day_hours: input.day_hours ?? null,
      min_notice_hours: input.min_notice_hours,
      slot_mode: input.slot_mode,
      deadline_at: input.deadline_at ?? null,
      meeting_type: input.meeting_type,
      cancel_deadline_hours: input.cancel_deadline_hours,
      // mode は定員から導出（作成と同じ規則）
      mode: input.capacity_per_slot > 1 ? "one_to_many" : "one_to_one",
      capacity_per_slot: Math.max(1, input.capacity_per_slot),
      link_type: input.link_type,
      salon_menu_ids: input.salon_menu_ids ?? null,
      salon_staff_ids: input.salon_staff_ids ?? null,
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      sync_google_busy: input.sync_google_busy,
      show_guest_names: input.show_guest_names,
      email_mode: input.email_mode,
      phone_mode: input.phone_mode,
      custom_fields: input.custom_fields,
      default_view: input.default_view,
      reminder_hours: input.reminder_hours ?? null,
      reminders: input.reminders ?? [],
      reminder_message: input.reminder_message ?? null,
      header_image_url: input.header_image_url ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (ownerId) query = query.eq("owner_user_id", ownerId);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data as BookingLink;
}

export async function setBookingLinkStatus(
  id: string,
  status: "active" | "paused",
  ownerId?: string,
): Promise<void> {
  const supabase = anonClient();
  let query = supabase
    .from("booking_links")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (ownerId) query = query.eq("owner_user_id", ownerId);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteBookingLink(id: string, ownerId?: string): Promise<void> {
  const supabase = anonClient();
  let query = supabase.from("booking_links").delete().eq("id", id);
  if (ownerId) query = query.eq("owner_user_id", ownerId);
  const { error } = await query;
  if (error) throw error;
}

export async function listReservations(
  linkId: string,
): Promise<BookingReservation[]> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("booking_reservations")
    .select("*")
    .eq("link_id", linkId)
    .order("start_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookingReservation[];
}

// ---- 手動枠ロック（電話予約分を塞ぐ等） ----

export async function createSlotLock(input: {
  link_id: string;
  start_at: string;
  end_at: string;
  reason?: string | null;
}): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase.from("booking_slot_locks").insert({
    link_id: input.link_id,
    start_at: input.start_at,
    end_at: input.end_at,
    reason: input.reason ?? null,
  });
  if (error) throw error;
}

export async function deleteSlotLock(
  linkId: string,
  startAt: string,
): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("booking_slot_locks")
    .delete()
    .eq("link_id", linkId)
    .eq("start_at", startAt);
  if (error) throw error;
}
