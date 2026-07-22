import { getAuthedClientForUser } from "./oauth";

// 主催者の Google Calendar クライアントを取得（未連携・失敗なら null）。
// reserve / cancel 両ハンドラで共用。
export async function getOwnerCalendar(ownerUserId: string) {
  try {
    const authed = await getAuthedClientForUser(ownerUserId);
    if (!authed) return null;
    const { google } = await import("googleapis");
    return google.calendar({ version: "v3", auth: authed });
  } catch {
    return null;
  }
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
    const gcal = await getOwnerCalendar(ownerUserId);
    if (!gcal) return [];
    const list = await gcal.events.list({
      calendarId: "primary",
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
