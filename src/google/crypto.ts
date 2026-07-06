import crypto from "crypto";

// ============================================================
// トークン暗号化（AES-256-GCM）
// ============================================================
// 環境変数 TOOL_CREDENTIALS_KEY（32バイトの base64）で対称暗号化。
// 出力形式: base64( iv[12] + authTag[16] + ciphertext )
// Google OAuth のアクセス/リフレッシュトークンの保存に使う。
// ============================================================

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey(): Buffer {
  const raw = process.env.TOOL_CREDENTIALS_KEY;
  if (!raw)
    throw new Error(
      "TOOL_CREDENTIALS_KEY が未設定です。環境変数に 32バイトの base64 を設定してください",
    );
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error(
      "TOOL_CREDENTIALS_KEY は 32バイト（base64 で 44文字）である必要があります",
    );
  return key;
}

export function encryptToken(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ct]).toString("base64");
}

export function decryptToken(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
