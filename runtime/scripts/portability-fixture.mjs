#!/usr/bin/env node
// P7.3 "OS pairs in CI": one OS exports a fixture project, every other OS imports it.
//
//   node runtime/scripts/portability-fixture.mjs export <out.adstate>
//     A throwaway home (paths with spaces and non-ASCII): project A with a sentinel lesson and
//     the git remote https://example.invalid/org/app.git, project B that must not travel, a
//     schedule, an account. Exports A with `ad state export` and writes <out>.json beside it.
//   node runtime/scripts/portability-fixture.mjs import <bundle.adstate>...
//     For each bundle, a fresh home with a clone of A at another path (found by its remote):
//     `ad state import`, `ad state verify --import` (the sentinel among the probes),
//     `ad review --import --accept-all` (AD_INTERNAL_TEST_CONFIRM: CI has no terminal),
//     `ad query-retrieve` (the sentinel in the injected context), a scan for any of B's text,
//     and a second import that adds nothing. Exits 1 on the first failure.
//
// Never the user's own folders: every home is a temp folder made here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeStateFixture } from "../testkit/state-fixture.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const REMOTE = "https://example.invalid/org/app.git";
const LESSON_QUERY = "Why does the pnpm workspace hoisting break?";

function homeEnv(root) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, AD_ROOT: path.join(root, ".agent-daemon") };
  for (const k of ["AD_TOOL_SHELL", "AD_INTERNAL_TEST_CONFIRM", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return env;
}
function ad(args, env, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input: input ?? "", encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", REMOTE);
}
function check(ok, what, detail = "") {
  if (!ok) {
    console.error(`FAIL: ${what}${detail ? `\n${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}
function allText(dir) {
  const out = [];
  const go = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) out.push([p, fs.readFileSync(p).toString("latin1")]);
    }
  };
  go(dir);
  return out;
}

// Rows a re-import could add to.
async function counts(env) {
  const { openDatabase } = await import("../src/memory/driver.mjs");
  const db = await openDatabase(path.join(env.AD_ROOT, "episodic.db"));
  try {
    return ["learnings", "user_facts", "sessions"].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  } finally {
    db.close();
  }
}

async function exportOne(out) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad port src ö "));
  const f = await makeStateFixture({ root, keyish: false });
  gitRepo(f.A.dir);
  const reg = path.join(f.ad, "projects.json");
  const doc = JSON.parse(fs.readFileSync(reg, "utf8"));
  doc.projects.find((p) => p.id === f.A.id).gitRemote = REMOTE;
  fs.writeFileSync(reg, JSON.stringify(doc, null, 2));
  const r = ad(["state", "export", "--project", f.A.dir, "--out", path.resolve(out), "--redact"], f.env);
  check(r.code === 0 && fs.existsSync(out), `export from ${process.platform}`, r.out);
  fs.writeFileSync(`${out}.json`, JSON.stringify({ from: process.platform, sentinel: f.A.sentinel, notTravelling: f.B.sentinel }));
}

async function importOne(bundle) {
  const meta = JSON.parse(fs.readFileSync(`${bundle}.json`, "utf8"));
  const tag = `${meta.from} → ${process.platform}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad port dst ü "));
  const env = homeEnv(root);
  const code = path.join(root, "code");
  const clone = path.join(code, "app hére");
  gitRepo(clone);

  const first = ad(["state", "import", path.resolve(bundle), "--search", code], env);
  const id = /Imported \((imp_[0-9A-Z]+)\)/.exec(first.out)?.[1];
  check(first.code === 0 && id && /matched by git remote/.test(first.out), `${tag}: import finds the clone by its remote`, first.out);

  const verify = ad(["state", "verify", "--import", id], env);
  check(verify.code === 0 && /Recall: (\d+)\/\1 lessons found/.test(verify.out), `${tag}: verify --import (recall probes)`, verify.out);

  const review = ad(["review", "--import", id, "--accept-all"], { ...env, AD_INTERNAL_TEST_CONFIRM: id });
  check(review.code === 0, `${tag}: review --import --accept-all`, review.out);

  const recall = ad(["query-retrieve", "--output-json", "--cwd", clone], env, JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: clone, prompt: LESSON_QUERY }));
  check(recall.code === 0 && recall.out.includes(meta.sentinel), `${tag}: the sentinel lesson comes back in the injected context`, recall.out);

  const leaked = allText(root).filter(([, t]) => t.includes(meta.notTravelling)).map(([p]) => p);
  check(leaked.length === 0, `${tag}: nothing of project B arrived`, leaked.join("\n"));

  const before = await counts(env);
  const again = ad(["state", "import", path.resolve(bundle), "--search", code], env);
  const after = await counts(env);
  check(again.code === 0 && JSON.stringify(after) === JSON.stringify(before), `${tag}: a second import adds nothing`, `${JSON.stringify(before)} → ${JSON.stringify(after)}\n${again.out}`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const [cmd, ...files] = process.argv.slice(2);
if (cmd === "export" && files.length === 1) await exportOne(files[0]);
else if (cmd === "import" && files.length) for (const f of files) await importOne(f);
else {
  console.error("Usage: portability-fixture.mjs export <out.adstate> | import <bundle.adstate>...");
  process.exit(2);
}
