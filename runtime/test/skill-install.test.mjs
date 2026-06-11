// Tests for `ad skill install|list|remove|search` (src/skill-install.mjs).
// Subprocess pattern with HOME=tmp; a fabricated bundled repo serves as
// PROJECT_ROOT via AGENT_DAEMON_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function run(args, home, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.stderr.on("data", c => stderr += c.toString());
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const GOOD_SKILL = (name) => [
  "---",
  `name: ${name}`,
  `description: "Use when the user says \\"${name} trigger phrase\\" or asks about ${name}."`,
  "---",
  "",
  `# ${name}`,
  "Procedure body.",
  ""
].join("\n");

const BAD_SKILL = (name) => [
  "---",
  `name: ${name}`,
  "---",
  "",
  "# missing description",
  ""
].join("\n");

async function makeFixtureRepo(root) {
  // Fabricated PROJECT_ROOT with a skills/ dir (one bucket, two flat skills)
  const repo = path.join(root, "fixture-repo");
  await fs.mkdir(path.join(repo, "skills", "good-bundled"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "good-bundled", "SKILL.md"), GOOD_SKILL("good-bundled"), "utf8");
  await fs.mkdir(path.join(repo, "skills", "daemon", "bucketed-skill"), { recursive: true });
  await fs.writeFile(path.join(repo, "skills", "daemon", "bucketed-skill", "SKILL.md"), GOOD_SKILL("bucketed-skill"), "utf8");
  return repo;
}

async function withTmp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-install-"));
  const project = path.join(root, "proj");
  await fs.mkdir(project, { recursive: true });
  try {
    await fn(root, project, await makeFixtureRepo(root));
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
}

test("bundled install lands in the global lane with manifest provenance and a route map", async () => {
  await withTmp(async (root, project, repo) => {
    const r = await run(["skill", "install", "good-bundled", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /✓ good-bundled/);
    assert.match(r.stdout, /session start/i);

    await fs.access(path.join(root, ".claude", "skills", "good-bundled", "SKILL.md"));

    const manifest = JSON.parse(await fs.readFile(path.join(root, ".agent-daemon", "skill-manifest.json"), "utf8"));
    const entry = manifest.installs.find(i => i.name === "good-bundled");
    assert.equal(entry.sourceType, "bundled");
    assert.equal(entry.lane, "global");
    assert.match(entry.skillMdSha256, /^[a-f0-9]{64}$/);

    // Route map compiled with the new skill's trigger
    const map = JSON.parse(await fs.readFile(path.join(root, ".agent-daemon", "route-map.json"), "utf8"));
    const mapped = map.entries.find(e => e.skill === "good-bundled");
    assert.ok(mapped, "installed skill present in compiled route map");
    assert.ok(mapped.triggers.includes("good-bundled trigger phrase"));
  });
});

test("project lane install + re-install refusal + --force overwrite", async () => {
  await withTmp(async (root, project, repo) => {
    let r = await run(["skill", "install", "bucketed-skill", "--project", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, r.stderr);
    await fs.access(path.join(project, ".claude", "skills", "bucketed-skill", "SKILL.md"));

    r = await run(["skill", "install", "bucketed-skill", "--project", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 1, "second install without --force refused");
    assert.match(r.stderr, /already installed/);

    r = await run(["skill", "install", "bucketed-skill", "--project", "--force", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, "force overwrite succeeds");
  });
});

test("local path install: single skill dir; lint errors block without --force", async () => {
  await withTmp(async (root, project, repo) => {
    // Valid local skill
    const localGood = path.join(root, "local-good");
    await fs.mkdir(localGood, { recursive: true });
    await fs.writeFile(path.join(localGood, "SKILL.md"), GOOD_SKILL("local-good"), "utf8");

    let r = await run(["skill", "install", localGood, "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, r.stderr);
    await fs.access(path.join(root, ".claude", "skills", "local-good", "SKILL.md"));

    // Lint-broken local skill
    const localBad = path.join(root, "local-bad");
    await fs.mkdir(localBad, { recursive: true });
    await fs.writeFile(path.join(localBad, "SKILL.md"), BAD_SKILL("local-bad"), "utf8");

    r = await run(["skill", "install", localBad, "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 1, "lint errors block install");
    assert.match(r.stderr, /missing `description`/);

    r = await run(["skill", "install", localBad, "--force", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, "--force bypasses lint");
  });
});

test("list shows provenance; remove round-trip; unmanaged removal needs --force", async () => {
  await withTmp(async (root, project, repo) => {
    await run(["skill", "install", "good-bundled", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });

    let r = await run(["skill", "list", "--json", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0);
    const rows = JSON.parse(r.stdout);
    const managed = rows.find(x => x.name === "good-bundled");
    assert.match(managed.source, /^bundled:/);

    // Hand-authored (unmanaged) skill
    const handDir = path.join(root, ".claude", "skills", "hand-made");
    await fs.mkdir(handDir, { recursive: true });
    await fs.writeFile(path.join(handDir, "SKILL.md"), GOOD_SKILL("hand-made"), "utf8");

    r = await run(["skill", "remove", "hand-made", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 1, "unmanaged removal refused without --force");
    assert.match(r.stdout, /hand-authored|not installed by agent-daemon/);

    r = await run(["skill", "remove", "good-bundled", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, r.stdout);
    const gone = await fs.access(path.join(root, ".claude", "skills", "good-bundled")).then(() => false, () => true);
    assert.equal(gone, true);
  });
});

test("search finds bundled skills by name and description", async () => {
  await withTmp(async (root, project, repo) => {
    const r = await run(["skill", "search", "bucketed", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /bucketed-skill/);
  });
});

test("git URL install from a local repo (skipped when git is unavailable)", async (t) => {
  const gitCheck = await new Promise(resolve => {
    const c = spawn("git", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    c.on("close", code => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
  if (!gitCheck) { t.skip("git not available"); return; }

  await withTmp(async (root, project, repo) => {
    // Build a git repo containing one skill
    const gitSrc = path.join(root, "git-src");
    await fs.mkdir(path.join(gitSrc, "skills", "git-skill"), { recursive: true });
    await fs.writeFile(path.join(gitSrc, "skills", "git-skill", "SKILL.md"), GOOD_SKILL("git-skill"), "utf8");
    const git = (args) => new Promise(resolve => {
      const c = spawn("git", args, { cwd: gitSrc, stdio: "ignore", shell: process.platform === "win32" });
      c.on("close", code => resolve(code));
    });
    await git(["init"]);
    await git(["add", "-A"]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "skill", "--no-gpg-sign"]);

    const url = "file:///" + gitSrc.replace(/\\/g, "/");
    const r = await run(["skill", "install", url, "--skill", "git-skill", "--cwd", project], root, { AGENT_DAEMON_HOME: repo });
    assert.equal(r.code, 0, r.stderr);
    await fs.access(path.join(root, ".claude", "skills", "git-skill", "SKILL.md"));

    const manifest = JSON.parse(await fs.readFile(path.join(root, ".agent-daemon", "skill-manifest.json"), "utf8"));
    const entry = manifest.installs.find(i => i.name === "git-skill");
    assert.equal(entry.sourceType, "git");
    assert.match(entry.sourceRef, /@[a-f0-9]{12}$/, "commit sha recorded");
  });
});
