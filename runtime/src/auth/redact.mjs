// The redactor (P3.3): secrets out of everything ad shows or writes about errors:
// CLI error lines, engine error texts and details, session notices, notes, ad doctor
// details, TUI error cells, gateway observations. Not applied to conversation content.
//
//   registerSecret(value, label)  a value ad holds (each key the gateway loads, its
//                                 token): exact and JSON-escaped forms are redacted
//   redact(text), redactDeep(value)
// Patterns cover key-shaped strings ad never registered (an engine echoing a key).

const registered = new Map(); // value → label
const MIN = 8;

export function registerSecret(value, label = "secret") {
  const v = String(value ?? "");
  if (v.length < MIN) return;
  registered.set(v, label);
  const escaped = JSON.stringify(v).slice(1, -1);
  if (escaped !== v) registered.set(escaped, label);
}

export function forgetSecret(value) {
  const v = String(value ?? "");
  registered.delete(v);
  registered.delete(JSON.stringify(v).slice(1, -1));
}

const PATTERNS = [
  [/\bsk-or-v1-[0-9a-f]{32,}\b/g, "[redacted: key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted: key]"],
  [/\bxai-[A-Za-z0-9]{20,}/g, "[redacted: key]"],
  [/\bfw_[A-Za-z0-9]{16,}/g, "[redacted: key]"],
  [/\bBearer\s+[^\s"',;]{16,}/g, "[redacted: bearer]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted: token]"],
  [/([?&](?:code|code_verifier|id_token_hint)=)[^&\s"']+/g, "$1[redacted]"],
];

export function redact(text) {
  let s = String(text ?? "");
  if (!s) return s;
  // Longest first, so a value containing another is replaced whole.
  for (const [v, label] of [...registered].sort((a, b) => b[0].length - a[0].length)) if (s.includes(v)) s = s.split(v).join(`[redacted: ${label}]`);
  for (const [re, to] of PATTERNS) s = s.replace(re, to);
  return s;
}

export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

/** Tests only. */
export function _resetForTests() {
  registered.clear();
}
