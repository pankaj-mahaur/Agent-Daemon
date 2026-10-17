// Tests of the engine's home folder states (engine/codex/home-resolve.mjs):
// fresh installs, older installs, the link between them, two folders at once,
// and what each folder holds. Every test makes its own temp root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateMessages, twoHomesRefusal } from "../src/engine/attribution.mjs";
import { acquireLock } from "../src/lock.mjs";
import { createEngine } from "../src/engine/index.mjs";
import { BOOTSTRAP_CONFIG, canonicalPath, homeOverride, isManagedHome, prepareDefaultHome } from "../src/engine/codex/home.mjs";
import { createLegacyLink, entryKind, homeFacts, isEmptyHome, removeLink, resolveHomeState } from "../src/engine/codex/home-resolve.mjs";
import { reportHomeEvents } from "../src/harness/start.mjs";

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

test("5: ad's own codex-home link to a removed engine/ is removed in write mode, leaving fresh", () => {
  const root = tempRoot();
  try {
    link(join(root, NEW), join(root, OLD));
    assert.equal(entryKind(join(root, OLD)), "dangling");
    const s = resolveHomeState({ root, write: true });
    assert.equal(entryKind(join(root, OLD)), "missing");
    assert.equal(s.state, "fresh");
    assert.equal(s.path, join(root, NEW));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6: a user's codex-home link to a drive that isn't there is refused and kept, in read and write mode", () => {
  const root = tempRoot();
  const drive = tempRoot(); // the other drive (USB, encrypted volume, share)
  try {
    const target = makeHome(join(drive, "my-engine"), { auth: true, rollouts: 2 });
    const oldP = join(root, OLD);
    link(target, oldP);
    renameSync(target, join(drive, "unplugged"));
    assert.equal(entryKind(oldP), "dangling");
    for (const write of [false, true]) {
      assert.throws(() => resolveHomeState({ root, write }), (err) => err.code === "HOME_BROKEN" && err.message.includes("my-engine"));
    }
    assert.throws(() => prepareDefaultHome({ root, env: {} }), (err) => err.code === "HOME_BROKEN");
    assert.equal(entryKind(oldP), "dangling", "the user's link is kept");
    assert.equal(existsSync(join(root, NEW)), false, "no new, empty folder");
    renameSync(join(drive, "unplugged"), target); // plugged in again
    const s = resolveHomeState({ root, write: true });
    assert.equal(s.state, "old");
    assert.equal(s.path, oldP);
    const f = homeFacts(oldP);
    assert.equal(f.signedIn, true);
    assert.equal(f.conversations, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(drive, { recursive: true, force: true });
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
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.throws(() => removeLink(empty), (err) => err.code === "NOT_A_LINK", "an empty real folder is refused too");
    assert.equal(entryKind(empty), "dir");
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

test("24: isEmptyHome: anything beyond ad's bootstrap is the user's", () => {
  const root = tempRoot();
  try {
    const mk = (name, files = {}, dirs = []) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "config.toml"), BOOTSTRAP_CONFIG);
      writeFileSync(join(d, ".agent-daemon-managed"), "Created by Agent Daemon.\n");
      for (const sub of dirs) mkdirSync(join(d, sub), { recursive: true });
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(dirname(join(d, f)), { recursive: true });
        writeFileSync(join(d, f), text);
      }
      return d;
    };
    assert.equal(isEmptyHome(mk("bootstrap", {}, ["log", "tmp"])), true, "ad's bootstrap with empty log/ and tmp/");
    const userSetups = {
      singleQuotedProvider: { "config.toml": `cli_auth_credentials_store = "file"\nmodel_provider = 'openrouter'\n` },
      customProvider: { "config.toml": `cli_auth_credentials_store = "file"\nmodel_provider = "azure"\n[model_providers.azure]\nenv_key = "AZURE_KEY"\n` },
      keyringSignIn: { "config.toml": `cli_auth_credentials_store = "keyring"\n` },
      mcpServers: { "config.toml": `cli_auth_credentials_store = "file"\n[mcp_servers.tools]\ncommand = "tools"\n` },
      agentsFile: { "AGENTS.md": "# mine\n" },
      skill: { "skills/mine/SKILL.md": "---\nname: mine\n---\n" },
      history: { "history.jsonl": "{}\n" },
      logContent: { "log/engine.log": "x\n" },
    };
    for (const [name, files] of Object.entries(userSetups)) {
      assert.equal(isEmptyHome(mk(name, files)), false, name);
      // Next to a signed-in engine/, empty-picking must refuse rather than set it aside.
      const pair = join(root, `pair-${name}`);
      makeHome(join(pair, NEW), { auth: true });
      renameSync(join(root, name), join(pair, OLD));
      assert.throws(() => resolveHomeState({ root: pair, write: true, autoPickEmpty: true }), (err) => err.code === "HOME_TWO_FOLDERS", name);
      assert.deepEqual(readdirSync(pair).sort(), [OLD, NEW].sort(), `${name}: nothing set aside`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("25: engine/ as a link to codex-home is one folder, never two, and never set aside", () => {
  const root = tempRoot();
  try {
    const oldP = makeHome(join(root, OLD), { auth: true });
    link(oldP, join(root, NEW));
    const s = resolveHomeState({ root });
    assert.equal(s.state, "old");
    assert.equal(s.path, oldP);
    assert.equal(s.sameFolder, true);
    // An empty one under empty-picking: the bug made a link loop here.
    const root2 = join(root, "second");
    const oldP2 = makeHome(join(root2, OLD));
    link(oldP2, join(root2, NEW));
    assert.equal(prepareDefaultHome({ root: root2, autoPickEmpty: true, env: {} }), oldP2);
    assert.equal(entryKind(oldP2), "dir");
    assert.equal(entryKind(join(root2, NEW)), "link");
    assert.deepEqual(readdirSync(root2).sort(), [OLD, NEW].sort(), "nothing set aside");
    assert.equal(resolveHomeState({ root: root2 }).state, "old", "the next start still works");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("26: codex-home as the user's link to another folder, next to engine/, is never auto-picked", () => {
  const root = tempRoot();
  try {
    const mine = makeHome(join(root, "mine"));
    link(mine, join(root, OLD));
    makeHome(join(root, NEW));
    assert.equal(resolveHomeState({ root }).state, "two-folders");
    assert.throws(() => resolveHomeState({ root, write: true, autoPickEmpty: true }), (err) => err.code === "HOME_TWO_FOLDERS");
    assert.equal(entryKind(join(root, OLD)), "link");
    assert.equal(entryKind(join(root, NEW)), "dir");
    assert.deepEqual(readdirSync(root).sort(), ["mine", OLD, NEW].sort(), "nothing set aside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("27: a missing codex-home link next to engine/ is made again on start", () => {
  const root = tempRoot();
  try {
    const newP = makeHome(join(root, NEW), { auth: true, marker: true });
    assert.equal(prepareDefaultHome({ root, env: {} }), newP);
    assert.equal(entryKind(join(root, OLD)), "link");
    assert.equal(canonicalPath(join(root, OLD)), canonicalPath(newP));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("28: a set-aside folder reaches the user: the engine's homeEvents, then the notice", async () => {
  const root = tempRoot();
  const lockDir = join(root, "locks");
  try {
    const oldP = makeHome(join(root, OLD));
    makeHome(join(root, NEW), { auth: true });
    const engine = await createEngine({ homeRoot: root, lockDir, command: FAKE, env: { ...SCRUB }, interactive: true });
    let events;
    try {
      events = engine.homeEvents;
      assert.equal(engine.home, join(root, NEW));
    } finally {
      await engine.close();
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "setAside");
    assert.ok(events[0].path.startsWith(`${oldP}.empty-`));
    const err = { text: "", write(s) { this.text += s; } };
    reportHomeEvents(events, err, null);
    assert.equal(err.text, `[agent-daemon] ${migrateMessages.oneEmpty({ name: events[0].path })}\n`);
    const err2 = { text: "", write(s) { this.text += s; } };
    reportHomeEvents([{ type: "linkFailed", link: join(root, OLD), error: "not supported" }], err2, null);
    assert.match(err2.text, /not supported/);
    assert.ok(err2.text.includes(join(root, OLD)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const noChmod = (process.platform === "win32" || process.getuid?.() === 0) && "chmod is not enforced here";

test("29: a link whose target can't be read right now is unreachable: refused, kept", { skip: noChmod }, () => {
  const root = tempRoot();
  const locked = join(root, "locked");
  try {
    const target = makeHome(join(locked, "home"), { auth: true });
    link(target, join(root, OLD));
    chmodSync(locked, 0o000);
    try {
      assert.equal(entryKind(join(root, OLD)), "unreachable");
      assert.throws(() => resolveHomeState({ root, write: true }), (err) => err.code === "HOME_UNREACHABLE");
      assert.throws(() => prepareDefaultHome({ root, env: {} }), (err) => err.code === "HOME_UNREACHABLE");
      assert.equal(entryKind(join(root, OLD)), "unreachable", "the link is kept");
      assert.equal(existsSync(join(root, NEW)), false, "no new, empty folder");
    } finally {
      chmodSync(locked, 0o700);
    }
    assert.equal(resolveHomeState({ root }).state, "old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("30: a link that can't be made is reported, and the start goes on", { skip: noChmod }, () => {
  const root = tempRoot();
  try {
    const newP = makeHome(join(root, NEW), { marker: true });
    chmodSync(root, 0o500);
    const events = [];
    try {
      assert.equal(prepareDefaultHome({ root, env: {}, onEvent: (e) => events.push(e) }), newP);
    } finally {
      chmodSync(root, 0o700);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "linkFailed");
    assert.equal(entryKind(join(root, OLD)), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("31: ad's own link after ~/.agent-daemon moved, or a dangling engine link, is refused with the remove-only-the-link hint", () => {
  const top = tempRoot();
  try {
    const a = join(top, "before");
    const b = join(top, "after");
    prepareDefaultHome({ root: a, env: {} });
    renameSync(a, b); // a profile rename that keeps the junction
    assert.equal(entryKind(join(b, OLD)), "dangling");
    assert.throws(() => resolveHomeState({ root: b, write: true }), (err) => err.code === "HOME_BROKEN" && /only the link/.test(err.message));
    assert.equal(entryKind(join(b, OLD)), "dangling", "kept until the user removes it");
    removeLink(join(b, OLD)); // what the message says
    assert.equal(prepareDefaultHome({ root: b, env: {} }), join(b, NEW));
    assert.equal(canonicalPath(join(b, OLD)), canonicalPath(join(b, NEW)), "the next start makes the link again");

    const c = join(top, "c");
    mkdirSync(c);
    link(join(top, "unplugged-drive"), join(c, NEW));
    assert.throws(() => resolveHomeState({ root: c, write: true }), (err) => err.code === "HOME_BROKEN" && /unplugged-drive, which doesn't exist/.test(err.message) && /only the link/.test(err.message));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
