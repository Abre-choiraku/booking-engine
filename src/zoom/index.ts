import { getZoomAccessTokenForUser } from "./oauth";

// ============================================================
// Zoom ミーティング発行
// ============================================================
// 発行方式は2系統:
//   1. per-owner OAuth（推奨・現行）: 事業者ごとに連携した Zoom アカウントで
//      発行する。createZoomMeetingForUser / deleteZoomMeetingForUser。
//      トークンは zoom/oauth.ts（getZoomAccessTokenForUser）が管理。
//   2. S2S（旧・後方互換）: 環境変数 1組の Zoom アカウントで発行する。
//      createZoomMeeting / deleteZoomMeeting。
//
// いずれも未設定・失敗時は null / no-op を返し、予約自体は成立させる。
// ============================================================

export type ZoomMeeting = { joinUrl: string; meetingId: string };

// ---- 共通: トークンを使ってミーティングを作成 ----
async function createMeetingWithToken(
  token: string,
  input: { topic: string; startIso: string; durationMin: number },
): Promise<ZoomMeeting | null> {
  // Zoom は timezone 指定時、start_time に 'Z'(UTC) を付けても
  // 「時刻部分」をその timezone のローカル時刻として解釈してしまう。
  // そのため JST のローカル時刻文字列（Z・オフセットなし）で渡す。
  //   例: UTC 2026-07-13T01:00:00Z → "2026-07-13T10:00:00"（JST 10:00）
  const jstLocal = new Date(Date.parse(input.startIso) + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
  try {
    const res = await fetch(`https://api.zoom.us/v2/users/me/meetings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic: input.topic,
        type: 2, // scheduled meeting
        start_time: jstLocal,
        duration: input.durationMin,
        timezone: "Asia/Tokyo",
        settings: {
          join_before_host: true,
          waiting_room: false,
          approval_type: 2, // 事前登録なし
        },
      }),
    });
    if (!res.ok) {
      console.error(
        "zoom meeting create failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const json = (await res.json()) as {
      id?: number | string;
      join_url?: string;
    };
    if (!json.join_url || json.id === undefined) return null;
    return { joinUrl: json.join_url, meetingId: String(json.id) };
  } catch (e) {
    console.error("zoom meeting create error:", (e as Error).message);
    return null;
  }
}

async function deleteMeetingWithToken(
  token: string,
  meetingId: string,
): Promise<void> {
  try {
    await fetch(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
  } catch (e) {
    console.error("zoom meeting delete error:", (e as Error).message);
  }
}

// ============================================================
// 1. per-owner OAuth 方式（推奨）
// ============================================================
// 事業者（リンク所有者）ごとに連携した Zoom で発行。未連携なら null。
export async function createZoomMeetingForUser(
  ownerUserId: string,
  input: { topic: string; startIso: string; durationMin: number },
): Promise<ZoomMeeting | null> {
  const token = await getZoomAccessTokenForUser(ownerUserId);
  if (!token) return null;
  return createMeetingWithToken(token, input);
}

export async function deleteZoomMeetingForUser(
  ownerUserId: string,
  meetingId: string,
): Promise<void> {
  const token = await getZoomAccessTokenForUser(ownerUserId);
  if (!token) return;
  await deleteMeetingWithToken(token, meetingId);
}

// ============================================================
// 2. S2S（Server-to-Server）方式（旧・後方互換）
// ============================================================
// 環境変数:
//   ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET
//   ZOOM_HOST_EMAIL（任意・既定 "me"）
function zoomConfigured(): boolean {
  return !!(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET
  );
}

async function getZoomS2SToken(): Promise<string | null> {
  if (!zoomConfigured()) return null;
  const accountId = process.env.ZOOM_ACCOUNT_ID!;
  const basic = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`,
  ).toString("base64");
  try {
    const res = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    if (!res.ok) {
      console.error(
        "zoom token failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch (e) {
    console.error("zoom token error:", (e as Error).message);
    return null;
  }
}

export async function createZoomMeeting(input: {
  topic: string;
  startIso: string;
  durationMin: number;
}): Promise<ZoomMeeting | null> {
  const token = await getZoomS2SToken();
  if (!token) return null;
  return createMeetingWithToken(token, input);
}

export async function deleteZoomMeeting(meetingId: string): Promise<void> {
  const token = await getZoomS2SToken();
  if (!token) return;
  await deleteMeetingWithToken(token, meetingId);
}
