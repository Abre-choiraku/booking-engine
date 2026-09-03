import { NextRequest, NextResponse } from "next/server";
import { anonClient, resolveCalendar, resolveHooks } from "../config";
import { notifyReservationCancelled } from "../notify";
import { recordNotifyFailure } from "../repo/reservations";
import { getOwnerCalendarTarget, DEFAULT_CALENDAR_ID } from "../google/calendar";
import { deleteStaffEvent } from "../google/staff-calendar";
import { deleteZoomMeetingForUser } from "../zoom";
import { slotCapacity } from "../core/availability";
import type { BookingLinkRow } from "../types";

// ============================================================
// 予約キャンセル（ログイン不要・キャンセルトークンで本人確認）
// ============================================================
// GET  : キャンセル画面表示用の予約情報
// POST : キャンセル実行
//   - 期限（cancel_deadline_hours 前まで）を検証
//   - Google 予定削除 → ミラー予定削除（アダプタ）→ 予約を cancelled に
//     （枠は自動解放: 空き枠計算は confirmed のみ busy 扱いのため）
//   - 通知（メール等）+ ベル（フック）
//
//   export const GET  = createCancelInfoHandler();
//   export const POST = createCancelHandler();
// ============================================================

type ReservationRow = {
  id: string;
  link_id: string;
  start_at: string;
  end_at: string;
  guest_name: string;
  guest_email: string | null;
  line_user_id?: string | null;
  status: string;
  event_id: string | null;
  google_event_id: string | null;
  zoom_meeting_id: string | null;
  meet_url: string | null;
  staff_id: string | null;
  link: BookingLinkRow;
};

async function loadByToken(ctoken: string): Promise<ReservationRow | null> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_reservations")
    .select(
      "id, link_id, start_at, end_at, guest_name, guest_email, line_user_id, status, event_id, google_event_id, zoom_meeting_id, meet_url, staff_id, link:booking_links(*)",
    )
    .eq("cancel_token", ctoken)
    .maybeSingle();
  if (!data) return null;
  return data as unknown as ReservationRow;
}

function cancellableCheck(r: ReservationRow): { ok: boolean; reason?: string } {
  if (r.status !== "confirmed") {
    return { ok: false, reason: "この予約はすでにキャンセル済みです" };
  }
  const deadlineMs =
    Date.parse(r.start_at) - r.link.cancel_deadline_hours * 60 * 60 * 1000;
  if (Date.now() > deadlineMs) {
    return {
      ok: false,
      reason: `キャンセル期限（${r.link.cancel_deadline_hours}時間前）を過ぎています。お手数ですが主催者まで直接ご連絡ください`,
    };
  }
  return { ok: true };
}

export function createCancelInfoHandler() {
  return async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ ctoken: string }> },
  ) {
    const { ctoken } = await params;
    const r = await loadByToken(ctoken);
    if (!r) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const check = cancellableCheck(r);
    return NextResponse.json({
      title: r.link.title,
      location: r.link.location,
      guest_name: r.guest_name,
      start_at: r.start_at,
      end_at: r.end_at,
      status: r.status,
      cancellable: check.ok,
      reason: check.reason ?? null,
    });
  };
}

