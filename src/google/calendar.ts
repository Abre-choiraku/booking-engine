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
