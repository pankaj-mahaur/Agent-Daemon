// L7 Done-when 2: the self-protection gate on the held-out guards corpus. Its 60
// self-protection blocks and 44 allows go through the hook's own path (the fast path,
// selfProtect, then toolBefore) with zero rules, under every name ad's command goes by.
// Scored on totals only: the corpus is held out, so no item is printed or looked at.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolBefore, selfProtectTriggered } from "../src/hooks/tool-before.mjs";
import { selfProtect } from "../src/hooks/self-protect.mjs";
import { ENTRY_NAMES } from "../src/hooks/self-protect-words.mjs";
import { substitute } from "../testkit/rule-examples.mjs";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-gate-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`./corpora/${rel}`, import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const HOMES = { linux: "/home/dev", macos: "/Users/dev", windows: "C:\\Users\\dev" };

/** The decisions the hook makes for an item under one name of ad's command (one per call form). */
function decide(it, pkg) {
  const ctx = { pkg, tool: it.tool, os: it.os };
  const input = substitute(it.input, ctx);
  const platform = it.os === "windows" ? "win32" : it.os === "macos" ? "darwin" : "linux";
  const host = it.host === "codex" ? "codex" : "claude";
  const forms = [];
  if (it.tool === "apply_patch") {
    const patch = input.patch ?? input.command;
    forms.push({ tool_name: "apply_patch", tool_input: { command: patch } });
    forms.push({ tool_name: "Bash", tool_input: { command: `apply_patch <<'EOF'\n${patch}\nEOF\n` } });
  } else forms.push({ tool_name: it.tool === "shell" ? "Bash" : it.tool, tool_input: input });
  return forms.map((f) => {
    const payload = { session_id: "s", cwd: it.cwd, permission_mode: "default", ...(host === "codex" ? { turn_id: "t" } : {}), ...f };
    // As bin/hook.mjs does: self-protection only when the fast path asks for it.
    const sp = selfProtectTriggered(payload) ? selfProtect(payload, { host, platform, home: HOMES[it.os], env: {} }) : null;
    const out = toolBefore(payload, { root: path.join(TMP, "no-rules"), env: {}, host, platform, log: () => {}, selfProtect: sp });
    return out?.hookSpecificOutput?.permissionDecision ?? null;
  });
}

test("Done-when 2: self-protection on the held-out corpus, zero rules, every name — totals only", () => {
  const blocks = read("guards/must-block.jsonl").filter((it) => it.rule?.type === "self-protection");
  const allows = read("guards/must-allow.jsonl").filter((it) => it.rule?.type === "self-protection");
  assert.equal(blocks.length, 60);
  assert.equal(allows.length, 44);
  const names = [...new Set(ENTRY_NAMES)];
  assert.ok(names.length >= 2, names.join(" "));
  let missed = 0;
  let blockForms = 0;
  let allowForms = 0;
  const perName = [];
  for (const pkg of names) {
    let fp = 0;
    for (const it of blocks) for (const d of decide(it, pkg)) {
      blockForms++;
      if (!d) missed++;
    }
    for (const it of allows) for (const d of decide(it, pkg)) {
      allowForms++;
      if (d) fp++;
    }
    perName.push(fp);
  }
  console.log(`self-protection gate: ${names.length} names; must-block forms missed ${missed}/${blockForms}; must-allow forms decided per name ${perName.join(", ")} (of ${allowForms / names.length})`);
  assert.equal(missed, 0, `${missed} must-block forms got no decision`);
  // ≤ 2 % of the file's 154 allows (at most 3) under every name, counted together with the rule
  // items: Done-when 1 (l7-tool-before.test.mjs) asserts those have none.
  const RULE_ITEM_FALSE_POSITIVES = 0;
  assert.ok(Math.max(...perName) + RULE_ITEM_FALSE_POSITIVES <= 3, `false positives per name: ${perName.join(", ")}`);
});

test("the dev set's c, d, f and g items (writes to ad's state, host config, the Windows folder, startup), both sides", async () => {
  const { BLOCK, ALLOW } = await import("./fixtures/rules/self-protection-dev.mjs");
  const items = [...BLOCK, ...ALLOW].filter((x) => ["c", "d", "f", "g"].includes(x.cls));
  assert.ok(items.length > 80, `${items.length} items`);
  // A home and a project with the files the settings and startup items edit.
  const home = path.join(TMP, "dev-home");
  const proj = path.join(TMP, "dev-app");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"model": "opus", "hooks": {"PreToolUse": [{"onFailure": "block"}]}}');
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), '{"allow": []}');
  fs.writeFileSync(path.join(home, ".bashrc"), "# end\n");
  const wrong = [];
  for (const it of items) {
    const usesHome = JSON.stringify(it.input).includes("{home}");
    const fill = (v) => (typeof v === "string" ? v.replaceAll("{home}", home).replaceAll("/work/app", it.os === "linux" ? proj : "/work/app") : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
    const input = fill(substitute(it.input, { tool: it.tool, os: it.os }));
    const platform = it.os === "windows" ? "win32" : it.os === "macos" ? "darwin" : "linux";
    const r = selfProtect({ tool_name: it.tool, tool_input: input, cwd: fill(it.cwd), session_id: "s" }, { host: it.host === "codex" ? "codex" : "claude", platform, home: usesHome ? home : HOMES[it.os], env: {} });
    const got = r?.decision ?? "allow";
    if (got !== it.expect) wrong.push(`${it.id}: want ${it.expect}, got ${got}`);
  }
  assert.deepEqual(wrong, []);
});

