// ============================================================
// API route handler ファクトリ
// ============================================================
// 各アプリは薄い re-export でマウントする。例:
//   // app/api/booking/[token]/slots/route.ts
//   import { createSlotsHandler } from "@sheals/booking-engine/api";
//   export const GET = createSlotsHandler();
// ============================================================

export { createSlotsHandler } from "./slots";
export { createReserveHandler } from "./reserve";
export { createCancelInfoHandler, createCancelHandler } from "./cancel";
export { createManageHandler } from "./manage";
export type { ManageHandlerOptions } from "./manage";
export {
  createScheduleDataHandler,
  createScheduleRespondHandler,
} from "./schedule";
