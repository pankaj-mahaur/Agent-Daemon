// Path tokens (P7.1b): a bundle names places by role, never by one machine's absolute path.
//
//   toToken(p, roots, { caseInsensitive }) → { value, token: boolean }
//     roots: [{ token: "{HOME}" | "{AD_ROOT}" | "{PROJECT:<id>}", path }]
//     The longest matching root wins; a match is case-insensitive when the SOURCE OS is Windows
//     or macOS. A path under no root stays literal (token: false): the caller counts it as a
//     foreign path. Pure string work: nothing on disk is read.
//   fromToken(value, roots, { join }) → a path on this machine, or the literal value
//   tokenRoots({ home, adRoot, projects: [{ id, path }] }) → the roots, in a stable order
//
// Only registered structured fields are rewritten (the inventory says which); prose never.

import path from "node:path";

const TOKEN = /^\{(HOME|AD_ROOT|PROJECT:[A-Za-z0-9_-]+)\}(?:\/(.*))?$/s;

/** Separators normalised to "/", no trailing separator (a drive root keeps its own). */
function norm(p) {
  const s = String(p).replace(/\\/g, "/");
  return s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, "") : s;
}

export function tokenRoots({ home = null, adRoot = null, projects = [] } = {}) {
  const roots = [];
  for (const p of projects) if (p?.id && p.path) roots.push({ token: `{PROJECT:${p.id}}`, path: p.path });
  if (adRoot) roots.push({ token: "{AD_ROOT}", path: adRoot });
  if (home) roots.push({ token: "{HOME}", path: home });
  return roots;
}

export function toToken(p, roots = [], { caseInsensitive = false } = {}) {
  if (typeof p !== "string" || !p) return { value: p, token: false };
  if (TOKEN.test(p)) return { value: p, token: true }; // already a token
  const s = norm(p);
  const fold = (x) => (caseInsensitive ? x.toLowerCase() : x);
  let best = null;
  for (const r of roots) {
    const root = norm(r.path);
    if (!root) continue;
    const a = fold(s);
    const b = fold(root);
    if (a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`)) {
      if (!best || root.length > best.root.length) best = { root, token: r.token };
    }
  }
  if (!best) return { value: p, token: false };
  const rest = s.slice(best.root.length).replace(/^\/+/, "");
  return { value: rest ? `${best.token}/${rest}` : best.token, token: true };
}

/** A token back to a path under this machine's root for it; an unknown token stays literal. */
export function fromToken(value, roots = [], { join = path.join } = {}) {
  const m = typeof value === "string" ? TOKEN.exec(value) : null;
  if (!m) return value;
  const r = roots.find((x) => x.token === `{${m[1]}}`);
  if (!r) return value;
  return m[2] ? join(r.path, ...m[2].split("/")) : r.path;
}

export const isToken = (value) => typeof value === "string" && TOKEN.test(value);
