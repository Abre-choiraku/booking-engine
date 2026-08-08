import { anonClient } from "../config";

// ============================================================
// 改善要望（利用者フィードバック）
// ============================================================
// 管理画面の「改善要望を送る」から投稿され、ClaudeCode が定期的に
// 新着を仕分けして CEO に提案一覧を出すための元データ。
// ============================================================

export type ImprovementCategory = "bug" | "improve" | "feature" | "other";
export type ImprovementStatus =
  | "new"
  | "triaged"
  | "planned"
  | "done"
  | "rejected";

export type ImprovementRequest = {
  id: string;
  owner_user_id: string | null;
  submitter_email: string | null;
  body: string;
  page_path: string | null;
  category: ImprovementCategory;
  status: ImprovementStatus;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<ImprovementStatus, string> = {
  new: "新着",
  triaged: "仕分け済",
  planned: "対応予定",
  done: "対応済",
  rejected: "見送り",
};
const CATEGORY_LABEL: Record<ImprovementCategory, string> = {
  bug: "不具合",
  improve: "改善",
  feature: "新機能",
  other: "その他",
};
export function improvementStatusLabel(s: ImprovementStatus): string {
  return STATUS_LABEL[s] ?? s;
}
export function improvementCategoryLabel(c: ImprovementCategory): string {
  return CATEGORY_LABEL[c] ?? c;
}

// 要望を1件登録
export async function createImprovementRequest(input: {
  ownerUserId?: string | null;
  submitterEmail?: string | null;
  body: string;
  pagePath?: string | null;
  category?: ImprovementCategory;
}): Promise<ImprovementRequest> {
  const body = input.body.trim();
  if (!body) throw new Error("内容を入力してください");
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("improvement_requests")
    .insert({
      owner_user_id: input.ownerUserId ?? null,
      submitter_email: input.submitterEmail ?? null,
      body: body.slice(0, 4000),
      page_path: input.pagePath ?? null,
      category: input.category ?? "other",
      status: "new",
    })
    .select()
    .single();
  if (error) throw error;
  return data as ImprovementRequest;
}

// 自分が送った要望の一覧（送信者向け）
export async function listMyImprovementRequests(
  ownerId: string,
  limit = 50,
): Promise<ImprovementRequest[]> {
  const supabase = anonClient();
  const { data, error } = await supabase
    .from("improvement_requests")
    .select("*")
    .eq("owner_user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ImprovementRequest[];
}

// 運営（ClaudeCode / CEO）向け: ステータスで絞って全件取得
export async function listImprovementRequests(opts?: {
  status?: ImprovementStatus | ImprovementStatus[];
  limit?: number;
}): Promise<ImprovementRequest[]> {
  const supabase = anonClient();
  let q = supabase.from("improvement_requests").select("*");
  if (opts?.status) {
    q = Array.isArray(opts.status)
      ? q.in("status", opts.status)
      : q.eq("status", opts.status);
  }
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 200);
  if (error) throw error;
  return (data ?? []) as ImprovementRequest[];
}

// 未対応（新着＋仕分け済＋対応予定）の件数。定期ダイジェストの判定に使う。
export async function countOpenImprovementRequests(): Promise<{
  new: number;
  open: number;
}> {
  const rows = await listImprovementRequests({
    status: ["new", "triaged", "planned"],
    limit: 500,
  });
  return {
    new: rows.filter((r) => r.status === "new").length,
    open: rows.length,
  };
}

// ステータス・メモの更新（仕分け／対応済みの記録）
export async function updateImprovementRequest(
  id: string,
  patch: { status?: ImprovementStatus; admin_note?: string | null },
): Promise<void> {
  const supabase = anonClient();
  const { error } = await supabase
    .from("improvement_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
