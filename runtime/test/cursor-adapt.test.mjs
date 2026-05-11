// Round-trip tests for adapters/cursor/adapt.mjs.
// Verifies SKILL.md (our format) → .mdc (Cursor format) preserves the trigger
// description, body, and stamps `alwaysApply: false` for auto-routing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPT = resolve(HERE, "..", "..", "adapters", "cursor", "adapt.mjs");
const REPO_ROOT = resolve(HERE, "..", "..");
const REAL_SKILLS = join(REPO_ROOT, "skills");

function makeFixtureSkill(dir, name, frontmatter, body) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${fm}\n---\n${body}`);
  return join(skillDir, "SKILL.md");
}

function runAdapt(args) {
  return spawnSync(process.execPath, [ADAPT, ...args], { encoding: "utf8" });
}

test("adapt.mjs emits valid MDC frontmatter for a single skill", () => {
  // Use a real skill from skills/ so we don't depend on fixture wiring.
  const someSkill = readdirSync(REAL_SKILLS).find((n) => {
    const p = join(REAL_SKILLS, n, "SKILL.md");
    return existsSync(p);
  });
  assert.ok(someSkill, "no skills available to test against");

  const r = runAdapt([join(REAL_SKILLS, someSkill)]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^---\r?\n/);
  assert.match(r.stdout, /\ndescription:\s+".+"/);
  assert.match(r.stdout, /\nalwaysApply:\s+false\n/);
  // Body should follow the closing --- delimiter.
  assert.match(r.stdout, /---\r?\n\r?\n[\s\S]+/);
});

test("adapt.mjs trims a >400-char description to 400 with ellipsis", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ad-cursor-adapt-"));
  const skillsDir = join(tmp, "skills");
  const longDesc = "Use when " + "X".repeat(500);
  const skillPath = makeFixtureSkill(skillsDir, "long-desc", { name: "long-desc", description: longDesc }, "# Body\n");
  try {
    const r = runAdapt([skillPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const descLine = r.stdout.match(/\ndescription:\s+"([^"]+)"/);
    assert.ok(descLine, "description line missing");
    assert.ok(descLine[1].endsWith("..."), `expected trailing ellipsis, got: ${descLine[1].slice(-10)}`);
    assert.ok(descLine[1].length <= 400, `description ${descLine[1].length} chars > 400`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapt.mjs preserves the skill body verbatim", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ad-cursor-adapt-"));
  const body = "# Heading\n\nParagraph with `code` and **bold**.\n\n## Steps\n\n1. First\n2. Second\n";
  const skillPath = makeFixtureSkill(join(tmp, "skills"), "body-preserve", {
    name: "body-preserve",
    description: "Use when testing body preservation",
  }, body);
  try {
    const r = runAdapt([skillPath]);
    assert.equal(r.status, 0);
    const afterFrontmatter = r.stdout.split(/\n---\n/)[1] || "";
    assert.ok(afterFrontmatter.includes("# Heading"));
    assert.ok(afterFrontmatter.includes("Paragraph with `code` and **bold**."));
    assert.ok(afterFrontmatter.includes("1. First"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapt.mjs --core --out writes only non-vendored skills", () => {
  const tmpOut = mkdtempSync(join(tmpdir(), "ad-cursor-out-"));
  try {
    const r = runAdapt(["--core", "--out", tmpOut]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const files = readdirSync(tmpOut).filter((f) => f.endsWith(".mdc"));
    assert.ok(files.length > 0, "no MDC files written");
    // Our core skills include known names.
    const names = new Set(files.map((f) => f.replace(/\.mdc$/, "")));
    assert.ok(names.has("bootstrap-daemon") || names.has("debug-triage"), "expected at least one core skill in output");
    // Vendored skill names should NOT appear (sample a few common ECC imports).
    assert.ok(!names.has("django-tdd"), "vendored django-tdd leaked into --core output");
    assert.ok(!names.has("springboot-patterns"), "vendored springboot-patterns leaked into --core output");
  } finally {
    rmSync(tmpOut, { recursive: true, force: true });
  }
});

test("adapt.mjs errors cleanly on a missing skill", () => {
  const r = runAdapt(["/does/not/exist"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no SKILL\.md/);
});

test("adapt.mjs escapes quotes inside description", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ad-cursor-adapt-"));
  const skillPath = makeFixtureSkill(join(tmp, "skills"), "quoted", {
    name: "quoted",
    description: 'Use when handling "quoted" text',
  }, "# body\n");
  try {
    const r = runAdapt([skillPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /description:\s+"Use when handling \\"quoted\\" text"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
