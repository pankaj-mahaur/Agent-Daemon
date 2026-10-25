// The reasoning envelope (P6.1, D11): a provider's hidden reasoning (DeepSeek's
// reasoning_content, Gemini's thought signatures) rides in the engine's encrypted_content
// as "adg1." + base64url(nonce ‖ ciphertext ‖ tag), AES-256-GCM under a per-install key,
// bound to provider + "\n" + model. Another provider's, another model's, a tampered or a
// foreign blob opens to null and is dropped; anyone without the key sees only noise.
//
//   seal(key, { provider, model }, text) → "adg1.…"
//   open(key, { provider, model }, blob)  → text | null

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "adg1.";
const aad = ({ provider, model }) => Buffer.from(`${provider}\n${model}`, "utf8");

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Object.assign(new Error("the gateway's seal key must be 32 bytes"), { code: "SEAL_KEY" });
}

export function seal(key, scope, text) {
  checkKey(key);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(scope));
  const body = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return PREFIX + Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url");
}

export function open(key, scope, blob) {
  checkKey(key);
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) return null;
  const raw = Buffer.from(blob.slice(PREFIX.length), "base64url");
  if (raw.length < 12 + 16) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(aad(scope));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const isEnvelope = (blob) => typeof blob === "string" && blob.startsWith(PREFIX);
