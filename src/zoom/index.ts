// ============================================================
// Zoom 連携（Server-to-Server OAuth）
// ============================================================
// 事業者の Zoom アカウント1つに紐付けてミーティングを自動発行する。
// （販売モデル = 1インスタンス 1事業者。利用者ごとの接続は不要）
//
// 環境変数:
//   ZOOM_ACCOUNT_ID     … Zoom アカウント ID
//   ZOOM_CLIENT_ID      … Server-to-Server OAuth アプリの Client ID
//   ZOOM_CLIENT_SECRET  … 同 Client Secret
//   ZOOM_HOST_EMAIL     … 主催ホストのメール（任意。既定 "me" = アプリ所有者）
//
// 未設定・失敗時は null を返し、予約自体は成立させる（Google と同じ方針）。
// ============================================================

function zoomConfigured(): boolean {
  return !!(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET
  );
}

// アクセストークン取得（S2S: account_credentials グラント）
async function getZoomToken(): Promise<string | null> {
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
      console.error("zoom token failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch (e) {
    console.error("zoom token error:", (e as Error).message);
    return null;
  }
}

export type ZoomMeeting = { joinUrl: string; meetingId: string };

// ミーティングを作成。未設定・失敗時は null。
export async function createZoomMeeting(input: {
  topic: string;
  startIso: string;
  durationMin: number;
}): Promise<ZoomMeeting | null> {
  const token = await getZoomToken();
  if (!token) return null;
  const host = process.env.ZOOM_HOST_EMAIL || "me";
  // Zoom は timezone 指定時、start_time に 'Z'(UTC) を付けても
  // 「時刻部分」をその timezone のローカル時刻として解釈してしまう。
  // そのため JST のローカル時刻文字列（Z・オフセットなし）で渡す。
  //   例: UTC 2026-07-13T01:00:00Z → "2026-07-13T10:00:00"（JST 10:00）
  const jstLocal = new Date(Date.parse(input.startIso) + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
  try {
    const res = await fetch(
      `https://api.zoom.us/v2/users/${encodeURIComponent(host)}/meetings`,
      {
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
      },
    );
    if (!res.ok) {
      console.error("zoom meeting create failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { id?: number | string; join_url?: string };
    if (!json.join_url || json.id === undefined) return null;
    return { joinUrl: json.join_url, meetingId: String(json.id) };
  } catch (e) {
    console.error("zoom meeting create error:", (e as Error).message);
    return null;
  }
}

// ミーティング削除（キャンセル時。失敗しても無視）
export async function deleteZoomMeeting(meetingId: string): Promise<void> {
  const token = await getZoomToken();
  if (!token) return;
  try {
    await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error("zoom meeting delete error:", (e as Error).message);
  }
}
