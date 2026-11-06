// The install ledger v2 (MCP launch plan L3, Decision 8): one record per item ad
// wrote into a host's settings, so uninstall removes exactly ad's items and keeps
// everything the user had before or changed after.
//
//   item = { id, host, kind, file, locator, value, canonicalSha256, preExisted,
//            installedAt, updatedAt, version, source? }
//   kind:    "mcp" (the MCP server entry), "hook" (one hook handler), "env" (one
//            variable, e.g. the agent-shell marker), "skill-dir" (a skill folder)
//   locator: what finds the item by content, never by position:
//            mcp {key, scope?} · hook {event, step, script} · env {path: [...keys]} · skill-dir {name}
//   source:  "v1" while the item mirrors a v1 record; a direct write clears it.
//
// ad's own later edits (the review service's onFailure switch, a setup re-run) go
// through updateItem, which re-hashes, so they never read as the user's edits.
// v1 (install-ledger.json, one record per host) stays as it is for 3.1.0 binaries.
// This version mirrors it into v2 on every v1 write, and merges it in memory where
// a fresh view matters (uninstall), since a 3.1.0 binary may have written it since.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.mjs";
import { ledger2Path, readItems } from "../memory/ledger-read.mjs";
import { PRODUCT } from "../product.mjs";

export { ledger2Path };

// Fields of a hook handler that ad itself may change after writing it: comparing
// them would make ad's own edit look like the user's.
const AD_OWNED_HOOK_FIELDS = ["onFailure", "timeout"];

// ad's own paths, matched on "/"-separated text: the stable launcher, 3.1.0's
// launcher, the dispatcher and the MCP server in a checkout, and the plugin's copy
// (its folder is named after the plugin). Anchored on their parent folders, so a
// user's "my-server/server.mjs" is not ad's.
const AD_PATHS = [
  /\/memory\/launch\/run\.mjs\b/i,
  /\/memory\/bin\/launch\.mjs\b/i,
  /\/runtime\/bin\/hook\.mjs\b/i,
  /\/runtime\/src\/mcp\/memory-server\.mjs\b/i,
  new RegExp(`/${PRODUCT.plugin.replace(/[-.]/g, "\\$&")}/(?:[^/"]+/)*server/(?:hook|server)\\.mjs\\b`, "i"),
];
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const slashes = (s) => String(s).replace(/\\+/g, "/");

/** JSON with every object's keys sorted (arrays keep their order). */
export function canonicalJson(value, { kind } = {}) {
  // Through JSON first: a value with toJSON (a TOML date) hashes as it is written.
  const plain = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const sort = (v, top) => {
    if (Array.isArray(v)) return v.map((x) => sort(x, false));
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (top && kind === "hook" && AD_OWNED_HOOK_FIELDS.includes(k)) continue;
      out[k] = sort(v[k], false);
    }
    return out;
  };
  return JSON.stringify(sort(plain, true));
}

export const canonicalSha256 = (value, opts) => crypto.createHash("sha256").update(canonicalJson(value, opts) ?? "undefined").digest("hex");

// One spelling of a path for ids: "/" separators, and no case on Windows.
const idPath = (p) => {
  const s = slashes(path.resolve(String(p)));
  return process.platform === "win32" ? s.toLowerCase() : s;
};

/** A stable id from what the item is, not where it sits or how a path was spelled. */
export function itemId({ host, kind, file, locator }) {
  const loc = Object.fromEntries(Object.entries(locator ?? {}).map(([k, v]) => [k, k === "script" && v ? idPath(v) : v]));
  const key = [host, kind, file ? idPath(file) : "", canonicalJson(loc)].join("\n");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export const emptyLedger = () => ({ schemaVersion: 2, items: [] });

/** For hooks and reports: tolerant (a garbled file reads as empty). */
export const readLedger2 = (root) => ({ schemaVersion: 2, items: readItems(root) });

/**
 * For writers: the ledger, or a reason not to write over it. A garbled file is
 * moved aside (ledger.json.bad-<time>) so nothing it held is lost silently; a
 * newer version's file is never written by this one.
 * → { ledger, note? } or { refuse }
 */
export function openLedger2ForWrite(root, { now = new Date() } = {}) {
  const file = ledger2Path(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ledger: emptyLedger() };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  if (j && typeof j.schemaVersion === "number" && j.schemaVersion > 2) return { refuse: `${file} is from a newer version (schema ${j.schemaVersion}); this one leaves it alone` };
  if (j?.schemaVersion === 2 && Array.isArray(j.items)) return { ledger: { schemaVersion: 2, items: j.items.filter((i) => i && typeof i.id === "string") } };
  const aside = `${file}.bad-${now.toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(file, aside);
  return { ledger: emptyLedger(), note: `${file} couldn't be read; it was moved to ${aside} and started again` };
}

export async function writeLedger2(root, ledger) {
  fs.mkdirSync(path.dirname(ledger2Path(root)), { recursive: true });
  await writeFileAtomic(ledger2Path(root), JSON.stringify({ schemaVersion: 2, items: ledger.items }, null, 2) + "\n");
}

const validDate = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0));

