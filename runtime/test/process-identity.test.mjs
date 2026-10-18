// P0.3a: locks judge their holder by process start identity
// (runtime/src/process-identity.mjs + lock.mjs). A reused pid is reclaimed at
// once; a live holder keeps its lock whatever its heartbeat (Ctrl+Z, a
// debugger pause); when the OS can't say, the heartbeat decides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock, liveLocks } from "../src/lock.mjs";
import { classifyHolder, identityOf, parseLstart } from "../src/process-identity.mjs";

const LOCK_URL = pathToFileURL(fileURLToPath(new URL("../src/lock.mjs", import.meta.url))).href;
const isWin = process.platform === "win32";
const tempDir = () => mkdtempSync(join(tmpdir(), "ad-lockid-"));
const longChild = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
const waitSpawn = (child) => new Promise((r) => child.once("spawn", r));
const age = (file, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

// A child process that takes lock `name` in `dir` and keeps it.
function holderProcess(name, dir) {
  const code = `import { acquireLock } from ${JSON.stringify(LOCK_URL)}; acquireLock(${JSON.stringify(name)}, { dir: ${JSON.stringify(dir)}, heartbeatMs: 3600000 }); console.log("held"); setTimeout(() => {}, 120000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => String(c).includes("held") && resolve());
    child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  return { child, ready };
}

test("a dead holder whose pid now belongs to another live process is reclaimed at once", async () => {
  const dir = tempDir();
  const child = longChild();
  try {
    await waitSpawn(child);
    // The lock says its holder started 10 minutes ago; the live process with that pid started just now.
    writeFileSync(join(dir, "r1.lock"), JSON.stringify({ pid: child.pid, startedAt: Date.now() - 600_000, threadId: "r1", token: "x" }));
    const release = acquireLock("r1", { dir });
    assert.equal(JSON.parse(readFileSync(join(dir, "r1.lock"), "utf8")).pid, process.pid);
    release();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live holder with a 10-minute-old heartbeat is not taken over", async () => {
  const dir = tempDir();
  const h = holderProcess("h1", dir);
  try {
    await h.ready;
    age(join(dir, "h1.lock"), 600_000);
    assert.throws(() => acquireLock("h1", { dir }), (e) => e.code === "LOCK_BUSY" && e.holder.pid === h.child.pid);
    assert.deepEqual(liveLocks({ dir }).map((l) => l.pid), [h.child.pid], "liveLocks counts it too");
  } finally {
    h.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SIGSTOPped holder keeps its lock", { skip: isWin && "POSIX signals" }, async () => {
  const dir = tempDir();
  const h = holderProcess("s1", dir);
  try {
    await h.ready;
    process.kill(h.child.pid, "SIGSTOP");
    age(join(dir, "s1.lock"), 600_000);
    assert.throws(() => acquireLock("s1", { dir }), (e) => e.code === "LOCK_BUSY");
  } finally {
    try { process.kill(h.child.pid, "SIGCONT"); } catch { /* gone */ }
    h.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown identity: busy while the heartbeat is fresh, takeable when stale", () => {
  const dir = tempDir();
  try {
    const unknown = () => ({ unknown: "test" });
    writeFileSync(join(dir, "u1.lock"), JSON.stringify({ pid: 424242, startedAt: Date.now(), token: "x" }));
    assert.throws(() => acquireLock("u1", { dir, isAlive: () => true, identityOf: unknown }), (e) => e.code === "LOCK_BUSY");
    age(join(dir, "u1.lock"), 600_000);
    acquireLock("u1", { dir, isAlive: () => true, identityOf: unknown })();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock file without startedAt (older than 3.0) is judged by its heartbeat", () => {
  const dir = tempDir();
  try {
    const os = () => ({ startedAt: Date.now() });
    writeFileSync(join(dir, "o1.lock"), JSON.stringify({ pid: 424242, token: "x" }));
    assert.throws(() => acquireLock("o1", { dir, isAlive: () => true, identityOf: os }), (e) => e.code === "LOCK_BUSY");
    age(join(dir, "o1.lock"), 600_000);
    acquireLock("o1", { dir, isAlive: () => true, identityOf: os })();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyHolder: the one-sided start rule, startId first, and no lookup for a dead pid", () => {
  const alive = () => true;
  assert.equal(classifyHolder({ pid: 7, startId: "linux:b:100", startedAt: 1000 }, { isAlive: alive, identityOf: () => ({ startId: "linux:b:100", startedAt: 11_000 }) }), "live", "equal startId, clock stepped +10 s");
  assert.equal(classifyHolder({ pid: 7, startId: "linux:b:100" }, { isAlive: alive, identityOf: () => ({ startId: "linux:b:200" }) }), "reused");
  assert.equal(classifyHolder({ pid: 7, startedAt: 10_000 }, { isAlive: alive, identityOf: () => ({ startedAt: 9_500 }) }), "live", "the OS started it before it wrote the lock");
  assert.equal(classifyHolder({ pid: 7, startedAt: 10_000 }, { isAlive: alive, identityOf: () => ({ startedAt: 5_000 }) }), "live", "a slow start-up (5 s before Node) is still the same process");
  assert.equal(classifyHolder({ pid: 7, startedAt: 10_000 }, { isAlive: alive, identityOf: () => ({ startedAt: 11_900 }) }), "live", "within the 2 s margin");
  assert.equal(classifyHolder({ pid: 7, startedAt: 10_000 }, { isAlive: alive, identityOf: () => ({ startedAt: 12_100 }) }), "reused");
  assert.equal(classifyHolder({ pid: 7, startedAt: 10_000 }, { isAlive: () => false, identityOf: () => { throw new Error("must not look up a dead pid"); } }), "dead");
  assert.equal(classifyHolder({ pid: "x" }, { isAlive: alive }), "unknown");
  assert.equal(classifyHolder({ pid: 7 }, { isAlive: alive, identityOf: () => ({ startedAt: 1 }) }), "unknown", "no startedAt in the file");
  // Our own pid needs no lookup: the exact start we wrote is us, any other an earlier process.
  const noLookup = () => { throw new Error("no lookup for our own pid"); };
  assert.equal(classifyHolder({ pid: 9, startedAt: 500 }, { isAlive: alive, identityOf: noLookup, selfPid: 9, selfStartedAt: 500 }), "live");
  assert.equal(classifyHolder({ pid: 9, startedAt: 400 }, { isAlive: alive, identityOf: noLookup, selfPid: 9, selfStartedAt: 500 }), "reused");
});

test("identityOf: a lookup that times out is unknown; a non-pid is never looked up", () => {
  const timeout = () => { const e = new Error("t"); e.code = "ETIMEDOUT"; throw e; };
  assert.deepEqual(identityOf(1234, { platform: "darwin", run: timeout }), { unknown: "lookup timed out" });
  for (const bad of [0, -1, 1.5, "1; calc", NaN]) {
    assert.deepEqual(identityOf(bad, { platform: "win32", run: () => { throw new Error("must not run"); } }), { unknown: "not a pid" });
  }
});

test("identityOf on Linux reads /proc: start ticks after the last ')', the boot id, btime", () => {
  const files = {
    "/proc/77/stat": "77 (we ird) name)) S 1 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 5000 1000 100",
    "/proc/sys/kernel/random/boot_id": "abc-boot\n",
    "/proc/stat": "cpu 1 2 3\nbtime 1700000000\n",
  };
  const id = identityOf(77, { platform: "linux", readFile: (p) => files[p], run: () => "100\n" });
  assert.equal(id.startId, "linux:abc-boot:5000");
  assert.equal(id.startedAt, (1700000000 + 5000 / 100) * 1000);
});

test("macOS lstart is parsed as UTC (a DST fall-back hour doesn't shift it), from /bin/ps with TZ=UTC", () => {
  assert.equal(parseLstart("Sun Nov  1 01:30:00 2026"), Date.UTC(2026, 10, 1, 1, 30, 0));
  assert.equal(parseLstart("Mon Oct 19 10:00:00 2026\n"), Date.UTC(2026, 9, 19, 10, 0, 0));
  assert.equal(parseLstart("garbage"), null);
  const seen = [];
  identityOf(55, { platform: "darwin", run: (cmd, args, opts) => { seen.push({ cmd, args, tz: opts.env.TZ, lc: opts.env.LC_ALL }); return "Mon Oct 19 10:00:00 2026"; } });
  assert.deepEqual(seen[0], { cmd: "/bin/ps", args: ["-o", "lstart=", "-p", "55"], tz: "UTC", lc: "C" });
});

test("identityOf on this OS: a live child is found", { skip: !["win32", "linux", "darwin"].includes(process.platform) && "no lookup here" }, async () => {
  const child = longChild();
  try {
    await waitSpawn(child);
    const id = identityOf(child.pid);
    assert.ok(!id.unknown, JSON.stringify(id));
    if (id.startedAt) assert.ok(Math.abs(id.startedAt - Date.now()) < 60_000, new Date(id.startedAt).toISOString());
  } finally {
    child.kill();
  }
});

test("liveLocks counts a live holder with a stale heartbeat and skips a reused one", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.lock"), JSON.stringify({ pid: 111, startedAt: 1000, threadId: "a", token: "x" }));
    writeFileSync(join(dir, "b.lock"), JSON.stringify({ pid: 222, startedAt: 1000, threadId: "b", token: "y" }));
    age(join(dir, "a.lock"), 600_000);
    const ids = { 111: { startedAt: 900 }, 222: { startedAt: 500_000 } };
    assert.deepEqual(liveLocks({ dir, isAlive: () => true, identityOf: (pid) => ids[pid] }).map((h) => h.name), ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under node --test with the real home, defaultLockDir() is a temp folder; with a faked home it is under that home", () => {
  const code = `import { defaultLockDir } from ${JSON.stringify(LOCK_URL)}; console.log(defaultLockDir());`;
  const real = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" } });
  assert.match(real.stdout.trim(), /ad-test-locks-\d+$/, real.stderr);
  const fake = mkdtempSync(join(tmpdir(), "ad-fakehome-"));
  try {
    const faked = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "child-v8", HOME: fake, USERPROFILE: fake } });
    assert.equal(faked.stdout.trim(), join(fake, ".agent-daemon", "locks"));
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test("assertFakeHome fails with the real home and passes with a faked one", async () => {
  const { assertFakeHome } = await import("../testkit/real-home-guard.mjs");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    if (process.platform !== "win32") process.env.HOME = (await import("node:os")).userInfo().homedir;
    else process.env.USERPROFILE = (await import("node:os")).userInfo().homedir;
    assert.throws(() => assertFakeHome(), /must set HOME\/USERPROFILE to a temp folder/);
    const fake = mkdtempSync(join(tmpdir(), "ad-fakehome-"));
    process.env.HOME = fake;
    process.env.USERPROFILE = fake;
    assertFakeHome();
    rmSync(fake, { recursive: true, force: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
