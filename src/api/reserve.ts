import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, resolveCalendar, resolveHooks, getEngineConfig } from "../config";
import { notifyReservationConfirmed } from "../notify";
import { getOwnerCalendar } from "../google/calendar";
import { createZoomMeeting } from "../zoom";
import { isSlotAvailable, fetchWindows, slotCapacity } from "../core/availability";
import type { BookingLinkRow } from "../types";

// ============================================================
// 予約リンク 予約確定（ログイン不要）
// ============================================================
// 排他制御:
//   booking_reservations の部分一意制約 (link_id, start_at, slot_seq)
//   に対し seq 0..定員-1 を順に INSERT で確保する。
//   - 1対1: 定員1 → seq 0 のみ = 1件だけ成功
//   - 1対多数: 定員 N → N 件まで成功、以降は 409（満席）
// 予定作成:
//   - Google（Meet）はエンジンが直接作成し google_event_id を保持
//   - アプリ内カレンダーのミラー予定は CalendarAdapter 経由（standalone は no-op）
//   - 通知はメール等（notify）、ベルは hooks に委譲
//
//   export const POST = createReserveHandler();
// ============================================================

function generateCancelToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type GuestInput = {
  name: string;
  email: string;
  phone: string;
  note: string;
};

// 定員内の空き seq を確保して予約行を作る（一意制約が同時リクエストを弾く）
async function insertReservation(
  supabase: SupabaseClient,
  link: BookingLinkRow,
  startIso: string,
  endIso: string,
  guest: GuestInput,
  cancelToken: string,
  customAnswers: Record<string, string>,
): Promise<{ reservation?: Record<string, unknown>; full?: boolean; error?: string }> {
  const capacity = slotCapacity(link);
  for (let seq = 0; seq < capacity; seq++) {
    const { data, error } = await supabase
      .from("booking_reservations")
      .insert({
        link_id: link.id,
        start_at: startIso,
        end_at: endIso,
        slot_seq: seq,
        guest_name: guest.name,
        guest_email: guest.email || null,
        guest_phone: guest.phone || null,
        guest_note: guest.note || null,
        custom_answers: customAnswers,
        status: "confirmed",
        cancel_token: cancelToken,
      })
      .select()
      .single();
    if (!error && data) return { reservation: data };
    if (error?.code === "23505") continue; // その seq は取られた → 次へ
    return { error: error?.message ?? "insert failed" };
  }
  return { full: true };
}

