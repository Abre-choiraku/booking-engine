import { NextRequest, NextResponse } from "next/server";
import { anonClient, resolveHooks } from "../config";
import { getBrand } from "../repo/brands";
import * as salon from "../repo/salon";
import {
  computeSalonAvailability,
  isSalonSlotAvailable,
} from "../core/availability";
import { getOwnerCalendar } from "../google/calendar";
import { createZoomMeeting } from "../zoom";
import { notifyReservationConfirmed } from "../notify";
import { getEngineConfig } from "../config";
import type { BookingLinkRow } from "../types";

// ============================================================
// サロン型 公開 API（メニュー→スタッフ→時間→確定）
// ============================================================

async function loadSalonLink(token: string): Promise<BookingLinkRow | null> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  return data as BookingLinkRow;
}

// ---- 情報取得: メニュー・スタッフ一覧 ----
export function createSalonInfoHandler() {
  return async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const link = await loadSalonLink(token);
    if (!link || link.link_type !== "salon") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const [menus, staffWithMenus, brand] = await Promise.all([
      salon.listMenus(link.owner_user_id),
      salon.listStaffWithMenus(link.owner_user_id),
      getBrand(link.owner_user_id),
    ]);
    return NextResponse.json({
      title: link.title,
      description: link.description,
      location: link.location,
      meeting_type: link.meeting_type,
      status: link.status,
      email_mode: link.email_mode ?? "optional",
      phone_mode: link.phone_mode ?? "optional",
      brand,
      menus: menus.filter((m) => m.active),
      staff: staffWithMenus
        .filter((s) => s.active)
        .map((s) => ({ id: s.id, name: s.name, menu_ids: s.menu_ids })),
    });
  };
}

// ---- 空き枠: ?menuId=&staffId=（staffId 省略=おまかせ）----
export function createSalonSlotsHandler() {
  return async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const menuId = req.nextUrl.searchParams.get("menuId") ?? "";
    const staffId = req.nextUrl.searchParams.get("staffId") ?? "";
    const link = await loadSalonLink(token);
    if (!link || link.link_type !== "salon" || link.status !== "active") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const menu = await salon.getMenu(menuId, link.owner_user_id);
    if (!menu) return NextResponse.json({ error: "メニューが不正です" }, { status: 400 });

    if (staffId) {
      const days = await computeSalonAvailability(link, {
        staffId,
        durationMin: menu.duration_min,
      });
      return NextResponse.json({ duration_min: menu.duration_min, days });
    }

    // おまかせ: 対応スタッフの空きを合算（どれか空いていれば予約可）
    const staffList = await salon.listStaffForMenu(link.owner_user_id, menuId);
    const perStaff = await Promise.all(
      staffList.map((s) =>
        computeSalonAvailability(link, { staffId: s.id, durationMin: menu.duration_min }),
      ),
    );
    const union = new Map<string, { date: string; weekday: string; slots: Set<string> }>();
    perStaff.forEach((days) => {
      for (const d of days) {
        if (!union.has(d.date)) union.set(d.date, { date: d.date, weekday: d.weekday, slots: new Set() });
        for (const s of d.slots) union.get(d.date)!.slots.add(s.start_at);
      }
    });
    const durMs = menu.duration_min * 60 * 1000;
    const days = [...union.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        weekday: d.weekday,
        slots: [...d.slots]
          .sort()
          .map((iso) => ({
            start_at: iso,
            end_at: new Date(Date.parse(iso) + durMs).toISOString(),
          })),
      }));
    return NextResponse.json({ duration_min: menu.duration_min, days });
  };
}

function generateCancelToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- 予約確定 ----
export function createSalonReserveHandler() {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const supabase = anonClient();
    let body: {
      menuId?: string;
      staffId?: string;
      start_at?: string;
      name?: string;
      email?: string;
      phone?: string;
      note?: string;
      custom_answers?: Record<string, string>;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
    }

    const link = await loadSalonLink(token);
    if (!link || link.link_type !== "salon") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (link.status !== "active") {
      return NextResponse.json({ error: "現在受付を停止しています" }, { status: 409 });
    }

    const guest = {
      name: (body.name ?? "").trim(),
      email: (body.email ?? "").trim(),
      phone: (body.phone ?? "").trim(),
      note: (body.note ?? "").trim(),
    };
    if (!guest.name) {
      return NextResponse.json({ error: "お名前を入力してください" }, { status: 400 });
    }
    const emailMode = link.email_mode ?? "optional";
    const phoneMode = link.phone_mode ?? "optional";
    if (emailMode === "off") guest.email = "";
    if (phoneMode === "off") guest.phone = "";
    if (emailMode === "required" && !guest.email) {
      return NextResponse.json({ error: "メールアドレスは必須です" }, { status: 400 });
    }
    if (guest.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) {
      return NextResponse.json({ error: "メールアドレスの形式が不正です" }, { status: 400 });
    }
    if (phoneMode === "required" && !guest.phone) {
      return NextResponse.json({ error: "電話番号は必須です" }, { status: 400 });
    }

    const menu = await salon.getMenu(body.menuId ?? "", link.owner_user_id);
    if (!menu) return NextResponse.json({ error: "メニューが不正です" }, { status: 400 });
    const startAt = body.start_at ?? "";
    const startMs = Date.parse(startAt);
    if (Number.isNaN(startMs)) {
      return NextResponse.json({ error: "日時が不正です" }, { status: 400 });
    }
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(startMs + menu.duration_min * 60 * 1000).toISOString();

    // 担当スタッフの決定（指定 or おまかせ）
    let staffId = (body.staffId ?? "").trim();
    if (staffId) {
      if (!(await salon.staffHandlesMenu(staffId, menu.id))) {
        return NextResponse.json({ error: "このスタッフはそのメニューに対応していません" }, { status: 400 });
      }
      const check = await isSalonSlotAvailable(link, staffId, startAt, menu.duration_min);
      if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 409 });
    } else {
      // おまかせ: 対応スタッフから空いている人を選ぶ
      const staffList = await salon.listStaffForMenu(link.owner_user_id, menu.id);
      let picked = "";
      for (const s of staffList) {
        const check = await isSalonSlotAvailable(link, s.id, startAt, menu.duration_min);
        if (check.ok) {
          picked = s.id;
          break;
        }
      }
      if (!picked) {
        return NextResponse.json(
          { error: "その時間に対応できるスタッフがいません。別の枠をお選びください" },
          { status: 409 },
        );
      }
      staffId = picked;
    }

    const cancelToken = generateCancelToken();
    // 予約を INSERT（uq_booking_salon: link_id×staff_id×start_at で排他）
    const { data: reservation, error: insErr } = await supabase
      .from("booking_reservations")
      .insert({
        link_id: link.id,
        start_at: startIso,
        end_at: endIso,
        slot_seq: 0,
        staff_id: staffId,
        menu_id: menu.id,
        guest_name: guest.name,
        guest_email: guest.email || null,
        guest_phone: guest.phone || null,
        guest_note: guest.note || null,
        custom_answers: body.custom_answers ?? {},
        status: "confirmed",
        cancel_token: cancelToken,
      })
      .select()
      .single();
    if (insErr || !reservation) {
      // 一意制約違反 = ちょうど埋まった
      if (insErr?.code === "23505") {
        return NextResponse.json(
          { error: "その枠は直前に埋まりました。別の枠をお選びください" },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: `予約の登録に失敗しました: ${insErr?.message ?? ""}` },
        { status: 500 },
      );
    }

    // Web会議（Zoom / Meet）と Google カレンダー（スタッフの暦）
    const wantZoom = link.meeting_type === "zoom";
    const wantMeet = link.meeting_type === "meet";
    let meetUrl: string | null = null;
    let googleEventId: string | null = null;
    let zoomMeetingId: string | null = null;

    if (wantZoom) {
      const zm = await createZoomMeeting({
        topic: `${menu.name}（${guest.name}様）`,
        startIso,
        durationMin: menu.duration_min,
      });
      if (zm) {
        meetUrl = zm.joinUrl;
        zoomMeetingId = zm.meetingId;
      }
    }

    const gcal = await getOwnerCalendar(staffId); // スタッフ本人の Google
    if (gcal) {
      try {
        const descLines = [
          `メニュー: ${menu.name}`,
          `お名前: ${guest.name}`,
          guest.email ? `メール: ${guest.email}` : null,
          guest.phone ? `電話: ${guest.phone}` : null,
          guest.note ? `備考: ${guest.note}` : null,
          meetUrl ? `Web会議: ${meetUrl}` : null,
        ].filter(Boolean) as string[];
        const res = await gcal.events.insert({
          calendarId: "primary",
          conferenceDataVersion: wantMeet ? 1 : 0,
          requestBody: {
            summary: `${menu.name}（${guest.name}様）`,
            description: descLines.join("\n"),
            location: link.location ?? undefined,
            start: { dateTime: startIso, timeZone: "Asia/Tokyo" },
            end: { dateTime: endIso, timeZone: "Asia/Tokyo" },
            ...(wantMeet
              ? {
                  conferenceData: {
                    createRequest: {
                      requestId: reservation.id,
                      conferenceSolutionKey: { type: "hangoutsMeet" },
                    },
                  },
                }
              : {}),
            ...(guest.email ? { attendees: [{ email: guest.email, displayName: guest.name }] } : {}),
          },
        });
        googleEventId = res.data.id ?? null;
        if (wantMeet) {
          meetUrl =
            res.data.hangoutLink ??
            res.data.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ??
            null;
        }
      } catch (e) {
        console.error("salon google sync failed:", (e as Error).message);
      }
    }

    await supabase
      .from("booking_reservations")
      .update({ google_event_id: googleEventId, meet_url: meetUrl, zoom_meeting_id: zoomMeetingId })
      .eq("id", reservation.id);

    // ベル通知（フック）
    try {
      await resolveHooks().onReserved?.({
        link,
        guestName: guest.name,
        guestEmail: guest.email || null,
        startIso,
        durationMin: menu.duration_min,
      });
    } catch (e) {
      console.error("salon reserve hook failed:", (e as Error).message);
    }

    // メール通知
    const baseUrl = getEngineConfig().publicBaseUrl ?? request.nextUrl.origin;
    const cancelUrl = `${baseUrl}/cancel/${cancelToken}`;
    await notifyReservationConfirmed({
      link: { ...link, title: `${link.title}｜${menu.name}` },
      guestName: guest.name,
      guestEmail: guest.email || null,
      startIso,
      endIso,
      meetUrl,
      cancelUrl,
    });

    return NextResponse.json({
      ok: true,
      start_at: startIso,
      end_at: endIso,
      meet_url: meetUrl,
      cancel_url: cancelUrl,
    });
  };
}