/**
 * Record what ad wrote. A second write of the same item keeps the first one's
 * preExisted and installedAt (the user's state before ad is what uninstall
 * restores); updatedAt moves on every write. A write without a source is a direct
 * v2 write and clears "v1".
 */
export function upsertItem(ledger, { host, kind, file, locator, value, preExisted = false, version, source, now = new Date() }) {
  const at = validDate(now).toISOString();
  const id = itemId({ host, kind, file, locator });
  const prev = ledger.items.find((i) => i.id === id);
  const item = {
    id,
    host,
    kind,
    file: file ?? null,
    locator,
    value,
    canonicalSha256: canonicalSha256(value, { kind }),
    preExisted: prev ? prev.preExisted : Boolean(preExisted),
    installedAt: prev?.installedAt ?? at,
    updatedAt: at,
    version: version ?? prev?.version ?? null,
    ...(source ? { source } : {}),
  };
  ledger.items = [...ledger.items.filter((i) => i.id !== id), item];
  return item;
}

/** ad's own edit of an item it wrote (re-hashed, so it isn't read as the user's). */
export function updateItem(ledger, id, value, { now = new Date() } = {}) {
  const i = ledger.items.find((x) => x.id === id);
  if (!i) return null;
  i.value = value;
  i.canonicalSha256 = canonicalSha256(value, { kind: i.kind });
  i.updatedAt = validDate(now).toISOString();
  delete i.source;
  return i;
}

export function dropItem(ledger, id) {
  ledger.items = ledger.items.filter((i) => i.id !== id);
}

/**
 * Merge v1's per-host records in. A v1 record replaces the item it mirrors, and an
 * item written to v2 directly only when the v1 record is newer than that item's
 * last write (a 3.1.0 install ran since).
 */
export function mergeV1(ledger, v1) {
  for (const [host, rec] of Object.entries(v1?.hosts ?? {})) {
    if (!rec || typeof rec !== "object") continue;
    const at = validDate(rec.installedAt ? new Date(rec.installedAt) : new Date(0));
    const consider = (spec) => {
      const prev = ledger.items.find((i) => i.id === itemId(spec));
      if (prev && prev.source !== "v1" && validDate(new Date(prev.updatedAt ?? prev.installedAt)) >= at) return;
      upsertItem(ledger, { ...spec, version: rec.version ?? null, source: "v1", now: at });
    };
    if (rec.driver === "file" && rec.entry) consider({ host, kind: "mcp", file: rec.realFile ?? rec.file, locator: { key: rec.entryKey ?? PRODUCT.mcpServerKey }, value: rec.entry });
    if (rec.driver === "cli" && rec.entry) consider({ host, kind: "mcp", file: null, locator: { key: rec.entryKey ?? PRODUCT.mcpServerKey, scope: rec.scope ?? "user" }, value: rec.entry });
    for (const [name, s] of Object.entries(rec.skills ?? {})) {
      if (s?.path) consider({ host, kind: "skill-dir", file: s.path, locator: { name }, value: { sha256: s.sha256 ?? null } });
    }
  }
  return ledger;
}

/**
 * Mirror v1 into v2 after a v1 write. MCP entries keep v1's mechanics (the byte
 * restore of a file ad created or left unchanged); v2 records them as items so every
 * kind is listed in one place. An item that came from v1 and is no longer in it (an
 * uninstall removed it) goes; items written to v2 directly are never touched here.
 * → a note for the user, or null
 */