export function createReserveHandler() {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const supabase = anonClient();
    const calendar = resolveCalendar();

    let body: {
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

    const guest: GuestInput = {
      name: (body.name ?? "").trim(),
      email: (body.email ?? "").trim(),
      phone: (body.phone ?? "").trim(),
      note: (body.note ?? "").trim(),
    };
    const startAt = body.start_at ?? "";

    const { data: linkRow } = await supabase
      .from("booking_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (!linkRow) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const link = linkRow as BookingLinkRow;
    if (link.status !== "active") {
      return NextResponse.json(
        { error: "この予約リンクは現在受付を停止しています" },
        { status: 409 },
      );
    }

    // ---- 入力項目のバリデーション（リンクの設定に従う） ----
    const emailMode = link.email_mode ?? "optional";
    const phoneMode = link.phone_mode ?? "optional";
    if (emailMode === "off") guest.email = "";
    if (phoneMode === "off") guest.phone = "";

    if (!guest.name) {
      return NextResponse.json({ error: "お名前を入力してください" }, { status: 400 });
    }
    if (guest.name.length > 60) {
      return NextResponse.json({ error: "お名前が長すぎます" }, { status: 400 });
    }
    if (emailMode === "required" && !guest.email) {
      return NextResponse.json({ error: "メールアドレスは必須です" }, { status: 400 });
    }
    if (guest.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) {
      return NextResponse.json({ error: "メールアドレスの形式が不正です" }, { status: 400 });
    }
    if (phoneMode === "required" && !guest.phone) {
      return NextResponse.json({ error: "電話番号は必須です" }, { status: 400 });
    }
    if (guest.phone.length > 30) {
      return NextResponse.json({ error: "電話番号が長すぎます" }, { status: 400 });
    }
    if (guest.note.length > 500) {
      return NextResponse.json({ error: "備考が長すぎます（500文字まで）" }, { status: 400 });
    }

    // カスタム項目: 定義された項目だけ受け付け、必須は入力チェック
    const customAnswers: Record<string, string> = {};
    for (const f of link.custom_fields ?? []) {
      const val = (body.custom_answers?.[f.id] ?? "").toString().trim();
      if (f.required && !val) {
        return NextResponse.json({ error: `「${f.label}」を入力してください` }, { status: 400 });
      }
      if (val.length > 500) {
        return NextResponse.json({ error: `「${f.label}」が長すぎます（500文字まで）` }, { status: 400 });
      }
      if (val) customAnswers[f.id] = val;
    }

    // 枠の検証（グリッド整合 + 空き/残席/ロックの再確認）
    const windows =
      link.slot_mode === "ranges" || link.slot_mode === "both"
        ? await fetchWindows(link.id)
        : [];
    const check = await isSlotAvailable(link, startAt, windows);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 409 });
    }

    const startMs = Date.parse(startAt);
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(startMs + link.duration_min * 60 * 1000).toISOString();
    const cancelToken = generateCancelToken();
    const isGroup = slotCapacity(link) > 1;
    const wantMeet = link.meeting_type === "meet";
    const wantZoom = link.meeting_type === "zoom";

    // ★予約行を先に INSERT（一意制約 (link_id, start_at, slot_seq) が排他を保証）
    const ins = await insertReservation(
      supabase,
      link,
      startIso,
      endIso,
      guest,
      cancelToken,
      customAnswers,
    );
    if (ins.full) {
      return NextResponse.json(
        {
          error: isGroup
            ? "その枠は満席になりました。別の枠をお選びください"
            : "その枠は直前に埋まりました。他の枠をお選びください",
        },
        { status: 409 },
      );
    }
    if (ins.error || !ins.reservation) {
      return NextResponse.json(
        { error: `予約の登録に失敗しました: ${ins.error ?? ""}` },
        { status: 500 },
      );
    }
    const reservation = ins.reservation as { id: string };

    let meetUrl: string | null = null;
    let eventId: string | null = null;
    let googleEventId: string | null = null;
    let zoomMeetingId: string | null = null;

    if (!isGroup) {
      // ==== 1対1: 予約ごとにミラー予定 + Web会議（Google Meet / Zoom） ====
      // Zoom を先に発行（Google 連携の有無に依存しない）
      if (wantZoom) {
        const zm = await createZoomMeeting({
          topic: `${link.title}（${guest.name}様）`,
          startIso,
          durationMin: link.duration_min,
        });
        if (zm) {
          meetUrl = zm.joinUrl;
          zoomMeetingId = zm.meetingId;
        }
      }

      const descLines = [
        `予約リンク経由で確定`,
        `お名前: ${guest.name}`,
        guest.email ? `メール: ${guest.email}` : null,
        guest.phone ? `電話: ${guest.phone}` : null,
        guest.note ? `備考: ${guest.note}` : null,
        meetUrl ? `Web会議: ${meetUrl}` : null,
      ].filter(Boolean) as string[];

      // アプリ内カレンダーのミラー予定（standalone は null）
      const mirror = await calendar.createMirrorEvent({
        link,
        title: `${link.title}（${guest.name}様）`,
        description: descLines.join("\n"),
        startIso,
        endIso,
      });
      eventId = mirror?.id ?? null;

      const gcal = await getOwnerCalendar(link.owner_user_id);
      if (gcal) {
        try {
          const res = await gcal.events.insert({
            calendarId: "primary",
            conferenceDataVersion: wantMeet ? 1 : 0,
            requestBody: {
              summary: `${link.title}（${guest.name}様）`,
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
              ...(guest.email
                ? { attendees: [{ email: guest.email, displayName: guest.name }] }
                : {}),
            },
          });
          googleEventId = res.data.id ?? null;
          if (eventId && googleEventId) {
            await calendar.setMirrorGoogleEventId(eventId, googleEventId);
          }
          if (wantMeet) {
            meetUrl =
              res.data.hangoutLink ??
              res.data.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")
                ?.uri ??
              null;
          }
        } catch (e) {
          console.error("booking google sync failed:", (e as Error).message);
        }
      }
    } else {
      // ==== 1対多数: 枠につき1つの共有予定 + 共有 Meet ====
      // booking_slot_events の一意制約 (link_id, start_at) で「最初の1人」を決める
      const { data: slotEvRow, error: seErr } = await supabase
        .from("booking_slot_events")
        .insert({ link_id: link.id, start_at: startIso })
        .select()
        .single();

      if (!seErr && slotEvRow) {
        // --- 自分が最初の予約者: 共有予定 + Web会議（Google Meet / Zoom）を作成 ---
        if (wantZoom) {
          const zm = await createZoomMeeting({
            topic: `${link.title}（グループ）`,
            startIso,
            durationMin: link.duration_min,
          });
          if (zm) {
            meetUrl = zm.joinUrl;
            zoomMeetingId = zm.meetingId;
          }
        }

        const mirror = await calendar.createMirrorEvent({
          link,
          title: `${link.title}（グループ）`,
          description: `予約リンク（グループ）\n参加者:\n・${guest.name}${meetUrl ? `\nWeb会議: ${meetUrl}` : ""}`,
          startIso,
          endIso,
        });
        eventId = mirror?.id ?? null;

        const gcal = await getOwnerCalendar(link.owner_user_id);
        if (gcal) {
          try {
            const res = await gcal.events.insert({
              calendarId: "primary",
              conferenceDataVersion: wantMeet ? 1 : 0,
              requestBody: {
                summary: `${link.title}（グループ）`,
                description: `参加者:\n・${guest.name}`,
                location: link.location ?? undefined,
                start: { dateTime: startIso, timeZone: "Asia/Tokyo" },
                end: { dateTime: endIso, timeZone: "Asia/Tokyo" },
                ...(wantMeet
                  ? {
                      conferenceData: {
                        createRequest: {
                          requestId: slotEvRow.id,
                          conferenceSolutionKey: { type: "hangoutsMeet" },
                        },
                      },
                    }
                  : {}),
                ...(guest.email
                  ? { attendees: [{ email: guest.email, displayName: guest.name }] }
                  : {}),
              },
            });
            googleEventId = res.data.id ?? null;
            if (wantMeet) {
              meetUrl =
                res.data.hangoutLink ??
                res.data.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")
                  ?.uri ??
                null;
            }
          } catch (e) {
            console.error("group google sync failed:", (e as Error).message);
          }
        }
        if (eventId && googleEventId) {
          await calendar.setMirrorGoogleEventId(eventId, googleEventId);
        }
        await supabase
          .from("booking_slot_events")
          .update({
            event_id: eventId,
            google_event_id: googleEventId,
            meet_url: meetUrl,
            zoom_meeting_id: zoomMeetingId,
          })
          .eq("id", slotEvRow.id);
      } else {
        // --- 既に共有予定がある: 参照して参加者を追記 ---
        // 直後だと作成中のことがあるので少し待って読む
        let slotGoogleId: string | null = null;
        for (let i = 0; i < 4; i++) {
          const { data: existing } = await supabase
            .from("booking_slot_events")
            .select("*")
            .eq("link_id", link.id)
            .eq("start_at", startIso)
            .maybeSingle();
          if (existing?.event_id || existing?.meet_url || i === 3) {
            eventId = existing?.event_id ?? null;
            meetUrl = existing?.meet_url ?? null;
            slotGoogleId = existing?.google_event_id ?? null;
            break;
          }
          await new Promise((r) => setTimeout(r, 700));
        }
        // 参加者リストを再構築して共有予定に反映（ベストエフォート）
        try {
          const { data: members } = await supabase
            .from("booking_reservations")
            .select("guest_name, guest_email")
            .eq("link_id", link.id)
            .eq("start_at", startIso)
            .eq("status", "confirmed")
            .order("slot_seq", { ascending: true });
          const list = (members ?? []).map((m) => `・${m.guest_name}`).join("\n");
          if (eventId) {
            await calendar.updateMirrorDescription(
              eventId,
              `予約リンク（グループ）\n参加者:\n${list}`,
            );
          }
          if (slotGoogleId) {
            const gcal = await getOwnerCalendar(link.owner_user_id);
            if (gcal) {
              const attendees = (members ?? [])
                .filter((m) => m.guest_email)
                .map((m) => ({ email: m.guest_email as string, displayName: m.guest_name }));
              await gcal.events.patch({
                calendarId: "primary",
                eventId: slotGoogleId,
                requestBody: {
                  description: `参加者:\n${list}`,
                  ...(attendees.length > 0 ? { attendees } : {}),
                },
              });
            }
          }
        } catch (e) {
          console.error("group participants sync failed:", (e as Error).message);
        }
      }
    }

    // 予約行に event_id / google_event_id / meet_url / zoom_meeting_id を反映
    await supabase
      .from("booking_reservations")
      .update({
        event_id: eventId,
        google_event_id: googleEventId,
        meet_url: meetUrl,
        zoom_meeting_id: zoomMeetingId,
      })
      .eq("id", reservation.id);

    // ベル通知（フック・ベストエフォート）
    try {
      await resolveHooks().onReserved?.({
        link,
        guestName: guest.name,
        guestEmail: guest.email || null,
        startIso,
        durationMin: link.duration_min,
      });
    } catch (e) {
      console.error("reserve hook failed:", (e as Error).message);
    }

    // メール通知（Vercel は応答後の処理を打ち切るため必ず await）
    const baseUrl = getEngineConfig().publicBaseUrl ?? request.nextUrl.origin;
    const cancelUrl = `${baseUrl}/cancel/${cancelToken}`;
    await notifyReservationConfirmed({
      link,
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
      google_synced: !!googleEventId,
      meet_url: meetUrl,
      cancel_url: cancelUrl,
    });
  };
}
