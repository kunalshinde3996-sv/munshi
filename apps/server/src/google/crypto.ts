import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(keyB64: string | undefined): Buffer {
  if (!keyB64) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

/** AES-256-GCM. Output: v1.<iv>.<authTag>.<ciphertext> (all base64). A fresh random 96-bit IV per call. */
export function encryptJson(value: unknown, keyB64: string | undefined): string {
  const key = parseKey(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

/** Throws if the key is wrong or the ciphertext was modified (GCM authentication). */
export function decryptJson<T = unknown>(payload: string, keyB64: string | undefined): T {
  const key = parseKey(keyB64);
  const [v, iv, tag, data] = payload.split(".");
  if (v !== VERSION || !iv || !tag || !data) throw new Error("Unrecognised token format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

export const isValidKey = (keyB64: string | undefined) => {
  try {
    parseKey(keyB64);
    return true;
  } catch {
    return false;
  }
};
