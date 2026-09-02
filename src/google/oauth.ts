import { google } from "googleapis";
import { encryptToken, decryptToken } from "./crypto";
import { anonClient } from "../config";

// ============================================================
// Google OAuth 2.0 認証フロー
// ============================================================
// 各主催者個人の Google アカウントに接続して Calendar API を叩く。
// トークンは AES-256-GCM で暗号化して google_auth_tokens に保存。
// 環境変数: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI /
//           TOOL_CREDENTIALS_KEY
//
// 連携先カレンダーは google_auth_tokens.calendar_id で指定する。
// 既定は "primary"（メインカレンダー）。仕事用の別カレンダーを使いたい場合は
// そのカレンダーID（例: xxxxx@group.calendar.google.com）を保存する。
// ============================================================

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

// メインカレンダーを表す既定値
export const DEFAULT_CALENDAR_ID = "primary";

// 入力・DB 値をカレンダーIDに正規化（空なら primary）
export function normalizeCalendarId(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  return v === "" ? DEFAULT_CALENDAR_ID : v;
}

export function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth 環境変数（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI）が未設定です",
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// 認証開始 URL を生成。state に user_id を埋め込む。
export function buildAuthUrl(userId: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: userId,
    include_granted_scopes: true,
  });
}

// callback で受け取ったコードをトークンに交換 → DB 保存
// 既存行の calendar_id はそのまま残す（再連携でカレンダー指定が消えないように）。
export async function exchangeAndSave(
  code: string,
  userId: string,
): Promise<{ email: string }> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const me = await oauth2.userinfo.get();
  const email = me.data.email ?? "";

  const supabase = anonClient();
  await supabase.from("google_auth_tokens").upsert(
    {
      user_id: userId,
      google_email: email,
      access_token_encrypted: tokens.access_token
        ? encryptToken(tokens.access_token)
        : null,
      refresh_token_encrypted: tokens.refresh_token
        ? encryptToken(tokens.refresh_token)
        : null,
      expires_at: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
      scope: (tokens.scope as string) ?? SCOPES.join(" "),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  return { email };
}

// 有効な OAuth2Client ＋ 連携先カレンダーIDを取得（必要なら refresh）
export async function getAuthedClientAndCalendar(userId: string): Promise<{
  client: InstanceType<typeof google.auth.OAuth2>;
  calendarId: string;
} | null> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("google_auth_tokens")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;

  const client = getOAuth2Client();
  const access = data.access_token_encrypted
    ? decryptToken(data.access_token_encrypted as string)
    : undefined;
  const refresh = data.refresh_token_encrypted
    ? decryptToken(data.refresh_token_encrypted as string)
    : undefined;
  client.setCredentials({
    access_token: access,
    refresh_token: refresh,
    expiry_date: data.expires_at ? new Date(data.expires_at).getTime() : null,
  });

  // 期限切れなら refresh
  const now = Date.now();
  const expiry = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  if (!expiry || expiry <= now + 60_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await supabase
        .from("google_auth_tokens")
        .update({
          access_token_encrypted: credentials.access_token
            ? encryptToken(credentials.access_token)
            : (data.access_token_encrypted as string | null),
          expires_at: credentials.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    } catch (e) {
      console.error("トークン refresh 失敗:", e);
      return null;
    }
  }
  return {
    client,
    calendarId: normalizeCalendarId(data.calendar_id as string | null),
  };
}

// 有効な OAuth2Client を取得（必要なら refresh）
export async function getAuthedClientForUser(
  userId: string,
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const authed = await getAuthedClientAndCalendar(userId);
  return authed?.client ?? null;
}

// 連携先カレンダーID（未連携・未設定なら primary）
export async function getCalendarIdForUser(userId: string): Promise<string> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("google_auth_tokens")
    .select("calendar_id")
    .eq("user_id", userId)
    .maybeSingle();
  return normalizeCalendarId((data?.calendar_id as string | null) ?? null);
}

// 連携先カレンダーIDを保存（空文字なら primary に戻す）
export async function setCalendarId(
  userId: string,
  calendarId: string | null,
): Promise<void> {
  const supabase = anonClient();
  await supabase
    .from("google_auth_tokens")
    .update({
      calendar_id: normalizeCalendarId(calendarId),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

export async function disconnectUser(userId: string): Promise<void> {
  const supabase = anonClient();
  await supabase.from("google_auth_tokens").delete().eq("user_id", userId);
}

// 現在の接続状態
export async function getConnectionStatus(userId: string): Promise<{
  connected: boolean;
  email: string | null;
  calendarId: string;
}> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("google_auth_tokens")
    .select("google_email, calendar_id")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    connected: !!data,
    email: (data?.google_email as string | null) ?? null,
    calendarId: normalizeCalendarId((data?.calendar_id as string | null) ?? null),
  };
}