export function createCancelHandler() {
  return async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ ctoken: string }> },
  ) {
    const { ctoken } = await params;
    const supabase = anonClient();
    const calendar = resolveCalendar();
    const r = await loadByToken(ctoken);
    if (!r) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const check = cancellableCheck(r);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 409 });
    }

    // 予約を cancelled に（枠が解放される）
    const { error: updErr } = await supabase
      .from("booking_reservations")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("status", "confirmed");
    if (updErr) {
      return NextResponse.json({ error: "キャンセル処理に失敗しました" }, { status: 500 });
    }

    if (slotCapacity(r.link) > 1) {
      // ==== グループ: 残り参加者を見て共有予定を更新 or 削除 ====
      try {
        const { data: members } = await supabase
          .from("booking_reservations")
          .select("guest_name, guest_email")
          .eq("link_id", r.link_id)
          .eq("start_at", r.start_at)
          .eq("status", "confirmed")
          .order("slot_seq", { ascending: true });
        const { data: se } = await supabase
          .from("booking_slot_events")
          .select("*")
          .eq("link_id", r.link_id)
          .eq("start_at", r.start_at)
          .maybeSingle();

        if ((members ?? []).length === 0) {
          // 最後の1人 → 共有予定ごと削除
          if (se?.google_event_id) {
            const gtarget = await getOwnerCalendarTarget(r.link.owner_user_id);
            const gcal = gtarget?.gcal ?? null;
            const calId = gtarget?.calendarId ?? DEFAULT_CALENDAR_ID;
            if (gcal) {
              await gcal.events
                .delete({ calendarId: calId, eventId: se.google_event_id })
                .catch(() => {});
            }
          }
          if (se?.zoom_meeting_id) {
            await deleteZoomMeetingForUser(r.link.owner_user_id, se.zoom_meeting_id);
          }
          if (se?.event_id) {
            await calendar.deleteMirrorEvent(se.event_id);
          }
          if (se) {
            await supabase.from("booking_slot_events").delete().eq("id", se.id);
          }
        } else {
          // 参加者リストを再構築して反映
          const list = (members ?? []).map((m) => `・${m.guest_name}`).join("\n");
          if (se?.event_id) {
            await calendar.updateMirrorDescription(
              se.event_id,
              `予約リンク（グループ）\n参加者:\n${list}`,
            );
          }
          if (se?.google_event_id) {
            const gtarget = await getOwnerCalendarTarget(r.link.owner_user_id);
            const gcal = gtarget?.gcal ?? null;
            const calId = gtarget?.calendarId ?? DEFAULT_CALENDAR_ID;
            if (gcal) {
              const attendees = (members ?? [])
                .filter((m) => m.guest_email)
                .map((m) => ({ email: m.guest_email as string, displayName: m.guest_name }));
              await gcal.events
                .patch({
                  calendarId: calId,
                  eventId: se.google_event_id,
                  requestBody: {
                    description: `参加者:\n${list}`,
                    ...(attendees.length > 0 ? { attendees } : {}),
                  },
                })
                .catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error("group cancel sync failed:", (e as Error).message);
      }
    } else {
      // ==== 1対1: Google 予定 + Zoom + ミラー予定を削除 ====
      try {
        if (r.google_event_id) {
          // サロン型は担当スタッフのカレンダーに入っている（未連携ならオーナー）。
          // 消す先を間違えると予定が残り、その枠が永久に埋まったままになる。
          await deleteStaffEvent(r.staff_id, r.link.owner_user_id, r.google_event_id);
        }
        if (r.zoom_meeting_id) {
          await deleteZoomMeetingForUser(r.link.owner_user_id, r.zoom_meeting_id);
        }
        if (r.event_id) {
          await calendar.deleteMirrorEvent(r.event_id);
        }
      } catch (e) {
        console.error("cancel google/app event delete failed:", (e as Error).message);
      }
    }

    // ベル通知（フック）
    try {
      await resolveHooks().onCancelled?.({
        link: r.link,
        guestName: r.guest_name,
        startIso: r.start_at,
      });
    } catch (e) {
      console.error("cancel hook failed:", (e as Error).message);
    }

    // メール通知（Vercel は応答後の処理を打ち切るため await 必須）
    // ★届かなかったら予約に理由を残す（2026-09-04）。キャンセルは成立させたまま。
    const notify = await notifyReservationCancelled({
      link: r.link,
      guestName: r.guest_name,
      guestEmail: r.guest_email,
      startIso: r.start_at,
      endIso: r.end_at,
      meetUrl: r.meet_url,
      cancelUrl: null,
      lineFriendId: r.line_user_id ?? null,
    });
    if (!notify.ok) {
      await recordNotifyFailure(r.id, "キャンセル", notify.error ?? "理由不明");
    }

    return NextResponse.json({ ok: true, notified: notify.ok });
  };
}
