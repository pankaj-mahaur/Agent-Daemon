// `ad auth` commands over the account list (P3.8a). One function per command; auth.mjs
// dispatches and keeps 3.0's engine-side commands (ChatGPT sign-in, `logout` alone).
//
//   resolveAccount(doc, ref)        id → provider/label → a provider with one account →
//                                   a label used once; ACCOUNT_NOT_FOUND / ACCOUNT_AMBIGUOUS
//   accountJson(a, ctx)             the documented JSON shape, built from an allowlist
//   cmdList / cmdUse / cmdRename / cmdLogoutAccount / cmdRemove / cmdStatusAccount
// Account changes refuse in the agent's own shell (AD_TOOL_SHELL=1, D49): an accident or a
// naive injection can't add, pick, rename, sign out or remove accounts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { writeFileAtomicSync } from "../atomic-json.mjs";
import { engineHome } from "../engine/index.mjs";
import { createInterface } from "node:readline";
import { readRegistry, transact } from "../auth/accounts/registry.mjs";
import { createAccountService } from "../auth/accounts/service.mjs";
import { accountName, providerDisplay } from "../auth/accounts/target.mjs";
import { listModels } from "../providers/models.mjs";
import { presetFor, PROVIDER_PRESETS } from "../providers/registry.mjs";
import { lastUpstream } from "./gateway-runtime.mjs";
import { AUTH_TEXTS } from "./auth-texts.mjs";
import { listLines } from "./auth-list-view.mjs";
import { defaultLockDir, liveLocks } from "../lock.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { fromChatgpt, readStore, recordObservations } from "../providers/quota.mjs";
import { listCell, quotaJson, quotaView } from "../providers/quota-view.mjs";
import { refreshOpenRouterKey } from "../providers/upstream.mjs";

const fail = (code, message, exit = 1) => Object.assign(new Error(message), { code, exit });
const refOf = (a) => `${a.provider}/${a.label}`;
const PROVIDER_ORDER = ["chatgpt", ...PROVIDER_PRESETS.map((p) => p.id)];

