// doctor's rules rows (MCP launch plan L7, design D21): the rules, their pauses and orphans,
// the snapshot against the store, the sentinel, the rule switch against the rules, the guard
// copy, Codex on Windows and Codex's sandbox, the per-host limits and the events log. No row
// names a command that lowers enforcement: an agent's shell may run doctor (S4).
//
//   rulesChecks(ctx, { now, platform, openStore }) → [{ code, ok, note, host? }]

import fs from "node:fs";
import path from "node:path";
import { activeRuleCount, loadGuards, readActive } from "../hooks/guards.mjs";
import { ruleEventsPath } from "../hooks/rule-events.mjs";
import { readGuard } from "../memory/launch/dists.mjs";
import { RULES_LIMITS } from "../memory/rules-read.mjs";
import { copyIntact, manifestSha } from "./guard-copy.mjs";
import { readLedger2 } from "./ledger2.mjs";
import { readSwitchRecord, wantedNow } from "./rule-switch.mjs";

const at = (iso) => String(iso).slice(0, 16).replace("T", " ");
const live = (p, now) => Boolean(p && typeof p === "object" && typeof p.at === "string" && (p.until === null || Date.parse(p.until) > now));
const until = (p) => (p.until === null ? "until resumed" : `until ${at(p.until)}`);

/** The store's rules side: { count, orphaned, ids, storeId } or null (no store, no rules table). */
async function storeSide(root, openStore) {
  const file = path.join(root, "episodic.db");
  if (!openStore && !fs.existsSync(file)) return null;
  let h = null;
  try {
    h = openStore ? await openStore() : await (await import("../memory/sqlite.mjs")).open({ dbPath: file });
    if (!h) return null;
    const rows = h.all("SELECT id, orphaned_at FROM rules");
    let storeId = null;
    try {
      storeId = h.get("SELECT value FROM memory_settings WHERE key = 'store_id'")?.value ?? null;
    } catch {
      // an older store
    }
    return { count: rows.length, orphaned: rows.filter((r) => r.orphaned_at).length, ids: new Set(rows.map((r) => r.id)), storeId };
  } catch {
    return null;
  } finally {
    try {
      if (!openStore) h?.close?.();
    } catch {
      // closed already
    }
  }
}

