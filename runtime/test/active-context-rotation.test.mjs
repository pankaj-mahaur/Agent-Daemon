// Tests for runtime/src/session-start.mjs — WS-8 activeContext.md rotation.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { rotateActiveContextIfNeeded } from "../src/session-start.mjs";

async function setupFixture(opts = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ad-rotate-test-"));
  const memDir = path.join(cwd, ".agent-daemon", "memory");
  await fs.mkdir(memDir, { recursive: true });
  const filePath = path.join(memDir, "activeContext.md");
  if (opts.content !== undefined) {
    await fs.writeFile(filePath, opts.content, "utf8");
  }
  if (opts.olderThanDays) {
    const past = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
    await fs.utimes(filePath, new Date(past), new Date(past));
  }
  return { cwd, filePath, memDir, archiveDir: path.join(cwd, ".agent-daemon", "archive") };
}

async function tearDown(cwd) {
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
}

test("rotation skips when both thresholds NOT met (small + fresh)", async () => {
  const { cwd } = await setupFixture({
    content: "## Small\nfresh content\n",
    olderThanDays: 0
  });
  try {
    const r = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r.rotated, false);
    assert.match(r.reason, /thresholds not met/);
  } finally {
    await tearDown(cwd);
  }
});

test("rotation skips when only size threshold met (big but fresh)", async () => {
  const bigContent = "line\n".repeat(10000);  // ~50KB, fresh
  const { cwd } = await setupFixture({ content: bigContent, olderThanDays: 0 });
  try {
    const r = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r.rotated, false);
  } finally {
    await tearDown(cwd);
  }
});

test("rotation skips when only age threshold met (small but old)", async () => {
  const smallContent = "## small but old\n" + "x\n".repeat(50);
  const { cwd } = await setupFixture({ content: smallContent, olderThanDays: 10 });
  try {
    const r = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r.rotated, false);
  } finally {
    await tearDown(cwd);
  }
});

test("rotation fires when both thresholds met (big + old)", async () => {
  // ~40KB, 10 days old
  const bigContent = Array.from({ length: 4000 }, (_, i) => `Line ${i}: lorem ipsum dolor sit amet`).join("\n");
  const { cwd, filePath, archiveDir } = await setupFixture({
    content: bigContent,
    olderThanDays: 10
  });
  try {
    const r = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r.rotated, true);
    assert.ok(r.archive, "archive path returned");

    // archive file exists with the old content
    const archiveContent = await fs.readFile(r.archive, "utf8");
    assert.match(archiveContent, /# Archived from activeContext.md/);
    assert.match(archiveContent, /Line 0:/);

    // activeContext.md now smaller, has breadcrumb + newest half
    const remaining = await fs.readFile(filePath, "utf8");
    assert.match(remaining, /agent-daemon: \d+ earlier line\(s\) rotated/);
    // Roughly half the lines remain
    const linesLeft = remaining.split("\n").length;
    assert.ok(linesLeft < 2200, `expected ~2000 lines, got ${linesLeft}`);
    assert.ok(linesLeft > 1800, `expected ~2000 lines, got ${linesLeft}`);

    // archive dir created
    const archiveStat = await fs.stat(archiveDir);
    assert.ok(archiveStat.isDirectory());
  } finally {
    await tearDown(cwd);
  }
});

test("rotation appends to existing archive if rotated twice on same day", async () => {
  const bigContent = Array.from({ length: 4000 }, (_, i) => `LineFirst ${i}`).join("\n");
  const { cwd, filePath } = await setupFixture({
    content: bigContent,
    olderThanDays: 10
  });
  try {
    const r1 = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r1.rotated, true);

    // Write new big content + backdate again, rotate again
    const newBig = Array.from({ length: 4000 }, (_, i) => `LineSecond ${i}`).join("\n");
    await fs.writeFile(filePath, newBig, "utf8");
    const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fs.utimes(filePath, new Date(past), new Date(past));

    const r2 = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r2.rotated, true);
    assert.equal(r1.archive, r2.archive, "same date → same archive path");

    const archiveContent = await fs.readFile(r2.archive, "utf8");
    assert.match(archiveContent, /LineFirst 0/);
    assert.match(archiveContent, /LineSecond 0/);
    assert.match(archiveContent, /---/, "separator between archives");
  } finally {
    await tearDown(cwd);
  }
});

test("rotation no-ops when file doesn't exist", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ad-rotate-noexist-"));
  try {
    const r = await rotateActiveContextIfNeeded(cwd);
    assert.equal(r.rotated, false);
    assert.match(r.reason, /no activeContext.md/);
  } finally {
    await tearDown(cwd);
  }
});

test("rotation refuses with no cwd", async () => {
  const r = await rotateActiveContextIfNeeded("");
  assert.equal(r.rotated, false);
  assert.equal(r.reason, "no cwd");
});
