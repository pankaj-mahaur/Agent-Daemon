// ad must never run Codex in the user's own Codex home (~/.codex, or a
// CODEX_HOME their shell sets for their own Codex), however the path is
// spelled, and must never hand ad's Codex the user's CODEX_* settings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGED_MARKER,
  assertIsolatedHome,
  canonicalPath,
  codexEnv,
  ensureCodexHome,
  userCodexHomes,
} from "../src/engine/codex/home.mjs";

const userCodex = join(homedir(), ".codex");
const win = process.platform === "win32";

function scratch(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-iso-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("~/.codex is always the user's, however it is spelled", () => {
  assert.ok(userCodexHomes({}).includes(userCodex));
  assert.throws(() => assertIsolatedHome(userCodex, {}), /your own Codex home/);
  assert.throws(() => assertIsolatedHome(userCodex + (win ? "\\" : "/"), {}), /your own Codex home/, "trailing separator");
  assert.throws(() => assertIsolatedHome(".codex", {}, homedir()), /your own Codex home/, "relative to the cwd Codex starts in");
  if (win) {
    assert.throws(() => assertIsolatedHome(userCodex.toUpperCase(), {}), /your own Codex home/, "case");
    assert.throws(() => assertIsolatedHome(userCodex.replace(/\\/g, "/"), {}), /your own Codex home/, "forward slashes");
    assert.throws(() => assertIsolatedHome(`\\\\?\\${userCodex}`, {}), /your own Codex home/, "extended-length prefix");
  }
});

test("a link or junction to the user's home is the user's home", () => {
  scratch((root) => {
    const theirs = join(root, "their-codex");
    mkdirSync(theirs);
    const link = join(root, "looks-different");
    symlinkSync(theirs, link, win ? "junction" : "dir");
    const env = { CODEX_HOME: theirs };
    assert.throws(() => assertIsolatedHome(link, env), /your own Codex home/);
    assert.throws(() => assertIsolatedHome(join(link, "."), env), /your own Codex home/);
    assert.equal(canonicalPath(link), canonicalPath(theirs));
  });
});

test("an inherited CODEX_HOME is the user's unless ad created it", () => {
  scratch((root) => {
    const theirs = join(root, "work-codex");
    mkdirSync(theirs);
    // Even when AD_CODEX_HOME points at it too.
    const env = { CODEX_HOME: theirs, AD_CODEX_HOME: theirs };
    assert.throws(() => assertIsolatedHome(theirs, env), /your own Codex home/);

    // Codex runs ad's hooks with ad's home inherited; that one is marked as ours.
    const ours = join(root, "ad-home");
    mkdirSync(ours);
    writeFileSync(join(ours, MANAGED_MARKER), "test\n");
    const hookEnv = { CODEX_HOME: ours, AD_CODEX_HOME: ours };
    assert.doesNotThrow(() => assertIsolatedHome(ours, hookEnv));
    assert.ok(!userCodexHomes(hookEnv).includes(ours));
  });
});

test("no CODEX_HOME at all is refused", () => {
  assert.throws(() => assertIsolatedHome(undefined, {}), /without an explicit CODEX_HOME/);
  assert.throws(() => assertIsolatedHome("", {}), /without an explicit CODEX_HOME/);
});

test("codexEnv drops every inherited CODEX_* setting and pins an absolute home", () => {
  scratch((root) => {
    const base = {
      PATH: "/usr/bin",
      CODEX_HOME: userCodex,
      CODEX_SQLITE_HOME: join(userCodex, "sqlite"),
      codex_exec_server_url: "ws://127.0.0.1:9",
      CODEX_API_KEY: "sk-user",
      CODEX_ACCESS_TOKEN: "tok-user",
      AD_CODEX_BIN: "/opt/codex",
    };
    const env = codexEnv({ home: "ad-home", base, cwd: root, extra: { OPENROUTER_API_KEY: "sk-or", FAKE_FLAG: "1" } });
    assert.equal(env.CODEX_HOME, join(root, "ad-home"));
    for (const key of Object.keys(env)) {
      if (key === "CODEX_HOME") continue;
      assert.doesNotMatch(key, /^codex_/i, `${key} must not reach ad's Codex`);
    }
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.AD_CODEX_BIN, "/opt/codex");
    assert.equal(env.OPENROUTER_API_KEY, "sk-or");
    assert.equal(env.FAKE_FLAG, "1");
    assert.throws(() => codexEnv({ home: userCodex, base: {} }), /your own Codex home/);
  });
});

test("ensureCodexHome refuses the user's home before writing anything", () => {
  scratch((root) => {
    const theirs = join(root, "not-yet-created");
    assert.throws(() => ensureCodexHome(theirs, { env: { CODEX_HOME: theirs } }), /your own Codex home/);
    assert.equal(existsSync(theirs), false, "no config or marker was written");
  });
});

// Every place that starts the real Codex must build its environment with
// codexEnv(). A new spawn site that forgets fails here by name.
test("every source file that resolves the Codex binary isolates its environment", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs")) files.push(path);
    }
  };
  walk(src);
  const users = files.filter((f) => /resolveCodexCommand\(/.test(readFileSync(f, "utf8")));
  assert.ok(users.length >= 3, `found ${users.length}`);
  for (const file of users) {
    assert.match(readFileSync(file, "utf8"), /codexEnv\(/, `${relative(src, file)} resolves the Codex binary without codexEnv()`);
  }
});
