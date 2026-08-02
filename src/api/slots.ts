import { NextRequest, NextResponse } from "next/server";
import { anonClient } from "../config";
import {
  computeAvailability,
  fetchWindows,
  fetchConfirmedGuests,
  slotCapacity,
} from "../core/availability";
import { getBrand } from "../repo/brands";
import type { BookingLinkRow } from "../types";

// ============================================================
// 予約リンク 空き枠取得（ログイン不要）
// ============================================================
// アプリ側は薄い re-export でマウントする:
//   export const GET = createSlotsHandler();
// ============================================================

export function createSlotsHandler() {
  return async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
  ) {
    const { token } = await params;
    const supabase = anonClient();

    const { data: link, error } = await supabase
      .from("booking_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
    }
    if (!link) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const l = link as BookingLinkRow;
    const brand = await getBrand(l.owner_user_id);
    const deadlinePassed = !!l.deadline_at && Date.now() > Date.parse(l.deadline_at);
    if (l.status !== "active" || deadlinePassed) {
      return NextResponse.json({
        title: l.title,
        description: l.description,
        location: l.location,
        duration_min: l.duration_min,
        meeting_type: l.meeting_type,
        status: deadlinePassed ? "closed" : l.status,
        brand,
        days: [],
      });
    }

    const windows =
      l.slot_mode === "ranges" || l.slot_mode === "both" ? await fetchWindows(l.id) : [];
    // hours/ranges/both は予約不可枠も✕で表示（computeAvailability 内で判定）
    const days = await computeAvailability(l, windows);

    // 予約者名の付与（show_guest_names が ON のリンクのみ）
    let daysWithGuests = days as (typeof days[number] & {
      slots: (typeof days[number]["slots"][number] & { guests?: string[] })[];
    })[];
    if (l.show_guest_names) {
      const guests = await fetchConfirmedGuests(l.id);
      daysWithGuests = days.map((d) => ({
        ...d,
        slots: d.slots.map((s) => ({
          ...s,
          guests: guests.get(Date.parse(s.start_at)) ?? [],
        })),
      }));
    }

    return NextResponse.json({
      title: l.title,
      description: l.description,
      location: l.location,
      header_image_url: (l as { header_image_url?: string | null }).header_image_url ?? null,
      duration_min: l.duration_min,
      meeting_type: l.meeting_type,
      link_type: l.link_type,
      capacity: slotCapacity(l),
      show_guest_names: l.show_guest_names,
      default_view: (l as { default_view?: string }).default_view ?? "week",
      email_mode: l.email_mode ?? "optional",
      phone_mode: l.phone_mode ?? "optional",
      custom_fields: l.custom_fields ?? [],
      status: l.status,
      brand,
      days: daysWithGuests,
    });
  };
}