/** The account a reference names, in the documented order. */
export function resolveAccount(doc, ref) {
  const r = String(ref ?? "").trim();
  const all = (doc.accounts ?? []).filter((a) => a.status !== "removing");
  const lower = r.toLowerCase();
  const byId = all.find((a) => a.id === r);
  if (byId) return byId;
  const slash = lower.indexOf("/");
  if (slash > 0) {
    const hit = all.find((a) => a.provider === lower.slice(0, slash) && String(a.label).toLowerCase() === lower.slice(slash + 1));
    if (hit) return hit;
    throw fail("ACCOUNT_NOT_FOUND", AUTH_TEXTS.ACCOUNT_NOT_FOUND(r, all.map(refOf)));
  }
  const ofProvider = all.filter((a) => a.provider === lower);
  if (ofProvider.length === 1) return ofProvider[0];
  if (ofProvider.length > 1) throw fail("ACCOUNT_AMBIGUOUS", AUTH_TEXTS.ACCOUNT_AMBIGUOUS(r, ofProvider.map(refOf)));
  const byLabel = all.filter((a) => String(a.label).toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw fail("ACCOUNT_AMBIGUOUS", AUTH_TEXTS.ACCOUNT_AMBIGUOUS(r, byLabel.map(refOf)));
  throw fail("ACCOUNT_NOT_FOUND", AUTH_TEXTS.ACCOUNT_NOT_FOUND(r, all.map(refOf)));
}

/** D49: account changes refuse in the agent's own shell. */
export function refuseInToolShell(env = process.env) {
  if (env.AD_TOOL_SHELL === "1") throw fail("TOOL_SHELL", AUTH_TEXTS.TOOL_SHELL, 2);
}

const maskEmail = (e) => {
  if (!e || !String(e).includes("@")) return e ?? null;
  const [u, d] = String(e).split("@");
  return `${u.slice(0, 1)}***@${d}`;
};

/**
 * One account for --json, from an allowlist: never the credential (secret ref, home
 * path), the salt, an identity key, an attempt or a full email. Later parts extend it here.
 */
export function accountJson(a, { defaultId = null, upstream = lastUpstream, quota = () => null } = {}) {
  const obs = upstream(a.id);
  return {
    id: a.id,
    provider: a.provider,
    providerName: providerDisplay(a.provider),
    label: a.label,
    owner: a.owner ?? "",
    method: a.method,
    identity: a.identity ? { email: maskEmail(a.identity.email), plan: a.identity.plan ?? null, workspace: a.identity.workspace ?? null } : null,
    keyHint: a.keyHint ?? null,
    credentialRevision: a.credentialRevision ?? 1,
    status: a.status,
    statusDetail: a.statusDetail ?? null,
    endpoint: a.endpoint ?? null,
    defaultModel: a.defaultModel ?? null,
    isDefault: a.id === defaultId,
    createdAt: a.createdAt ?? null,
    lastUsedAt: a.lastUsedAt ?? null,
    lastUpstream: obs ? { status: obs.status ?? null, retryAfterS: obs.retryAfterS ?? null, at: obs.at ?? null } : null,
    quota: quotaJson(quota(a)),
  };
}

export function listJson(doc, ctx = {}) {
  const t = doc.defaults?.target ?? null;
  return {
    schemaVersion: 1,
    defaults: { target: t ? { account: t.account ?? null, model: t.model ?? null, effort: t.effort ?? null, source: "global" } : null },
    accounts: (doc.accounts ?? []).filter((a) => a.status !== "removing").map((a) => accountJson(a, { ...ctx, defaultId: t?.account ?? null })),
  };
}

// The live engines' homes (P0.3 leases), in any ad window on this machine.
function liveEngineHomes() {
  return new Set(liveLocks({ dir: defaultLockDir() }).filter((h) => h.kind === "engine" && h.home).map((h) => engineHome.canonical(h.home)));
}
const signedIn = (a) => a.method === "engine-login" || a.credential?.kind === "engine-home";

// A ChatGPT sign-in's limits through its own engine (--refresh=all), started and stopped here.
async function readSignInLimits(a, { store } = {}) {
  const { closeHarnessEngines, launchHarness } = await import("./engines.mjs");
  const sink = { write: () => true };
  const h = await launchHarness({ cwd: os.tmpdir(), account: a.id, store, err: sink, purpose: "limits" });
  try {
    return await h.engine.usage.limits();
  } finally {
    await h.release();
    await closeHarnessEngines();
  }
}

/**
 * --refresh (P4.6): OpenRouter's /key for each OpenRouter key now, in parallel (5 s each).
 * --refresh=all also asks each ChatGPT sign-in's engine, one at a time, and only for a home no
 * window holds: never a second engine on a live home.
 */
export async function refreshLimits(accounts, { out, all = false, store, fetch, clientVersion, doc = readRegistry(), liveHomes = liveEngineHomes, readLimits = readSignInLimits, root } = {}) {
  await Promise.all(
    accounts
      .filter((a) => a.provider === "openrouter")
      .map((a) => refreshOpenRouterKey(a, { store, fetch, clientVersion, ...(root ? { root } : {}) }).catch((e) => out.write(`${a.label}: OpenRouter didn't answer${e?.status ? ` (HTTP ${e.status})` : ""}; showing the last known.\n`))),
  );
  const signIns = accounts.filter(signedIn);
  if (!signIns.length) return;
  if (!all) return void out.write("ChatGPT limits come from a running window; ad auth list --refresh=all checks them now.\n");
  const { homeKeyFor, homePathFor } = await import("./engines.mjs");
  const live = liveHomes();
  for (const a of signIns) {
    // The sign-in's own home ("@default", "a/<id>"), else where ad would run it.
    const key = a.credential?.kind === "engine-home" && a.credential.home ? a.credential.home : homeKeyFor({ account: a.id }, doc);
    const home = engineHome.canonical(homePathFor(key) ?? engineHome.defaultPath());
    if (live.has(home)) {
      out.write(`${a.label}: in use in another window; showing the last known.\n`);
      continue;
    }
    out.write(`Checking ${accountName(a)} (starts its engine)…\n`);
    const snap = await readLimits(a, { store }).catch(() => null);
    if (snap) await recordObservations(fromChatgpt(snap.rateLimits ?? snap, { accountId: a.id, source: "chatgpt:rateLimits/read" }), root ? { root } : {});
  }
}

export async function cmdList({ out, json = false, provider = null, wide = false, width = process.stdout.columns ?? 80, upstream = lastUpstream, refresh = false, refreshAll = false, store, fetch, clientVersion, now = Date.now(), refreshOpts = {} }) {
  const doc = readRegistry();
  const pick = (a) => a.status !== "removing" && (!provider || a.provider === String(provider).toLowerCase());
  if (refresh) await refreshLimits(doc.accounts.filter(pick), { out: json ? { write: () => true } : out, all: refreshAll, store: store ?? createSecretStore(), fetch, clientVersion, doc, ...refreshOpts });
  // Limits as last seen (P4.6): the QuotaStore, read once.
  const qs = readStore();
  const quota = (a) => quotaView(a.id, { store: qs, now, provider: a.provider });
  if (json) {
    const j = listJson(doc, { upstream, quota });
    j.accounts = j.accounts.filter((a) => !provider || a.provider === String(provider).toLowerCase());
    out.write(`${JSON.stringify(j, null, 2)}\n`);
    return 0;
  }
  const accounts = doc.accounts.filter(pick);
  if (!accounts.length) {
    out.write("No accounts yet. Add one: ad auth login <provider> (see: ad auth login --help)\n");
    return 0;
  }
  const lines = listLines(accounts, { width, wide, defaultId: doc.defaults?.target?.account ?? null, upstream, limits: (a) => listCell(quota(a), now), providerOrder: PROVIDER_ORDER, nameOf: providerDisplay, now });
  out.write(`${lines.join("\n")}\n`);
  return 0;
}

const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
/** The lines that set a variable in this terminal: PowerShell and cmd on Windows (and Git Bash's), export elsewhere. */
export function shellLines(name, value, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return [`export ${name}=${sq(value)}`];
  const lines = [`PowerShell:  $env:${name} = "${String(value).replace(/[`"$]/g, "`$&")}"`, `cmd:         set "${name}=${value}"`];
  if (env.MSYSTEM) lines.push(`Git Bash:    export ${name}=${sq(value)}`);
  return lines;
}

export async function cmdUse(ref, { out, model = null, effort = null, scope = "global", cwd = process.cwd(), store, fetch, platform = process.platform, env = process.env, clientVersion, home = os.homedir() } = {}) {
  const doc = readRegistry();
  const a = resolveAccount(doc, ref);
  if (a.status !== "ready") {
    const { TARGET_TEXTS } = await import("../auth/accounts/target.mjs");
    throw fail("TARGET_NOT_READY", TARGET_TEXTS.TARGET_NOT_READY(a));
  }
  const name = accountName(a);
  // A model the provider doesn't list is a warning, never a refusal (it may still work).
  if (model && a.method !== "engine-login" && a.method !== "api-key-engine") {
    try {
      const key = a.credential?.kind === "secret" ? store?.get(a.credential.ref) : null;
      const models = await listModels(a, { key, fetch, clientVersion });
      if (models.length && !models.some((m) => m.id === model)) out.write(`${AUTH_TEXTS.MODEL_UNLISTED(providerDisplay(a.provider), model)}\n`);
    } catch {
      // unreachable: nothing to check against
    }
  }
  if (scope === "session") {
    const lines = [...shellLines("AD_ACCOUNT", refOf(a), { platform, env }), ...(model ? shellLines("AD_MODEL", model, { platform, env }) : [])];
    out.write(`${AUTH_TEXTS.USE_SESSION}\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
    return 0;
  }
  if (scope === "project") {
    const file = projectSelectorFile(cwd, { home });
    let cfg = {};
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st) {
      if (!st.isFile()) throw fail("PROJECT_FILE", AUTH_TEXTS.PROJECT_NOT_FILE(file));
      try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw fail("PROJECT_FILE", AUTH_TEXTS.PROJECT_BAD_JSON(file));
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw fail("PROJECT_FILE", AUTH_TEXTS.PROJECT_BAD_JSON(file));
    }
    // Names only: never an id or a credential (the file may be shared with a project).
    cfg.target = { provider: a.provider, label: a.label, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
    out.write(`${AUTH_TEXTS.USE_PROJECT(name, a.label, providerDisplay(a.provider))}\n`);
    return 0;
  }
  if (scope === "digest") {
    await transact((d) => {
      d.defaults.digest = a.id;
    });
    out.write(`${AUTH_TEXTS.USE_DIGEST(name)}\n`);
    return 0;
  }
  await transact((d) => {
    d.defaults.target = { account: a.id, model: model ?? a.defaultModel ?? null, effort: effort ?? null };
  });
  out.write(`${AUTH_TEXTS.USE_GLOBAL(name, model ?? a.defaultModel)}\n`);
  return 0;
}

/**
 * The selector file `use --project` writes: the nearest one above cwd that a launch would
 * read, else cwd's own. Never in the home folder or ad's own folder, never through a link.
 */
export function projectSelectorFile(cwd, { home = os.homedir(), root = adRoot() } = {}) {
  const stop = engineHome.canonical(home);
  const own = engineHome.canonical(root);
  const start = path.resolve(cwd);
  const refuse = (dir) => engineHome.canonical(dir) === stop || engineHome.canonical(path.join(dir, ".agent-daemon")) === own;
  if (refuse(start)) throw fail("PROJECT_FILE", AUTH_TEXTS.PROJECT_NOT_HERE);
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (refuse(dir)) break;
    const f = path.join(dir, ".agent-daemon", "config.json");
    if (fs.existsSync(f)) return checkNoLink(dir, f);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return checkNoLink(start, path.join(start, ".agent-daemon", "config.json"));
}

function checkNoLink(dir, file) {
  for (const p of [path.join(dir, ".agent-daemon"), file]) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw fail("PROJECT_FILE", AUTH_TEXTS.PROJECT_LINK(p));
  }
  return file;
}

export async function cmdRename(ref, newLabel, { out, owner, store } = {}) {
  const a = resolveAccount(readRegistry(), ref);
  const service = createAccountService({ store });
  const x = await service.rename(a.id, { label: newLabel ?? undefined, owner: owner ?? undefined });
  out.write(`${AUTH_TEXTS.RENAMED(accountName(x), x.owner && x.owner !== x.label ? x.owner : null)}\n`);
  return 0;
}

/** Sign out one key account: its key goes, the record stays (needs-sign-in). → null when not a key account. */
export async function cmdLogoutAccount(ref, { out, store } = {}) {
  const a = resolveAccount(readRegistry(), ref);
  if (a.credential?.kind !== "secret") return { account: a, handled: false };
  store.delete(a.credential.ref);
  await createAccountService({ store }).setStatus(a.id, "needs-sign-in", "signed out");
  out.write(`${AUTH_TEXTS.SIGNED_OUT_KEY(accountName(a), providerDisplay(a.provider))}\n`);
  return { account: a, handled: true };
}

async function askYes(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const a = await new Promise((resolve) => rl.question(prompt, resolve));
    return /^\s*y/i.test(a);
  } finally {
    rl.close();
  }
}

export async function cmdRemove(ref, { out, err, yes = false, store, stdin = process.stdin, cwd = process.cwd(), ask = askYes } = {}) {
  const doc = readRegistry();
  const a = resolveAccount(doc, ref);
  const name = accountName(a);
  // ChatGPT accounts: the one in the main engine folder signs out there; the rest come with P3.7.
  if (a.method === "engine-login" || a.credential?.kind === "engine-home") throw fail("REMOVE_REFUSED", a.credential?.home === "@default" || !a.credential?.home ? AUTH_TEXTS.DEFAULT_HOME_KEPT : AUTH_TEXTS.CHATGPT_LATER);
  if (!yes) {
    if (!stdin.isTTY) throw fail("NEEDS_YES", AUTH_TEXTS.NEEDS_YES);
    const ok = await ask(a.credential?.kind === "secret" ? AUTH_TEXTS.REMOVE_ASK_KEY(name) : AUTH_TEXTS.REMOVE_ASK(name), { stdin, stderr: err });
    if (!ok) {
      out.write("Nothing removed.\n");
      return 1;
    }
  }
  const wasDefault = doc.defaults?.target?.account === a.id;
  await createAccountService({ store }).remove(a.id);
  out.write(`${AUTH_TEXTS.REMOVED(name)}\n`);
  if (wasDefault) out.write(`${AUTH_TEXTS.REMOVED_DEFAULT}\n`);
  const sel = path.join(cwd, ".agent-daemon", "config.json");
  try {
    const t = JSON.parse(fs.readFileSync(sel, "utf8"))?.target;
    if (t?.provider === a.provider && String(t.label).toLowerCase() === String(a.label).toLowerCase()) out.write(`${AUTH_TEXTS.REMOVED_PROJECT(sel)}\n`);
  } catch {
    // no project selector here
  }
  return 0;
}

export function cmdStatusAccount(ref, { out, json = false, upstream = lastUpstream } = {}) {
  const doc = readRegistry();
  const a = resolveAccount(doc, ref);
  const j = accountJson(a, { defaultId: doc.defaults?.target?.account ?? null, upstream });
  if (json) {
    out.write(`${JSON.stringify(j, null, 2)}\n`);
    return 0;
  }
  const rows = [
    ["account:", `${accountName(a)}${j.isDefault ? " (default)" : ""}`],
    ["status:", `${j.status}${j.statusDetail ? ` (${j.statusDetail})` : ""}`],
    ["method:", j.method],
    ...(j.keyHint ? [["key:", `…${j.keyHint}`]] : []),
    ...(j.identity?.email ? [["signed in as:", `${j.identity.email}${j.identity.plan ? ` · ${j.identity.plan}` : ""}`]] : []),
    ...(j.endpoint ? [["endpoint:", j.endpoint]] : []),
    ...(j.defaultModel ? [["model:", j.defaultModel]] : []),
    ["last used:", j.lastUsedAt ?? "never"],
    ["last answer:", j.lastUpstream ? `HTTP ${j.lastUpstream.status}${j.lastUpstream.retryAfterS ? `, retry after ${j.lastUpstream.retryAfterS} s` : ""}` : "none this run"],
  ];
  for (const [k, v] of rows) out.write(`${k.padEnd(16)}${v}\n`);
  return 0;
}

/** The status block after 3.0's two lines. */
export function statusSummary(store) {
  const doc = readRegistry();
  const live = doc.accounts.filter((a) => a.status !== "removing");
  const t = doc.defaults?.target;
  const def = t?.account ? live.find((a) => a.id === t.account) : null;
  const by = (s) => live.filter((a) => a.status === s).length;
  const parts = [`${by("ready")} ready`, by("needs-sign-in") && `${by("needs-sign-in")} need${by("needs-sign-in") === 1 ? "s" : ""} sign-in`, by("error") && `${by("error")} error`].filter(Boolean);
  return {
    active: def ? `${accountName(def)}${t.model ?? def.defaultModel ? `, model ${t.model ?? def.defaultModel}` : ""} (global default)` : null,
    lines: [`${"accounts:".padEnd(16)}${live.length}${live.length ? ` (${parts.join(", ")}). List them: ad auth list` : ". Add one: ad auth login <provider>"}`, `${"secret store:".padEnd(16)}${store.backend}`],
  };
}

export { presetFor };
