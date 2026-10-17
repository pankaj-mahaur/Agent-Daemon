// Tests for `ad migrate` (harness/migrate.mjs): the older engine folder
// becomes engine/ with the old name left as a link, or everything stays as
// it was. Every case runs on a temp root with an explicit lock dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMessages, twoHomesRefusal } from "../src/engine/attribution.mjs";
import { isManagedHome } from "../src/engine/codex/home.mjs";
import { createLegacyLink, entryKind } from "../src/engine/codex/home-resolve.mjs";
import { acquireLock } from "../src/lock.mjs";
import { cmdMigrate } from "../src/harness/migrate.mjs";

const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = realFs;
const TODAY = new Date("2026-10-12T00:00:00Z");

class Sink {
  constructor() {
    this.text = "";
  }
  write(s) {
    this.text += s;
  }
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "ad-migrate-"));
}

/** A 2.2.0-shaped home: marker, bootstrap config, sign-in, 2 rollouts, hooks. */
function shape2_2(home) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), '# test engine settings\ncli_auth_credentials_store = "file"\n');
  writeFileSync(join(home, ".agent-daemon-managed"), "Created by Agent Daemon.\n");
  writeFileSync(join(home, "auth.json"), "{}");
  writeFileSync(join(home, "hooks.json"), "{}");
  const d = join(home, "sessions", "2026", "10", "12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "rollout-1.jsonl"), "{}\n");
  writeFileSync(join(d, "rollout-2.jsonl"), "{}\n");
  return home;
}

