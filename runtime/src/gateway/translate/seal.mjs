// The reasoning envelope (P6.1, D11): a provider's hidden reasoning (DeepSeek's
// reasoning_content, Gemini's thought signatures) rides in the engine's encrypted_content
// as "adg1." + hint + "." + base64url(nonce ‖ ciphertext ‖ tag), AES-256-GCM under a
// per-install key, bound to provider + "\n" + model. Another provider's, another model's,
// a tampered or a foreign blob opens to null and is dropped; anyone without the key sees
// only noise.
//
// The hint (8 hex of SHA-256 of the scope) is not a secret and proves nothing (the AAD does):
// it only tells "sealed for this provider and model, but no longer opens" (a replaced key:
// truly lost) apart from "sealed for another scope, or not ad's" (absent, not lost).
//
//   seal(key, { provider, model }, text) → "adg1.<hint>.…"
//   open(key, { provider, model }, blob)  → text | null
//   sealedFor({ provider, model }, blob)  → true when the blob names this scope

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "adg1.";
const scopeText = ({ provider, model }) => `${provider}\n${model}`;
const aad = (scope) => Buffer.from(scopeText(scope), "utf8");
const hintOf = (scope) => createHash("sha256").update(scopeText(scope)).digest("hex").slice(0, 8);

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Object.assign(new Error("the gateway's seal key must be 32 bytes"), { code: "SEAL_KEY" });
}

// "adg1.<hint>.<data>" → { hint, data }; the older "adg1.<data>" (no hint) → { hint: null, data }.
function parts(blob) {
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) return null;
  const rest = blob.slice(PREFIX.length);
  const m = /^([0-9a-f]{8})\.(.+)$/.exec(rest);
  return m ? { hint: m[1], data: m[2] } : { hint: null, data: rest };
}

export function seal(key, scope, text) {
  checkKey(key);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(scope));
  const body = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `${PREFIX}${hintOf(scope)}.${Buffer.concat([nonce, body, c.getAuthTag()]).toString("base64url")}`;
}

export function open(key, scope, blob) {
  checkKey(key);
  const p = parts(blob);
  if (!p) return null;
  const raw = Buffer.from(p.data, "base64url");
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

export const sealedFor = (scope, blob) => parts(blob)?.hint === hintOf(scope);

export const isEnvelope = (blob) => typeof blob === "string" && blob.startsWith(PREFIX);
