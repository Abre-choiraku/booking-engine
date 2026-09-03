import type { NotifyAdapter, NotifyPayload } from "../config";

// ============================================================
// VAILS（LINE運用管理）連携アダプタ — KICKOFF「lineモード」Phase 3 実装
// ============================================================
// 予約者が LINE 経由（lineFriendId あり）の場合、VAILS の Webhook に
// イベントを POST する。VAILS 側でタグ付与・LINEプッシュ（確定/リマインド/
// キャンセル）・シナリオ発火を行う。
// lineFriendId が無い予約は fallback（メール等）へそのまま委譲する。
// Webhook 失敗でも予約は巻き戻さない（呼び出し元が例外を握る設計を踏襲し、
// ここでも fallback は必ず試みる）。
// ============================================================

export interface VailsNotifyOptions {
  webhookUrl: string; // 例: https://<vails>/api/koroai/webhook
  secret: string;     // VAILS 側 KOROAI_WEBHOOK_SECRET と一致させる
  fallback?: NotifyAdapter; // lineFriendId が無い予約用（通常はメールアダプタ）
}

async function postEvent(
  opts: VailsNotifyOptions,
  event: "reservation.confirmed" | "reservation.cancelled" | "reservation.reminder",
  payload: NotifyPayload,
): Promise<void> {
  const res = await fetch(opts.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-koroai-secret": opts.secret,
    },
    body: JSON.stringify({
      event,
      // ★どのアカウントの予約かを「イベント自身」に必ず載せる（2026-09-02）。
      //   これが無いと VAILS 側は「その人が友だちになっているアカウント」から
      //   送信元を推測するしかなく、同じ人が2アカウントの友だちになった瞬間に
      //   別のお店の回線から通知が出る。100アカウント運用では確実に起きる。
      //   ・clientId      … 予約ページに焼き付けた VAILS のアカウントID（最優先）
      //   ・ownerUserId   … 予約システム側の店舗ID（VAILS の clients と1:1）
      clientId: payload.link?.partner_client_id ?? null,
      ownerUserId: payload.link?.owner_user_id ?? null,
      lineUserId: payload.lineFriendId,
      linkTitle: payload.link?.title ?? "",
      baseTitle: payload.baseTitle ?? payload.link?.title ?? "",
      location: payload.link?.location ?? null,
      guestName: payload.guestName,
      startIso: payload.startIso,
      endIso: payload.endIso,
      meetUrl: payload.meetUrl,
      cancelUrl: payload.cancelUrl,
      reminderMessage: payload.reminderMessage ?? null,
    }),
  });
  if (!res.ok) {
    // ★VAILS は「なぜ送れなかったか」を本文の error に日本語で返してくる（2026-09-04）。
    //   HTTP番号だけだと予約システム側の運用者には何のことか分からないので、
    //   理由をそのまま持ち帰って記録・画面表示に使う。
    throw new Error(`${await readReason(res)}（VAILS ${event} HTTP ${res.status}）`);
  }
}

/** VAILS が返したエラー本文から、人が読める理由を取り出す（読めなければ既定文） */
async function readReason(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text) {
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j?.error) return String(j.error).slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    }
  } catch {
    // 本文が読めなくても既定文で続ける
  }
  return "LINEへの通知が受け付けられませんでした";
}

export function createVailsNotifyAdapter(opts: VailsNotifyOptions): NotifyAdapter {
  return {
    async reservationConfirmed(payload: NotifyPayload): Promise<void> {
      if (payload.lineFriendId) {
        await postEvent(opts, "reservation.confirmed", payload);
        return;
      }
      await opts.fallback?.reservationConfirmed(payload);
    },
    async reservationCancelled(payload: NotifyPayload): Promise<void> {
      if (payload.lineFriendId) {
        await postEvent(opts, "reservation.cancelled", payload);
        return;
      }
      await opts.fallback?.reservationCancelled(payload);
    },
    async reservationReminder(payload: NotifyPayload): Promise<void> {
      if (payload.lineFriendId) {
        await postEvent(opts, "reservation.reminder", payload);
        return;
      }
      await opts.fallback?.reservationReminder?.(payload);
    },
  };
}
