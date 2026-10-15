// Tests of the engine's home folder states (engine/codex/home-resolve.mjs):
// fresh installs, older installs, the link between them, two folders at once,
// and what each folder holds. Every test makes its own temp root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { twoHomesRefusal } from "../src/engine/attribution.mjs";
import { acquireLock } from "../src/lock.mjs";
import { createEngine } from "../src/engine/index.mjs";
import { canonicalPath, homeOverride, isManagedHome, prepareDefaultHome } from "../src/engine/codex/home.mjs";
import { createLegacyLink, entryKind, homeFacts, isEmptyHome, removeLink, resolveHomeState } from "../src/engine/codex/home-resolve.mjs";

const FAKE = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };
// The developer's own shell must not leak an override into these runs.
const SCRUB = { AD_CODEX_HOME: undefined, AD_ENGINE_DIR: undefined, AD_ENGINE_HOME: undefined };

const OLD = "codex-home";
const NEW = "engine";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "ad-home-"));
}

function makeHome(dir, { auth = false, marker = false, openrouter = false, rollouts = 0, archived = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  let config = `# test home\ncli_auth_credentials_store = "file"\n`;
  if (openrouter) config += `model_provider = "openrouter"\n`;
  writeFileSync(join(dir, "config.toml"), config);
  if (marker) writeFileSync(join(dir, ".agent-daemon-managed"), "Created by Agent Daemon.\n");
  if (auth) writeFileSync(join(dir, "auth.json"), "{}");
  const put = (base, n) => {
    for (let i = 0; i < n; i++) {
      const d = join(base, "2026", "10", "12");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `rollout-${i}.jsonl`), "{}\n");
    }
  };
  if (rollouts) put(join(dir, "sessions"), rollouts);
  if (archived) put(join(dir, "archived_sessions"), archived);
  return dir;
}

const link = (target, p) => createLegacyLink(target, p, { hide: false });

