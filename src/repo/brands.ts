import { anonClient, serviceClient } from "../config";

// ============================================================
// 白ラベル: 主催者ごとのブランド設定
// ============================================================

export type TenantBrand = {
  owner_user_id: string;
  display_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  updated_at?: string;
};

// 主催者のブランドを取得（未設定は null）
export async function getBrand(ownerId: string): Promise<TenantBrand | null> {
  if (!ownerId) return null;
  const supabase = anonClient();
  const { data } = await supabase
    .from("tenant_brands")
    .select("*")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  return (data as TenantBrand) ?? null;
}

// リンク単位の店名指定があれば表示名を上書きして返す（VAILS連携）。
// 別事業者のロゴが出ないよう、上書き時はロゴを外しアクセント色だけ引き継ぐ。
export function withLinkBrand(
  brand: TenantBrand | null,
  linkDisplayName?: string | null,
): TenantBrand | null {
  const name = (linkDisplayName ?? "").trim();
  if (!name) return brand;
  return {
    owner_user_id: brand?.owner_user_id ?? "",
    display_name: name,
    logo_url: null,
    accent_color: brand?.accent_color ?? null,
  };
}

// ブランドを作成/更新
export async function upsertBrand(input: {
  ownerId: string;
  displayName?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
}): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase.from("tenant_brands").upsert(
    {
      owner_user_id: input.ownerId,
      display_name: input.displayName ?? null,
      logo_url: input.logoUrl ?? null,
      accent_color: input.accentColor ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_user_id" },
  );
  if (error) throw error;
}

// ロゴ画像を Supabase Storage にアップロードして公開URLを返す（service role 必須）
export async function uploadBrandLogo(input: {
  ownerId: string;
  bytes: ArrayBuffer | Uint8Array;
  contentType: string;
  ext: string;
}): Promise<string> {
  const admin = serviceClient();
  if (!admin) throw new Error("ロゴのアップロードには SUPABASE_SERVICE_ROLE_KEY が必要です");
  const path = `${input.ownerId}/logo.${input.ext}`;
  const body =
    input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const { error } = await admin.storage
    .from("brand-logos")
    .upload(path, body, { contentType: input.contentType, upsert: true });
  if (error) throw error;
  const { data } = admin.storage.from("brand-logos").getPublicUrl(path);
  // キャッシュ回避のため updated パラメータを付ける
  return `${data.publicUrl}?v=${Date.now()}`;
}
