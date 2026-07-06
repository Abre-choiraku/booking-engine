// ============================================================
// @sheals/booking-engine — 予約・日程調整の共有エンジン
// ============================================================
// SHEALS ops / 単体予約アプリ / VAILS(LINE) が共通で読み込む核。
// 各アプリは起動時に configureBookingEngine({...}) でアダプタを差し込む。
//
//   import { configureBookingEngine, createEmailNotifyAdapter } from "@sheals/booking-engine";
//   configureBookingEngine({
//     projectsEnabled: false,
//     notify: createEmailNotifyAdapter({ ownerDashboardUrl: "..." }),
//     // calendar / auth は必要に応じて差し込む
//   });
// ============================================================

// 型
export * from "./types";

// 設定・アダプタ
export {
  configureBookingEngine,
  getEngineConfig,
  anonClient,
  serviceClient,
  projectsEnabled,
  resolveCalendar,
  resolveNotify,
  resolveAuth,
  resolveHooks,
} from "./config";
export type {
  EngineConfig,
  AuthAdapter,
  NotifyAdapter,
  NotifyPayload,
  CalendarAdapter,
  ReservationHooks,
} from "./config";

// 空き計算エンジン（核）
export {
  computeAvailability,
  isSlotAvailable,
  collectBusy,
  enumerateSlotsForManagement,
  fetchWindows,
  fetchLocks,
  fetchConfirmedCounts,
  fetchConfirmedGuests,
  slotCapacity,
  effectiveSyncBusy,
} from "./core/availability";

// 通知（ディスパッチャ + メールアダプタ）
export {
  notifyReservationConfirmed,
  notifyReservationCancelled,
  createEmailNotifyAdapter,
} from "./notify";
export type { EmailNotifyOptions } from "./notify";

// Google カレンダー連携
export {
  buildAuthUrl,
  exchangeAndSave,
  getAuthedClientForUser,
  disconnectUser,
  getConnectionStatus,
  getOAuth2Client,
} from "./google/oauth";
export { encryptToken, decryptToken } from "./google/crypto";

// 管理側 repo
export * as bookingLinks from "./repo/booking-links";
export * as schedulePolls from "./repo/schedule-polls";
