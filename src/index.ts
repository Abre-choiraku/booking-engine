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
  notifyReservationReminder,
  createEmailNotifyAdapter,
  createVailsNotifyAdapter,
} from "./notify";
export type { EmailNotifyOptions, VailsNotifyOptions } from "./notify";

// Google カレンダー連携
export {
  buildAuthUrl,
  exchangeAndSave,
  getAuthedClientForUser,
  getAuthedClientAndCalendar,
  getCalendarIdForUser,
  setCalendarId,
  normalizeCalendarId,
  DEFAULT_CALENDAR_ID,
  disconnectUser,
  getConnectionStatus,
  getOAuth2Client,
} from "./google/oauth";
export { encryptToken, decryptToken } from "./google/crypto";
export {
  getOwnerCalendar,
  getOwnerCalendarTarget,
  getOwnerBusyTimes,
  verifyCalendarAccess,
} from "./google/calendar";
export type { CalendarAccessError } from "./google/calendar";
// スタッフごとの Google カレンダー連携
export {
  getStaffCalendarTarget,
  getStaffTokenUserId,
  deleteStaffEvent,
  listStaffGoogleStatuses,
  getStaffGoogleStatus,
  linkStaffGoogleAccount,
  disconnectStaffGoogle,
} from "./google/staff-calendar";
export type {
  StaffCalendarTarget,
  StaffGoogleState,
  StaffGoogleStatus,
} from "./google/staff-calendar";

// Zoom 連携（per-owner OAuth ＋ 旧 S2S）
export {
  createZoomMeeting,
  deleteZoomMeeting,
  createZoomMeetingForUser,
  deleteZoomMeetingForUser,
} from "./zoom";
export type { ZoomMeeting } from "./zoom";
export {
  buildZoomAuthUrl,
  exchangeAndSaveZoom,
  getZoomAccessTokenForUser,
  disconnectZoomUser,
  getZoomConnectionStatus,
} from "./zoom/oauth";

// 管理側 repo
export * as bookingLinks from "./repo/booking-links";
export * as schedulePolls from "./repo/schedule-polls";
export * as brands from "./repo/brands";
export type { TenantBrand } from "./repo/brands";
export * as salon from "./repo/salon";
export type { Staff, Menu } from "./types";
export * as owners from "./repo/owners";
export type { OwnerUser } from "./repo/owners";
export * as reservations from "./repo/reservations";
// 改善要望（利用者フィードバック）
export * as improvements from "./repo/improvements";
export type {
  ImprovementRequest,
  ImprovementCategory,
  ImprovementStatus,
} from "./repo/improvements";
export type { OwnerReservation } from "./repo/reservations";
