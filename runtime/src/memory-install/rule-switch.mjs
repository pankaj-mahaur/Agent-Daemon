// The rule switch (MCP launch plan L7, D13). While rules exist (paused ones too: a pause ends by
// itself, and nothing has to raise the check again then), every live tool.before handler of
// ad's in Claude Code's user settings fails closed (`onFailure: "block"`, `timeout: 10`), and
// while an env-read policy rule exists its matcher also covers Read (L7b). With no rules left,
// what ad raised goes back to the values it had before the raise (`orig` in the ledger item,
// absence included) — a field the user changed since is left as it is. Raising needs nothing;
// lowering needs the review token (S1). It runs after the tokened rule writers (afterReview,
// setPolicy) and in setup — never in a hook or the refresh job, whose import graphs carry no
// npm package (jsonc-parser is the installer's). What was applied is recorded in
// `<root>/memory/switch.json`; `switchDue` says when it disagrees with the rules or failed.

import fs from "node:fs";
import path from "node:path";
import { loadGuards, readActive } from "../hooks/guards.mjs";
import { inspect, writeChecked } from "./fsx.mjs";
import { itemId, openLedger2ForWrite, writeLedger2 } from "./ledger2.mjs";
import { applyOps, locateHook, parseSettings, restoreOps, withLedgerLock } from "./setup.mjs";

export const BLOCK_TIMEOUT = 10;
export const switchPath = (root) => path.join(root, "memory", "switch.json");

/** What the snapshot asks for: { active (rules exist), readMatcher (an env-read policy rule exists) }. Pauses don't count. */
export function wantedState(snapshot) {
  if (!snapshot) return { active: false, readMatcher: false };
  const lists = [snapshot.global?.rules, ...Object.values(snapshot.projects ?? {}).map((p) => p?.rules)].map((l) => (Array.isArray(l) ? l : []));
  const active = lists.some((l) => l.length > 0);
  const readMatcher = lists.some((l) => l.some((r) => r?.rule?.type === "policy" && r.rule.family === "env-read"));
  return { active, readMatcher };
}

/**
 * What the rules on disk ask for → { active, readMatcher, sure }. Only the current snapshot
 * is sure. From the last-good copy, or with both unreadable, guards.active (D3) still says
 * rules exist: raise, never lower (sure: false).
 */
export function wantedNow(root, now = Date.now()) {
  const { snapshot, source } = loadGuards({ root });
  const sentinel = readActive({ root }) !== null;
  if (snapshot && source === "current") return { ...wantedState(snapshot), sure: true };
  if (snapshot) {
    const w = wantedState(snapshot);
    return { active: w.active || sentinel, readMatcher: w.readMatcher, sure: false };
  }
  return { active: sentinel, readMatcher: false, sure: !sentinel && !fs.existsSync(path.join(root, "guards.json")) };
}

/** The record of what the switch last applied (null when none or unreadable). */
export function readSwitchRecord(root) {
  try {
    return JSON.parse(fs.readFileSync(switchPath(root), "utf8"));
  } catch {
    return null;
  }
}

