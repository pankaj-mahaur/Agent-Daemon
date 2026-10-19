// The one secret-pattern module. Memory capture redacts with it at every
// write, rendering redacts again at read time, and later parts (the record
// tools, the provider gateway) import it rather than keep their own list.
//
// Two confidence levels:
//   high    — a provider's documented key shape (sk-ant-…, ghp_…, AKIA…, a PEM
//             block). Safe to act on: the memory scan holds such rows back.
//   generic — a secret-looking value next to a secret-looking name
//             (DB_PASSWORD=…, "the password is …", user:pass@, Bearer …).
//             Redacted in text, never used to hide a whole row.
//
// Placeholders (<your key>, ${VAR}, $VAR, %VAR%, xxxx, ***, changeme,
// your…here, example, [redacted:…]), digits-only values and dotted
// identifiers (process.env.OPENAI_API_KEY) are never secrets.

const p = (kind, confidence, re, extra = {}) => Object.freeze({ kind, confidence, re, ...extra });

// An OpenAI-style body: a digit and an upper-case letter, or 40+ characters
// with no "-" word breaks. Keeps sk-learn-ensemble-classifier-v2 out.
const openaiBody = (m) => {
  const body = m[0].replace(/^sk-(?:proj-|svcacct-|admin-)?/, "");
  return (/\d/.test(body) && /[A-Z]/.test(body)) || (body.length >= 40 && !/-[a-z]+-/.test(body));
};

const SECRET_SEGMENTS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "CREDENTIALS", "AUTH"]);
const NOT_SECRET_SUFFIX = /_(URL|URI|HOST|PATH|DIR|FILE|NAME|USER|TYPE|MODE|KIND|FORMAT|SCOPE|SCOPES|VERSION|LENGTH|TTL|EXPIRY)$/;