function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([p, readFileSync(p, "utf8")]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

async function run(root, opts = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await cmdMigrate({ root, lockDir: join(root, "locks"), interactive: true, today: TODAY, stdout, stderr, ...opts });
  return { code, out: stdout.text, err: stderr.text };
}

const busy = (op) => { const e = new Error(op); e.code = "EBUSY"; throw e; };

test("1: a 2.2.0 home moves to engine/ with the old name left as a link", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const newP = join(root, "engine");
    const before = collect(oldP);
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.deepEqual(collect(newP).map(([p, c]) => [p.slice(newP.length), c]), before.map(([p, c]) => [p.slice(oldP.length), c]), "every file with the same content");
    assert.equal(entryKind(oldP), "link");
    assert.equal(readFileSync(join(oldP, "config.toml"), "utf8"), readFileSync(join(newP, "config.toml"), "utf8"), "readable through the link");
    assert.equal(isManagedHome(oldP), true);
    assert.ok(existsSync(join(root, "migrate.json")), "recorded for ad doctor");
    assert.deepEqual(readdirSync(join(root, "backup")), [], "no sign-in copy left");
    const platform = process.platform;
    assert.equal(out.trim(), migrateMessages.done({ oldPath: oldP, newPath: newP, unsafeDeleteTool: platform === "win32" ? "Remove-Item -Recurse" : undefined, macos: platform === "darwin" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2: a rename that never succeeds keeps everything and leaves no sign-in copy behind", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const before = collect(oldP);
    const fs = { ...realFs, renameSync: () => busy("rename") };
    const { code, err } = await run(root, { fs });
    assert.equal(code, 1);
    assert.match(err, /something is using/);
    assert.match(err, /Nothing changed/);
    assert.deepEqual(collect(oldP), before, "the folder is untouched");
    assert.equal(existsSync(join(root, "engine")), false);
    assert.deepEqual(readdirSync(join(root, "backup")), [], "nothing moved, so no copy is left");
    assert.doesNotMatch(err, /copy of the sign-in/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3: a rename that fails twice then works is retried", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    let calls = 0;
    const fs = { ...realFs, renameSync: (a, b) => (++calls <= 2 ? busy("rename") : realFs.renameSync(a, b)) };
    const { code } = await run(root, { fs });
    assert.equal(code, 0);
    assert.equal(entryKind(join(root, "engine")), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4: a link that cannot be made renames the folder back", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const before = collect(oldP);
    const fs = { ...realFs, createLink: () => { const e = new Error("nope"); e.code = "EPERM"; throw e; } };
    const { code, err } = await run(root, { fs });
    assert.equal(code, 1);
    assert.match(err, /Couldn't move/);
    assert.deepEqual(collect(oldP), before, "a real folder again with all files");
    assert.equal(existsSync(join(root, "engine")), false);
    assert.deepEqual(readdirSync(join(root, "backup")), [], "moved back, so no copy is left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5: a check that cannot read through the link removes it and renames back", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const before = collect(oldP);
    const fs = {
      ...realFs,
      readdirSync: (p, ...a) => {
        if (String(p) === oldP) { const e = new Error("unreadable"); e.code = "EACCES"; throw e; }
        return realFs.readdirSync(p, ...a);
      },
    };
    const { code } = await run(root, { fs });
    assert.equal(code, 1);
    assert.equal(entryKind(oldP), "dir", "the link is gone");
    assert.deepEqual(collect(oldP), before, "renamed back with all files");
    assert.equal(existsSync(join(root, "engine")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("16: a home without config.toml still migrates; the link is checked by listing", async () => {
  const root = tempRoot();
  try {
    const oldP = join(root, "codex-home");
    mkdirSync(join(oldP, "sessions", "2026", "10", "12"), { recursive: true });
    writeFileSync(join(oldP, "auth.json"), "{}");
    writeFileSync(join(oldP, "sessions", "2026", "10", "12", "rollout-1.jsonl"), "{}\n");
    const { code } = await run(root);
    assert.equal(code, 0);
    assert.equal(entryKind(oldP), "link");
    assert.equal(entryKind(join(root, "engine")), "dir");
    assert.ok(existsSync(join(oldP, "auth.json")), "readable through the link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6: a chosen folder is never moved", async () => {
  const root = tempRoot();
  try {
    const custom = join(root, "mine");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "keep.txt"), "mine\n");
    const { code, out } = await run(root, { env: { AD_ENGINE_DIR: custom } });
    assert.equal(code, 0);
    assert.match(out, /nothing moved/);
    assert.equal(readFileSync(join(custom, "keep.txt"), "utf8"), "mine\n");
    assert.equal(existsSync(join(root, "engine")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7: the older env name prints its own note", async () => {
  const root = tempRoot();
  try {
    const custom = join(root, "mine");
    const { code, out } = await run(root, { env: { AD_CODEX_HOME: custom } });
    assert.equal(code, 0);
    assert.equal(out.trim(), migrateMessages.customPath({ path: custom }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8: off a terminal the move is refused with the winpty hint", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    const { code, err } = await run(root, { interactive: false });
    assert.equal(code, 2);
    assert.match(err, /winpty ad migrate/);
    assert.equal(entryKind(join(root, "codex-home")), "dir", "nothing moved");
    assert.equal(existsSync(join(root, "engine")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9: while another ad moves the folder, migrate waits its turn", async () => {
  const root = tempRoot();
  const lockDir = join(root, "locks");
  try {
    const release = acquireLock("migrate", { dir: lockDir, isAlive: () => true });
    try {
      const { code, err } = await run(root, {});
      assert.equal(code, 1);
      assert.match(err, /Another ad is moving/);
    } finally {
      release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10: two real folders are refused with the two-homes text", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    mkdirSync(join(root, "engine"), { recursive: true });
    const { code, err } = await run(root);
    assert.equal(code, 2);
    assert.equal(err.trim(), twoHomesRefusal({ oldPath: join(root, "codex-home"), newPath: join(root, "engine") }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("11: an already migrated folder is left alone", async () => {
  const root = tempRoot();
  try {
    const newP = shape2_2(join(root, "engine"));
    const { createLegacyLink } = await import("../src/engine/codex/home-resolve.mjs");
    createLegacyLink(newP, join(root, "codex-home"), { hide: false });
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.match(out, /Nothing to move: the engine's folder is already/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("12: with no folder at all there is nothing to move", async () => {
  const root = tempRoot();
  try {
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.match(out, /Nothing to move: ad hasn't created/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13: undo after a move puts the folder back", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const before = collect(oldP);
    assert.equal((await run(root)).code, 0);
    const { code, out } = await run(root, { undo: true });
    assert.equal(code, 0);
    assert.match(out, /Nothing was deleted/);
    assert.deepEqual(collect(oldP), before, "a real folder again with all files");
    assert.equal(existsSync(join(root, "engine")), false);
    assert.equal(existsSync(join(root, "migrate.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("14: an undo whose rename back fails puts the link back and keeps engine/", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    assert.equal((await run(root)).code, 0);
    const fs = { ...realFs, renameSync: () => busy("rename") };
    const { code } = await run(root, { undo: true, fs });
    assert.equal(code, 1);
    assert.equal(entryKind(join(root, "codex-home")), "link", "the link is back");
    assert.equal(entryKind(join(root, "engine")), "dir", "engine/ intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("15: undo with nothing migrated does nothing", async () => {
  const root = tempRoot();
  try {
    const { code, out } = await run(root, { undo: true });
    assert.equal(code, 0);
    assert.match(out, /Nothing to undo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const link = (target, p) => createLegacyLink(target, p, { hide: false });

test("17: a running ad session refuses the move, before anything is copied", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const before = collect(oldP);
    const release = acquireLock("thread-1", { dir: join(root, "locks") });
    try {
      const { code, err } = await run(root);
      assert.equal(code, 1);
      assert.match(err, /an ad session is running/);
      assert.match(err, /Nothing changed/);
    } finally {
      release();
    }
    assert.deepEqual(collect(oldP), before);
    assert.equal(existsSync(join(root, "engine")), false);
    assert.equal(existsSync(join(root, "backup")), false, "no sign-in copy made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("18: a running ad session refuses the undo", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    assert.equal((await run(root)).code, 0);
    const release = acquireLock("thread-1", { dir: join(root, "locks") });
    try {
      const { code, err } = await run(root, { undo: true });
      assert.equal(code, 1);
      assert.match(err, /ad migrate --undo/);
    } finally {
      release();
    }
    assert.equal(entryKind(join(root, "codex-home")), "link");
    assert.equal(entryKind(join(root, "engine")), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("19: an undo whose link can't be put back says exactly where things are, and throws nothing", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    assert.equal((await run(root)).code, 0);
    const fs = { ...realFs, renameSync: () => busy("rename"), createLink: () => { const e = new Error("exists"); e.code = "EEXIST"; throw e; } };
    const { code, err } = await run(root, { undo: true, fs });
    assert.equal(code, 1);
    assert.match(err, /Putting the link back also failed \(exists\)/);
    assert.ok(err.includes(join(root, "engine")), "names where the folder is");
    assert.match(err, /nothing was deleted/);
    assert.doesNotMatch(err, /Nothing changed/);
    assert.equal(entryKind(join(root, "engine")), "dir", "engine/ intact");
    assert.ok(existsSync(join(root, "engine", "auth.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("20: undo leaves a codex-home link that points elsewhere alone", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "engine"));
    const mine = shape2_2(join(root, "mine"));
    link(mine, join(root, "codex-home"));
    const { code, err } = await run(root, { undo: true });
    assert.equal(code, 2);
    assert.match(err, /not to/);
    assert.equal(entryKind(join(root, "codex-home")), "link", "the user's link is kept");
    assert.equal(entryKind(join(root, "engine")), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("21: engine/ without its link: migrate makes the link, undo renames back", async () => {
  const root = tempRoot();
  try {
    const newP = shape2_2(join(root, "engine"));
    const oldP = join(root, "codex-home");
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.match(out, /Made the link/);
    assert.equal(entryKind(oldP), "link");
    assert.ok(existsSync(join(oldP, "auth.json")), "readable through the link");
    const { removeLink } = await import("../src/engine/codex/home-resolve.mjs");
    removeLink(oldP);
    const undone = await run(root, { undo: true });
    assert.equal(undone.code, 0);
    assert.equal(entryKind(oldP), "dir");
    assert.equal(existsSync(newP), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("22: a dangling engine link is named as such, not as something in use", async () => {
  const root = tempRoot();
  try {
    shape2_2(join(root, "codex-home"));
    link(join(root, "nowhere"), join(root, "engine"));
    const { code, err } = await run(root);
    assert.equal(code, 2);
    assert.match(err, /doesn't exist/);
    assert.doesNotMatch(err, /something is using/);
    assert.equal(entryKind(join(root, "codex-home")), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("23: codex-home as the user's own link is left where it is, its target named", async () => {
  const root = tempRoot();
  try {
    const mine = shape2_2(join(root, "mine"));
    link(mine, join(root, "codex-home"));
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.match(out, /your own link/);
    assert.ok(out.includes("mine"));
    assert.equal(existsSync(join(root, "engine")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("24: engine/ as a link to codex-home: one folder, nothing to move", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    link(oldP, join(root, "engine"));
    const { code, out } = await run(root);
    assert.equal(code, 0);
    assert.match(out, /both names open the same folder/);
    assert.equal(entryKind(oldP), "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("25: a real folder that appears at codex-home mid-move is never removed by the roll-back", async () => {
  const root = tempRoot();
  try {
    const oldP = shape2_2(join(root, "codex-home"));
    const fs = {
      ...realFs,
      createLink: (_target, p) => {
        mkdirSync(p);
        writeFileSync(join(p, "someone-elses.txt"), "keep\n");
        const e = new Error("exists");
        e.code = "EEXIST";
        throw e;
      },
    };
    const { code, err } = await run(root, { fs });
    assert.equal(code, 1);
    assert.match(err, /Moving it back also failed/);
    assert.equal(readFileSync(join(oldP, "someone-elses.txt"), "utf8"), "keep\n", "the new folder survives");
    assert.ok(existsSync(join(root, "engine", "auth.json")), "the moved folder is intact");
    assert.equal(readdirSync(join(root, "backup")).length, 1, "the sign-in copy is kept when the roll-back failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