export async function rulesChecks(ctx, { now = Date.now(), platform = ctx.platform ?? process.platform, openStore } = {}) {
  const rows = [];
  const add = (code, ok, note, host) => rows.push({ code, ok, note, ...(host ? { host } : {}) });
  const root = ctx.root;
  const { snapshot, source } = loadGuards({ root });
  const sentinel = readActive({ root });
  const all = snapshot ? [...(snapshot.global?.rules ?? []), ...Object.values(snapshot.projects ?? {}).flatMap((p) => p?.rules ?? [])] : [];
  const n = all.length;

  // The rules, and what is paused.
  if (snapshot) {
    const paused = [];
    if (live(snapshot.pausedAll, now)) paused.push(`all ${until(snapshot.pausedAll)}`);
    const projects = Object.entries(snapshot.projects ?? {}).filter(([, p]) => live(p?.paused, now));
    if (projects.length) paused.push(`${projects.length} project${projects.length === 1 ? "" : "s"} (${projects.map(([, p]) => until(p.paused)).join(", ")})`);
    const active = activeRuleCount(snapshot, now);
    add("rules.count", true, n ? `${n} rule${n === 1 ? "" : "s"}, ${active} in force${paused.length ? `; paused: ${paused.join("; ")}` : ""}` : "no rules");
  } else add("rules.count", true, sentinel ? "the rules file can't be read (see Rules file)" : "no rules");

  // The snapshot against the store: the store's id and rules the snapshot holds but the store lacks.
  const store = await storeSide(root, openStore);
  if (store) {
    const orphaned = store.orphaned ? `; ${store.orphaned} whose learning is gone (each waits for your review to be removed)` : "";
    if (snapshot && source === "current") {
      const missing = all.filter((r) => r && r.id !== undefined && !store.ids.has(r.id)).length;
      const otherStore = snapshot.store_id && store.storeId && snapshot.store_id !== store.storeId;
      const ok = !missing && !otherStore;
      add("rules.store", ok, otherStore ? "the rules file was built from another memory store: rules from it still apply until your next review rebuilds it" : missing ? `the rules file holds ${missing} rule${missing === 1 ? "" : "s"} the store doesn't have: they still apply until your next review rebuilds it` : `the store has ${store.count} rule${store.count === 1 ? "" : "s"}${orphaned}`);
    } else add("rules.store", true, `the store has ${store.count} rule${store.count === 1 ? "" : "s"}${orphaned}`);
  }

  // The sentinel (D3): present while rules exist, so an unreadable rules file never reads as none.
  if (snapshot && source === "current") {
    const ok = n > 0 ? sentinel !== null : true;
    add("rules.sentinel", ok, n > 0 ? (sentinel !== null ? "present" : "missing although rules exist: run repair") : sentinel !== null ? "present from earlier rules (removed by your next review)" : "none (no rules)");
  }

  // The rule switch (D13): ad's tool.before fails closed while rules exist; the record says what it applied.
  const want = wantedNow(root, now);
  const rec = readSwitchRecord(root);
  const claude = readLedger2(root).items.filter((i) => i.host === "claude-code" && i.kind === "hook" && i.locator?.event === "tool.before");
  if (claude.length) {
    if (rec?.failed) add("rules.switch", false, "ad couldn't switch its rules check the last time the rules changed: run repair (it raises it); a lowering waits for your next review");
    else if (!rec) add("rules.switch", !want.active, want.active ? "no record of the switch although rules exist: run repair" : "no rules yet: the check stays as setup wrote it");
    else if (rec.active !== want.active && want.active) add("rules.switch", false, "rules exist but ad's rules check isn't fail-closed yet: run repair");
    else if (rec.pendingLower || (rec.active && !want.active)) add("rules.switch", true, "no rule is left, but ad's rules check still fails closed: your next review in your own terminal puts it back");
    else add("rules.switch", true, want.active ? `fail-closed${want.readMatcher ? ", Read included" : ""} (from your next session after a change)` : "resting values (no rules)");
  }

  // The guard copy the rules check runs (D10).
  const g = readGuard(root);
  if (g.missing) {
    if (n) add("rules.guard", false, "no guard copy recorded although rules exist: run repair");
  } else if (g.unreadable) add("rules.guard", false, `the guard record is ${g.unreadable}: run repair`);
  else if (g.route === "npm") {
    const intact = copyIntact(g.path) && manifestSha(g.path) === g.manifestSha256;
    add("rules.guard", intact, intact ? `${g.distVersion} (manifest verified)` : `${g.distVersion}: its files don't match the manifest ad recorded, so the rules check decides without it: run repair`);
  } else add("rules.guard", true, `${g.distVersion} from ${g.path} (ad's clone)`);

  // Codex on Windows: tool.before arrives with the first rule (C-L3-CODEXWIN).
  const codex = readLedger2(root).items.filter((i) => i.host === "codex" && i.kind === "hook");
  if (platform === "win32" && codex.length && !codex.some((i) => i.locator?.event === "tool.before")) {
    add("rules.codex-windows", !n, n ? "Codex on Windows has no rules check yet although rules exist: run setup" : "Codex on Windows gets ad's rules check with your first rule (until then no rule or self-protection check runs there)", "codex");
  }
  // Codex's sandbox: a hook runs outside it, but full access lets the agent do what a rule can't see.
  if (codex.length && n) {
    try {
      const { codexConfigFile, safeToml } = await import("./setup-codex.mjs");
      const mode = safeToml(fs.readFileSync(codexConfigFile(ctx), "utf8")).doc?.sandbox_mode ?? null;
      if (mode) add("rules.codex-sandbox", true, `sandbox_mode = ${mode}${mode === "danger-full-access" ? ": rules see the shell and patch calls only; anything else runs unchecked" : ""}`, "codex");
    } catch {
      // no config.toml, or unreadable: nothing to say
    }
  }

  if (n) add("rules.limits", true, RULES_LIMITS);

  // The events log (capped at 256 KB with one rotation).
  try {
    const size = [ruleEventsPath(root), `${ruleEventsPath(root)}.1`].reduce((s, f) => s + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
    if (size) add("rules.events", true, `${Math.round(size / 1024)} KB (kept under 512 KB)`);
  } catch {
    // unreadable: nothing to say
  }
  return rows;
}
