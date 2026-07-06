import { NextRequest, NextResponse } from "next/server";
import { anonClient } from "../config";
import { enumerateSlotsForManagement, fetchWindows } from "../core/availability";
import type { BookingLinkRow } from "../types";

// ============================================================
// 予約リンク管理: 枠一覧（状態付き・要ログイン）
// ============================================================
// 手動ロック / 代理予約 UI 用に、全候補枠を
// 空き / 予約あり / ロック / 予定あり の状態付きで返す。
//
// 認証はアプリ依存なので authorize アダプタで差し込む:
//   export const GET = createManageHandler({ authorize: async (req) => {...} });
// authorize 省略時はガードなし（アプリが別途保護する前提）。
// ============================================================

export interface ManageHandlerOptions {
  // true を返せば許可。false なら 403。省略時はガードなし。
  authorize?: (request: NextRequest) => Promise<boolean>;
}

export function createManageHandler(options: ManageHandlerOptions = {}) {
  return async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ linkId: string }> },
  ) {
    if (options.authorize) {
      const ok = await options.authorize(request);
      if (!ok) {
        return NextResponse.json({ error: "権限がありません" }, { status: 403 });
      }
    }

    const { linkId } = await params;
    const supabase = anonClient();
    const { data: link } = await supabase
      .from("booking_links")
      .select("*")
      .eq("id", linkId)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const l = link as BookingLinkRow;
    const windows =
      l.slot_mode === "ranges" || l.slot_mode === "both" ? await fetchWindows(l.id) : [];
    const days = await enumerateSlotsForManagement(l, windows);
    return NextResponse.json({ token: (link as { token: string }).token, days });
  };
}
