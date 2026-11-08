// `agent-daemon-memory doctor` (P5.3): is memory set up and working in each
// host the installer set up? Each check has a stable code for --json.
//   node.version node.path sqlite.driver db.open db.schema db.stray
//   per host: config.parse entry command.exists smoke.legacy smoke.modern
//             capture.double entry.duplicate; pkg.stale

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { availableDrivers } from "../memory/driver.mjs";
import { HOSTS, SERVER_NAME, claudeHasAdHooks, claudePluginEnabled, hostById } from "./hosts.mjs";
import { readLedger } from "./ledger.mjs";
import { inspect } from "./fsx.mjs";
import { jsonEntry } from "./edit-json.mjs";
import { claudeGet } from "./claude-cli.mjs";
import { currentDist, makeContext } from "./install.mjs";
import { codexTrust } from "./setup.mjs";
import { PRODUCT } from "../product.mjs";

const MIN_NODE = [22, 13];
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

const nodeOk = (v) => {
  const [a, b] = v.split(".").map(Number);
  return a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]);
};
const newer = (a, b) => {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** Start the entry the host would start, send `requests`, collect answers by id. */
export function smoke(entry, requests, { cwd, env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(entry.command, entry.args, { cwd, env: { ...env, ...(entry.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ error: e.message });
      return;
    }
    const want = new Set(requests.map((r) => r.id));
    const got = {};
    let buf = "";
    let err = "";
    const done = (extra) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // gone
      }
      resolve({ got, stderr: err.slice(-400), ...extra });
    };
    const timer = setTimeout(() => done({ error: "no answer in time" }), timeoutMs);
    child.on("error", (e) => done({ error: e.message }));
    child.stderr.on("data", (c) => (err += c));
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined) {
            got[m.id] = m;
            want.delete(m.id);
            if (!want.size) done();
          }
        } catch {
          // not ours
        }
      }
    });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}

const listsTools = (r) => Array.isArray(r?.result?.tools) && r.result.tools.some((t) => t.name === "memory_search");