function isPlaceholder(v) {
  const s = v.replace(/^["']|["']$/g, "");
  return (
    /^</.test(s) ||
    /^\$\{/.test(s) ||
    /^\$[A-Za-z_]\w*$/.test(s) ||
    /^%[A-Za-z_]\w*%$/.test(s) ||
    /^x{3,}/i.test(s) ||
    /^\*{3,}/.test(s) ||
    /^changeme$/i.test(s) ||
    /^your.*here$/i.test(s) ||
    /example/i.test(s) ||
    /^\[redacted:[a-z-]+\]$/.test(s)
  );
}
const digitsOnly = (v) => /^\d+$/.test(v.replace(/^["']|["']$/g, ""));
const dottedIdentifier = (v) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v);

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const q = n / s.length;
    h -= q * Math.log2(q);
  }
  return h;
}

// KEY after one of these names a data key, not a credential (PRIMARY_KEY=user_id).
const DATA_KEY_PREFIX = new Set(["PRIMARY", "SORT", "SORTING", "CACHE", "FOREIGN", "PARTITION", "ROUTING", "SHARD", "LOOKUP", "INDEX", "HASH", "MAP", "GROUP"]);

// A short value needs mixed case and a digit to look like a secret (AUTH=oauth2 isn't).
const secretLooking = (v) => (v.length >= 12 && (/\d/.test(v) || entropy(v) >= 3.5)) || (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v));

const envNameIsSecret = (raw) => {
  const name = raw.toUpperCase();
  if (name === "PWD" || name === "OLDPWD" || NOT_SECRET_SUFFIX.test(name)) return false;
  const segs = name.split("_");
  const hits = segs.map((s, i) => [s, i]).filter(([s]) => SECRET_SEGMENTS.has(s));
  if (!hits.length) return false;
  return !hits.every(([s, i]) => s === "KEY" && i > 0 && DATA_KEY_PREFIX.has(segs[i - 1]));
};

// A password or secret name: any value of 6+ characters is the secret (a
// lowercase passphrase included). KEY/TOKEN/AUTH names also name ordinary
// values (TOKEN_TYPE, AUTH=oauth2), so those values must look secret.
const PASSWORD_SEGMENTS = new Set(["PASSWORD", "PASSWD", "SECRET", "CREDENTIAL", "CREDENTIALS"]);

const envAssignment = (m) => {
  const value = m[2].replace(/^["']|["']$/g, "");
  if (!envNameIsSecret(m[1]) || value.length < 6 || digitsOnly(value) || isPlaceholder(value)) return false;
  return m[1].toUpperCase().split("_").some((s) => PASSWORD_SEGMENTS.has(s)) || secretLooking(value);
};

const keywordValue = (m) => {
  const v = m[2];
  return /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) >= 3.3 && !isPlaceholder(v) && !dottedIdentifier(v);
};

const urlPassword = (m) => !isPlaceholder(m[2]);
const hasDigit = (m) => /\d/.test(m[1]);
const flagValue = (m) => !isPlaceholder(m[2]) && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2]);

/** Ordered: high-confidence kinds first, so an overlap keeps the specific kind. */
export const SECRET_PATTERNS = Object.freeze([
  p("anthropic-key", "high", /\bsk-ant-[A-Za-z0-9_-]{20,}/dg),
  p("openrouter-key", "high", /\bsk-or-v1-[A-Za-z0-9]{32,}/dg),
  p("openai-key", "high", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/dg, { test: openaiBody }),
  p("github-token", "high", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/dg),
  p("gitlab-token", "high", /\bglpat-[A-Za-z0-9_-]{20,}/dg),
  p("aws-access-key", "high", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg),
  p("google-api-key", "high", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/dg),
  p("slack-token", "high", /\bxox[abprs]-[A-Za-z0-9-]{10,}/dg),
  p("stripe-key", "high", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/dg),
  p("huggingface-token", "high", /\bhf_[A-Za-z0-9]{30,}/dg),
  p("npm-token", "high", /\bnpm_[A-Za-z0-9]{36}\b/dg),
  p("jwt", "high", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg),
  p("sendgrid-key", "high", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/dg),
  p("pypi-token", "high", /\bpypi-[A-Za-z0-9_-]{50,}/dg),
  p("webhook-secret", "high", /\bwhsec_[A-Za-z0-9+/=]{24,}/dg),
  p("slack-webhook", "high", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/dg),
  p("npm-token", "high", /_authToken=([^\s"']{12,})/dg, { valueGroup: 1 }),
  p("azure-key", "high", /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{20,}={0,2})/dg, { valueGroup: 1 }),
  // A PEM block; or, when the END line was cut off, the BEGIN line plus the
  // key-data lines after it (never the prose after a mere mention).
  p("private-key", "high", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/dg),
  p("private-key", "high", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[^\S\r\n]*\r?\n(?:[A-Za-z0-9+/]{12,}={0,2}[^\S\r\n]*(?:\r?\n|$))+/dg),
  p("url-credentials", "generic", /\b[a-z][a-z0-9+.-]{0,31}:\/\/([^\s:/@]{1,256}):([^\s@/]{1,256})@/dgi, { valueGroup: 2, test: urlPassword }),
  p("bearer-token", "generic", /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/dg, { valueGroup: 1, test: hasDigit }),
  p("basic-auth", "generic", /\bAuthorization:\s*Basic\s+([A-Za-z0-9+/]{12,}={0,2})/dgi, { valueGroup: 1 }),
  p("env-assignment", "generic", /\bsetx\s+([A-Za-z_][A-Za-z0-9_]*)\s+("[^"\n]*"|[^\s"']+)/dgi, { valueGroup: 2, test: envAssignment }),
  p("env-assignment", "generic", /(?<![\w.$%{-])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/dg, { valueGroup: 2, test: envAssignment }),
  // A secret-ish name ending an identifier (aws_secret_access_key, "api_key"),
  // an optional closing quote, a separator, an optional opening quote, a value.
  p("keyword-secret", "generic", /(?<![A-Za-z0-9])(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|token|passw(?:or)?d|credentials?|private[_-]?key)["']?\s*(?::|=>|=|\bis\b|\bwas\b)\s*["']?([^\s"',;]{12,})/dgi, { valueGroup: 2, test: keywordValue }),
  p("keyword-secret", "generic", /(?<![\w-])--(password|passwd|token|api-key|secret|client-secret)(?:=|\s+)([^\s"']{6,})/dgi, { valueGroup: 2, test: flagValue }),
]);

const RANK = { generic: 0, high: 1 };

/**
 * @returns {{kind:string, confidence:"high"|"generic", start:number, end:number}[]} sorted, non-overlapping
 */
export function findSecrets(text, { minConfidence = "generic" } = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const pat of SECRET_PATTERNS) {
    if (RANK[pat.confidence] < RANK[minConfidence]) continue;
    pat.re.lastIndex = 0;
    for (const m of text.matchAll(pat.re)) {
      if (pat.test && !pat.test(m)) continue;
      const [start, end] = pat.valueGroup ? m.indices[pat.valueGroup] : m.indices[0];
      if (isPlaceholder(text.slice(start, end))) continue;
      // Keep the first (higher-ranked) pattern on any overlap.
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ kind: pat.kind, confidence: pat.confidence, start, end });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Replace every secret value with "[redacted:<kind>]". Idempotent.
 * @returns {{text:any, kinds:string[]}}
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return { text, kinds: [] };
  const hits = findSecrets(text);
  if (hits.length === 0) return { text, kinds: [] };
  let out = text;
  for (const h of [...hits].reverse()) out = out.slice(0, h.start) + `[redacted:${h.kind}]` + out.slice(h.end);
  return { text: out, kinds: [...new Set(hits.map((h) => h.kind))] };
}
