import { serviceClient } from "../config";
import type { NotifyAdapter, NotifyPayload } from "../config";
import { getBrand } from "../repo/brands";

// 差出人を組み立てる。屋号（ブランド表示名）があれば表示名に使い、
// メールアドレス部分は MAIL_FROM（認証済ドメイン）から流用する。
async function resolveFrom(ownerId: string, fallback?: string): Promise<string | undefined> {
  const base = fallback ?? process.env.MAIL_FROM ?? "予約 <onboarding@resend.dev>";
  try {
    const brand = await getBrand(ownerId);
    const name = brand?.display_name?.trim();
    if (!name) return base;
    const m = base.match(/<([^>]+)>/);
    const addr = m ? m[1] : base;
    return `${name} <${addr}>`;
  } catch {
    return base;
  }
}

// ============================================================
// 予約メール通知（Resend）— standalone モードの NotifyAdapter
// ============================================================
// RESEND_API_KEY が未設定の間は送信せずログのみ（予約機能自体は動く）。
// 有効化手順:
//   1. https://resend.com でアカウント作成（無料枠 100通/日）
//   2. API Key を発行 → 環境変数 RESEND_API_KEY に設定
//   3. 差出人: 独自ドメインを Resend で認証して MAIL_FROM に設定
// 送信失敗はログに残すが予約は成立させる。
// ============================================================

export interface EmailNotifyOptions {
  // 差出人。省略時は MAIL_FROM env → テスト用アドレス。
  from?: string;
  // 主催者宛メールに載せる管理画面 URL（省略可）。
  ownerDashboardUrl?: string;
}

function jstRange(startIso: string, endIso: string): string {
  const d = new Date(startIso);
  const dateStr = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(d);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d) + "T12:00:00+09:00",
    ).getUTCDay()
  ];
  const time = (iso: string) =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  return `${dateStr}（${wd}） ${time(startIso)} 〜 ${time(endIso)}`;
}

async function resendSend(
  to: string,
  subject: string,
  text: string,
  from?: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[mail skipped: RESEND_API_KEY 未設定] to=${to} subject=${subject}`);
    return false;
  }
  const sender = from ?? process.env.MAIL_FROM ?? "予約 <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: sender, to: [to], subject, text }),
  });
  if (!res.ok) {
    console.error(`mail send failed (${res.status}):`, (await res.text()).slice(0, 300));
    return false;
  }
  return true;
}

// 主催者のメールアドレスを取得（service role がある場合のみ）
async function getOwnerEmail(ownerUserId: string): Promise<string | null> {
  const admin = serviceClient();
  if (!admin) return null;
  try {
    const { data } = await admin.auth.admin.getUserById(ownerUserId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

// メール通知アダプタを生成する。standalone アプリの configureBookingEngine に渡す。
export function createEmailNotifyAdapter(opts: EmailNotifyOptions = {}): NotifyAdapter {
  return {
    async reservationConfirmed(input: NotifyPayload) {
      const when = jstRange(input.startIso, input.endIso);
      const from = await resolveFrom(input.link.owner_user_id, opts.from);
      // --- 予約者宛 ---
      if (input.guestEmail) {
        const lines: string[] = [];
        lines.push(`${input.guestName} 様`);
        lines.push("");
        lines.push(`「${input.link.title}」のご予約が確定しました。`);
        lines.push("");
        lines.push(`■ 日時: ${when}`);
        if (input.link.location) lines.push(`■ 場所: ${input.link.location}`);
        if (input.meetUrl) lines.push(`■ Web会議: ${input.meetUrl}`);
        if (input.link.description) {
          lines.push("");
          lines.push(input.link.description);
        }
        if (input.cancelUrl) {
          lines.push("");
          lines.push(`キャンセルはこちら（${input.link.cancel_deadline_hours}時間前まで）:`);
          lines.push(input.cancelUrl);
        }
        await resendSend(
          input.guestEmail,
          `【ご予約確定】${input.link.title} - ${when}`,
          lines.join("\n"),
          from,
        );
      }
      // --- 主催者宛 ---
      const ownerEmail = await getOwnerEmail(input.link.owner_user_id);
      if (ownerEmail) {
        await resendSend(
          ownerEmail,
          `【予約が入りました】${input.link.title} - ${when}`,
          [
            `${input.guestName} 様から予約が入りました。`,
            "",
            `■ 日時: ${when}`,
            input.guestEmail ? `■ メール: ${input.guestEmail}` : null,
            input.meetUrl ? `■ Web会議: ${input.meetUrl}` : null,
            opts.ownerDashboardUrl ? "" : null,
            opts.ownerDashboardUrl ? `詳細: ${opts.ownerDashboardUrl}` : null,
          ]
            .filter((v) => v !== null)
            .join("\n"),
          from,
        );
      }
    },

    async reservationCancelled(input: NotifyPayload) {
      const when = jstRange(input.startIso, input.endIso);
      const from = await resolveFrom(input.link.owner_user_id, opts.from);
      if (input.guestEmail) {
        await resendSend(
          input.guestEmail,
          `【キャンセル完了】${input.link.title} - ${when}`,
          [
            `${input.guestName} 様`,
            "",
            `「${input.link.title}」（${when}）のご予約をキャンセルしました。`,
            "改めてのご予約をご希望の場合は、お手数ですが予約ページから再度お手続きください。",
          ].join("\n"),
          from,
        );
      }
      const ownerEmail = await getOwnerEmail(input.link.owner_user_id);
      if (ownerEmail) {
        await resendSend(
          ownerEmail,
          `【予約キャンセル】${input.link.title} - ${when}`,
          [
            `${input.guestName} 様の予約がキャンセルされました。`,
            "",
            `■ 日時: ${when}（枠は解放されました）`,
          ].join("\n"),
          from,
        );
      }
    },

    async reservationReminder(input: NotifyPayload) {
      if (!input.guestEmail) return; // メール未登録者にはリマインドできない
      const when = jstRange(input.startIso, input.endIso);
      const from = await resolveFrom(input.link.owner_user_id, opts.from);
      const lines: string[] = [];
      lines.push(`${input.guestName} 様`);
      lines.push("");
      lines.push(`ご予約の日時が近づきましたのでお知らせします。`);
      lines.push("");
      // 事業者が設定した任意の案内文（リマインド固有→リンク共通の順で解決済み）
      const rmsg = (input.reminderMessage ?? input.link.reminder_message)?.trim();
      if (rmsg) {
        lines.push(rmsg);
        lines.push("");
      }
      lines.push(`■ ${input.link.title}`);
      lines.push(`■ 日時: ${when}`);
      if (input.link.location) lines.push(`■ 場所: ${input.link.location}`);
      if (input.meetUrl) lines.push(`■ Web会議: ${input.meetUrl}`);
      if (input.cancelUrl) {
        lines.push("");
        lines.push(`ご都合が悪くなった場合のキャンセルはこちら（${input.link.cancel_deadline_hours}時間前まで）:`);
        lines.push(input.cancelUrl);
      }
      await resendSend(
        input.guestEmail,
        `【ご予約リマインド】${input.link.title} - ${when}`,
        lines.join("\n"),
        from,
      );
    },
  };
}
