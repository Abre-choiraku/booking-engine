import type { calendar_v3 } from "googleapis";
import {
  getAuthedClientAndCalendar,
  normalizeCalendarId,
  DEFAULT_CALENDAR_ID,
} from "./oauth";

// 主催者（またはスタッフ）の Google Calendar クライアント＋連携先カレンダーIDを取得。
// 未連携・失敗なら null。calendarId は google_auth_tokens.calendar_id（既定 primary）。
export async function getOwnerCalendarTarget(ownerUserId: string): Promise<{
  gcal: calendar_v3.Calendar;
  calendarId: string;
} | null> {
  try {
    const authed = await getAuthedClientAndCalendar(ownerUserId);
    if (!authed) return null;
    const { google } = await import("googleapis");
    return {
      gcal: google.calendar({ version: "v3", auth: authed.client }),
      calendarId: authed.calendarId,
    };
  } catch {
    return null;
  }
}

// 主催者の Google Calendar クライアントを取得（未連携・失敗なら null）。
// reserve / cancel 両ハンドラで共用。※カレンダーIDが必要な場面では
// getOwnerCalendarTarget を使うこと（別カレンダー連携に対応するため）。
export async function getOwnerCalendar(ownerUserId: string) {
  const target = await getOwnerCalendarTarget(ownerUserId);
  return target?.gcal ?? null;
}

// 主催者の Google カレンダーの busy（予定あり）区間を期間指定で取得。
// 未連携・失敗時は空配列。日程調整の候補自動生成で「予定と重なる枠」を除くのに使う。
// events.list を使う（calendar.events スコープで確実に予定を取得できる。予約リンク側と同方式）。
export async function getOwnerBusyTimes(
  ownerUserId: string,
  fromIso: string,
  toIso: string,
): Promise<{ start: string; end: string }[]> {
  try {
    const target = await getOwnerCalendarTarget(ownerUserId);
    if (!target) return [];
    const list = await target.gcal.events.list({
      calendarId: target.calendarId,
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
    });
    const out: { start: string; end: string }[] = [];
    for (const ev of list.data.items ?? []) {
      // キャンセル済み・「予定なし(透明)」表示の予定は空きとみなす
      if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
      const s =
        ev.start?.dateTime ??
        (ev.start?.date ? `${ev.start.date}T00:00:00+09:00` : null);
      const e =
        ev.end?.dateTime ??
        (ev.end?.date ? `${ev.end.date}T00:00:00+09:00` : null);
      if (s && e) out.push({ start: s, end: e });
    }
    return out;
  } catch (e) {
    console.error("getOwnerBusyTimes failed:", (e as Error).message);
    return [];
  }
}

// 指定カレンダーIDに実際にアクセスできるか確認する（保存前チェック用）。
// events.list を1件だけ叩いて権限・存在を確かめる（calendar.events スコープで通る）。
export type CalendarAccessError =
  | "not_connected" // Google 未連携
  | "not_found" // そのIDのカレンダーが無い
  | "forbidden" // 権限が無い
  | "unknown"; // それ以外（通信エラー等）

export async function verifyCalendarAccess(
  userId: string,
  calendarId: string,
): Promise<{ ok: boolean; code?: CalendarAccessError }> {
  const id = normalizeCalendarId(calendarId);
  const authed = await getAuthedClientAndCalendar(userId);
  if (!authed) return { ok: false, code: "not_connected" };
  try {
    const { google } = await import("googleapis");
    const gcal = google.calendar({ version: "v3", auth: authed.client });
    await gcal.events.list({
      calendarId: id,
      maxResults: 1,
      timeMin: new Date().toISOString(),
      singleEvents: true,
    });
    return { ok: true };
  } catch (e) {
    const err = e as { code?: number; status?: number; message?: string };
    const status = err.code ?? err.status;
    if (status === 404) return { ok: false, code: "not_found" };
    if (status === 403) return { ok: false, code: "forbidden" };
    console.error("verifyCalendarAccess failed:", err.message);
    return { ok: false, code: "unknown" };
  }
}

export { DEFAULT_CALENDAR_ID };
