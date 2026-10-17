// Tests for runtime/src/engine/attribution.mjs: the only prose that names the
// engine. What matters: every text renders from the ENGINE facts, the
// identity block knows each sign-in route and no model, the attributed
// prompt files keep their Apache-2.0 headers (dropping one must fail), and
// the live brand test's allowance covers every rendered text and nothing more.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as attribution from "../src/engine/attribution.mjs";
import {
  aboutLines,
  ATTRIBUTED_FILES,
  brandPatterns,
  ENGINE,
  envConflictRefusal,
  envRenameNote,
  formAutoCancel,
  identityBlock,
  legacyHomeName,
  migrateMessages,
  ownEngineHomeDefaultRefusal,
  ownEngineHomeRefusal,
  ownEngineHomeStartRefusal,
  ownEngineSessionsNote,
  projectConfigFolder,
  readmeSentence,
  renderedSamples,
  sandboxConsent,
  SIGN_IN_ROUTES,
  signInNoteBrowser,
  signInNoteDevice,
  tombstoneEngineUiCommand,
  tombstoneEngineUiSlash,
  twoHomesRefusal,
} from "../src/engine/attribution.mjs";
import { BRAND, screenHits } from "../scripts/check-brand.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PINNED = JSON.parse(readFileSync(path.join(ROOT, "runtime", "package.json"), "utf8")).dependencies[ENGINE.npmPackage];

// Apache-2.0 §4(c): each file that reproduces upstream's text names the source, the license and the pinned version in its first lines.
function checkAttributedHeaders(root, pinned) {
  const problems = [];
  for (const { file, header } of ATTRIBUTED_FILES) {
    let head;
    try {
      head = readFileSync(path.join(root, file), "utf8").split("\n").slice(0, 10).join("\n");
    } catch {
      problems.push(`${file}: missing`);
      continue;
    }
    if (!header.test(head)) problems.push(`${file}: no attribution header matching ${header}`);
    if (!head.includes(pinned)) problems.push(`${file}: header doesn't name the pinned version ${pinned}`);
  }
  return problems;
}

test("the attributed prompt files keep their Apache-2.0 headers and name the pinned version", () => {
  assert.equal(typeof PINNED, "string");
  assert.deepEqual(checkAttributedHeaders(ROOT, PINNED), []);
});

test("dropping an attribution header, or leaving an old version in it, is caught", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ad-attribution-"));
  try {
    for (const { file } of ATTRIBUTED_FILES) {
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), `// Codex ${PINNED} prompt, verbatim from openai/codex (Apache-2.0).\nexport const X = 1;\n`);
    }
    assert.deepEqual(checkAttributedHeaders(dir, PINNED), []);
    const first = ATTRIBUTED_FILES[0].file;
    writeFileSync(path.join(dir, first), "export const X = 1;\n");
    const problems = checkAttributedHeaders(dir, PINNED);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /no attribution header/);
    assert.match(problems[1], /pinned version/);
    writeFileSync(path.join(dir, first), "// verbatim from openai/codex (Apache-2.0) at rust-v0.1.0\n");
    assert.deepEqual(checkAttributedHeaders(dir, PINNED).map((p) => p.replace(/^.*?: /, "")), [`header doesn't name the pinned version ${PINNED}`]);
    rmSync(path.join(dir, first));
    assert.match(checkAttributedHeaders(dir, PINNED)[0], /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ENGINE facts, the two on-disk names, and brand-free export names", () => {
  assert.ok(Object.isFrozen(ENGINE));
  assert.deepEqual(Object.keys(ENGINE), ["name", "vendor", "license", "url", "processName", "npmPackage"]);
  assert.equal(legacyHomeName, "codex-home");
  assert.equal(projectConfigFolder, ".codex");
  // callers live outside the allowed zone: an export named after the engine would make each of them a rule A hit
  for (const name of Object.keys(attribution)) assert.doesNotMatch(name, BRAND, `export ${name} carries the brand word`);
});

