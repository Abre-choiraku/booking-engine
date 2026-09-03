import { anonClient, resolveCalendar } from "../config";
import { makeHolidayChecker } from "./holidays";
import type {
  BookingLinkRow,
  BookingWindow,
  Busy,
  DaySlots,
  ManagedDay,
  ManagedSlot,
  Slot,
  SlotLock,
} from "../types";

// ============================================================
// 予約リンク: 空き枠計算（サーバー専用・チャネル非依存の核）
// ============================================================
// 主催者の「Google カレンダー + 既存予約 + アプリ内予定（アダプタ）」を
// busy として、営業時間グリッド / 手動範囲から空き枠を算出する。
// - アプリ内予定（SHEALS の calendar_events 等）は CalendarAdapter 経由。
//   単体アプリ / LINE では既定 no-op（Google と既存予約だけで計算）。
// - Google 未連携・取得失敗時はそのソースを飛ばして続行（機能は落とさない）。
// - 日本は DST が無いため +09:00 固定で扱う。
// ============================================================

export type { BookingLinkRow, BookingWindow, Slot, DaySlots, SlotLock } from "../types";

export function slotCapacity(link: BookingLinkRow): number {
  return Math.max(1, link.capacity_per_slot ?? 1);
}

// Google/アプリ予定との空き連動を行うか（選択制。未設定は旧挙動）
// anytime（終日・受付時間未設定）は Google 空きが唯一の制約なので常に連動する
export function effectiveSyncBusy(link: BookingLinkRow): boolean {
  if (link.slot_mode === "anytime") return true;
  if (link.sync_google_busy !== null && link.sync_google_busy !== undefined) {
    return link.sync_google_busy;
  }
  return link.mode !== "one_to_many";
}

// 日付グリッド（受付時間帯）から枠を生成するモードか
function usesHoursGrid(link: BookingLinkRow): boolean {
  return (
    link.slot_mode === "hours" ||
    link.slot_mode === "both" ||
    link.slot_mode === "anytime"
  );
}

// 指定日の枠生成レンジ（ms）。anytime は終日（00:00〜翌00:00）
function dayWindowMs(link: BookingLinkRow, dateStr: string): { start: number; end: number } {
  if (link.slot_mode === "anytime") {
    const start = Date.parse(`${dateStr}T00:00:00+09:00`);
    return { start, end: start + 24 * 60 * 60 * 1000 };
  }
  return {
    start: Date.parse(`${dateStr}T${link.day_start}:00+09:00`),
    end: Date.parse(`${dateStr}T${link.day_end}:00+09:00`),
  };
}

// 枠の開始間隔（ms）。slot_interval_min があればそれ、無ければ所要+buffer（従来）。
function slotStepMs(link: BookingLinkRow): number {
  const iv = link.slot_interval_min;
  const base = iv && iv > 0 ? iv : link.duration_min + link.buffer_min;
  return Math.max(1, base) * 60 * 1000;
}

// 受付する曜日か（0=日〜6=土）。weekdays が指定されていればそれに従い、
// 無ければ従来の exclude_weekends（土日除外）に従う。
function enabledWeekday(link: BookingLinkRow, dow: number): boolean {
  const wd = link.weekdays;
  if (Array.isArray(wd) && wd.length > 0) return wd.includes(dow);
  return !(link.exclude_weekends && (dow === 0 || dow === 6));
}

// 受付時間帯（配列）。time_ranges があればそれ、無ければ day_start〜day_end 単一。
function dayTimeRanges(link: BookingLinkRow): { start: string; end: string }[] {
  const tr = link.time_ranges;
  if (Array.isArray(tr) && tr.length > 0) {
    return tr.filter((r) => r && r.start && r.end);
  }
  return [{ start: link.day_start, end: link.day_end }];
}

// （dayRangesMs は dateOpenRanges に統合）
function rangeToMs(dateStr: string, r: { start: string; end: string }) {
  return {
    start: Date.parse(`${dateStr}T${r.start}:00+09:00`),
    end: Date.parse(`${dateStr}T${r.end}:00+09:00`),
  };
}

// 祝日判定が必要か（day_hours の祝日扱いが weekday 以外、または exclude_holidays）
function needsHolidayCheck(link: BookingLinkRow): boolean {
  if (link.exclude_holidays) return true;
  const dh = link.day_hours;
  return !!dh && dh.holidayMode !== "weekday";
}