export async function doctor(opts = {}) {
  const ctx = opts.ctx ?? makeContext(opts);
  const checks = [];
  const add = (code, ok, note, host) => checks.push({ code, ok, note, ...(host ? { host } : {}) });

  add("node.version", nodeOk(process.versions.node), `Node ${process.versions.node}${nodeOk(process.versions.node) ? "" : ` (needs ${MIN_NODE.join(".")} or newer)`}`);
  const drivers = await availableDrivers();
  add("sqlite.driver", drivers.length > 0, drivers.length ? drivers.join(", ") : "no SQLite driver: needs Node 22.16+ (node:sqlite with full-text search)");
  try {
    const { open } = await import("../memory/sqlite.mjs");
    const db = await open({ dbPath: path.join(ctx.root, "episodic.db"), prefer: "node:sqlite" });
    add("db.open", Boolean(db), db ? `${ctx.display(db.path)} (${db.driver})` : "no driver");
    if (db) {
      const v = db.get("SELECT MAX(version) AS v FROM schema_version")?.v;
      add("db.schema", v >= 2, `schema version ${v}`);
      db.close();
    }
  } catch (e) {
    add("db.open", false, e.message);
  }
  const stray = path.join(opts.cwd ?? process.cwd(), "episodic.db");
  add("db.stray", !fs.existsSync(stray), fs.existsSync(stray) ? `${stray} is a memory database an older version left in this folder; ad's own is in ${ctx.display(ctx.root)}` : "none in this folder");

  const ledger = readLedger(ctx.root);
  for (const [id, rec] of Object.entries(ledger.hosts)) {
    if (Array.isArray(rec.entry?.args) && rec.entry.args.some((a) => /[\\/]memory[\\/]bin[\\/]launch\.mjs$/.test(String(a)))) {
      // Claude Code with the plugin on: install leaves its entry alone (one route per host), so the old one goes.
      const fix = id === "claude-code" && claudePluginEnabled(ctx.home, ctx.env) ? "the plugin serves memory now: run uninstall --host claude-code to remove it" : "run install to move it to the stable one";
      add("entry.legacy", false, `still starts 3.1.0's launcher (memory/bin/launch.mjs): ${fix}`, id);
    }
    const host = hostById(id);
    if (!host) continue;
    const entry = rec.entry;
    if (rec.driver === "file") {
      const t = inspect(rec.file);
      if (!t.exists) {
        add("config.parse", false, `${ctx.display(rec.file)} is gone`, id);
        continue;
      }
      let current;
      if (host.driver === "toml") {
        try {
          const { parse } = await import("smol-toml");
          current = parse(t.text)?.mcp_servers?.[SERVER_NAME];
          add("config.parse", true, ctx.display(rec.file), id);
        } catch (e) {
          add("config.parse", false, `${ctx.display(rec.file)}: ${String(e.message).split("\n")[0]}`, id);
          continue;
        }
      } else {
        const j = jsonEntry(t.text);
        add("config.parse", j.ok, j.ok ? ctx.display(rec.file) : `${ctx.display(rec.file)}: ${j.error}`, id);
        if (!j.ok) continue;
        current = j.entry;
      }
      add("entry", current !== undefined, current === undefined ? "ad's entry is missing: run repair" : "present", id);
    } else {
      const resolved = ctx.resolve("claude");
      const got = resolved ? await claudeGet(resolved, entry?.args?.[1], ctx.claudeOpts) : { present: false, out: "claude isn't on PATH" };
      add("entry", got.present, got.present ? "claude mcp get shows it" : "claude mcp get doesn't show it: run repair", id);
    }
    if (!entry) continue;
    add("node.path", fs.existsSync(entry.command), fs.existsSync(entry.command) ? entry.command : `${entry.command} doesn't exist (Node moved?): run repair`, id);
    const file = entry.args.find((a) => /\.(m?js)$/.test(a));
    add("command.exists", Boolean(file && fs.existsSync(file)), file ? ctx.display(file) : "no script in the entry", id);
    if (file && fs.existsSync(file) && fs.existsSync(entry.command)) {
      const legacy = await smoke(entry, [{ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "doctor", version: "0" } } }, { id: 2, method: "tools/list" }], { cwd: ctx.home, env: ctx.env });
      add("smoke.legacy", listsTools(legacy.got?.[2]), legacy.error ? `${legacy.error} ${legacy.stderr ?? ""}`.trim() : "initialize + tools/list answered", id);
      const modern = await smoke(entry, [{ id: 1, method: "server/discover", params: { _meta: META } }, { id: 2, method: "tools/list", params: { _meta: META } }], { cwd: ctx.home, env: ctx.env });
      add("smoke.modern", listsTools(modern.got?.[2]), modern.error ? `${modern.error} ${modern.stderr ?? ""}`.trim() : "server/discover + tools/list answered", id);
    }
    if (id === "claude-code") {
      const double = claudeHasAdHooks(ctx.home) && rec.capture === "tools";
      add("capture.double", !double, double ? "ad's hooks and the record tools both capture here: run install --capture hooks" : "one capture path", id);
      // The installer's entry and the plugin both serve memory: tools twice, notes twice.
      const plugin = claudePluginEnabled(ctx.home, ctx.env);
      add("route.double", !plugin, plugin ? `the ${plugin} plugin also serves memory here: keep one (uninstall --host claude-code, or disable the plugin)` : "one route", id);
    }
    if (id === "cursor") {
      const proj = path.join(opts.cwd ?? process.cwd(), ".cursor", "mcp.json");
      const dup = path.resolve(proj) !== path.resolve(host.file(ctx)) && fs.existsSync(proj) && jsonEntry(fs.readFileSync(proj, "utf8")).entry !== undefined;
      add("entry.duplicate", !dup, dup ? `${proj} also defines ${PRODUCT.mcpServerKey} (Cursor shows it twice)` : "no project copy", id);
    }
  }
  // Codex runs a new or changed hook only once you trust it in /hooks (L3, D16).
  // The Codex version matters only for a hash that doesn't match: asked then, not on every run.
  let trust = codexTrust(ctx);
  if (trust.some((t) => t.state === "modified")) trust = codexTrust(ctx, { codexVersion: codexVersionOf(ctx) });
  if (trust.length) {
    const by = (s) => trust.filter((t) => t.state === s).map((t) => t.item.locator.event);
    const parts = [];
    if (by("trusted").length) parts.push(`trusted: ${by("trusted").join(", ")}`);
    if (by("pending").length) parts.push(`not reviewed yet: ${by("pending").join(", ")} (open Codex and run /hooks)`);
    if (by("modified").length) parts.push(`Codex won't run ${by("modified").join(", ")} until you review ${by("modified").length === 1 ? "it" : "them"} again in /hooks`);
    if (by("unknown").length) parts.push(`can't confirm ${by("unknown").join(", ")} on this Codex, newer than the one ad checked (see /hooks)`);
    if (by("disabled").length) parts.push(`turned off in /hooks: ${by("disabled").join(", ")}`);
    if (by("changed").length) parts.push(`you changed ad's ${by("changed").join(", ")} hook`);
    add("hooks.trust", trust.every((t) => !["pending", "modified", "unknown"].includes(t.state)), parts.join("; ") || "no hooks of ad's found", "codex");
  }
  // The plugin and Codex's command skills (L3 P4): their own module.
  for (const c of await (await import("./doctor-product.mjs")).productChecks(ctx, opts)) add(c.code, c.ok, c.note, c.host);
  // The newest copy the launcher runs (npx installs; none for a clone: nothing to compare).
  const cur = currentDist(ctx.root);
  if (cur) add("pkg.stale", !newer(ctx.version, cur), newer(ctx.version, cur) ? `installed ${cur}, this is ${ctx.version}: run install to update` : `installed ${cur}`);

  if (opts.json) ctx.out(JSON.stringify(checks));
  else {
    for (const c of checks) ctx.out(`${c.ok ? "✓" : "✗"} ${c.host ? `${hostById(c.host)?.name ?? c.host} ` : ""}${c.code}: ${c.note}`);
    if (!Object.keys(ledger.hosts).length) ctx.out(`No hosts set up yet: run install (${HOSTS.map((h) => h.id).join(", ")}).`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

// The user's Codex version (for the trust check), or null when it can't be asked.
function codexVersionOf(ctx) {
  const r = ctx.resolve("codex");
  if (!r) return null;
  try {
    const p = spawnSync(r.cmd, [...(r.prefix ?? []), "--version"], { encoding: "utf8", timeout: 10_000, env: ctx.env, windowsHide: true });
    return /(\d+\.\d+\.\d+)/.exec(p.stdout ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}
