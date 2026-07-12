import { serviceClient } from "../config";

// ============================================================
// 主催者（オーナー）アカウント管理 — service role 必須
// ============================================================
// 認証ユーザー = 予約システムの主催者（テナント）。
// スーパー管理者だけが作成できるよう、ゲート（誰が呼べるか）は
// アプリのサーバーアクション側で必ず確認すること。
// ============================================================

export type OwnerUser = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
};

// 新規オーナー（認証ユーザー）を作成する。メールは確認済み扱いで即ログイン可能。
export async function createOwnerUser(input: {
  email: string;
  password: string;
}): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const admin = serviceClient();
  if (!admin) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が未設定です" };
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "メールアドレスの形式が不正です" };
  }
  if ((input.password ?? "").length < 8) {
    return { ok: false, error: "パスワードは8文字以上にしてください" };
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, userId: data.user?.id ?? "" };
}

// 既存オーナー一覧（一覧表示用）
export async function listOwnerUsers(): Promise<OwnerUser[]> {
  const admin = serviceClient();
  if (!admin) return [];
  const { data } = await admin.auth.admin.listUsers();
  return (data?.users ?? []).map((u) => ({
    id: u.id,
    email: u.email ?? null,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
  }));
}