// 指定日に「開いている受付レンジ（ms）」を返す。空配列 = その日は受付なし（休み）。
// day_hours があれば曜日別・祝日別を最優先。無ければ従来ロジック。
function dateOpenRanges(
  link: BookingLinkRow,
  dateStr: string,
  isHoliday: boolean,
): { start: number; end: number }[] {
  const dow = new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();
  const dh = link.day_hours;

  if (dh && dh.days) {
    let open: boolean;
    let ranges: { start: string; end: string }[];
    if (isHoliday) {
      const mode = dh.holidayMode ?? "weekday";
      if (mode === "closed") return [];
      if (mode === "custom") {
        ranges = dh.holiday ?? [];
        open = link.slot_mode === "anytime" || ranges.length > 0;
      } else {
        const c = dh.days[String(dow)];
        open = !!c?.open;
        ranges = c?.ranges ?? [];
      }
    } else {
      const c = dh.days[String(dow)];
      open = !!c?.open;
      ranges = c?.ranges ?? [];
    }
    if (!open) return [];
    if (link.slot_mode === "anytime") return [dayWindowMs(link, dateStr)];
    return ranges.filter((r) => r.start && r.end).map((r) => rangeToMs(dateStr, r));
  }

  // --- 従来ロジック ---
  if (!enabledWeekday(link, dow)) return [];
  if (link.exclude_holidays && isHoliday) return [];
  if (link.slot_mode === "anytime") return [dayWindowMs(link, dateStr)];
  return dayTimeRanges(link).map((r) => rangeToMs(dateStr, r));
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// JST の日付文字列（YYYY-MM-DD）
function jstDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function overlaps(aStart: number, aEnd: number, b: Busy): boolean {
  return aStart < b.end && aEnd > b.start;
}

// 主催者の busy 区間を集める（アプリ内予定[アダプタ] + 既存予約 + Google）
// excludeOwnLink=true のとき、このリンク自身が作った予定・予約は busy に数えない
// （定員>1 + Google 連動 ON で、自分の共有予定が残席を塞ぐのを防ぐ）
export async function collectBusy(
  link: BookingLinkRow,
  fromIso: string,
  toIso: string,
  opts?: { excludeOwnLink?: boolean; staffId?: string },
): Promise<Busy[]> {
  const supabase = anonClient();
  const calendar = resolveCalendar();
  const busy: Busy[] = [];
  const excludeOwn = opts?.excludeOwnLink ?? false;
  // ★予約の前後バッファ（2026-08-30 CEO要望）: 既存予約の前後に準備・片付け時間を確保する。
  //   既存予約ブロックを [開始-前バッファ, 終了+後バッファ] に広げることで、
  //   「前の予約の終わり直後」「次の予約の直前」に食い込む新規予約を弾く。
  //   予約由来のブロックだけに適用（Google予定・シフトブロックは本人管理のためそのまま）。
  //   カラム未追加のDBでも undefined ?? 0 で従来動作。
  const bufBefore = ((link as { buffer_before_min?: number | null }).buffer_before_min ?? 0) * 60_000;
  const bufAfter = ((link as { buffer_after_min?: number | null }).buffer_after_min ?? 0) * 60_000;
  const reservationBusy = (startIso: string, endIso: string): Busy => ({
    start: Date.parse(startIso) - bufBefore,
    end: Date.parse(endIso) + bufAfter,
  });

  // ---- イベント型: 主催者が「◯月◯日 ◯時〜」と明示的に決めた開催枠なので、
  // 他の予定（主催者のGoogle予定・他リンクの予約）では塞がない。
  // 受付可否は定員（confirmed 件数）と手動ロックだけで判定する。
  if (!opts?.staffId && link.link_type === "event") return busy;

  // ---- サロン型: 指定スタッフの busy（そのスタッフの Google + 全予約 + 内部予定）----
  if (opts?.staffId) {
    const staffId = opts.staffId;
    const internal = await calendar.getInternalBusy(staffId, fromIso, toIso);
    busy.push(...internal);
    // シフトブロック（直接登録の休み・時間帯ブロック）
    {
      const { data: blocks } = await supabase
        .from("staff_time_blocks")
        .select("start_at, end_at")
        .eq("staff_id", staffId)
        .lt("start_at", toIso)
        .gt("end_at", fromIso);
      for (const b of (blocks ?? []) as { start_at: string; end_at: string }[]) {
        busy.push({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) });
      }
    }
    // そのスタッフの確定予約（どのリンク経由でも塞ぐ。前後バッファ込み）
    const { data: rs } = await supabase
      .from("booking_reservations")
      .select("start_at, end_at")
      .eq("staff_id", staffId)
      .eq("status", "confirmed")
      .lt("start_at", toIso)
      .gt("end_at", fromIso);
    for (const r of rs ?? []) {
      busy.push(reservationBusy(r.start_at, r.end_at));
    }
    // スタッフ本人の Google 予定（未連携ならオーナーのカレンダーを見る＝予定の入る先と必ず同じ）
    try {
      const { getStaffCalendarTarget } = await import("../google/staff-calendar");
      const target = await getStaffCalendarTarget(staffId, link.owner_user_id);
      if (target) {
        // この予約システムが作った予定は除外する。
        // 予約ぶんの塞ぎは上の booking_reservations で済んでおり、
        // オーナーのカレンダーを共有している場合に
        // 「別スタッフの予約」まで塞いでしまうのを防ぐ。
        const ourEventIds = new Set<string>();
        const { data: ourEvents } = await supabase
          .from("booking_reservations")
          .select("google_event_id, link:booking_links!inner(owner_user_id)")
          .eq("link.owner_user_id", link.owner_user_id)
          .not("google_event_id", "is", null)
          .lt("start_at", toIso)
          .gt("end_at", fromIso);
        for (const row of (ourEvents ?? []) as { google_event_id: string | null }[]) {
          if (row.google_event_id) ourEventIds.add(row.google_event_id);
        }
        // events.list を使う（連携先が別カレンダーでも calendar.events スコープで確実に読める）
        const list = await target.gcal.events.list({
          calendarId: target.calendarId,
          timeMin: fromIso,
          timeMax: toIso,
          singleEvents: true,
          maxResults: 2500,
        });
        for (const ev of list.data.items ?? []) {
          if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
          if (ev.id && ourEventIds.has(ev.id)) continue;
          const s = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00+09:00` : null);
          const e = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00+09:00` : null);
          if (s && e) busy.push({ start: Date.parse(s), end: Date.parse(e) });
        }
      }
    } catch (e) {
      console.error("staff google busy failed:", (e as Error).message);
    }
    return busy;
  }

  // 自リンク由来の Google イベント ID を集める（Google busy から除外するため）。
  // 1対1は booking_reservations.google_event_id、グループは booking_slot_events.google_event_id に入る。
  const ownGoogleIds = new Set<string>();
  if (excludeOwn) {
    const [{ data: se }, { data: rs }] = await Promise.all([
      supabase
        .from("booking_slot_events")
        .select("google_event_id")
        .eq("link_id", link.id)
        .not("google_event_id", "is", null),
      supabase
        .from("booking_reservations")
        .select("google_event_id")
        .eq("link_id", link.id)
        .not("google_event_id", "is", null),
    ]);
    for (const row of se ?? []) {
      if (row.google_event_id) ownGoogleIds.add(row.google_event_id as string);
    }
    for (const row of rs ?? []) {
      if (row.google_event_id) ownGoogleIds.add(row.google_event_id as string);
    }
  }

  // 1. アプリ内の予定（SHEALS=calendar_events / 単体=空）。自リンク除外はアダプタが担当。
  const internal = await calendar.getInternalBusy(
    link.owner_user_id,
    fromIso,
    toIso,
    excludeOwn ? { excludeLinkId: link.id } : undefined,
  );
  busy.push(...internal);

  // 2. この主催者宛の既存予約（イベント作成に失敗していても枠は塞ぐ。キャンセル済みは除外）
  const { data: reservations } = await supabase
    .from("booking_reservations")
    .select("link_id, start_at, end_at, status, link:booking_links!inner(owner_user_id)")
    .eq("link.owner_user_id", link.owner_user_id)
    .eq("status", "confirmed")
    .lt("start_at", toIso)
    .gt("end_at", fromIso);
  for (const r of reservations ?? []) {
    if (excludeOwn && r.link_id === link.id) continue;
    busy.push(reservationBusy(r.start_at, r.end_at));
  }

  // 3. Google カレンダー（連携済みの場合のみ。失敗しても続行）
  try {
    const { getAuthedClientAndCalendar } = await import("../google/oauth");
    const authed = await getAuthedClientAndCalendar(link.owner_user_id);
    if (authed) {
      const { google } = await import("googleapis");
      const gcal = google.calendar({ version: "v3", auth: authed.client });
      // 連携先カレンダー（既定 primary）の予定を events.list で取得。
      // ID で自リンク分を除外できる／別カレンダーでも calendar.events スコープで確実に読める。
      const list = await gcal.events.list({
        calendarId: authed.calendarId,
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: true,
        maxResults: 2500,
      });
      for (const ev of list.data.items ?? []) {
        if (excludeOwn && ev.id && ownGoogleIds.has(ev.id)) continue;
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        const s = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00+09:00` : null);
        const e = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00+09:00` : null);
        if (s && e) busy.push({ start: Date.parse(s), end: Date.parse(e) });
      }
    }
  } catch (e) {
    console.error("booking google busy failed (app-events only):", (e as Error).message);
  }

  return busy;
}