test("generated: every .agent-daemon path the shipped skills and commands name can be written (bar the listed ones), and ad sp workers can work", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) files.push(p);
    }
  };
  walk(path.join(REPO, "skills"));
  walk(path.join(REPO, "commands"));
  assert.ok(files.length > 10, `${files.length} skill and command files`);
  // Paths the skills name that a write doesn't simply pass (they only read them, or D12c guards
  // them by design): each with the decision a write gets, and why. Every entry must be named.
  const LISTED = new Map([
    ["home:locks", ["deny", "ad's own leases (read in troubleshooting)"]],
    ["home:hooks/hook.log", ["deny", "the hook's log (read)"]],
    ["home:memory/dist", ["deny", "the guard copy (read)"]],
    ["project:learning-journal.jsonl", ["deny", "the capture journal: ad writes it, never the agent (D12c)"]],
    ["home:guards.json", ["deny", "the rules snapshot (named in troubleshooting; the user moves a broken one)"]],
    ["home:episodic.db", ["deny", "the memory database (queried read-only)"]],
    ["home:user.md", ["ask", "the user's profile: bootstrap writes it once, with the user's answers (D12c asks)"]],
  ]);
  const named = new Set();
  const home = path.join(TMP, "gen-home");
  const proj = path.join(TMP, "gen-app");
  const seen = new Set();
  const wrong = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/(~\/)?\.agent-daemon\/([^\s`'"),;|]*)/g)) {
      const where = m[1] ? "home" : "project";
      const rel = m[2].replace(/<[^>]*>/g, "x").replace(/\{[^}]*\}/g, "x").replace(/[*…]/g, "a").replace(/[.:]+$/, "").replace(/\/+$/, "");
      if (!rel) continue;
      const key = `${where}:${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = path.join(where === "home" ? path.join(home, ".agent-daemon") : path.join(proj, ".agent-daemon"), rel, /\.\w+$/.test(rel) ? "" : "note.md");
      const write = selfProtect({ tool_name: "Write", tool_input: { file_path: target, content: "x" }, cwd: proj, session_id: "s" }, { host: "claude", platform: "linux", home, env: {} })?.decision ?? "allow";
      const shell = selfProtect({ tool_name: "Bash", tool_input: { command: `echo x >> '${target}'` }, cwd: proj, session_id: "s" }, { host: "claude", platform: "linux", home, env: {} })?.decision ?? "allow";
      const listed = LISTED.get(key);
      if (listed) {
        named.add(key);
        if (write !== listed[0]) wrong.push(`${key}: listed as ${listed[0]}, a write gets ${write}`);
      } else if (write !== "allow" || shell !== "allow") wrong.push(`${key} (${path.relative(REPO, f)}): write ${write}, shell ${shell}`);
    }
  }
  assert.ok(seen.size > 15, `${seen.size} paths`);
  assert.deepEqual([...LISTED.keys()].filter((k) => !named.has(k)), [], "every listed path is one the skills name");
  assert.deepEqual(wrong, []);
  // Every sqlite3 command on ad's database in them runs as a read (D12c: -init /dev/null, SELECTs only).
  let sqls = 0;
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/^\s*(sqlite3 [^\n]*\.agent-daemon[^\n]*)$/gm)) {
      sqls++;
      const command = m[1].replace(/\$ARGUMENTS/g, "x");
      const d = selfProtect({ tool_name: "Bash", tool_input: { command }, cwd: proj, session_id: "s" }, { host: "claude", platform: "linux", home, env: {} })?.decision ?? "allow";
      if (d !== "allow") wrong.push(`${path.relative(REPO, f)}: ${command.slice(0, 80)} → ${d}`);
    }
  }
  assert.ok(sqls >= 2, `${sqls} sqlite3 commands`);
  assert.deepEqual(wrong, []);
  // ad sp workers work in ~/.agent-daemon/worktrees/<branch>: their ordinary work passes.
  const wt = path.join(home, ".agent-daemon", "worktrees", "feat-x");
  for (const c of ["git add -A && git commit -m 'feat: x'", "npm test", "echo x > src/a.js", "rm -rf node_modules dist", "git push -u origin feat/x", "sqlite3 test.db 'create table t(x)'", "mkdir -p .agent-daemon && echo n > .agent-daemon/notes.md"]) {
    const d = selfProtect({ tool_name: "Bash", tool_input: { command: c }, cwd: wt, session_id: "s" }, { host: "claude", platform: "linux", home, env: {} })?.decision ?? "allow";
    assert.equal(d, "allow", c);
  }
  assert.equal(selfProtect({ tool_name: "Write", tool_input: { file_path: path.join(wt, "src", "b.js"), content: "x" }, cwd: wt, session_id: "s" }, { host: "claude", platform: "linux", home, env: {} })?.decision ?? "allow", "allow");
});
