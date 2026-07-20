import { encryptToken, decryptToken } from "../google/crypto";
import { anonClient } from "../config";

// ============================================================
// Zoom ユーザーレベル OAuth（事業者ごと連携）
// ============================================================
// 各主催者（事業者）個人の Zoom アカウントに接続してミーティングを発行する。
// Google カレンダー連携（google/oauth.ts）と対称の作り。
// トークンは AES-256-GCM（TOOL_CREDENTIALS_KEY）で暗号化して
// zoom_auth_tokens に保存。Zoom は refresh_token をローテーションするため、
// リフレッシュのたびに新しい refresh_token を保存し直す。
//
// 環境変数:
//   ZOOM_OAUTH_CLIENT_ID     … User-managed OAuth アプリの Client ID
//   ZOOM_OAUTH_CLIENT_SECRET … 同 Client Secret
//   ZOOM_OAUTH_REDIRECT_URI  … 例: https://koroai.net/api/zoom/callback
//   TOOL_CREDENTIALS_KEY     … トークン暗号化鍵（Google 連携と共用）
// ============================================================

const ZOOM_SCOPES = "meeting:write:meeting user:read:user";

function zoomOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = process.env.ZOOM_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ZOOM_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.ZOOM_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Zoom OAuth 環境変数（ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET / ZOOM_OAUTH_REDIRECT_URI）が未設定です",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function basicAuth(): string {
  const { clientId, clientSecret } = zoomOAuthConfig();
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

// 認証開始 URL を生成。state に user_id を埋め込む。
export function buildZoomAuthUrl(userId: string): string {
  const { clientId, redirectUri } = zoomOAuthConfig();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: userId,
  });
  return `https://zoom.us/oauth/authorize?${p.toString()}`;
}

// callback で受け取ったコードをトークンに交換 → DB 保存
export async function exchangeAndSaveZoom(
  code: string,
  userId: string,
): Promise<{ email: string }> {
  const { redirectUri } = zoomOAuthConfig();
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Zoom token 交換に失敗: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  // ユーザーのメール取得（任意・失敗しても連携は成立）
  let email = "";
  try {
    const me = await fetch("https://api.zoom.us/v2/users/me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (me.ok) {
      const j = (await me.json()) as { email?: string };
      email = j.email ?? "";
    }
  } catch {
    /* email は任意 */
  }

  const supabase = anonClient();
  await supabase.from("zoom_auth_tokens").upsert(
    {
      user_id: userId,
      zoom_email: email,
      access_token_encrypted: encryptToken(tok.access_token),
      refresh_token_encrypted: tok.refresh_token
        ? encryptToken(tok.refresh_token)
        : null,
      expires_at: new Date(
        Date.now() + (tok.expires_in ?? 3600) * 1000,
      ).toISOString(),
      scope: tok.scope ?? ZOOM_SCOPES,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  return { email };
}

// 有効なアクセストークンを取得（必要なら refresh）。未連携/失敗は null。
export async function getZoomAccessTokenForUser(
  userId: string,
): Promise<string | null> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("zoom_auth_tokens")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;

  const now = Date.now();
  const expiry = data.expires_at
    ? new Date(data.expires_at as string).getTime()
    : 0;
  // 期限内ならそのまま使う
  if (expiry && expiry > now + 60_000 && data.access_token_encrypted) {
    return decryptToken(data.access_token_encrypted as string);
  }

  // 期限切れ → refresh（Zoom は refresh_token がローテーションする）
  const refresh = data.refresh_token_encrypted
    ? decryptToken(data.refresh_token_encrypted as string)
    : null;
  if (!refresh) {
    return data.access_token_encrypted
      ? decryptToken(data.access_token_encrypted as string)
      : null;
  }
  try {
    const res = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
      }).toString(),
    });
    if (!res.ok) {
      console.error(
        "zoom token refresh failed:",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const tok = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    await supabase
      .from("zoom_auth_tokens")
      .update({
        access_token_encrypted: encryptToken(tok.access_token),
        refresh_token_encrypted: tok.refresh_token
          ? encryptToken(tok.refresh_token)
          : (data.refresh_token_encrypted as string | null),
        expires_at: new Date(
          Date.now() + (tok.expires_in ?? 3600) * 1000,
        ).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    return tok.access_token;
  } catch (e) {
    console.error("zoom token refresh error:", (e as Error).message);
    return null;
  }
}

export async function disconnectZoomUser(userId: string): Promise<void> {
  const supabase = anonClient();
  await supabase.from("zoom_auth_tokens").delete().eq("user_id", userId);
}

// 現在の接続状態
export async function getZoomConnectionStatus(
  userId: string,
): Promise<{ connected: boolean; email: string | null }> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("zoom_auth_tokens")
    .select("zoom_email")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    connected: !!data,
    email: (data?.zoom_email as string | null) ?? null,
  };
}
