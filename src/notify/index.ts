import { resolveNotify } from "../config";
import type { NotifyPayload } from "../config";

// ============================================================
// 通知ディスパッチャ（本人特定＋通知の唯一の差し込み口）
// ============================================================
// KICKOFF セクション5「通知アダプタ」に相当。
// 予約確定・キャンセル時に、設定された NotifyAdapter を呼ぶ1関数に集約する。
//   standalone → createEmailNotifyAdapter（メール）
//   line       → VAILS プッシュのアダプタ
// アダプタ未設定なら何もしない（予約自体は成立させる）。
//
// ★2026-09-04: 失敗を握りつぶすのをやめた。
//   以前は try/catch で console.error を出すだけの void 関数だったため、
//   VAILS が「回線が決まらないので送りませんでした」と 502 を返しても
//   予約システム側には何も残らず、運用者からは完全な成功に見えていた。
//   VAILS 側の S3（失敗が黙って消えない）と同じ考え方に揃える:
//     ・送る関数は void を返さない（void ＝ 失敗を伝える気が無い、の印）
//     ・結果は NotifyOutcome で必ず返す
//     ・通知の失敗で予約そのものは巻き戻さない（ここは従来どおり）
//   記録するのは呼び出し元（予約IDを知っているのは呼び出し元だけのため）。
// ============================================================

export type { NotifyPayload, NotifyAdapter } from "../config";
export { createEmailNotifyAdapter } from "./email";
export type { EmailNotifyOptions } from "./email";
export { createVailsNotifyAdapter } from "./vails";
export type { VailsNotifyOptions } from "./vails";

/** 通知1回分の結果。ok=false のときだけ error に理由が入る */
export interface NotifyOutcome {
  ok: boolean;
  /** 人が読める失敗理由（記録・画面表示に使う） */
  error?: string;
  /** 通知アダプタが設定されておらず、そもそも送る先が無かった */
  skipped?: boolean;
}

function failure(label: string, e: unknown): NotifyOutcome {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`${label} failed:`, message);
  return { ok: false, error: message };
}

export async function notifyReservationConfirmed(payload: NotifyPayload): Promise<NotifyOutcome> {
  const adapter = resolveNotify();
  if (!adapter) return { ok: true, skipped: true };
  try {
    await adapter.reservationConfirmed(payload);
    return { ok: true };
  } catch (e) {
    return failure("notifyReservationConfirmed", e);
  }
}

export async function notifyReservationCancelled(payload: NotifyPayload): Promise<NotifyOutcome> {
  const adapter = resolveNotify();
  if (!adapter) return { ok: true, skipped: true };
  try {
    await adapter.reservationCancelled(payload);
    return { ok: true };
  } catch (e) {
    return failure("notifyReservationCancelled", e);
  }
}

export async function notifyReservationReminder(payload: NotifyPayload): Promise<NotifyOutcome> {
  const adapter = resolveNotify();
  if (!adapter?.reservationReminder) return { ok: true, skipped: true };
  try {
    await adapter.reservationReminder(payload);
    return { ok: true };
  } catch (e) {
    return failure("notifyReservationReminder", e);
  }
}
