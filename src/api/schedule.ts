import { NextRequest, NextResponse } from "next/server";
import { anonClient, resolveHooks } from "../config";
import { getBrand } from "../repo/brands";

// ============================================================
// 日程調整（調整さん風）公開 API（ログイン不要）
// ============================================================
//   export const GET  = createScheduleDataHandler();
//   export const POST = createScheduleRespondHandler();
// ============================================================

// ---- 公開データ取得 ----
export function createScheduleDataHandler() {
  return async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const supabase = anonClient();

    const { data: poll, error } = await supabase
      .from("schedule_polls")
      .select("id, title, description, location, status, confirmed_slot_id, created_by")
      .eq("token", token)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
    }
    if (!poll) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const brand = poll.created_by ? await getBrand(poll.created_by) : null;

    const [slotsRes, respRes] = await Promise.all([
      supabase
        .from("schedule_poll_slots")
        .select("id, start_at, end_at")
        .eq("poll_id", poll.id)
        .order("start_at", { ascending: true }),
      supabase
        .from("schedule_poll_responses")
        .select("respondent_name, comment, answers, updated_at")
        .eq("poll_id", poll.id)
        .order("created_at", { ascending: true }),
    ]);

    return NextResponse.json({
      title: poll.title,
      description: poll.description,
      location: poll.location,
      status: poll.status,
      confirmed_slot_id: poll.confirmed_slot_id,
      brand,
      slots: slotsRes.data ?? [],
      responses: respRes.data ?? [],
    });
  };
}

const VALID_ANSWERS = new Set(["ok", "maybe", "ng"]);

// ---- 回答送信（同じ名前で再送信すると上書き） ----
export function createScheduleRespondHandler() {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const supabase = anonClient();

    let body: { name?: string; comment?: string; answers?: Record<string, string> };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
    }

    const name = (body.name ?? "").trim();
    const comment = (body.comment ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "お名前を入力してください" }, { status: 400 });
    }
    if (name.length > 40) {
      return NextResponse.json({ error: "お名前が長すぎます（40文字まで）" }, { status: 400 });
    }
    if (comment.length > 500) {
      return NextResponse.json({ error: "コメントが長すぎます（500文字まで）" }, { status: 400 });
    }

    const { data: poll } = await supabase
      .from("schedule_polls")
      .select("id, status, title, created_by")
      .eq("token", token)
      .maybeSingle();
    if (!poll) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (poll.status !== "open") {
      return NextResponse.json(
        { error: "この日程調整は回答を締め切っています" },
        { status: 409 },
      );
    }

    // 回答の検証: この調整の候補 slot_id に対する ok/maybe/ng のみ受け付ける
    const { data: slots } = await supabase
      .from("schedule_poll_slots")
      .select("id")
      .eq("poll_id", poll.id);
    const validSlotIds = new Set((slots ?? []).map((s) => s.id));
    const answers: Record<string, string> = {};
    for (const [slotId, ans] of Object.entries(body.answers ?? {})) {
      if (validSlotIds.has(slotId) && VALID_ANSWERS.has(ans)) {
        answers[slotId] = ans;
      }
    }
    if (Object.keys(answers).length === 0) {
      return NextResponse.json(
        { error: "少なくとも1つの候補に回答してください" },
        { status: 400 },
      );
    }

    const { error } = await supabase.from("schedule_poll_responses").upsert(
      {
        poll_id: poll.id,
        respondent_name: name,
        comment: comment || null,
        answers,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "poll_id,respondent_name" },
    );
    if (error) {
      return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
    }

    // 作成者への通知（ベル等）はフック経由（失敗しても回答自体は成功扱い）
    if (poll.created_by) {
      const okCount = Object.values(answers).filter((a) => a === "ok").length;
      try {
        await resolveHooks().onScheduleResponse?.({
          pollTitle: poll.title,
          createdBy: poll.created_by,
          respondentName: name,
          okCount,
          comment: comment || null,
        });
      } catch (e) {
        console.error("schedule_response hook failed:", (e as Error).message);
      }
    }

    return NextResponse.json({ ok: true });
  };
}