test("1: nothing on disk resolves to a fresh engine folder, creating nothing", () => {
  const root = tempRoot();
  try {
    const s = resolveHomeState({ root });
    assert.equal(s.path, join(root, NEW));
    assert.equal(s.state, "fresh");
    assert.equal(existsSync(join(root, NEW)), false);
    assert.equal(existsSync(join(root, OLD)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2: an older codex-home folder is used as is", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, OLD), { auth: true });
    const s = resolveHomeState({ root });
    assert.equal(s.state, "old");
    assert.equal(s.path, join(root, OLD));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3: engine/ with the codex-home link is the new state", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, NEW));
    link(join(root, NEW), join(root, OLD));
    const s = resolveHomeState({ root });
    assert.equal(s.state, "new");
    assert.equal(s.path, join(root, NEW));
    assert.equal(s.oldKind, "link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4: engine/ alone is new, and read-only mode creates no link", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, NEW));
    const s = resolveHomeState({ root });
    assert.equal(s.state, "new");
    assert.equal(s.oldKind, "missing");
    assert.equal(entryKind(join(root, OLD)), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5: a dangling codex-home link is removed in write mode, leaving fresh", () => {
  const root = tempRoot();
  try {
    link(join(root, "nowhere"), join(root, OLD));
    assert.equal(entryKind(join(root, OLD)), "dangling");
    const s = resolveHomeState({ root, write: true });
    assert.equal(entryKind(join(root, OLD)), "missing");
    assert.equal(s.state, "fresh");
    assert.equal(s.path, join(root, NEW));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6: a dangling codex-home link next to engine/ points at engine/ again", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, NEW));
    link(join(root, "nowhere"), join(root, OLD));
    const s = resolveHomeState({ root, write: true });
    assert.equal(s.state, "new");
    assert.equal(entryKind(join(root, OLD)), "link");
    assert.equal(canonicalPath(join(root, OLD)), canonicalPath(join(root, NEW)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7: two real folders read as two-folders without throwing", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, OLD), { rollouts: 1 });
    makeHome(join(root, NEW), { rollouts: 1 });
    const s = resolveHomeState({ root });
    assert.equal(s.state, "two-folders");
    assert.equal(s.path, join(root, NEW));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8: two full folders throw HOME_TWO_FOLDERS even when empty-picking is on, touching nothing", () => {
  const root = tempRoot();
  try {
    const oldP = makeHome(join(root, OLD), { rollouts: 1 });
    const newP = makeHome(join(root, NEW), { auth: true });
    assert.throws(() => resolveHomeState({ root, write: true, autoPickEmpty: true }), (err) => {
      assert.equal(err.code, "HOME_TWO_FOLDERS");
      assert.equal(err.message, twoHomesRefusal({ oldPath: oldP, newPath: newP }));
      return true;
    });
    assert.equal(entryKind(oldP), "dir");
    assert.equal(entryKind(newP), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9: an empty older folder is set aside and becomes the link", () => {
  const root = tempRoot();
  try {
    const oldP = join(root, OLD);
    const newP = makeHome(join(root, NEW), { auth: true });
    makeHome(oldP);
    const s = resolveHomeState({ root, write: true, autoPickEmpty: true, today: new Date("2026-10-12") });
    assert.equal(s.state, "new");
    assert.equal(s.path, newP);
    assert.equal(s.oldKind, "link");
    assert.equal(s.setAside, `${oldP}.empty-2026-10-12`);
    assert.equal(entryKind(`${oldP}.empty-2026-10-12`), "dir");
    assert.equal(entryKind(oldP), "link");
    assert.equal(canonicalPath(oldP), canonicalPath(newP));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10: an empty new folder is set aside, keeping the older one", () => {
  const root = tempRoot();
  try {
    const oldP = makeHome(join(root, OLD), { rollouts: 1 });
    makeHome(join(root, NEW));
    const s = resolveHomeState({ root, write: true, autoPickEmpty: true, today: new Date("2026-10-12") });
    assert.equal(s.state, "old");
    assert.equal(s.path, oldP);
    assert.equal(s.setAside, `${join(root, NEW)}.empty-2026-10-12`);
    assert.equal(entryKind(`${join(root, NEW)}.empty-2026-10-12`), "dir");
    assert.equal(entryKind(join(root, NEW)), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("11: two empty folders keep engine/ and set the older name aside", () => {
  const root = tempRoot();
  try {
    const oldP = makeHome(join(root, OLD));
    const newP = makeHome(join(root, NEW));
    const s = resolveHomeState({ root, write: true, autoPickEmpty: true, today: new Date("2026-10-12") });
    assert.equal(s.state, "new");
    assert.equal(s.path, newP);
    assert.equal(entryKind(newP), "dir");
    assert.equal(entryKind(oldP), "link");
    assert.ok(s.setAside);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("12: without empty-picking, one empty folder still throws HOME_TWO_FOLDERS", () => {
  const root = tempRoot();
  try {
    makeHome(join(root, OLD));
    makeHome(join(root, NEW), { auth: true });
    assert.throws(() => resolveHomeState({ root, write: true }), (err) => err.code === "HOME_TWO_FOLDERS");
    assert.equal(entryKind(join(root, OLD)), "dir");
    assert.equal(entryKind(join(root, NEW)), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13: a file where a folder belongs is HOME_BROKEN", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, NEW), "not a folder");
    assert.throws(() => resolveHomeState({ root }), (err) => err.code === "HOME_BROKEN");
    rmSync(join(root, NEW));
    writeFileSync(join(root, OLD), "not a folder");
    assert.throws(() => resolveHomeState({ root }), (err) => err.code === "HOME_BROKEN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("14: isEmptyHome counts a sign-in, an OpenRouter setting and any rollout", () => {
  const root = tempRoot();
  try {
    assert.equal(isEmptyHome(makeHome(join(root, "a"), { auth: true })), false);
    assert.equal(isEmptyHome(makeHome(join(root, "b"), { openrouter: true })), false);
    assert.equal(isEmptyHome(makeHome(join(root, "c"), { rollouts: 1 })), false);
    assert.equal(isEmptyHome(makeHome(join(root, "d"), { archived: 1 })), false);
    assert.equal(isEmptyHome(makeHome(join(root, "e"), { marker: true })), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("15: homeFacts counts conversations and reports the newest use", () => {
  const root = tempRoot();
  try {
    const dir = makeHome(join(root, "f"), { rollouts: 2 });
    const older = join(dir, "sessions", "2026", "10", "12", "rollout-0.jsonl");
    const newer = join(dir, "sessions", "2026", "10", "12", "rollout-1.jsonl");
    utimesSync(older, new Date("2026-10-10T10:00:00Z"), new Date("2026-10-10T10:00:00Z"));
    utimesSync(newer, new Date("2026-10-11T10:00:00Z"), new Date("2026-10-11T10:00:00Z"));
    const f = homeFacts(dir);
    assert.equal(f.path, dir);
    assert.equal(f.conversations, 2);
    assert.equal(f.lastUsed, new Date(statSync(newer).mtimeMs).toISOString());
    assert.equal(f.signedIn, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("18: removeLink removes the link and never its target", () => {
  const root = tempRoot();
  try {
    const target = makeHome(join(root, "target"), { rollouts: 1 });
    const p = join(root, OLD);
    link(target, p);
    removeLink(p);
    assert.equal(entryKind(p), "missing");
    assert.equal(existsSync(join(target, "config.toml")), true);
    assert.equal(existsSync(join(target, "sessions", "2026", "10", "12", "rollout-0.jsonl")), true);
    const real = makeHome(join(root, "real"));
    assert.throws(() => removeLink(real), "never a recursive delete: a real folder is refused");
    assert.equal(existsSync(join(real, "config.toml")), true, "the real folder survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("19: entryKind sees a link, and a dangling one after its target is gone", () => {
  const root = tempRoot();
  try {
    const target = makeHome(join(root, "target"));
    const p = join(root, OLD);
    link(target, p);
    assert.equal(entryKind(p), "link");
    rmSync(target, { recursive: true, force: true });
    assert.equal(entryKind(p), "dangling");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("16: prepareDefaultHome bootstraps engine/ plus the codex-home link", () => {
  const root = tempRoot();
  try {
    const p = prepareDefaultHome({ root, env: {} });
    assert.equal(p, join(root, NEW));
    assert.equal(existsSync(join(root, NEW, "config.toml")), true);
    assert.equal(entryKind(join(root, OLD)), "link");
    assert.equal(canonicalPath(join(root, OLD)), canonicalPath(join(root, NEW)));
    assert.equal(isManagedHome(join(root, OLD)), true, "managed through the link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("17: prepareDefaultHome leaves a 2.2.0-shaped home untouched", () => {
  const root = tempRoot();
  try {
    const home = join(root, OLD);
    makeHome(home, { auth: true, marker: true, rollouts: 3 });
    writeFileSync(join(home, "hooks.json"), "{}");
    const collect = (out) => {
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push([p, readFileSync(p, "utf8")]);
        }
      };
      walk(home);
    };
    const before = [];
    collect(before);
    const p = prepareDefaultHome({ root, env: {} });
    assert.equal(p, home);
    assert.equal(existsSync(join(root, NEW)), false, "no engine/ created");
    const after = [];
    collect(after);
    assert.deepEqual(after, before, "no file inside changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("20: homeOverride reads the new name, the old name, refuses conflicts and stray stamps", () => {
  const root = tempRoot();
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    assert.equal(homeOverride({ AD_ENGINE_DIR: a }), a);
    assert.equal(homeOverride({ AD_CODEX_HOME: b }), b);
    assert.equal(homeOverride({ AD_ENGINE_DIR: a, AD_CODEX_HOME: a }), a);
    assert.throws(() => homeOverride({ AD_ENGINE_DIR: a, AD_CODEX_HOME: b }), (err) => err.code === "HOME_CONFLICT");
    assert.throws(() => homeOverride({ AD_ENGINE_HOME: "x" }), (err) => err.code === "HOME_STRAY_STAMP");
    assert.equal(homeOverride({ AD_ENGINE_HOME: "x", CODEX_HOME: "y" }), null, "inside the engine's own processes: no refusal");
    assert.equal(homeOverride({}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("21: an engine without a home bootstraps engine/ under the lock, then releases it", async () => {
  const root = tempRoot();
  const lockDir = join(root, "locks");
  try {
    const engine = await createEngine({ homeRoot: root, lockDir, command: FAKE, env: { ...SCRUB } });
    try {
      assert.equal(engine.home, join(root, NEW));
      assert.equal(entryKind(join(root, OLD)), "link");
      assert.equal(existsSync(join(root, NEW, "config.toml")), true);
    } finally {
      await engine.close();
    }
    assert.equal(existsSync(join(lockDir, "migrate.lock")), false, "released after start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("22: an engine without a home refuses while another process moves the folder", async () => {
  const root = tempRoot();
  const lockDir = join(root, "locks");
  try {
    const release = acquireLock("migrate", { dir: lockDir, isAlive: () => true });
    try {
      await assert.rejects(createEngine({ homeRoot: root, lockDir, command: FAKE, env: { ...SCRUB }, lockWaitMs: 300 }), (err) => err.code === "HOME_BUSY");
    } finally {
      release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("23: an engine with a home never touches the root or the lock dir", async () => {
  const root = tempRoot();
  try {
    const home = makeHome(join(root, "custom"));
    const engine = await createEngine({ home, homeRoot: join(root, "nope"), lockDir: join(root, "nope-locks"), command: FAKE, env: { ...SCRUB } });
    try {
      assert.equal(engine.home, home);
    } finally {
      await engine.close();
    }
    assert.equal(existsSync(join(root, "nope")), false);
    assert.equal(existsSync(join(root, "nope-locks")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