// 営業時間グリッドの対象日リスト（期間指定があればその範囲、なければ今日から window_days 日）
function hoursDates(link: BookingLinkRow, now: number): string[] {
  const dates: string[] = [];
  if (link.period_start && link.period_end) {
    const todayStr = jstDateStr(new Date(now));
    let cur = link.period_start < todayStr ? todayStr : link.period_start;
    let guard = 0;
    while (cur <= link.period_end && guard < 366) {
      dates.push(cur);
      const next = new Date(Date.parse(`${cur}T12:00:00+09:00`) + 24 * 60 * 60 * 1000);
      cur = jstDateStr(next);
      guard++;
    }
    return dates;
  }
  for (let i = 0; i <= link.window_days; i++) {
    dates.push(jstDateStr(new Date(now + i * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

// 受付上限時刻（期間指定があれば期間末日の終わり、なければ rolling window）
function bookingHorizon(link: BookingLinkRow, now: number): number {
  if (link.period_start && link.period_end) {
    return Date.parse(`${link.period_end}T23:59:59+09:00`);
  }
  return now + link.window_days * 24 * 60 * 60 * 1000;
}

// 空き枠を日付ごとに算出
// - 定員（capacity_per_slot）は常に適用（残席0の枠は除外。includeFull なら full 付きで残す）
// - Google/アプリ予定との連動（sync_google_busy）は選択制。定員>1 のときは自リンク由来の予定を除外
export async function computeAvailability(
  link: BookingLinkRow,
  windows: BookingWindow[] = [],
): Promise<DaySlots[]> {
  const now = Date.now();
  // 受付締切を過ぎていたら枠なし
  if (link.deadline_at && now > Date.parse(link.deadline_at)) return [];

  const noticeLimit = now + link.min_notice_hours * 60 * 60 * 1000;
  const windowEnd = bookingHorizon(link, now);
  const step = slotStepMs(link);
  const durMs = link.duration_min * 60 * 1000;

  // busy 取得範囲は「グリッド上限」と「手動範囲の最遠」を包含させる
  let rangeMax = windowEnd;
  for (const w of windows) {
    const e = Date.parse(w.end_at);
    if (!Number.isNaN(e) && e > rangeMax) rangeMax = e;
  }
  const fromIso = new Date(now).toISOString();
  const toIso = new Date(rangeMax + 24 * 60 * 60 * 1000).toISOString();

  const capacity = slotCapacity(link);
  const syncBusy = effectiveSyncBusy(link);
  const isHoliday = needsHolidayCheck(link) ? await makeHolidayChecker() : () => false;
  // 自リンクの予約が作った予定は busy に数えない（数えると予約済み枠が
  // 「他の予定あり」として消え、予約者名が表示されなくなる）
  const busy = syncBusy
    ? await collectBusy(link, fromIso, toIso, { excludeOwnLink: true })
    : [];
  const locks = await fetchLocks(link.id);
  const counts = await fetchConfirmedCounts(link.id);
  const isLocked = (s: number, e: number) =>
    locks.some((lk) => overlaps(s, e, { start: Date.parse(lk.start_at), end: Date.parse(lk.end_at) }));

  const candidateStarts = new Map<number, number>(); // start → end

  // --- 日付グリッド（hours / both / anytime） ---
  if (usesHoursGrid(link)) {
    for (const dateStr of hoursDates(link, now)) {
      for (const { start: dayStartMs, end: dayEndMs } of dateOpenRanges(
        link,
        dateStr,
        isHoliday(dateStr),
      )) {
        if (Number.isNaN(dayStartMs) || Number.isNaN(dayEndMs)) continue;
        for (let t = dayStartMs; t + durMs <= dayEndMs; t += step) {
          if (t < noticeLimit || t > windowEnd) continue;
          candidateStarts.set(t, t + durMs);
        }
      }
    }
  }

  // --- 手動指定の日時範囲（ranges / both）。曜日除外は適用しない（明示指定を尊重） ---
  if (link.slot_mode === "ranges" || link.slot_mode === "both") {
    for (const w of windows) {
      const ws = Date.parse(w.start_at);
      const we = Date.parse(w.end_at);
      if (Number.isNaN(ws) || Number.isNaN(we)) continue;
      // イベント型: 指定した「◯月◯日 ◯時〜◯時」そのものが1つの開催枠。
      // 時間で刻まないので、開催ごとに長さが違ってもよい。
      if (link.link_type === "event") {
        if (ws >= noticeLimit) candidateStarts.set(ws, we);
        continue;
      }
      for (let t = ws; t + durMs <= we; t += step) {
        if (t < noticeLimit) continue;
        candidateStarts.set(t, t + durMs);
      }
    }
  }

  // 日付ごとにまとめる
  // - anytime: 受付時間の概念が無いため、空いている枠だけを出す（従来どおり）
  // - hours / ranges / both: 設定した時間はすべて表示し、
  //   予約不可（他予定・ロック・満席）は full=✕ で残す
  const showUnavailable = link.slot_mode !== "anytime";
  const byDay = new Map<string, Slot[]>();
  const sorted = [...candidateStarts.entries()].sort((a, b) => a[0] - b[0]);
  for (const [t, e] of sorted) {
    const isBusy = busy.some((b) => overlaps(t, e, b));
    const locked = isLocked(t, e);
    const seatsLeft = capacity - (counts.get(t) ?? 0);
    const unavailable = isBusy || locked || seatsLeft <= 0;
    if (unavailable && !showUnavailable) continue; // anytime は空きのみ
    const dateStr = jstDateStr(new Date(t));
    if (!byDay.has(dateStr)) byDay.set(dateStr, []);
    byDay.get(dateStr)!.push({
      start_at: new Date(t).toISOString(),
      end_at: new Date(e).toISOString(),
      ...(capacity > 1 && !unavailable ? { remaining: Math.max(0, seatsLeft) } : {}),
      ...(unavailable ? { full: true } : {}),
    });
  }

  const days: DaySlots[] = [];
  for (const [dateStr, slots] of [...byDay.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const dayOfWeek = new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();
    days.push({ date: dateStr, weekday: WEEKDAYS[dayOfWeek], slots });
  }
  return days;
}

// 予約時の再検証: グリッド/範囲に乗っていて、かつ空いているか
export async function isSlotAvailable(
  link: BookingLinkRow,
  startAtIso: string,
  windows: BookingWindow[] = [],
): Promise<{ ok: boolean; reason?: string }> {
  const startMs = Date.parse(startAtIso);
  if (Number.isNaN(startMs)) return { ok: false, reason: "日時が不正です" };
  const endMs = startMs + link.duration_min * 60 * 1000;
  const now = Date.now();
  if (link.deadline_at && now > Date.parse(link.deadline_at)) {
    return { ok: false, reason: "予約の受付を締め切りました" };
  }
  if (startMs < now + link.min_notice_hours * 60 * 60 * 1000) {
    return { ok: false, reason: "直前の予約はできません。別の枠をお選びください" };
  }
  const step = slotStepMs(link);

  // グリッド整合: 日付グリッド上 or 手動範囲上のどちらかに乗っていること
  let onGrid = false;
  if (usesHoursGrid(link)) {
    const withinHorizon = startMs <= bookingHorizon(link, now);
    const dateStr = jstDateStr(new Date(startMs));
    const withinPeriod =
      !link.period_start ||
      !link.period_end ||
      (dateStr >= link.period_start && dateStr <= link.period_end);
    const isHoliday = needsHolidayCheck(link) ? await makeHolidayChecker() : () => false;
    if (withinHorizon && withinPeriod) {
      for (const { start: dayStartMs, end: dayEndMs } of dateOpenRanges(
        link,
        dateStr,
        isHoliday(dateStr),
      )) {
        if (Number.isNaN(dayStartMs) || Number.isNaN(dayEndMs)) continue;
        if (
          startMs >= dayStartMs &&
          endMs <= dayEndMs &&
          (startMs - dayStartMs) % step === 0
        ) {
          onGrid = true;
          break;
        }
      }
    }
  }
  if (!onGrid && (link.slot_mode === "ranges" || link.slot_mode === "both")) {
    for (const w of windows) {
      const ws = Date.parse(w.start_at);
      const we = Date.parse(w.end_at);
      if (Number.isNaN(ws) || Number.isNaN(we)) continue;
      // イベント型は開催枠そのもの（開始が一致すればよい）
      if (link.link_type === "event") {
        if (startMs === ws) {
          onGrid = true;
          break;
        }
        continue;
      }
      if (startMs >= ws && endMs <= we && (startMs - ws) % step === 0) {
        onGrid = true;
        break;
      }
    }
  }
  if (!onGrid) {
    return { ok: false, reason: "受付時間外です" };
  }

  // 手動ロックの確認（両モード共通）
  const locks = await fetchLocks(link.id);
  if (
    locks.some((lk) =>
      overlaps(startMs, endMs, {
        start: Date.parse(lk.start_at),
        end: Date.parse(lk.end_at),
      }),
    )
  ) {
    return { ok: false, reason: "その枠は受付を停止しています。別の枠をお選びください" };
  }

  const capacity = slotCapacity(link);

  // 残席確認（最終的な排他は予約 INSERT の一意制約が保証）
  const counts = await fetchConfirmedCounts(link.id);
  if ((counts.get(startMs) ?? 0) >= capacity) {
    return {
      ok: false,
      reason:
        capacity > 1
          ? "その枠は満席になりました。別の枠をお選びください"
          : "その枠はちょうど埋まってしまいました。別の枠をお選びください",
    };
  }

  // 定員1: 自リンクの既存予約と時間が重なる枠は不可にする。
  // （開始間隔 < 所要 で枠が重なる設定のとき、同一開始時刻でないと一意制約が
  //  効かず重複予約できてしまうのを防ぐ。fetchConfirmedCounts は同一開始のみ判定）
  if (capacity <= 1) {
    const supabase = anonClient();
    const { data: own } = await supabase
      .from("booking_reservations")
      .select("start_at, end_at")
      .eq("link_id", link.id)
      .eq("status", "confirmed")
      .lt("start_at", new Date(endMs).toISOString())
      .gt("end_at", new Date(startMs).toISOString());
    for (const r of own ?? []) {
      if (
        overlaps(startMs, endMs, {
          start: Date.parse(r.start_at),
          end: Date.parse(r.end_at),
        })
      ) {
        return { ok: false, reason: "その枠はちょうど埋まってしまいました。別の枠をお選びください" };
      }
    }
  }

  // Google/アプリ予定との空き連動（選択制。自リンクの予定は上で判定済みのため除外）
  if (effectiveSyncBusy(link)) {
    const busy = await collectBusy(
      link,
      new Date(startMs - 1).toISOString(),
      new Date(endMs + 1).toISOString(),
      { excludeOwnLink: true },
    );
    if (busy.some((b) => overlaps(startMs, endMs, b))) {
      return { ok: false, reason: "その枠はちょうど埋まってしまいました。別の枠をお選びください" };
    }
  }
  return { ok: true };
}

// 手動範囲の取得ヘルパー（slots / reserve 両ルートで共用）
export async function fetchWindows(linkId: string): Promise<BookingWindow[]> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_link_windows")
    .select("start_at, end_at")
    .eq("link_id", linkId)
    .order("start_at", { ascending: true });
  return (data ?? []) as BookingWindow[];
}

// 手動ロックの取得（両モード共通で枠を塞ぐ）
export async function fetchLocks(linkId: string): Promise<SlotLock[]> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_slot_locks")
    .select("*")
    .eq("link_id", linkId);
  return (data ?? []) as SlotLock[];
}

// ============================================================
// 管理用: 全候補枠を状態付きで列挙（空き/予約あり/ロック/予定あり）
// ============================================================
export type { ManagedSlot, ManagedDay } from "../types";

export async function enumerateSlotsForManagement(
  link: BookingLinkRow,
  windows: BookingWindow[] = [],
): Promise<ManagedDay[]> {
  const now = Date.now();
  const windowEnd = bookingHorizon(link, now);
  const step = slotStepMs(link);
  const durMs = link.duration_min * 60 * 1000;
  const capacity = slotCapacity(link);
  const isGroup = capacity > 1;

  let rangeMax = windowEnd;
  for (const w of windows) {
    const e = Date.parse(w.end_at);
    if (!Number.isNaN(e) && e > rangeMax) rangeMax = e;
  }
  const fromIso = new Date(now).toISOString();
  const toIso = new Date(rangeMax + 24 * 60 * 60 * 1000).toISOString();

  const supabase = anonClient();
  const [busy, locks, resRows] = await Promise.all([
    effectiveSyncBusy(link)
      ? collectBusy(link, fromIso, toIso, { excludeOwnLink: true })
      : Promise.resolve([] as Busy[]),
    fetchLocks(link.id),
    supabase
      .from("booking_reservations")
      .select("start_at, guest_name")
      .eq("link_id", link.id)
      .eq("status", "confirmed")
      .then(({ data }) => data ?? []),
  ]);
  const guestsBySlot = new Map<number, string[]>();
  for (const r of resRows as { start_at: string; guest_name: string }[]) {
    const t = Date.parse(r.start_at);
    if (!guestsBySlot.has(t)) guestsBySlot.set(t, []);
    guestsBySlot.get(t)!.push(r.guest_name);
  }

  // 候補生成（computeAvailability と同じロジック）
  const isHoliday = needsHolidayCheck(link) ? await makeHolidayChecker() : () => false;
  const candidateStarts = new Map<number, number>();
  if (usesHoursGrid(link)) {
    for (const dateStr of hoursDates(link, now)) {
      for (const { start: dayStartMs, end: dayEndMs } of dateOpenRanges(
        link,
        dateStr,
        isHoliday(dateStr),
      )) {
        if (Number.isNaN(dayStartMs) || Number.isNaN(dayEndMs)) continue;
        for (let t = dayStartMs; t + durMs <= dayEndMs; t += step) {
          if (t < now || t > windowEnd) continue;
          candidateStarts.set(t, t + durMs);
        }
      }
    }
  }
  if (link.slot_mode === "ranges" || link.slot_mode === "both") {
    for (const w of windows) {
      const ws = Date.parse(w.start_at);
      const we = Date.parse(w.end_at);
      if (Number.isNaN(ws) || Number.isNaN(we)) continue;
      for (let t = ws; t + durMs <= we; t += step) {
        if (t < now) continue;
        candidateStarts.set(t, t + durMs);
      }
    }
  }

  const byDay = new Map<string, ManagedSlot[]>();
  for (const [t, e] of [...candidateStarts.entries()].sort((a, b) => a[0] - b[0])) {
    const lock = locks.find((lk) =>
      overlaps(t, e, { start: Date.parse(lk.start_at), end: Date.parse(lk.end_at) }),
    );
    const guests = guestsBySlot.get(t) ?? [];
    let state: ManagedSlot["state"] = "free";
    if (guests.length > 0) state = "booked";
    else if (lock) state = "locked";
    else if (!isGroup && busy.some((b) => overlaps(t, e, b))) state = "busy";
    const slot: ManagedSlot = {
      start_at: new Date(t).toISOString(),
      end_at: new Date(e).toISOString(),
      state,
      guests,
      ...(isGroup ? { remaining: Math.max(0, capacity - guests.length) } : {}),
      ...(lock ? { lock_reason: lock.reason } : {}),
    };
    const dateStr = jstDateStr(new Date(t));
    if (!byDay.has(dateStr)) byDay.set(dateStr, []);
    byDay.get(dateStr)!.push(slot);
  }

  const days: ManagedDay[] = [];
  for (const [dateStr, slots] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dayOfWeek = new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();
    days.push({ date: dateStr, weekday: WEEKDAYS[dayOfWeek], slots });
  }
  return days;
}

// 枠ごとの確定予約数（残席計算用）
export async function fetchConfirmedCounts(
  linkId: string,
): Promise<Map<number, number>> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_reservations")
    .select("start_at")
    .eq("link_id", linkId)
    .eq("status", "confirmed");
  const map = new Map<number, number>();
  for (const r of data ?? []) {
    const t = Date.parse(r.start_at);
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
}

// 枠ごとの予約者名（調整さん風の名前公開用）
export async function fetchConfirmedGuests(
  linkId: string,
): Promise<Map<number, string[]>> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("booking_reservations")
    .select("start_at, guest_name, slot_seq")
    .eq("link_id", linkId)
    .eq("status", "confirmed")
    .order("slot_seq", { ascending: true });
  const map = new Map<number, string[]>();
  for (const r of data ?? []) {
    const t = Date.parse(r.start_at);
    if (!map.has(t)) map.set(t, []);
    map.get(t)!.push(r.guest_name);
  }
  return map;
}

// ============================================================
// サロン型: スタッフ単位の空き計算
// ============================================================
// 店の営業時間(day_hours) + 指定スタッフの Google 予定 + そのスタッフの
// 全予約 + 手動ロック から、メニュー所要(durationMin)で空き枠を出す。
export async function computeSalonAvailability(
  link: BookingLinkRow,
  opts: {
    staffId: string;
    durationMin: number;
    // スタッフ別営業時間（あればリンクの day_hours より優先）
    staffDayHours?: import("../types").DayHours | null;
  },
): Promise<DaySlots[]> {
  const { staffId, durationMin } = opts;
  // 営業時間はスタッフ個別（あれば）を優先。他の設定はリンク共通。
  const hoursLink = opts.staffDayHours
    ? ({ ...link, day_hours: opts.staffDayHours } as BookingLinkRow)
    : link;
  const now = Date.now();
  if (link.deadline_at && now > Date.parse(link.deadline_at)) return [];
  const noticeLimit = now + link.min_notice_hours * 60 * 60 * 1000;
  const windowEnd = bookingHorizon(link, now);
  const step =
    (link.slot_interval_min && link.slot_interval_min > 0
      ? link.slot_interval_min
      : durationMin) *
    60 *
    1000;
  const durMs = durationMin * 60 * 1000;
  const fromIso = new Date(now).toISOString();
  const toIso = new Date(windowEnd + 24 * 60 * 60 * 1000).toISOString();

  const busy = await collectBusy(link, fromIso, toIso, { staffId });
  const locks = await fetchLocks(link.id);
  const isHoliday = needsHolidayCheck(hoursLink) ? await makeHolidayChecker() : () => false;
  const isLocked = (s: number, e: number) =>
    locks.some((lk) =>
      overlaps(s, e, { start: Date.parse(lk.start_at), end: Date.parse(lk.end_at) }),
    );

  const byDay = new Map<string, Slot[]>();
  for (const dateStr of hoursDates(link, now)) {
    for (const { start: ds, end: de } of dateOpenRanges(hoursLink, dateStr, isHoliday(dateStr))) {
      if (Number.isNaN(ds) || Number.isNaN(de)) continue;
      for (let t = ds; t + durMs <= de; t += step) {
        if (t < noticeLimit || t > windowEnd) continue;
        const e = t + durMs;
        if (busy.some((b) => overlaps(t, e, b))) continue;
        if (isLocked(t, e)) continue;
        const d = jstDateStr(new Date(t));
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d)!.push({
          start_at: new Date(t).toISOString(),
          end_at: new Date(e).toISOString(),
        });
      }
    }
  }
  const days: DaySlots[] = [];
  for (const [d, slots] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dow = new Date(`${d}T12:00:00+09:00`).getUTCDay();
    days.push({ date: d, weekday: WEEKDAYS[dow], slots });
  }
  return days;
}

// 予約確定時の再検証（サロン型・スタッフ単位）
export async function isSalonSlotAvailable(
  link: BookingLinkRow,
  staffId: string,
  startAtIso: string,
  durationMin: number,
  opts?: {
    staffDayHours?: import("../types").DayHours | null;
    // 管理者の代理予約: 最短予約リード/締切/受付時間の制限を外し、重複だけ確認
    admin?: boolean;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const hoursLink = opts?.staffDayHours
    ? ({ ...link, day_hours: opts.staffDayHours } as BookingLinkRow)
    : link;
  const admin = opts?.admin ?? false;
  const startMs = Date.parse(startAtIso);
  if (Number.isNaN(startMs)) return { ok: false, reason: "日時が不正です" };
  const endMs = startMs + durationMin * 60 * 1000;
  const now = Date.now();
  if (!admin && link.deadline_at && now > Date.parse(link.deadline_at)) {
    return { ok: false, reason: "予約の受付を締め切りました" };
  }
  if (!admin && startMs < now + link.min_notice_hours * 60 * 60 * 1000) {
    return { ok: false, reason: "直前の予約はできません。別の枠をお選びください" };
  }
  const step =
    (link.slot_interval_min && link.slot_interval_min > 0
      ? link.slot_interval_min
      : durationMin) *
    60 *
    1000;
  // 代理予約(admin)は受付時間・期間・グリッドの制約を外し、重複のみ確認する
  if (!admin) {
    const dateStr = jstDateStr(new Date(startMs));
    const withinHorizon = startMs <= bookingHorizon(link, now);
    const withinPeriod =
      !link.period_start ||
      !link.period_end ||
      (dateStr >= link.period_start && dateStr <= link.period_end);
    const isHoliday = needsHolidayCheck(hoursLink) ? await makeHolidayChecker() : () => false;
    let onGrid = false;
    if (withinHorizon && withinPeriod) {
      for (const { start: ds, end: de } of dateOpenRanges(hoursLink, dateStr, isHoliday(dateStr))) {
        if (startMs >= ds && endMs <= de && (startMs - ds) % step === 0) {
          onGrid = true;
          break;
        }
      }
    }
    if (!onGrid) return { ok: false, reason: "受付時間外です" };
  }

  const locks = await fetchLocks(link.id);
  if (
    locks.some((lk) =>
      overlaps(startMs, endMs, {
        start: Date.parse(lk.start_at),
        end: Date.parse(lk.end_at),
      }),
    )
  ) {
    return { ok: false, reason: "その枠は受付を停止しています。別の枠をお選びください" };
  }
  const busy = await collectBusy(
    link,
    new Date(startMs - 1).toISOString(),
    new Date(endMs + 1).toISOString(),
    { staffId },
  );
  if (busy.some((b) => overlaps(startMs, endMs, b))) {
    return { ok: false, reason: "その時間はちょうど埋まってしまいました。別の枠をお選びください" };
  }
  return { ok: true };
}
