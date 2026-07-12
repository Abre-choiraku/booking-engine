import { anonClient, serviceClient } from "../config";
import type { Staff, Menu, MenuOption } from "../types";

// ============================================================
// サロン型: スタッフ / メニュー / 紐づけ 管理
// ============================================================
// すべて owner_user_id（サロン）でスコープ。
// スタッフの Google 連携は google_auth_tokens を staff.id で再利用。
// ============================================================

export type { Staff, Menu, MenuOption } from "../types";

// 画像を salon-images バケットにアップロードして公開URLを返す（service role 必須）
export async function uploadSalonImage(input: {
  kind: "menu" | "staff";
  id: string;
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}): Promise<string> {
  const admin = serviceClient();
  if (!admin) throw new Error("画像アップロードには SUPABASE_SERVICE_ROLE_KEY が必要です");
  const path = `${input.kind}/${input.id}.${input.ext}`;
  const { error } = await admin.storage
    .from("salon-images")
    .upload(path, input.bytes, { contentType: input.contentType, upsert: true });
  if (error) throw error;
  const { data } = admin.storage.from("salon-images").getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

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
  patch: {
    name?: string;
    active?: boolean;
    display_order?: number;
    image_url?: string | null;
    day_hours?: import("../types").DayHours | null;
  },
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
  parentId?: string | null;
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
      parent_id: input.parentId ?? null,
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
    image_url?: string | null;
    parent_id?: string | null;
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

// ---- メニューオプション ----
export async function listOptions(menuId: string): Promise<MenuOption[]> {
  const supabase = anonClient();
  const { data } = await supabase
    .from("menu_options")
    .select("*")
    .eq("menu_id", menuId)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as MenuOption[];
}

// 複数メニューのオプションをまとめて取得（menu_id -> options）
export async function listOptionsForMenus(
  menuIds: string[],
): Promise<Map<string, MenuOption[]>> {
  const map = new Map<string, MenuOption[]>();
  if (menuIds.length === 0) return map;
  const supabase = anonClient();
  const { data } = await supabase
    .from("menu_options")
    .select("*")
    .in("menu_id", menuIds)
    .order("display_order", { ascending: true });
  for (const o of (data ?? []) as MenuOption[]) {
    if (!map.has(o.menu_id)) map.set(o.menu_id, []);
    map.get(o.menu_id)!.push(o);
  }
  return map;
}

export async function createOption(input: {
  ownerId: string;
  menuId: string;
  name: string;
  price?: number | null;
  durationMin?: number;
}): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase.from("menu_options").insert({
    owner_user_id: input.ownerId,
    menu_id: input.menuId,
    name: input.name,
    price: input.price ?? null,
    duration_min: input.durationMin ?? 0,
  });
  if (error) throw error;
}

export async function updateOption(
  id: string,
  ownerId: string,
  patch: {
    name?: string;
    price?: number | null;
    duration_min?: number;
    display_order?: number;
  },
): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("menu_options")
    .update(patch)
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

export async function deleteOption(id: string, ownerId: string): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("menu_options")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", ownerId);
  if (error) throw error;
}

// 指定オプション群を取得（予約時の合計計算・所有チェック用）
export async function getOptionsByIds(
  ownerId: string,
  ids: string[],
): Promise<MenuOption[]> {
  if (ids.length === 0) return [];
  const supabase = anonClient();
  const { data } = await supabase
    .from("menu_options")
    .select("*")
    .eq("owner_user_id", ownerId)
    .in("id", ids);
  return (data ?? []) as MenuOption[];
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
