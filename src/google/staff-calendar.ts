import type { calendar_v3 } from "googleapis";
import { anonClient } from "../config";
import { getOwnerCalendarTarget } from "./calendar";
import { normalizeCalendarId } from "./oauth";

// ============================================================
// スタッフごとの Google カレンダー
// ============================================================
// スタッフ1人ずつが自分の Google アカウントを連携できる。
//   staff.google_auth_user_id → google_auth_tokens.user_id を指す
//   （旧方式との互換: 列が空でも staff.id をキーにしたトークンがあればそれを使う）
// 未連携のスタッフは「オーナーのカレンダー」にフォールバックする。
// 読み（空き判定）と書き（予定作成）で必ず同じカレンダーを使うこと。
// 片方だけフォールバックするとダブルブッキングの原因になる。
// ============================================================

export type StaffCalendarTarget = {
  gcal: calendar_v3.Calendar;
  calendarId: string;
  /** 実際に使った google_auth_tokens.user_id */
  userId: string;
  /** true = スタッフ未連携のためオーナーのカレンダーを使っている */
  usingOwnerCalendar: boolean;
};

// スタッフのトークンキー（google_auth_tokens.user_id）。
// 列が未追加（マイグレーション未実行）の環境では staff.id を返す。
export async function getStaffTokenUserId(staffId: string): Promise<string> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, google_auth_user_id")
    .eq("id", staffId)
    .maybeSingle();
  if (error || !data) return staffId;
  return ((data as { google_auth_user_id?: string | null }).google_auth_user_id ?? staffId) as string;
}

// スタッフの連携先カレンダー（未連携ならオーナーへフォールバック。どちらも未連携なら null）
export async function getStaffCalendarTarget(
  staffId: string,
  ownerUserId: string,
): Promise<StaffCalendarTarget | null> {
  const tokenUserId = await getStaffTokenUserId(staffId);
  const own = await getOwnerCalendarTarget(tokenUserId);
  if (own) {
    return {
      gcal: own.gcal,
      calendarId: own.calendarId,
      userId: tokenUserId,
      usingOwnerCalendar: tokenUserId === ownerUserId,
    };
  }
  if (!ownerUserId || ownerUserId === tokenUserId) return null;
  const fallback = await getOwnerCalendarTarget(ownerUserId);
  if (!fallback) return null;
  return {
    gcal: fallback.gcal,
    calendarId: fallback.calendarId,
    userId: ownerUserId,
    usingOwnerCalendar: true,
  };
}

// スタッフの予定を消す。連携先が後から変わっていても取りこぼさないよう、
// スタッフ側 → オーナー側の順に試す（どちらかで消えれば成功）。
export async function deleteStaffEvent(
  staffId: string | null,
  ownerUserId: string,
  eventId: string,
): Promise<void> {
  const targets: { gcal: calendar_v3.Calendar; calendarId: string }[] = [];
  if (staffId) {
    const t = await getStaffCalendarTarget(staffId, ownerUserId);
    if (t) targets.push(t);
  }
  const ownerTarget = await getOwnerCalendarTarget(ownerUserId);
  if (
    ownerTarget &&
    !targets.some((t) => t.calendarId === ownerTarget.calendarId && t.gcal === ownerTarget.gcal)
  ) {
    targets.push(ownerTarget);
  }
  for (const t of targets) {
    try {
      await t.gcal.events.delete({ calendarId: t.calendarId, eventId });
      return; // 消せたら終わり
    } catch {
      // 見つからない/権限なし → 次の候補へ
    }
  }
}

// ---- 管理画面向けの連携状態 ----
export type StaffGoogleState =
  | "connected" // このスタッフ本人の Google につながっている
  | "broken" // つながっていたが切れた（取り消し・失効）
  | "owner_fallback" // 未連携。オーナーのカレンダーを使っている
  | "none"; // 未連携。オーナーも未連携（＝Google には何も入らない）

export type StaffGoogleStatus = {
  staffId: string;
  state: StaffGoogleState;
  email: string | null;
  calendarId: string;
  ownerEmail: string | null;
};

