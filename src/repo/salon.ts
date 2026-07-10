import { anonClient } from "../config";
import type { Staff, Menu } from "../types";

// ============================================================
// サロン型: スタッフ / メニュー / 紐づけ 管理
// ============================================================
// すべて owner_user_id（サロン）でスコープ。
// スタッフの Google 連携は google_auth_tokens を staff.id で再利用。
// ============================================================

export type { Staff, Menu } from "../types";

// ---- スタッフ ----
export async function listStaff(ownerId: string): Promise<Staff[]> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("staff")
    .select("*")
    .eq("owner_user_id", ownerId)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Staff[];
}

export async function createStaff(input: {
  ownerId: string;
  name: string;
  displayOrder?: number;
}): Promise<Staff> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("staff")
    .insert({
      owner_user_id: input.ownerId,
      name: input.name,
      display_order: input.displayOrder ?? 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Staff;
}

export async function updateStaff(
  id: string,
  ownerId: string,
  patch: { name?: string; active?: boolean; display_order?: number },
): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("staff")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

export async function deleteStaff(id: string, ownerId: string): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("staff")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

// 本人所有のスタッフ1件（未所有は null）
export async function getStaff(id: string, ownerId: string): Promise<Staff | null> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("staff")
    .select("*")
    .eq("id", id)
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  return (data as Staff) ?? null;
}

// ---- メニュー ----
// メニュー1件（ownerId 指定でその所有者のもののみ）
export async function getMenu(id: string, ownerId?: string): Promise<Menu | null> {
  const supabase = anonClient();
  let q = supabase.from("menus").select("*").eq("id", id);
  if (ownerId) q = q.eq("owner_user_id", ownerId);
  const { data } = await q.maybeSingle();
  return (data as Menu) ?? null;
}

// スタッフがそのメニューに対応しているか
export async function staffHandlesMenu(staffId: string, menuId: string): Promise<boolean> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("staff_menus")
    .select("staff_id")
    .eq("staff_id", staffId)
    .eq("menu_id", menuId)
    .maybeSingle();
  return !!data;
}

export async function listMenus(ownerId: string): Promise<Menu[]> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("menus")
    .select("*")
    .eq("owner_user_id", ownerId)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Menu[];
}

export async function createMenu(input: {
  ownerId: string;
  name: string;
  durationMin: number;
  price?: number | null;
  description?: string | null;
  displayOrder?: number;
}): Promise<Menu> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("menus")
    .insert({
      owner_user_id: input.ownerId,
      name: input.name,
      duration_min: input.durationMin,
      price: input.price ?? null,
      description: input.description ?? null,
      display_order: input.displayOrder ?? 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Menu;
}

export async function updateMenu(
  id: string,
  ownerId: string,
  patch: {
    name?: string;
    duration_min?: number;
    price?: number | null;
    description?: string | null;
    active?: boolean;
    display_order?: number;
  },
): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("menus")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

export async function deleteMenu(id: string, ownerId: string): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("menus")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

// ---- スタッフ×メニュー 紐づけ ----

// あるスタッフが対応するメニューID一覧
export async function getStaffMenuIds(staffId: string): Promise<string[]> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("staff_menus")
    .select("menu_id")
    .eq("staff_id", staffId);
  return (data ?? []).map((r) => r.menu_id as string);
}

// スタッフの対応メニューを一括設定（差し替え）
export async function setStaffMenus(staffId: string, menuIds: string[]): Promise<void> {
  const supabase = anonClient();
  await supabase.from("staff_menus").delete().eq("staff_id", staffId);
  if (menuIds.length > 0) {
    const { error } = await supabase
      .from("staff_menus")
      .insert(menuIds.map((menu_id) => ({ staff_id: staffId, menu_id })));
    if (error) throw error;
  }
}

// あるメニューに対応できる（稼働中の）スタッフ一覧
export async function listStaffForMenu(
  ownerId: string,
  menuId: string,
): Promise<Staff[]> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("staff_menus")
    .select("staff:staff!inner(*)")
    .eq("menu_id", menuId);
  const rows = (data ?? []) as unknown as { staff: Staff }[];
  return rows
    .map((r) => r.staff)
    .filter((s) => s && s.owner_user_id === ownerId && s.active)
    .sort((a, b) => a.display_order - b.display_order);
}

// 全スタッフ + 各自の対応メニューID（管理一覧用）
export async function listStaffWithMenus(
  ownerId: string,
): Promise<(Staff & { menu_ids: string[] })[]> {
  const staff = await listStaff(ownerId);
  const supabase = anonClient();
  const { data } = await supabase.from("staff_menus").select("staff_id, menu_id");
  const map = new Map<string, string[]>();
  for (const r of (data ?? []) as { staff_id: string; menu_id: string }[]) {
    if (!map.has(r.staff_id)) map.set(r.staff_id, []);
    map.get(r.staff_id)!.push(r.menu_id);
  }
  return staff.map((s) => ({ ...s, menu_ids: map.get(s.id) ?? [] }));
}