export async function syncFromV1(root, v1) {
  const opened = openLedger2ForWrite(root);
  if (opened.refuse) return opened.refuse;
  const led = opened.ledger;
  const current = new Set(mergeV1(emptyLedger(), v1).items.map((i) => i.id));
  led.items = led.items.filter((i) => i.source !== "v1" || current.has(i.id));
  mergeV1(led, v1);
  await writeLedger2(root, led);
  return opened.note ?? null;
}

/**
 * Does the live value carry ad's identity? For a skill folder `live` is
 * { sha256, marker }: the folder must be named as recorded, a skill name, and hold
 * ad's publish marker.
 */
export function carriesIdentity(item, live) {
  if (live === undefined || live === null) return false;
  if (item.kind === "skill-dir") {
    const name = item.locator?.name;
    return SKILL_NAME.test(String(name)) && path.basename(String(item.file ?? "")) === name && live.marker === true;
  }
  // One separator however it was written: JSON doubles a Windows path's backslashes.
  const text = slashes(typeof live === "string" ? live : JSON.stringify(live));
  if (item.kind === "mcp") return item.locator?.key === PRODUCT.mcpServerKey && AD_PATHS.some((re) => re.test(text));
  if (item.kind === "hook") return AD_PATHS.some((re) => re.test(text));
  if (item.kind === "env") return Array.isArray(item.locator?.path) && item.locator.path.at(-1) === "AD_TOOL_SHELL" && String(live) === "1";
  return false;
}

/**
 * What uninstall does with one item, given its live value (undefined: gone).
 * → { action: "remove" } or { action: "keep", why } or { action: "gone" }.
 */
export function removalDecision(item, live, { skillRoots = [] } = {}) {
  if (live === undefined) return { action: "gone" };
  if (item.preExisted) return { action: "keep", why: "you had it before" };
  if (item.kind === "skill-dir") {
    const p = path.resolve(item.file ?? "");
    const inside = skillRoots.some((r) => {
      const rel = path.relative(path.resolve(r), p);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
    });
    if (!inside) return { action: "keep", why: "it isn't in a host's skills folder" };
  }
  if (!carriesIdentity(item, live)) return { action: "keep", why: "it isn't ad's (none of ad's paths or values in it)" };
  const compared = item.kind === "skill-dir" ? { sha256: live.sha256 } : live;
  if (canonicalSha256(compared, { kind: item.kind }) !== item.canonicalSha256) return { action: "keep", why: "you changed it" };
  return { action: "remove" };
}

/** Uninstall's three lists, as lines. */
export function uninstallReport({ removed = [], kept = [], left = [] }, { display = (p) => p } = {}) {
  const lines = [];
  const what = (l) => (l?.key ? ` · ${l.key}` : l?.path ? ` · ${l.path.join(".")}` : l?.event ? ` · ${l.event} ${l.step ?? ""}`.trimEnd() : l?.name ? ` · ${l.name}` : "");
  const where = (i) => (i.file ? display(i.file) : i.host) + what(i.locator);
  lines.push(removed.length ? "Removed:" : "Removed: nothing");
  for (const i of removed) lines.push(`  - ${where(i)}`);
  if (kept.length) {
    lines.push("Kept:");
    for (const k of kept) lines.push(`  - ${where(k.item)}: ${k.why}${k.how ? `. To remove it: ${k.how}` : ""}`);
  }
  if (left.length) {
    lines.push("Left on disk:");
    for (const l of left) lines.push(`  - ${display(l.path)}${l.bytes ? ` (${Math.max(1, Math.round(l.bytes / 1024))} KB)` : ""}${l.what ? `: ${l.what}` : ""}`);
  }
  return lines;
}

/**
 * Does this config text still start the stable launcher (Decision 11)? Matched by
 * the launcher's own path suffix, whatever the home is spelled as (~, %USERPROFILE%,
 * /c/Users/…): finding one too many keeps the launcher, the safe side.
 */
export function referencesLauncher(text) {
  return /memory\/launch\/run\.mjs/i.test(slashes(text));
}
