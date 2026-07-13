import { resolveNotify } from "../config";
import type { NotifyPayload } from "../config";

// ============================================================
// 通知ディスパッチャ（本人特定＋通知の唯一の差し込み口）
// ============================================================
// KICKOFF セクション5「通知アダプタ」に相当。
// 予約確定・キャンセル時に、設定された NotifyAdapter を呼ぶ1関数に集約する。
//   standalone → createEmailNotifyAdapter（メール）
//   line       → VAILS プッシュのアダプタ（Phase 3 で実装）
// アダプタ未設定なら何もしない（予約自体は成立させる）。
// 通知失敗が予約を巻き戻さないよう、例外は内部で握りつぶしてログのみ。
// ============================================================

export type { NotifyPayload, NotifyAdapter } from "../config";
export { createEmailNotifyAdapter } from "./email";
export type { EmailNotifyOptions } from "./email";

export async function notifyReservationConfirmed(payload: NotifyPayload): Promise<void> {
  const adapter = resolveNotify();
  if (!adapter) return;
  try {
    await adapter.reservationConfirmed(payload);
  } catch (e) {
    console.error("notifyReservationConfirmed failed:", (e as Error).message);
  }
}

export async function notifyReservationCancelled(payload: NotifyPayload): Promise<void> {
  const adapter = resolveNotify();
  if (!adapter) return;
  try {
    await adapter.reservationCancelled(payload);
  } catch (e) {
    console.error("notifyReservationCancelled failed:", (e as Error).message);
  }
}

export async function notifyReservationReminder(payload: NotifyPayload): Promise<void> {
  const adapter = resolveNotify();
  if (!adapter?.reservationReminder) return;
  try {
    await adapter.reservationReminder(payload);
  } catch (e) {
    console.error("notifyReservationReminder failed:", (e as Error).message);
  }
}
