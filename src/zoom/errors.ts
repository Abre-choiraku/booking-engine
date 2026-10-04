// ============================================================
// Zoom のトークン更新エラーの見分け（DBに触らない純粋な判定だけ）
// ============================================================
// Zoom は「1つの Zoom アカウント × 1つのアプリ」につき有効な鍵を1組しか持たない。
// 同じ Zoom アカウントを別の主催者アカウントで連携し直すと、先に連携した側の鍵は
// その瞬間に無効になり、更新のたびに
//   400 {"reason":"Invalid Token!","error":"invalid_grant"}
// が返る（2026-10-04 に本番で発生。画面は「連携済み」のままURLだけ出なくなっていた）。
// この状態は待っても直らない＝連携し直すしかないので、一時的な障害と区別する。
// ============================================================

/** 連携が切れていて、連携し直すまで二度と更新できない応答か */
export function isDeadZoomGrant(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  try {
    const j = JSON.parse(bodyText) as { error?: string };
    return j?.error === "invalid_grant";
  } catch {
    return false;
  }
}
