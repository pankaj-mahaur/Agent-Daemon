// `agent-daemon-memory doctor` (P5.3): is memory set up and working in each
// host the installer set up? Each check has a stable code for --json.
//   node.version node.path sqlite.driver db.open db.schema db.stray
//   per host: config.parse entry command.exists smoke.legacy smoke.modern
//             capture.double entry.duplicate; pkg.stale

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { availableDrivers } from "../memory/driver.mjs";
import { HOSTS, SERVER_NAME, claudeHasAdHooks, hostById } from "./hosts.mjs";
import { readLedger } from "./ledger.mjs";
import { inspect } from "./fsx.mjs";
import { jsonEntry } from "./edit-json.mjs";
import { claudeGet } from "./claude-cli.mjs";
import { makeContext } from "./install.mjs";

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
  add("sqlite.driver", drivers.length > 0, drivers.length ? drivers.join(", ") : "no SQLite driver: needs Node 22.13+ (node:sqlite)");
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
    }
    if (id === "cursor") {
      const proj = path.join(opts.cwd ?? process.cwd(), ".cursor", "mcp.json");
      const dup = path.resolve(proj) !== path.resolve(host.file(ctx)) && fs.existsSync(proj) && jsonEntry(fs.readFileSync(proj, "utf8")).entry !== undefined;
      add("entry.duplicate", !dup, dup ? `${proj} also defines agent-daemon-memory (Cursor shows it twice)` : "no project copy", id);
    }
  }
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(ctx.root, "memory", "current.json"), "utf8"));
    add("pkg.stale", !newer(ctx.version, cur.version), newer(ctx.version, cur.version) ? `installed ${cur.version}, this is ${ctx.version}: run install to update` : `installed ${cur.version}`);
  } catch {
    // not installed through npx: nothing to compare
  }

  if (opts.json) ctx.out(JSON.stringify(checks));
  else {
    for (const c of checks) ctx.out(`${c.ok ? "✓" : "✗"} ${c.host ? `${hostById(c.host)?.name ?? c.host} ` : ""}${c.code}: ${c.note}`);
    if (!Object.keys(ledger.hosts).length) ctx.out(`No hosts set up yet: run install (${HOSTS.map((h) => h.id).join(", ")}).`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
