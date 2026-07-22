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
export async function getOwnerBusyTimes(
  ownerUserId: string,
  fromIso: string,
  toIso: string,
): Promise<{ start: string; end: string }[]> {
  try {
    const gcal = await getOwnerCalendar(ownerUserId);
    if (!gcal) return [];
    const fb = await gcal.freebusy.query({
      requestBody: { timeMin: fromIso, timeMax: toIso, items: [{ id: "primary" }] },
    });
    return (fb.data.calendars?.primary?.busy ?? [])
      .filter((p) => p.start && p.end)
      .map((p) => ({ start: p.start!, end: p.end! }));
  } catch (e) {
    console.error("getOwnerBusyTimes failed:", (e as Error).message);
    return [];
  }
}
