import type { ReminderConfig } from "../types";

// ============================================================
// リマインドの既定値・既定文・送信時刻（DBに触らない純粋な計算だけ）
// ============================================================
// 管理画面（クライアント側）からも読むので、ここには supabase 等を持ち込まない。
// 画面の入力欄に薄く出す文章と、実際に送る文章を同じ関数から作ることで、
// 「画面で見た文と届いた文が違う」を起こさない。
// ============================================================

/** 予約リンクを新しく作るときの初期リマインド（1日前の9:00 ＋ 当日の1時間前） */
export const DEFAULT_REMINDERS: ReminderConfig[] = [
  { kind: "at", days_before: 1, time: "09:00" },
  { kind: "before", hours: 1 },
];

// 「◯時間前」がこの時間以内なら「まもなく」の文にする
const SOON_HOURS = 3;

export type ReminderMessageOptions = {
  /** Web会議（Zoom / Google Meet）の予約リンクか */
  online: boolean;
  /** 送信時に会議URLを実際に持っているか。画面の見本では省略（＝ある前提） */
  hasUrl?: boolean;
  /** 「場所・住所」が入っているか。空なら来店とは限らない（電話相談など）ので「お越しください」と書かない */
  hasPlace?: boolean;
};

const CONTACT_LINE = "ご都合が悪くなった場合は、お早めにご連絡ください。";

/**
 * 案内文を何も設定しなかったときに送る文章。
 * タイミング（前日／当日／直前）と、Web会議かどうかで言い回しを変える。
 * 設定だけで決まる（予約ごとに変わらない）ので、画面の入力欄にもそのまま出せる。
 */
export function defaultReminderMessage(
  c: ReminderConfig,
  opts: ReminderMessageOptions,
): string {
  // ・Web会議: メールはURLが文の下、LINEは文の上に出るので「下記の」とは書かない。
  //   URLを発行できなかった予約には URL と書かない。
  // ・来店: 場所が空の予約（電話相談など）には「お越しください」と書かない。
  const joinLine = opts.online
    ? opts.hasUrl === false
      ? "開始時刻になりましたら、ご案内済みの方法でご参加ください。"
      : "開始時刻になりましたら、ご案内のURLからご参加ください。"
    : opts.hasPlace === false
      ? "どうぞよろしくお願いいたします。"
      : "お気をつけてお越しください。";
  if (c.kind === "before") {
    if (c.hours <= SOON_HOURS) {
      return ["まもなくご予約のお時間です。", joinLine].join("\n");
    }
    return ["ご予約のお時間が近づいてまいりました。", CONTACT_LINE].join("\n");
  }
  const days = Number.isFinite(c.days_before) ? c.days_before : 0;
  if (days <= 0) {
    return ["本日はご予約日です。", joinLine].join("\n");
  }
  if (days === 1) {
    return [
      "明日はご予約日です。",
      "お会いできるのを楽しみにしております。",
      CONTACT_LINE,
    ].join("\n");
  }
  return ["ご予約日が近づいてまいりました。", CONTACT_LINE].join("\n");
}

/** 実際に送る案内文。個別メッセージ → リンク共通の案内文 → 既定文 の順で決める */
export function resolveReminderMessage(
  c: ReminderConfig,
  linkMessage: string | null | undefined,
  opts: ReminderMessageOptions,
): string {
  return c.message?.trim() || linkMessage?.trim() || defaultReminderMessage(c, opts);
}

// リマインド1件の送信時刻(UTC ms)を計算。JST基準。無効なら null。
export function reminderFireTime(c: ReminderConfig, startMs: number): number | null {
  if (c.kind === "before") {
    if (!c.hours || c.hours <= 0) return null;
    return startMs - c.hours * 60 * 60 * 1000;
  }
  // kind === "at": 予約日(JST)の days_before 日前、その日の time(HH:MM, JST) に送る
  const JST = 9 * 60 * 60 * 1000;
  const jst = new Date(startMs + JST); // UTCゲッターでJSTの年月日が読める
  const y = jst.getUTCFullYear();
  const mo = jst.getUTCMonth();
  const d = jst.getUTCDate();
  const parts = (c.time || "09:00").split(":");
  let hh = parseInt(parts[0], 10);
  let mm = parseInt(parts[1], 10);
  if (!Number.isFinite(hh)) hh = 9;
  if (!Number.isFinite(mm)) mm = 0;
  const days = Number.isFinite(c.days_before) ? c.days_before : 0;
  // 予約日の 00:00 JST を UTC ms で表す（= Date.UTC(...) - 9h）
  const dayStartJstUtcMs = Date.UTC(y, mo, d, 0, 0, 0) - JST;
  return (
    dayStartJstUtcMs -
    days * 24 * 60 * 60 * 1000 +
    (hh * 60 + mm) * 60 * 1000
  );
}
