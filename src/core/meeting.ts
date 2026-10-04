// Web会議（Zoom / Google Meet）まわりの純粋な判定。画面からも読める。

export type MeetingType = "none" | "meet" | "zoom";

/** Web会議で行う予約リンクか */
export function isOnlineMeeting(type: string | null | undefined): boolean {
  return type === "zoom" || type === "meet";
}

/**
 * Web会議の予約なのに、参加URLを発行できていないか。
 * 連携切れ・未連携・発行失敗のいずれでも予約自体は成立させているので、
 * 主催者と予約者に「URLが無い」ことを知らせるために使う。
 */
export function meetingUrlMissing(
  type: string | null | undefined,
  meetUrl: string | null | undefined,
): boolean {
  return isOnlineMeeting(type) && !meetUrl;
}
