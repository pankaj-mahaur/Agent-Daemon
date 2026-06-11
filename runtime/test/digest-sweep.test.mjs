// Tests for `ad digest-sweep` (the VS Code SessionEnd fallback) and the
// throttled detached spawn from session-start.
//
// Pattern note: every better-sqlite3 handle is CLOSED before any assertion
// runs. A throwing assert between open() and close() leaves the DB locked by
// this process, and recursive fs.rm retry-backoff over a self-locked tree
// burns ~12 minutes per run (learned the hard way).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/memory/sqlite.mjs";
import { SETTLED_DIGEST_STATUSES } from "../src/memory/episodic.mjs";
import { spawnDigestSweep } from "../src/session-start.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "src", "cli.mjs");
const FIXTURE_WITH_DIGEST = path.join(HERE, "fixtures", "sample-transcript-with-digest.jsonl");
const FIXTURE_PLAIN = path.join(HERE, "fixtures", "sample-transcript.jsonl");

// Mirror of encodePath in cli.mjs (not exported — keep in sync).
function encodePath(p) {
  return p
    .replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + "-")
    .replace(/[\s\\/]/g, "-");
}

function run(args, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.stderr.on("data", c => stderr += c.toString());
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function ageFile(p, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60 * 1000);
  await fs.utimes(p, t, t);
}

// Best-effort cleanup with LOW retries — see the pattern note above.
async function cleanupTmp(root) {
  try {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch { /* leave for OS tmp cleaner */ }
}

// Read rows and CLOSE before returning, so asserts never run on an open handle.
function readSessionStatuses(dbPath, ids) {
  return open({ dbPath }).then(db => {
    try {
      const out = {};
      for (const id of ids) {
        out[id] = db.get("SELECT digest_status AS s FROM sessions WHERE id = ?", [id])?.s ?? null;
      }
      return out;
    } finally {
      db.close();
    }
  });
}

test("digest-sweep digests undigested transcripts, skips fresh + excluded, and settles on re-run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-sweep-"));
  const project = path.join(root, "proj");
  await fs.mkdir(project, { recursive: true });
  const transcriptDir = path.join(root, ".claude", "projects", encodePath(project));
  await fs.mkdir(transcriptDir, { recursive: true });

  try {
    // Two settled transcripts + one fresh (still being written) + one excluded
    const old1 = path.join(transcriptDir, "sess-aaa.jsonl");
    const old2 = path.join(transcriptDir, "sess-bbb.jsonl");
    const fresh = path.join(transcriptDir, "sess-fresh.jsonl");
    const excl = path.join(transcriptDir, "sess-live.jsonl");
    await fs.copyFile(FIXTURE_WITH_DIGEST, old1);
    await fs.copyFile(FIXTURE_PLAIN, old2);
    await fs.copyFile(FIXTURE_PLAIN, fresh);
    await fs.copyFile(FIXTURE_PLAIN, excl);
    await ageFile(old1, 30);
    await ageFile(old2, 30);
    await ageFile(excl, 30);
    await ageFile(fresh, 0);  // explicit — Windows copyFile preserves source mtime

    const first = await run(
      ["digest-sweep", "--cwd", project, "--exclude-session", "sess-live"],
      root
    );
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /sweeping sess-aaa\.jsonl/);
    assert.match(first.stderr, /sweeping sess-bbb\.jsonl/);
    assert.doesNotMatch(first.stderr, /sess-fresh/);
    assert.doesNotMatch(first.stderr, /sess-live/);

    // Both swept sessions settle (digested / no-block / triaged-skip / no-learnings)
    const statuses = await readSessionStatuses(
      path.join(root, ".agent-daemon", "episodic.db"),
      ["sess-aaa", "sess-bbb", "sess-live"]
    );
    assert.equal(statuses["sess-aaa"], "digested", "with-digest fixture fully digests");
    assert.ok(SETTLED_DIGEST_STATUSES.has(statuses["sess-bbb"]), `sess-bbb settled (got ${statuses["sess-bbb"]})`);
    assert.equal(statuses["sess-live"], null, "excluded session untouched");

    // Second run: nothing left to sweep
    const second = await run(["digest-sweep", "--cwd", project, "--verbose"], root);
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stderr, /sweeping sess-(aaa|bbb)/);
  } finally {
    await cleanupTmp(root);
  }
});

test("digest-sweep re-digests a transcript that grew after its last digest (resumed session)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-sweep-regrow-"));
  const project = path.join(root, "proj");
  await fs.mkdir(project, { recursive: true });
  const transcriptDir = path.join(root, ".claude", "projects", encodePath(project));
  await fs.mkdir(transcriptDir, { recursive: true });

  try {
    const t = path.join(transcriptDir, "sess-grow.jsonl");
    await fs.copyFile(FIXTURE_PLAIN, t);
    await ageFile(t, 30);

    const first = await run(["digest-sweep", "--cwd", project], root);
    assert.equal(first.code, 0);
    assert.match(first.stderr, /sweeping sess-grow\.jsonl/);

    // Simulate the session resuming: rewind digested_at well behind the
    // transcript's mtime (the regrowth window is 5 min).
    await fs.appendFile(t, "\n");
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const db = await open({ dbPath: path.join(root, ".agent-daemon", "episodic.db") });
    try {
      db.run("UPDATE sessions SET digested_at = ? WHERE id = 'sess-grow'", [past]);
    } finally {
      db.close();
    }
    await ageFile(t, 10);  // settled again, but newer than digested_at

    const second = await run(["digest-sweep", "--cwd", project], root);
    assert.equal(second.code, 0);
    assert.match(second.stderr, /sweeping sess-grow\.jsonl/, "regrown transcript re-swept");
  } finally {
    await cleanupTmp(root);
  }
});

test("spawnDigestSweep throttles via flag file and respects the disable env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-sweep-throttle-"));
  const project = path.join(root, "proj");
  await fs.mkdir(path.join(project, ".agent-daemon"), { recursive: true });

  try {
    // Disabled via env → never spawns
    process.env.AGENT_DAEMON_DISABLE_SWEEP = "1";
    assert.equal(await spawnDigestSweep({ cwd: project }), false);
    delete process.env.AGENT_DAEMON_DISABLE_SWEEP;

    // First call spawns (child exits quickly — no transcripts under this HOME)
    assert.equal(await spawnDigestSweep({ cwd: project }), true);
    const flag = path.join(project, ".agent-daemon", "last-digest-sweep.flag");
    await fs.access(flag);

    // Second call inside the throttle window → no spawn
    assert.equal(await spawnDigestSweep({ cwd: project }), false);

    // Non-daemon project → no spawn
    const bare = path.join(root, "bare");
    await fs.mkdir(bare, { recursive: true });
    assert.equal(await spawnDigestSweep({ cwd: bare }), false);
  } finally {
    await cleanupTmp(root);
  }
});
