import { anonClient, resolveAuth, resolveCalendar, projectsEnabled } from "../config";
import type {
  SchedulePoll,
  SchedulePollResponse,
  SchedulePollSlot,
  SchedulePollStatus,
} from "../types";

// ============================================================
// 日程調整（調整さん風）管理側 repo
// ============================================================
// 候補日時を作って公開リンクを発行 → 相手が ◯△× で回答 →
// 揃ったら確定して予定を作成する。
// 予定作成はアプリ内カレンダー（CalendarAdapter）に委譲。
//   SHEALS = calendar_events / 単体・LINE = 予定作成なし（確定だけ行う）。
// 公開側の読み書きは /api/schedule/[token]/* が担当（ここは使わない）。
// ============================================================

export type {
  SchedulePoll,
  SchedulePollSlot,
  SchedulePollResponse,
  SchedulePollStatus,
} from "../types";

export type SchedulePollWithCounts = SchedulePoll & {
  slot_count: number;
  response_count: number;
  project_name: string | null;
};

export const POLL_STATUS_LABELS: Record<SchedulePollStatus, string> = {
  open: "回答受付中",
  confirmed: "確定済み",
  closed: "締切",
};

export const ANSWER_LABELS: Record<string, string> = {
  ok: "◯",
  maybe: "△",
  ng: "×",
};

function generateToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ownerId を渡すとその作成者の調整だけに絞る（マルチテナントのデータ分離）。
export async function listPolls(ownerId?: string): Promise<SchedulePollWithCounts[]> {
  const supabase = anonClient();
  const select = projectsEnabled()
    ? "*, project:projects(name), slots:schedule_poll_slots(count), responses:schedule_poll_responses(count)"
    : "*, slots:schedule_poll_slots(count), responses:schedule_poll_responses(count)";
  let query = supabase.from("schedule_polls").select(select);
  if (ownerId) query = query.eq("created_by", ownerId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  type Row = SchedulePoll & {
    project?: { name: string } | null;
    slots: { count: number }[];
    responses: { count: number }[];
  };
  // select は projectsEnabled() で動的に切り替わるため型付きパーサを通せない → unknown 経由でキャスト
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    project_name: r.project?.name ?? null,
    slot_count: r.slots?.[0]?.count ?? 0,
    response_count: r.responses?.[0]?.count ?? 0,
  }));
}

export async function createPoll(input: {
  title: string;
  description?: string | null;
  location?: string | null;
  project_id?: string | null;
  slots: { start_at: string; end_at: string }[];
}): Promise<SchedulePoll> {
  const supabase = anonClient();
  let createdBy: string | null = null;
  try {
    const auth = resolveAuth();
    createdBy = auth ? await auth.getCurrentOwnerId() : null;
  } catch {
    /* 取得できなければ null */
  }
  const { data: poll, error } = await supabase
    .from("schedule_polls")
    .insert({
      token: generateToken(),
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      project_id: input.project_id ?? null,
      created_by: createdBy,
    })
    .select()
    .single();
  if (error) throw error;

  const rows = input.slots.map((s, i) => ({
    poll_id: (poll as SchedulePoll).id,
    start_at: s.start_at,
    end_at: s.end_at,
    display_order: i,
  }));
  const { error: slotErr } = await supabase
    .from("schedule_poll_slots")
    .insert(rows);
  if (slotErr) {
    // 候補が入らなければ本体ごと消してエラーに（中途半端な調整を残さない）
    await supabase.from("schedule_polls").delete().eq("id", (poll as SchedulePoll).id);
    throw slotErr;
  }
  return poll as SchedulePoll;
}

export async function getPollDetail(pollId: string): Promise<{
  poll: SchedulePoll;
  slots: SchedulePollSlot[];
  responses: SchedulePollResponse[];
} | null> {
  const supabase = anonClient();
  const [pollRes, slotsRes, respRes] = await Promise.all([
    supabase.from("schedule_polls").select("*").eq("id", pollId).maybeSingle(),
    supabase
      .from("schedule_poll_slots")
      .select("*")
      .eq("poll_id", pollId)
      .order("start_at", { ascending: true }),
    supabase
      .from("schedule_poll_responses")
      .select("*")
      .eq("poll_id", pollId)
      .order("created_at", { ascending: true }),
  ]);
  if (pollRes.error) throw pollRes.error;
  if (!pollRes.data) return null;
  if (slotsRes.error) throw slotsRes.error;
  if (respRes.error) throw respRes.error;
  return {
    poll: pollRes.data as SchedulePoll,
    slots: (slotsRes.data ?? []) as SchedulePollSlot[],
    responses: (respRes.data ?? []) as SchedulePollResponse[],
  };
}

// 確定: ステータス更新 + 予定を作成（アプリ内カレンダーがあれば）。
// 単体アプリ / LINE では予定作成なし → eventId は null。
export async function confirmPollSlot(
  pollId: string,
  slotId: string,
): Promise<{ eventId: string | null }> {
  const supabase = anonClient();
  const detail = await getPollDetail(pollId);
  if (!detail) throw new Error("日程調整が見つかりません");
  const slot = detail.slots.find((s) => s.id === slotId);
  if (!slot) throw new Error("候補日時が見つかりません");

  // アプリ内カレンダーへミラー予定を作成（standalone は no-op → null）
  const calendar = resolveCalendar();
  const created = await calendar.createMirrorEvent({
    // poll には link 型が無いため最小限のダミー link を渡す（mirror は title/日時のみ使う）
    link: {
      id: detail.poll.id,
      token: detail.poll.token,
      title: detail.poll.title,
      description: detail.poll.description,
      location: detail.poll.location,
      project_id: detail.poll.project_id,
      owner_user_id: detail.poll.created_by ?? "",
      duration_min: 0,
      window_days: 0,
      day_start: "00:00",
      day_end: "00:00",
      exclude_weekends: false,
      buffer_min: 0,
      min_notice_hours: 0,
      status: "active",
      slot_mode: "ranges",
      deadline_at: null,
      meeting_type: "none",
      cancel_deadline_hours: 0,
      mode: "one_to_one",
      capacity_per_slot: 1,
      link_type: "calendar",
      period_start: null,
      period_end: null,
      sync_google_busy: null,
      show_guest_names: false,
    },
    title: detail.poll.title,
    description: `日程調整で確定（回答 ${detail.responses.length} 名）`,
    startIso: slot.start_at,
    endIso: slot.end_at,
  });

  const { error } = await supabase
    .from("schedule_polls")
    .update({
      status: "confirmed",
      confirmed_slot_id: slotId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pollId);
  if (error) throw error;
  return { eventId: created?.id ?? null };
}

export async function reopenPoll(pollId: string): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("schedule_polls")
    .update({ status: "open", confirmed_slot_id: null, updated_at: new Date().toISOString() })
    .eq("id", pollId);
  if (error) throw error;
}

export async function deletePoll(pollId: string, ownerId?: string): Promise<void> {
  const supabase = anonClient();
  let query = supabase.from("schedule_polls").delete().eq("id", pollId);
  if (ownerId) query = query.eq("created_by", ownerId);
  const { error } = await query;
  if (error) throw error;
}