/** Is a switch due: no record, a record that disagrees with the rules, or one that failed? */
export function switchDue(root, now = Date.now()) {
  const want = wantedNow(root, now);
  const rec = readSwitchRecord(root);
  return !rec || rec.failed === true || rec.active !== want.active || rec.readMatcher !== want.readMatcher;
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
// Claude Code's matcher: none, "" or "*" match every tool; otherwise a regex over the tool name.
export function coversRead(m) {
  if (m === null || m === undefined || m === "" || m === "*") return true;
  try {
    return new RegExp(`^(?:${m})$`).test("Read");
  } catch {
    return String(m).split("|").includes("Read");
  }
}
const withRead = (m) => (coversRead(m) ? m : `${m}|Read`);
const withoutRead = (m) => String(m).split("|").filter((x) => x !== "Read").join("|");
const samePath = (a, b) => {
  const n = (x) => path.resolve(String(x)).replace(/\\/g, "/");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/**
 * Apply the switch to every Claude Code settings file whose tool.before entry ad's ledger
 * records (so it needs no home or env: ctx is { root, lockWaitMs? }). token: the review
 * token when the caller has one (checked here; only then does anything lower). → { changed,
 * active, readMatcher, pendingLower, why? }. A failure never undoes a rule: the caller prints `why`.
 */
export async function applyRuleSwitch({ ctx, token = null, now = Date.now() } = {}) {
  return withLedgerLock(ctx, () => switchLocked({ ctx, token, now }));
}

/**
 * After a tokened rule write (afterReview, setPolicy): the switch, its failure as `why` (never
 * thrown). On Windows the first rule also adds Codex's tool.before (setup for Codex, once: it
 * stays after the last rule); its lines come back as `codex`. ctxFor: a test seam for that setup.
 */
export async function switchAfterRules({ root, token = null, now = Date.now(), platform = process.platform, ctxFor } = {}) {
  let r;
  try {
    r = await applyRuleSwitch({ ctx: { root, lockWaitMs: 2000 }, token, now });
  } catch (e) {
    r = { why: `ad's rules check couldn't be switched: ${e?.message ?? e}` };
  }
  if (platform === "win32" && r.active) {
    try {
      const lines = await codexCheckOnce({ root, ctxFor });
      if (lines) r.codex = lines;
    } catch (e) {
      r.codex = [`Codex: ad's rules check couldn't be added (${e?.message ?? e}); run setup again in your own terminal`];
    }
  }
  return r;
}

// Codex set up (ad's hooks in its ledger) without tool.before: set it up again, now with it.
async function codexCheckOnce({ root, ctxFor }) {
  const { readLedger2 } = await import("./ledger2.mjs");
  const codex = readLedger2(root).items.filter((i) => i.host === "codex" && i.kind === "hook");
  if (!codex.length || codex.some((i) => i.locator?.event === "tool.before")) return null;
  const lines = [];
  const out = (l) => lines.push(String(l));
  const ctx = ctxFor ? ctxFor(out) : (await import("./install.mjs")).makeContext({ root, out, platform: "win32", lockWaitMs: 2000 });
  const { setup } = await import("./setup.mjs");
  await setup({ ctx, hosts: ["codex"] });
  return lines;
}

/** The switch for a caller already holding the ledger lock (setup, uninstall). */
export async function switchLocked({ ctx, token = null, now = Date.now() }) {
  const want = wantedNow(ctx.root, now);
  const out = { changed: false, active: want.active, readMatcher: want.readMatcher, pendingLower: false };
  // An unreadable rules file: raise when guards.active says rules exist, never lower.
  if (!want.sure && !want.active) return { ...out, why: "the rules file is unreadable, so the rules check was left as it is" };
  const mayLower = want.sure && Boolean(token) && (await import("../memory/review-service.mjs")).isReviewToken(token);
  const opened = openLedger2ForWrite(ctx.root);
  if (opened.refuse) return { ...out, why: opened.refuse };
  const ledger = opened.ledger;
  const items = ledger.items.filter((i) => i.host === "claude-code" && i.kind === "hook" && i.locator?.event === "tool.before" && typeof i.file === "string" && path.isAbsolute(i.file));
  const why = [];
  let failed = false;
  let ledgerChanged = false;
  for (const file of [...new Set(items.map((i) => i.file))]) {
    // One file's failure leaves the others switched (and their ledger items recorded).
    try {
      const r = await switchFile(file, items.filter((i) => samePath(i.file, file)), { want, mayLower, out, persist: () => writeLedger2(ctx.root, ledger) });
      if (r.why) why.push(r.why);
      failed ||= Boolean(r.failed);
      ledgerChanged ||= Boolean(r.ledgerChanged);
    } catch (e) {
      why.push(`couldn't switch ${file}: ${e?.message ?? e}`);
      failed = true;
    }
  }
  if (ledgerChanged) {
    try {
      await writeLedger2(ctx.root, ledger);
    } catch (e) {
      why.push(`couldn't record the rules check's resting values: ${e?.message ?? e}`);
      failed = true;
    }
  }
  if (failed && !want.active && mayLower) why.push("the next review in your own terminal retries it");
  if (why.length) out.why = why.join("; ");
  return record(ctx.root, out, now, failed);
}

// One settings file: the ops, a re-read to catch a race, the checked write. A raise's `orig`
// is in the ledger before the settings change (a lost ledger write must never leave an entry
// raised with nothing to put back); a lowering clears it once the write is done.
async function switchFile(file, items, { want, mayLower, out, persist }) {
  const t = inspect(file);
  if (!t.exists) return {};
  const p = parseSettings(t.text);
  if (!p.ok) return { why: `couldn't read ${file}: ${p.error}`, failed: true };
  const ops = [];
  const pre = [];
  const after = [];
  let why = null;
  for (const item of items) {
    let orig = item.orig ?? null;
    for (const f of locateHook(p.root, item.locator)) {
      const at = ["hooks", item.locator.hostEvent, f.gi];
      const h = f.handler;
      const n = ops.length;
      if (want.active) {
        // The values before the first raise, kept until a tokened run puts them back (absence included).
        const first = orig ?? { onFailure: hasOwn(h, "onFailure") ? h.onFailure : null, timeout: hasOwn(h, "timeout") ? h.timeout : null, matcher: f.matcher ?? null, had: { onFailure: hasOwn(h, "onFailure"), timeout: hasOwn(h, "timeout"), matcher: f.matcher !== null } };
        if (h.onFailure !== "block") ops.push({ path: [...at, "hooks", f.hi, "onFailure"], value: "block" });
        if (!(Number.isFinite(h.timeout) && h.timeout >= BLOCK_TIMEOUT)) ops.push({ path: [...at, "hooks", f.hi, "timeout"], value: BLOCK_TIMEOUT });
        // Read in the matcher while an env-read policy rule is in force. A group the entry
        // shares with other handlers keeps its matcher (they would run for Read too).
        let readAdded = Boolean(first.readAdded);
        if (want.readMatcher && !coversRead(f.matcher)) {
          if (f.groupSize > 1) why = `ad's rules check in ${file} shares its group with other hooks, so ad left the group's matcher: Read isn't checked there`;
          else {
            ops.push({ path: [...at, "matcher"], value: withRead(f.matcher) });
            readAdded = true;
          }
        } else if (!want.readMatcher && readAdded) {
          if (!mayLower) out.pendingLower = true;
          else {
            if (String(f.matcher ?? "").split("|").includes("Read")) ops.push({ path: [...at, "matcher"], value: withoutRead(f.matcher) });
            readAdded = false;
          }
        }
        if (ops.length > n || (orig && readAdded !== Boolean(orig.readAdded))) {
          const next = { ...first, ...(readAdded ? { readAdded: true } : {}) };
          if (!readAdded) delete next.readAdded;
          orig = next;
          pre.push(() => (item.orig = next));
        }
      } else if (orig) {
        // Back only what ad raised: a field the user changed since keeps their value.
        const back = restoreOps({ ...item, orig }, f, { blockTimeout: BLOCK_TIMEOUT });
        if (!mayLower) {
          if (back.length) out.pendingLower = true;
          continue;
        }
        ops.push(...back);
        after.push(() => delete item.orig);
      }
    }
    // Recorded but no longer in the file: nothing to put back.
    if (!want.active && mayLower && item.orig && !locateHook(p.root, item.locator).length) after.push(() => delete item.orig);
  }
  if (!ops.length) {
    for (const f of [...pre, ...after]) f();
    return { why, ledgerChanged: pre.length + after.length > 0 };
  }
  const bad = t.readOnly ? "it is read-only" : !Buffer.from(t.text, "utf8").equals(t.bytes) ? "it isn't UTF-8 text" : null;
  if (bad) return { why: `couldn't switch ${file}: ${bad}`, failed: true };
  const text = p.bom + applyOps(p.body, ops).text;
  // Changed under us since the read: leave it (the next run switches it).
  const again = inspect(file);
  if (!again.exists || !Buffer.from(again.bytes).equals(Buffer.from(t.bytes))) return { why: `couldn't switch ${file}: it changed while ad was switching it`, failed: true };
  if (pre.length) {
    const before = items.map((i) => [i, i.orig]);
    for (const f of pre) f();
    try {
      await persist();
    } catch (e) {
      for (const [i, o] of before) if (o === undefined) delete i.orig;
      else i.orig = o;
      return { why: `couldn't record the rules check's resting values, so ${file} was left as it is: ${e?.message ?? e}`, failed: true };
    }
  }
  await writeChecked(t.realFile ?? file, text, t.bytes);
  out.changed = true;
  for (const f of after) f();
  return { why, ledgerChanged: after.length > 0 };
}

function record(root, out, now, failed = false) {
  // What the snapshot asked for when this ran; pendingLower: a lowering is waiting for the
  // token (a tokenless run can't do it, so it isn't due again; doctor says so); failed: a
  // file couldn't be switched (due again).
  const rec = { at: new Date(now).toISOString(), active: out.active, readMatcher: out.readMatcher, pendingLower: out.pendingLower, ...(failed ? { failed: true } : {}) };
  try {
    fs.mkdirSync(path.dirname(switchPath(root)), { recursive: true });
    fs.writeFileSync(switchPath(root), JSON.stringify(rec));
  } catch {
    // no record: switchDue says a switch is due
  }
  return out;
}

export { itemId };
