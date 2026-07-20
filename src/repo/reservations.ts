import { anonClient, getEngineConfig } from "../config";
import { getOwnerCalendar } from "../google/calendar";
import { deleteZoomMeetingForUser } from "../zoom";
import { notifyReservationCancelled, notifyReservationReminder } from "../notify";
import type { BookingLinkRow, ReminderConfig } from "../types";

// ============================================================
// 予約一覧・管理者キャンセル（主催者ダッシュボード用）
// ============================================================
// すべて owner_user_id でスコープ（他テナントの予約は見えない/触れない）。
// ============================================================

export type OwnerReservation = {
  id: string;
  link_id: string;
  start_at: string;
  end_at: string;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  guest_note: string | null;
  custom_answers: Record<string, string> | null;
  status: "confirmed" | "cancelled";
  staff_id: string | null;
  menu_id: string | null;
  total_price: number | null;
  meet_url: string | null;
  cancel_token: string | null;
  created_at: string;
  // 付加情報
  link_title: string;
  link_type: "calendar" | "event" | "salon";
  menu_name: string | null;
  staff_name: string | null;
};

type Row = Omit<OwnerReservation, "link_title" | "link_type" | "menu_name" | "staff_name"> & {
  google_event_id: string | null;
  zoom_meeting_id: string | null;
  link: { owner_user_id: string; title: string; link_type: OwnerReservation["link_type"] };
};

// 主催者の予約を横断取得（既定=確定のみ・start_at 昇順）
export async function listOwnerReservations(
  ownerId: string,
  opts?: { includeCancelled?: boolean; fromIso?: string; toIso?: string; limit?: number },
): Promise<OwnerReservation[]> {
  const supabase = anonClient();
  let q = supabase
    .from("booking_reservations")
    .select(
      "id, link_id, start_at, end_at, guest_name, guest_email, guest_phone, guest_note, custom_answers, status, staff_id, menu_id, total_price, meet_url, cancel_token, created_at, link:booking_links!inner(owner_user_id, title, link_type)",
    )
    .eq("link.owner_user_id", ownerId);
  if (!opts?.includeCancelled) q = q.eq("status", "confirmed");
  if (opts?.fromIso) q = q.gte("start_at", opts.fromIso);
  if (opts?.toIso) q = q.lt("start_at", opts.toIso);
  q = q.order("start_at", { ascending: true }).limit(opts?.limit ?? 500);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as (Omit<Row, "google_event_id" | "zoom_meeting_id">)[];

  // メニュー名・スタッフ名を解決（FK 埋め込みに依存しない）
  const menuIds = [...new Set(rows.map((r) => r.menu_id).filter(Boolean))] as string[];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter(Boolean))] as string[];
  const menuMap = new Map<string, string>();
  const staffMap = new Map<string, string>();
  if (menuIds.length) {
    const { data: ms } = await supabase.from("menus").select("id, name").in("id", menuIds);
    for (const m of (ms ?? []) as { id: string; name: string }[]) menuMap.set(m.id, m.name);
  }
  if (staffIds.length) {
    const { data: ss } = await supabase.from("staff").select("id, name").in("id", staffIds);
    for (const s of (ss ?? []) as { id: string; name: string }[]) staffMap.set(s.id, s.name);
  }

  return rows.map((r) => ({
    id: r.id,
    link_id: r.link_id,
    start_at: r.start_at,
    end_at: r.end_at,
    guest_name: r.guest_name,
    guest_email: r.guest_email,
    guest_phone: r.guest_phone,
    guest_note: r.guest_note,
    custom_answers: r.custom_answers,
    status: r.status,
    staff_id: r.staff_id,
    menu_id: r.menu_id,
    total_price: r.total_price,
    meet_url: r.meet_url,
    cancel_token: r.cancel_token,
    created_at: r.created_at,
    link_title: r.link?.title ?? "",
    link_type: r.link?.link_type ?? "calendar",
    menu_name: r.menu_id ? menuMap.get(r.menu_id) ?? null : null,
    staff_name: r.staff_id ? staffMap.get(r.staff_id) ?? null : null,
  }));
}

// 管理者による予約キャンセル（本人所有のみ）。枠を解放し Google/Zoom も削除、ゲストへ通知。
export async function cancelReservationByOwner(
  reservationId: string,
  ownerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_reservations")
    .select(
      "id, link_id, start_at, end_at, guest_name, guest_email, meet_url, status, staff_id, google_event_id, zoom_meeting_id, link:booking_links!inner(owner_user_id, title, location, cancel_deadline_hours)",
    )
    .eq("id", reservationId)
    .eq("link.owner_user_id", ownerId)
    .maybeSingle();
  if (!data) return { ok: false, error: "予約が見つかりません" };
  const r = data as unknown as {
    id: string;
    start_at: string;
    end_at: string;
    guest_name: string;
    guest_email: string | null;
    meet_url: string | null;
    status: string;
    staff_id: string | null;
    google_event_id: string | null;
    zoom_meeting_id: string | null;
    link: BookingLinkRow;
  };
  if (r.status !== "confirmed") {
    return { ok: false, error: "この予約はすでにキャンセル済みです" };
  }

  const { error: updErr } = await supabase
    .from("booking_reservations")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", reservationId)
    .eq("status", "confirmed");
  if (updErr) return { ok: false, error: "キャンセル処理に失敗しました" };

  // Google 予定 / Zoom を削除（サロンはスタッフの暦、それ以外は主催者の暦）
  try {
    if (r.google_event_id) {
      const calOwner = r.staff_id ?? ownerId;
      const gcal = await getOwnerCalendar(calOwner);
      if (gcal) {
        await gcal.events
          .delete({ calendarId: "primary", eventId: r.google_event_id })
          .catch(() => {});
      }
    }
    if (r.zoom_meeting_id) await deleteZoomMeetingForUser(ownerId, r.zoom_meeting_id);
  } catch (e) {
    console.error("owner cancel google/zoom failed:", (e as Error).message);
  }

  // ゲストへキャンセル通知
  try {
    await notifyReservationCancelled({
      link: r.link,
      guestName: r.guest_name,
      guestEmail: r.guest_email,
      startIso: r.start_at,
      endIso: r.end_at,
      meetUrl: r.meet_url,
      cancelUrl: null,
    });
  } catch (e) {
    console.error("owner cancel notify failed:", (e as Error).message);
  }

  return { ok: true };
}