test("ad about: the engine, its vendor, license, URL, process name, home and settings path", () => {
  const lines = aboutLines({ engineVersion: "0.160.0", pinnedVersion: "0.160.0", homePath: "/h", settingsPath: "/h/config.toml" });
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "engine: Codex 0.160.0 by OpenAI, Apache-2.0, https://github.com/openai/codex");
  assert.match(lines[1], /codex \(codex\.exe on Windows\)/);
  assert.equal(lines[2], "engine home: /h");
  assert.match(lines[3], /^engine settings: \/h\/config\.toml \(TOML/);
  assert.equal(
    aboutLines({ engineVersion: "0.161.0", pinnedVersion: "0.160.0", homePath: "/h", settingsPath: "/s" })[0],
    "engine: Codex 0.161.0 by OpenAI, Apache-2.0, https://github.com/openai/codex (installed 0.161.0; ad was tested with 0.160.0)",
  );
  assert.equal(
    aboutLines({ pinnedVersion: "0.160.0", homePath: "/h", settingsPath: "/s" })[0],
    "engine: Codex by OpenAI, Apache-2.0, https://github.com/openai/codex (not installed; ad pins 0.160.0: cd runtime && npm install)",
  );
});

test("the identity block: every sign-in route, both versions, no model name, bad input refused", () => {
  const base = { adVersion: "3.0.0", engineVersion: "0.160.0" };
  for (const signIn of SIGN_IN_ROUTES) {
    const text = identityBlock({ ...base, signIn });
    assert.match(text, /^You are Agent Daemon's agent/);
    assert.match(text, /Agent Daemon 3\.0\.0/);
    assert.match(text, /OpenAI's open-source Codex 0\.160\.0/);
    assert.match(text, /call you "Codex": that is the engine's name, not yours/);
    assert.match(text, /not the ChatGPT app/);
    assert.match(text, /Never invent a model; never deny these facts\.$/);
    assert.doesNotMatch(text, /gpt-|o3|o4-mini|undefined/);
  }
  assert.match(identityBlock({ ...base, signIn: "chatgpt" }), /signed in with a ChatGPT plan, so the model is OpenAI's\./);
  assert.match(identityBlock({ ...base, signIn: "openai-key" }), /an OpenAI key, so the model is OpenAI's unless the key was pointed at another endpoint\./);
  assert.match(identityBlock({ ...base, signIn: "openrouter" }), /OpenRouter, so the model may come from any provider\./);
  assert.throws(() => identityBlock({ ...base, signIn: "anthropic" }), /unknown sign-in route "anthropic"; one of chatgpt, openai-key, openrouter/);
  assert.throws(() => identityBlock({ ...base }), /unknown sign-in route undefined/);
  assert.throws(() => identityBlock(), /unknown sign-in route/);
  assert.throws(() => identityBlock({ signIn: "chatgpt", engineVersion: "0.160.0" }), /adVersion must be a version string, got undefined/);
  assert.throws(() => identityBlock({ signIn: "chatgpt", adVersion: "3.0.0", engineVersion: " " }), /engineVersion must be a version string/);
});

test("sign-in notes: the ChatGPT route only, saying whose page it is", () => {
  assert.match(signInNoteBrowser, /^Opening your browser to sign in with ChatGPT\. The page is OpenAI's and may say 'Codex': that is the engine ad runs on\.$/);
  const device = signInNoteDevice({ url: "https://auth.openai.com/device", code: "ABCD-EFGH" });
  assert.match(device, /^Go to https:\/\/auth\.openai\.com\/device and enter ABCD-EFGH\. OpenAI's page may say 'Codex'/);
});

test("tombstones: what was removed, the settings path, `ad --last` and the upgrade guide", () => {
  const cli = tombstoneEngineUiCommand({ settingsPath: "/s/config.toml" });
  const slash = tombstoneEngineUiSlash({ settingsPath: "/s/config.toml" });
  assert.match(cli, /^`ad codex` was removed in 3\.0\. Settings: \/s\/config\.toml\. Resume a conversation: `ad --last`\. More: docs\/upgrade-3\.0\.md\.$/);
  assert.match(slash, /^\/codex was removed in 3\.0\. Settings: \/s\/config\.toml\./);
  assert.match(formAutoCancel, /engine's own UI, which ad doesn't ship; ad cancelled it\. Use \/mcp/);
});

test("the README sentence, the sandbox consent and the true statements about the user's own engine", () => {
  assert.match(readmeSentence, /^ad runs on a pinned copy of OpenAI's open-source Codex engine \(Apache-2\.0\) in its own folder; ad never writes to your own `~\/\.codex`\./);
  assert.match(readmeSentence, /`ad about` has the details\.$/);
  assert.match(sandboxConsent, /^Windows will ask for administrator permission\. The helper is OpenAI's sandbox program, shipped with the engine\./);
  assert.match(sandboxConsent, /shared with any other Codex install\. Continue\? \[y\/N\]$/);
  assert.equal(ownEngineHomeRefusal("/home/me/.codex"), "ad doesn't work inside a Codex home: /home/me/.codex");
  assert.match(ownEngineSessionsNote, /~\/\.codex\/sessions/);
  assert.match(ownEngineSessionsNote, /ad never writes there\.$/);
});

test("the engine home refusals say whose home it is and what to do", () => {
  assert.match(ownEngineHomeDefaultRefusal, /^ad won't start the engine without a home folder of its own: the default \(~\/\.codex\) belongs to your own Codex install\.$/);
  assert.equal(ownEngineHomeStartRefusal("/home/me/.codex"), "ad won't run the engine in /home/me/.codex: that is your own Codex home. Choose another folder with AD_ENGINE_DIR.");
});

test("env var renames: the note and the conflict refusal", () => {
  assert.equal(envRenameNote("AD_CODEX_BIN", "AD_ENGINE_BIN"), "AD_CODEX_BIN still works (its new name is AD_ENGINE_BIN).");
  assert.equal(
    envConflictRefusal({ newName: "AD_ENGINE_DIR", oldName: "AD_CODEX_HOME", newValue: "/a", oldValue: "/b" }),
    "AD_ENGINE_DIR (/a) and AD_CODEX_HOME (/b) point at different folders. Keep one of them.",
  );
});

test("migrate messages: done warns about an unsafe delete tool and macOS only when told; the rest say nothing changed", () => {
  const p = { oldPath: "/old/codex-home", newPath: "/new/engine" };
  const plain = migrateMessages.done(p);
  assert.match(plain, /^Moved \/old\/codex-home to \/new\/engine\. Sign-in, conversations, skills and hooks came along; nothing was deleted\. `codex-home` is now a link/);
  assert.doesNotMatch(plain, /rmdir|ad watch/);
  const full = migrateMessages.done({ ...p, unsafeDeleteTool: "Remove-Item -Recurse", macos: true });
  assert.match(full, /Delete it only with `rmdir`, never with `Remove-Item -Recurse`\. Restart `ad watch` \(or the service\) once\.$/);
  assert.match(migrateMessages.busy(p), /^Not moved: something is using \/old\/codex-home \(.*\)\. Nothing changed\. Close it and run `ad migrate` again\.$/);
  assert.equal(migrateMessages.failed({ reason: "permission denied" }), "Couldn't move the data folder (permission denied). Nothing changed.");
  assert.equal(migrateMessages.customPath({ path: "D:\\x" }), "AD_CODEX_HOME still works (its new name is AD_ENGINE_DIR). Using D:\\x; nothing moved.");
  assert.match(migrateMessages.oneEmpty({ name: "codex-home.empty-2026-10-12" }), /set it aside as codex-home\.empty-2026-10-12\.$/);
  assert.match(twoHomesRefusal(p), /^Two engine folders exist: \/old\/codex-home and \/new\/engine\. ad won't pick for you; nothing is deleted\./);
  assert.ok(Object.isFrozen(migrateMessages));
});

test("every export is a non-empty string, a function or deeply frozen data", () => {
  const deepFrozen = (v) => typeof v !== "object" || v === null || v instanceof RegExp || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
  for (const [name, value] of Object.entries(attribution)) {
    if (typeof value === "string") assert.ok(value.trim(), `${name} is empty`);
    else if (typeof value === "function") continue;
    else assert.ok(deepFrozen(value), `${name} should be frozen through`);
  }
});

test("S5: brandPatterns() covers every rendered text, each pattern is rendered somewhere, and nothing else is allowed", () => {
  const allow = brandPatterns();
  const samples = renderedSamples();
  assert.ok(samples.length >= 20);
  for (const sample of samples) assert.deepEqual(screenHits(sample, { allow }), [], `brand word not covered in: ${sample}`);
  const all = samples.join("\n");
  for (const p of allow) assert.match(all, p, `pattern never rendered: ${p}`);
  assert.equal(screenHits("■ Codex stopped (exit 3). Your text is kept.", { allow }).length, 1);
  assert.equal(screenHits("Try /review · /codex = stock Codex UI", { allow }).length, 1);
  assert.equal(screenHits("model: codex-mini-latest · gpt-5.x-codex", { allow }).length, 0);
});
