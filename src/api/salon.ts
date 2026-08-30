import { NextRequest, NextResponse } from "next/server";
import { anonClient, resolveHooks } from "../config";
import { getBrand, withLinkBrand } from "../repo/brands";
import * as salon from "../repo/salon";
import {
  computeSalonAvailability,
  isSalonSlotAvailable,
} from "../core/availability";
import { getOwnerCalendar } from "../google/calendar";
import { createZoomMeetingForUser } from "../zoom";
import { notifyReservationConfirmed } from "../notify";
import { getEngineConfig } from "../config";
import type { BookingLinkRow } from "../types";

// ============================================================
// サロン型 公開 API（メニュー→スタッフ→時間→確定）
// ============================================================

// メニュー + 選択オプションから 合計所要(分)・合計料金・有効オプションを求める
async function resolveTotals(
  ownerId: string,
  menu: { id: string; duration_min: number; price: number | null },
  optionIdsParam: string | null,
) {
  const ids = (optionIdsParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const opts =
    ids.length > 0
      ? (await salon.getOptionsByIds(ownerId, ids)).filter((o) => o.menu_id === menu.id)
      : [];
  const durationMin =
    menu.duration_min + opts.reduce((s, o) => s + (o.duration_min || 0), 0);
  const price = (menu.price ?? 0) + opts.reduce((s, o) => s + (o.price ?? 0), 0);
  return { durationMin, price, options: opts };
}

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

// リンクの salon_staff_ids（あれば）で許可スタッフを絞る集合。null=制限なし
function allowedStaffIdSet(link: BookingLinkRow): Set<string> | null {
  const ids = link.salon_staff_ids;
  return ids && ids.length > 0 ? new Set(ids) : null;
}

// リンクの salon_menu_ids（あれば）から「表示してよいメニューID集合」を作る。
// 選択された末端メニュー + その祖先カテゴリを含める。null=制限なし
function allowedMenuIdSet(
  link: BookingLinkRow,
  allMenus: { id: string; parent_id: string | null }[],
): Set<string> | null {
  const ids = link.salon_menu_ids;
  if (!ids || ids.length === 0) return null;
  const byId = new Map(allMenus.map((m) => [m.id, m]));
  const set = new Set<string>();
  for (const id of ids) {
    let cur = byId.get(id);
    while (cur && !set.has(cur.id)) {
      set.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  return set;
}

// おまかせ/一覧で使う「このリンクで有効な対応スタッフ」（メニュー対応 ∩ リンク許可）
async function staffForLinkMenu(
  link: BookingLinkRow,
  menuId: string,
): Promise<import("../types").Staff[]> {
  const list = await salon.listStaffForMenu(link.owner_user_id, menuId);
  const allow = allowedStaffIdSet(link);
  return allow ? list.filter((s) => allow.has(s.id)) : list;
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
    const [menus, staffWithMenus, ownerBrand] = await Promise.all([
      salon.listMenus(link.owner_user_id),
      salon.listStaffWithMenus(link.owner_user_id),
      getBrand(link.owner_user_id),
    ]);
    const brand = withLinkBrand(ownerBrand, link.brand_display_name);
    // リンクごとの絞り込み（未設定なら全部）
    const menuAllow = allowedMenuIdSet(link, menus);
    const staffAllow = allowedStaffIdSet(link);
    const activeMenus = menus.filter(
      (m) => m.active && (!menuAllow || menuAllow.has(m.id)),
    );
    const optionsByMenu = await salon.listOptionsForMenus(activeMenus.map((m) => m.id));
    return NextResponse.json({
      title: link.title,
      description: link.description,
      location: link.location,
      meeting_type: link.meeting_type,
      status: link.status,
      email_mode: link.email_mode ?? "optional",
      phone_mode: link.phone_mode ?? "optional",
      brand,
      menus: activeMenus.map((m) => ({
        id: m.id,
        parent_id: m.parent_id,
        name: m.name,
        duration_min: m.duration_min,
        price: m.price,
        description: m.description,
        image_url: m.image_url,
        options: optionsByMenu.get(m.id) ?? [],
      })),
      staff: staffWithMenus
        .filter((s) => s.active && (!staffAllow || staffAllow.has(s.id)))
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? null,
          image_url: s.image_url,
          // 対応メニューもリンク許可メニューに intersect（スタッフ先フローの整合）
          menu_ids: menuAllow ? s.menu_ids.filter((id) => menuAllow.has(id)) : s.menu_ids,
        })),
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
    const optionIds = req.nextUrl.searchParams.get("optionIds");
    const link = await loadSalonLink(token);
    if (!link || link.link_type !== "salon" || link.status !== "active") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const menu = await salon.getMenu(menuId, link.owner_user_id);
    if (!menu) return NextResponse.json({ error: "メニューが不正です" }, { status: 400 });
    const { durationMin } = await resolveTotals(link.owner_user_id, menu, optionIds);

    if (staffId) {
      // スタッフがそのメニューに対応し、かつこのリンクで許可されているか検証
      const staffAllow = allowedStaffIdSet(link);
      if (
        !(await salon.staffHandlesMenu(staffId, menuId)) ||
        (staffAllow && !staffAllow.has(staffId))
      ) {
        return NextResponse.json({ error: "スタッフが不正です" }, { status: 400 });
      }
      const st = await salon.getStaff(staffId, link.owner_user_id);
      const days = await computeSalonAvailability(link, {
        staffId,
        durationMin,
        staffDayHours: st?.day_hours ?? null,
      });
      return NextResponse.json({ duration_min: durationMin, days });
    }

    // おまかせ: 対応スタッフ（リンク許可内）の空きを合算（どれか空いていれば予約可）
    const staffList = await staffForLinkMenu(link, menuId);
    const perStaff = await Promise.all(
      staffList.map((s) =>
        computeSalonAvailability(link, {
          staffId: s.id,
          durationMin,
          staffDayHours: s.day_hours ?? null,
        }),
      ),
    );
    const union = new Map<string, { date: string; weekday: string; slots: Set<string> }>();
    perStaff.forEach((days) => {
      for (const d of days) {
        if (!union.has(d.date)) union.set(d.date, { date: d.date, weekday: d.weekday, slots: new Set() });
        for (const s of d.slots) union.get(d.date)!.slots.add(s.start_at);
      }
    });
    const durMs = durationMin * 60 * 1000;
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
    return NextResponse.json({ duration_min: durationMin, days });
  };
}

// ---- スタッフ×日 の空き一覧プレビュー: ?menuId=&optionIds= ----
export function createSalonOverviewHandler() {
  return async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const menuId = req.nextUrl.searchParams.get("menuId") ?? "";
    const optionIds = req.nextUrl.searchParams.get("optionIds");
    const link = await loadSalonLink(token);
    if (!link || link.link_type !== "salon" || link.status !== "active") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const menu = await salon.getMenu(menuId, link.owner_user_id);
    if (!menu) return NextResponse.json({ error: "メニューが不正です" }, { status: 400 });
    const { durationMin } = await resolveTotals(link.owner_user_id, menu, optionIds);
    const staffList = await staffForLinkMenu(link, menuId);
    const perStaff = await Promise.all(
      staffList.map(async (s) => {
        const days = await computeSalonAvailability(link, {
          staffId: s.id,
          durationMin,
          staffDayHours: s.day_hours ?? null,
        });
        return {
          id: s.id,
          name: s.name,
          image_url: s.image_url,
          days: days.map((d) => ({ date: d.date, weekday: d.weekday, count: d.slots.length })),
        };
      }),
    );
    return NextResponse.json({ duration_min: durationMin, staff: perStaff });
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
      optionIds?: string[];
      start_at?: string;
      name?: string;
      email?: string;
      phone?: string;
      note?: string;
      custom_answers?: Record<string, string>;
      line_user_id?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
    }
    // LINE連携（VAILS）: 配信URLの ?lu={userId} から渡される
    const rawLu = (body.line_user_id ?? "").trim();
    const lineUserId = /^U[0-9a-f]{32}$/.test(rawLu) ? rawLu : null;

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
    // リンクのメニュー絞り込み（許可外は拒否）
    const allMenus = await salon.listMenus(link.owner_user_id);
    const menuAllow = allowedMenuIdSet(link, allMenus);
    if (menuAllow && !menuAllow.has(menu.id)) {
      return NextResponse.json({ error: "このメニューは現在選べません" }, { status: 400 });
    }
    const optionIdsCsv = Array.isArray(body.optionIds) ? body.optionIds.join(",") : null;
    const { durationMin, price: totalPrice, options } = await resolveTotals(
      link.owner_user_id,
      menu,
      optionIdsCsv,
    );
    const startAt = body.start_at ?? "";
    const startMs = Date.parse(startAt);
    if (Number.isNaN(startMs)) {
      return NextResponse.json({ error: "日時が不正です" }, { status: 400 });
    }
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(startMs + durationMin * 60 * 1000).toISOString();

    // 担当スタッフの候補を決定（指定=1名 / おまかせ=空いている対応スタッフ全員）
    const staffAllow = allowedStaffIdSet(link);
    const requestedStaff = (body.staffId ?? "").trim();
    let candidates: string[] = [];
    if (requestedStaff) {
      if (!(await salon.staffHandlesMenu(requestedStaff, menu.id))) {
        return NextResponse.json({ error: "このスタッフはそのメニューに対応していません" }, { status: 400 });
      }
      if (staffAllow && !staffAllow.has(requestedStaff)) {
        return NextResponse.json({ error: "このスタッフは現在選べません" }, { status: 400 });
      }
      const st = await salon.getStaff(requestedStaff, link.owner_user_id);
      const check = await isSalonSlotAvailable(link, requestedStaff, startAt, durationMin, {
        staffDayHours: st?.day_hours ?? null,
      });
      if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 409 });
      candidates = [requestedStaff];
    } else {
      // おまかせ: 対応スタッフ（リンク許可内）で空いている人を順に候補化
      const staffList = await staffForLinkMenu(link, menu.id);
      for (const s of staffList) {
        const check = await isSalonSlotAvailable(link, s.id, startAt, durationMin, {
          staffDayHours: s.day_hours ?? null,
        });
        if (check.ok) candidates.push(s.id);
      }
      if (candidates.length === 0) {
        return NextResponse.json(
          { error: "その時間に対応できるスタッフがいません。別の枠をお選びください" },
          { status: 409 },
        );
      }
    }

    const cancelToken = generateCancelToken();
    // 予約を INSERT（uq_booking_salon: link_id×staff_id×start_at で排他）。
    // おまかせは、あるスタッフが直前に埋まっても（23505）次の候補で再試行する。
    let reservation: { id: string } | null = null;
    let staffId = "";
    let lastErrCode: string | undefined;
    for (const cand of candidates) {
      const { data, error } = await supabase
        .from("booking_reservations")
        .insert({
          link_id: link.id,
          start_at: startIso,
          end_at: endIso,
          slot_seq: 0,
          staff_id: cand,
          menu_id: menu.id,
          guest_name: guest.name,
          guest_email: guest.email || null,
          guest_phone: guest.phone || null,
          guest_note: guest.note || null,
          custom_answers: body.custom_answers ?? {},
          option_ids: options.map((o) => o.id),
          total_price: totalPrice,
          status: "confirmed",
          cancel_token: cancelToken,
          line_user_id: lineUserId,
        })
        .select()
        .single();
      if (!error && data) {
        reservation = data as { id: string };
        staffId = cand;
        break;
      }
      lastErrCode = error?.code;
      // 23505=一意制約 / 23P01=排他制約（同一スタッフ時間帯重なり）= この候補は埋まった → 次へ
      if (error?.code === "23505" || error?.code === "23P01") continue;
      break; // その他のエラーは中断
    }
    if (!reservation) {
      if (lastErrCode === "23505" || lastErrCode === "23P01") {
        return NextResponse.json(
          { error: "その枠は直前に埋まりました。別の枠をお選びください" },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "予約の登録に失敗しました" }, { status: 500 });
    }

    // Web会議（Zoom / Meet）と Google カレンダー（スタッフの暦）
    const wantZoom = link.meeting_type === "zoom";
    const wantMeet = link.meeting_type === "meet";
    let meetUrl: string | null = null;
    let googleEventId: string | null = null;
    let zoomMeetingId: string | null = null;

    if (wantZoom) {
      const zm = await createZoomMeetingForUser(link.owner_user_id, {
        topic: `${menu.name}（${guest.name}様）`,
        startIso,
        durationMin,
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
        durationMin,
      });
    } catch (e) {
      console.error("salon reserve hook failed:", (e as Error).message);
    }

    // メール通知
    const baseUrl = getEngineConfig().publicBaseUrl ?? request.nextUrl.origin;
    const cancelUrl = `${baseUrl}/cancel/${cancelToken}`;
    await notifyReservationConfirmed({
      // ★選択オプションも通知タイトルに含める（2026-08-30 CEO点検指摘:
      //   「カット＋トリートメント」のように選んだ内容が確定通知に出ないと当日に食い違う）
      link: { ...link, title: `${link.title}｜${menu.name}${options.length > 0 ? `（＋${options.map((o) => o.name).join("・")}）` : ""}` },
      guestName: guest.name,
      guestEmail: guest.email || null,
      startIso,
      endIso,
      meetUrl,
      cancelUrl,
      lineFriendId: lineUserId,
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

// ---- 代理予約（管理者が電話・来店客の分を登録）----
// 受付時間・リード・締切の制限を外し、重複だけ確認して登録する。
// 呼び出し側（アプリのサーバーアクション）で「link が本人所有か」を必ず確認すること。
export async function createSalonAdminReservation(
  link: BookingLinkRow,
  input: {
    staffId: string;
    menuId: string;
    optionIds?: string[];
    startAt: string;
    name: string;
    phone?: string;
    email?: string;
    note?: string;
  },
): Promise<
  | { ok: true; start_at: string; end_at: string; staff_id: string }
  | { ok: false; error: string }
> {
  const supabase = anonClient();
  if (link.link_type !== "salon") return { ok: false, error: "サロン型リンクではありません" };
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "お名前を入力してください" };
  const menu = await salon.getMenu(input.menuId, link.owner_user_id);
  if (!menu) return { ok: false, error: "メニューが不正です" };
  const staffId = (input.staffId ?? "").trim();
  if (!staffId) return { ok: false, error: "担当スタッフを選んでください" };
  if (!(await salon.staffHandlesMenu(staffId, menu.id))) {
    return { ok: false, error: "このスタッフはそのメニューに対応していません" };
  }
  const optionIdsCsv = Array.isArray(input.optionIds) ? input.optionIds.join(",") : null;
  const { durationMin, price: totalPrice, options } = await resolveTotals(
    link.owner_user_id,
    menu,
    optionIdsCsv,
  );
  const startMs = Date.parse(input.startAt);
  if (Number.isNaN(startMs)) return { ok: false, error: "日時が不正です" };
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + durationMin * 60 * 1000).toISOString();

  const st = await salon.getStaff(staffId, link.owner_user_id);
  const check = await isSalonSlotAvailable(link, staffId, startIso, durationMin, {
    admin: true,
    staffDayHours: st?.day_hours ?? null,
  });
  if (!check.ok) return { ok: false, error: check.reason ?? "その枠は予約できません" };

  const cancelToken = generateCancelToken();
  const { data: reservation, error: insErr } = await supabase
    .from("booking_reservations")
    .insert({
      link_id: link.id,
      start_at: startIso,
      end_at: endIso,
      slot_seq: 0,
      staff_id: staffId,
      menu_id: menu.id,
      guest_name: name,
      guest_email: (input.email ?? "").trim() || null,
      guest_phone: (input.phone ?? "").trim() || null,
      guest_note: (input.note ?? "").trim() || null,
      custom_answers: {},
      option_ids: options.map((o) => o.id),
      total_price: totalPrice,
      status: "confirmed",
      cancel_token: cancelToken,
    })
    .select()
    .single();
  if (insErr || !reservation) {
    if (insErr?.code === "23505" || insErr?.code === "23P01") {
      return { ok: false, error: "その枠は既に予約が入っています" };
    }
    return { ok: false, error: `予約の登録に失敗しました: ${insErr?.message ?? ""}` };
  }

  // スタッフの Google カレンダーへ（連携時のみ・任意）
  try {
    const gcal = await getOwnerCalendar(staffId);
    if (gcal) {
      const res = await gcal.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: `${menu.name}（${name}様）※代理`,
          description: [
            `メニュー: ${menu.name}`,
            `お名前: ${name}`,
            input.phone ? `電話: ${input.phone}` : null,
            input.note ? `備考: ${input.note}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          location: link.location ?? undefined,
          start: { dateTime: startIso, timeZone: "Asia/Tokyo" },
          end: { dateTime: endIso, timeZone: "Asia/Tokyo" },
        },
      });
      await supabase
        .from("booking_reservations")
        .update({ google_event_id: res.data.id ?? null })
        .eq("id", reservation.id);
    }
  } catch (e) {
    console.error("admin salon google sync failed:", (e as Error).message);
  }

  return { ok: true, start_at: startIso, end_at: endIso, staff_id: staffId };
}