// リマインド1件の送信時刻(UTC ms)を計算。JST基準。無効なら null。
function reminderFireTime(c: ReminderConfig, startMs: number): number | null {
  if (c.kind === "before") {
    if (!c.hours || c.hours <= 0) return null;
    return startMs - c.hours * 60 * 60 * 1000;
  }
  // kind === "at": 予約日(JST)の days_before 日前、その日の time(HH:MM, JST) に送る
  const JST = 9 * 60 * 60 * 1000;
  const jst = new Date(startMs + JST); // UTCゲッターでJSTの年月日が読める
  const y = jst.getUTCFullYear();
  const mo = jst.getUTCMonth();
  const d = jst.getUTCDate();
  const parts = (c.time || "09:00").split(":");
  let hh = parseInt(parts[0], 10);
  let mm = parseInt(parts[1], 10);
  if (!Number.isFinite(hh)) hh = 9;
  if (!Number.isFinite(mm)) mm = 0;
  const days = Number.isFinite(c.days_before) ? c.days_before : 0;
  // 予約日の 00:00 JST を UTC ms で表す（= Date.UTC(...) - 9h）
  const dayStartJstUtcMs = Date.UTC(y, mo, d, 0, 0, 0) - JST;
  return (
    dayStartJstUtcMs -
    days * 24 * 60 * 60 * 1000 +
    (hh * 60 + mm) * 60 * 1000
  );
}

// リマインド送信対象を探してメール送信する。Cron から定期実行。
// リンクの reminders（複数・「◯時間前」/「◯日前のHH:MM」）に対応。
// 旧 reminder_hours（単発）は後方互換で1件の「◯時間前」として扱う。
// 二重送信防止は booking_reminder_sends（reservation_id, reminder_key）で原子的に claim。
export async function sendDueReminders(): Promise<{ sent: number; checked: number }> {
  const supabase = anonClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // 先読み範囲は 60 日先まで（現実的な設定を十分カバー）
  const horizonIso = new Date(nowMs + 60 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("booking_reservations")
    .select(
      "id, start_at, end_at, guest_name, guest_email, meet_url, cancel_token, created_at, status, link:booking_links!inner(title, location, description, cancel_deadline_hours, owner_user_id, reminder_hours, reminders)",
    )
    .eq("status", "confirmed")
    .gt("start_at", nowIso)
    .lt("start_at", horizonIso)
    .limit(1000);
  const rows = (data ?? []) as unknown as {
    id: string;
    start_at: string;
    end_at: string;
    guest_name: string;
    guest_email: string | null;
    meet_url: string | null;
    cancel_token: string | null;
    created_at: string | null;
    link: BookingLinkRow & {
      reminder_hours: number | null;
      reminders: ReminderConfig[] | null;
    };
  }[];

  const baseUrl = getEngineConfig().publicBaseUrl ?? "";
  let sent = 0;
  let checked = 0;
  for (const r of rows) {
    // 新 reminders 優先。無ければ旧 reminder_hours を1件の「◯時間前」に変換。
    const configs: ReminderConfig[] =
      r.link?.reminders && r.link.reminders.length > 0
        ? r.link.reminders
        : r.link?.reminder_hours && r.link.reminder_hours > 0
          ? [{ kind: "before", hours: r.link.reminder_hours }]
          : [];
    if (configs.length === 0) continue;
    checked++;

    const startMs = Date.parse(r.start_at);
    const createdMs = r.created_at ? Date.parse(r.created_at) : 0;

    for (const c of configs) {
      const fireMs = reminderFireTime(c, startMs);
      if (fireMs === null) continue;
      if (nowMs < fireMs) continue; // まだ送信時刻に達していない
      if (createdMs && fireMs < createdMs) continue; // 予約時点で既に過ぎていた設定は送らない

      // 分単位のキーで原子的に claim（重複送信防止）
      const key = new Date(fireMs).toISOString().slice(0, 16);
      const { data: claimed } = await supabase
        .from("booking_reminder_sends")
        .upsert([{ reservation_id: r.id, reminder_key: key }], {
          onConflict: "reservation_id,reminder_key",
          ignoreDuplicates: true,
        })
        .select("reservation_id");
      if (!claimed || claimed.length === 0) continue; // 既に送信済み

      if (!r.guest_email) continue; // メール未登録は送れない
      try {
        await notifyReservationReminder({
          link: r.link,
          guestName: r.guest_name,
          guestEmail: r.guest_email,
          startIso: r.start_at,
          endIso: r.end_at,
          meetUrl: r.meet_url,
          cancelUrl: r.cancel_token ? `${baseUrl}/cancel/${r.cancel_token}` : null,
        });
        sent++;
      } catch (e) {
        console.error("reminder send failed:", (e as Error).message);
      }
    }
  }
  return { sent, checked };
}