// スタッフ一覧ぶんの連携状態をまとめて取得（クエリ2回）
export async function listStaffGoogleStatuses(
  ownerUserId: string,
  staffIds: string[],
): Promise<Record<string, StaffGoogleStatus>> {
  const out: Record<string, StaffGoogleStatus> = {};
  if (staffIds.length === 0) return out;
  const supabase = anonClient();

  // staff → トークンキー
  const keyByStaff = new Map<string, string>();
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id, google_auth_user_id")
    .in("id", staffIds);
  if (staffErr || !staffRows) {
    for (const id of staffIds) keyByStaff.set(id, id); // 列が無い環境は旧方式
  } else {
    for (const row of staffRows as { id: string; google_auth_user_id?: string | null }[]) {
      keyByStaff.set(row.id, row.google_auth_user_id ?? row.id);
    }
    for (const id of staffIds) if (!keyByStaff.has(id)) keyByStaff.set(id, id);
  }

  // トークン行（スタッフぶん＋オーナー）
  const userIds = Array.from(new Set([...keyByStaff.values(), ownerUserId].filter(Boolean)));
  type TokenRow = {
    user_id: string;
    google_email: string | null;
    calendar_id: string | null;
    last_error_at?: string | null;
  };
  let tokens: TokenRow[] = [];
  {
    const { data, error } = await supabase
      .from("google_auth_tokens")
      .select("user_id, google_email, calendar_id, last_error_at")
      .in("user_id", userIds);
    if (error) {
      // last_error_at 列が無い（マイグレーション未実行）環境向け
      const { data: legacy } = await supabase
        .from("google_auth_tokens")
        .select("user_id, google_email, calendar_id")
        .in("user_id", userIds);
      tokens = (legacy ?? []) as TokenRow[];
    } else {
      tokens = (data ?? []) as TokenRow[];
    }
  }
  const tokenByUser = new Map(tokens.map((t) => [t.user_id, t]));
  const ownerToken = ownerUserId ? tokenByUser.get(ownerUserId) : undefined;

  for (const staffId of staffIds) {
    const key = keyByStaff.get(staffId) ?? staffId;
    const row = tokenByUser.get(key);
    const isOwnerKey = key === ownerUserId;
    let state: StaffGoogleState;
    if (row && !isOwnerKey) {
      state = row.last_error_at ? "broken" : "connected";
    } else if (ownerToken) {
      state = "owner_fallback";
    } else {
      state = "none";
    }
    out[staffId] = {
      staffId,
      state,
      email: row && !isOwnerKey ? row.google_email ?? null : null,
      calendarId: normalizeCalendarId(
        (state === "connected" || state === "broken" ? row?.calendar_id : ownerToken?.calendar_id) ??
          null,
      ),
      ownerEmail: ownerToken?.google_email ?? null,
    };
  }
  return out;
}

export async function getStaffGoogleStatus(
  staffId: string,
  ownerUserId: string,
): Promise<StaffGoogleStatus> {
  const map = await listStaffGoogleStatuses(ownerUserId, [staffId]);
  return (
    map[staffId] ?? {
      staffId,
      state: "none",
      email: null,
      calendarId: "primary",
      ownerEmail: null,
    }
  );
}

// 連携完了時に「このスタッフはこのGoogle連携を使う」を記録する。
// 列が無い環境ではトークンが staff.id キーで保存されているのでそのまま動く。
export async function linkStaffGoogleAccount(
  staffId: string,
  tokenUserId: string,
): Promise<void> {
  const supabase = anonClient();
  await supabase
    .from("staff")
    .update({ google_auth_user_id: tokenUserId, updated_at: new Date().toISOString() })
    .eq("id", staffId);
}

// スタッフの連携を解除する。スタッフ専用のトークンだけ消す
// （オーナーのトークンを指していた場合はオーナー側は消さない）。
export async function disconnectStaffGoogle(
  staffId: string,
  ownerUserId: string,
): Promise<void> {
  const supabase = anonClient();
  const tokenUserId = await getStaffTokenUserId(staffId);
  if (tokenUserId && tokenUserId !== ownerUserId) {
    await supabase.from("google_auth_tokens").delete().eq("user_id", tokenUserId);
  }
  await supabase
    .from("staff")
    .update({ google_auth_user_id: null, updated_at: new Date().toISOString() })
    .eq("id", staffId);
}
