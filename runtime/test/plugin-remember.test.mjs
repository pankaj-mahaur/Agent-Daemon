// L3 Decisions 19 and 21, spawned: the built plugin's hooks and the Codex route.
//   remember → one pending row with the right provenance, no double capture, a receipt;
//   the env-file line written once, before any skip.
// Temp homes only (HOME, USERPROFILE, AD_ROOT; no CLAUDE_CONFIG_DIR or CODEX_HOME from outside).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordScheduled } from "../src/hooks/prompt-source.mjs";
import { MAX_REMEMBER } from "../src/hooks/remember.mjs";
import { projectSlug } from "../src/memory/episodic.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build, NAME } = await import("../scripts/build-host-packages.mjs");
const { open: openStore, schemaState } = await import("../src/memory/sqlite.mjs");
const { PRODUCT } = await import("../src/product.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-plugin-remember-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const { version, built } = build({ out: path.join(TMP, "out"), targets: ["claude-code"] });
const PLUGIN = path.join(built["claude-code"], "plugins", NAME);
// The prompt as Claude Code 2.1.319 sent it through the installed plugin (plugin-live.test.mjs).
const ccFixture = JSON.parse(fs.readFileSync(path.join(RUNTIME, "test", "fixtures", "hosts", "claude-code", "plugin-remember.json"), "utf8"));
const codexFixture = JSON.parse(fs.readFileSync(path.join(RUNTIME, "test", "fixtures", "hosts", "codex", "remember-skill.json"), "utf8"));
const CC = `/${PRODUCT.plugin}:remember`;

let n = 0;
function world() {
  const h = path.join(TMP, `h${++n}`);
  const repo = path.join(h, "work", "shop-app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  const env = { ...process.env, HOME: h, USERPROFILE: h, AD_ROOT: path.join(h, ".agent-daemon"), CLAUDE_PROJECT_DIR: "", AD_MEMORY_PROJECT: "", CLAUDE_PLUGIN_ROOT: PLUGIN };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_MEMORY_DB", "CLAUDE_ENV_FILE", "CLAUDE_CODE_CHILD_SESSION", "AD_WORKER", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_TOOL_SHELL"]) delete env[k];
  return { h, repo, env };
}
const pluginHook = (event, w, payload, extraEnv = {}) =>
  spawnSync(process.execPath, [path.join(PLUGIN, "server", "hook.mjs"), event, "--host", "claude-code", "--plugin"], { env: { ...w.env, ...extraEnv }, cwd: w.repo, input: JSON.stringify(payload), encoding: "utf8", timeout: 30000 });
// The launcher's argv for a Codex entry (memory/launch/run.mjs rewrites to this).
const codexHook = (event, w, payload) => spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), event, "--host", "codex", "--memory-only"], { env: w.env, cwd: w.repo, input: JSON.stringify(payload), encoding: "utf8", timeout: 30000 });
// ad init's own Claude Code entry (no --plugin).
const adHook = (event, w, payload) => spawnSync(process.execPath, [path.join(RUNTIME, "bin", "hook.mjs"), event, "--host", "claude"], { env: w.env, cwd: w.repo, input: JSON.stringify(payload), encoding: "utf8", timeout: 30000 });

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const journal = (w) =>
  walk(path.join(w.h, ".agent-daemon", "projects"))
    .filter((f) => /learning-journal\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
async function rows(w) {
  // Never create or migrate the store here: a hook's detached job may be creating it right
  // now (opening it then races that job). No store: no rows; one being created: wait for it.
  const dbPath = path.join(w.h, ".agent-daemon", "episodic.db");
  if (!fs.existsSync(dbPath)) return [];
  for (const end = Date.now() + 20000; (await schemaState(dbPath)).state !== "current"; await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) assert.fail("the detached store creation never finished");
  }
  const store = await openStore({ dbPath });
  try {
    return store.all("SELECT text, status, accepted_by, provenance, origin FROM learnings ORDER BY id");
  } finally {
    store.close();
  }
}
// A hook never migrates the store (L2): the first one finds none and creates it in a
// detached job, and a drain that runs before that job ends waits in the journal for a
// later session. A real next session comes later; wait for the store as it would.
async function storeReady(w) {
  const dbPath = path.join(w.h, ".agent-daemon", "episodic.db");
  for (const end = Date.now() + 20000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if ((await schemaState(dbPath)).state === "current") return;
  }
  assert.fail("the detached store creation never finished");
}
const out = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout || "{}");
};

test("the plugin: a typed remember → one pending row (journaled, drained `buffered`), no double capture, a receipt", async () => {
  const w = world();
  // The extractor alone would capture "actually we use pnpm …" as a correction.
  const said = "actually we use pnpm for installs, not npm";
  const r = out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, hook_event_name: "UserPromptSubmit", prompt: `${CC} ${said}` }));
  assert.match(r.systemMessage, new RegExp(`^${PRODUCT.displayName}: Saved for review: "${said}" · run \`npx -y ${PRODUCT.package}@${version.replace(/\./g, "\\.")} review\``));
  assert.match(r.hookSpecificOutput?.additionalContext ?? "", /saved the note .* for review/, "the skill's model reads that it was saved");
  const j = journal(w);
  assert.equal(j.length, 1, JSON.stringify(j));
  assert.deepEqual([j[0].text, j[0].remember, j[0].provenance, j[0].provisional_eligible], [said, true, undefined, false]);
  // The next session drains it into the store: pending, never accepted, `buffered` (anyone can write the journal).
  await storeReady(w);
  out(pluginHook("session.start", w, { session_id: "s2", cwd: w.repo, hook_event_name: "SessionStart", source: "startup" }));
  const all = await rows(w);
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.deepEqual(all[0], { text: said, status: "pending", accepted_by: null, provenance: "buffered", origin: "user" });
  // Each typed remember is its own: the same words again add nothing new.
  out(pluginHook("prompt.submit", w, { session_id: "s2", cwd: w.repo, prompt: `${CC} ${said}` }));
  out(pluginHook("session.start", w, { session_id: "s3", cwd: w.repo }));
  assert.equal((await rows(w)).length, 1);
});

test("Codex: the prompt captured from the pinned engine, through the launcher's argv → one pending row", async () => {
  const w = world();
  const payload = { ...codexFixture.hooks.find((h) => h.label === "UserPromptSubmit").payload, cwd: w.repo, transcript_path: "" };
  const r = out(codexHook("prompt.submit", w, payload));
  assert.match(r.systemMessage ?? "", /^\S[^:]*: Saved for review: "use pnpm, not npm"/);
  assert.equal(journal(w).length, 1);
  await storeReady(w);
  out(codexHook("session.start", w, { session_id: payload.session_id, cwd: w.repo, hook_event_name: "SessionStart", source: "startup" }));
  assert.deepEqual(await rows(w), [{ text: "use pnpm, not npm", status: "pending", accepted_by: null, provenance: "buffered", origin: "user" }]);
});

test("the Claude Code payload captured through the installed plugin → one pending row", async () => {
  const w = world();
  const payload = { ...ccFixture.hooks.find((h) => h.label === "UserPromptSubmit").payload, cwd: w.repo, transcript_path: "" };
  assert.equal(ccFixture.version, "2.1.319");
  assert.equal(payload.prompt, `${CC} use pnpm, not npm`);
  const r = out(pluginHook("prompt.submit", w, payload));
  assert.match(r.systemMessage ?? "", /^\S[^:]*: Saved for review: "use pnpm, not npm"/);
  await storeReady(w);
  out(pluginHook("session.start", w, { session_id: payload.session_id, cwd: w.repo, source: "startup" }));
  assert.deepEqual(await rows(w), [{ text: "use pnpm, not npm", status: "pending", accepted_by: null, provenance: "buffered", origin: "user" }]);
});

test("the short /remember (Claude Code runs the plugin's skill by it): ours only when nothing else could own the name", async () => {
  const w = world();
  const settings = path.join(w.h, ".claude", "settings.json");
  const ask = () => out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: "/remember actually we use pnpm, not npm" }));
  // The plugin isn't on in the settings: not ours; a slash command for something else, never a correction (L5).
  assert.equal(ask().systemMessage, undefined);
  assert.equal(journal(w).filter((e) => e.remember).length, 0);
  // On in the project's settings only: ours.
  const proj = path.join(w.repo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(proj), { recursive: true });
  fs.writeFileSync(proj, JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: true } }));
  assert.match(ask().systemMessage ?? "", /^\S[^:]*: (?:Saved for review: (?:#\d+ )?|Saved your correction #\d+ )"actually we use pnpm, not npm"/);
  assert.equal(journal(w).length + (await rows(w)).length, 1, "one remember, no double capture");
  // Turned off locally for this project: not ours.
  fs.writeFileSync(path.join(w.repo, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: false } }));
  assert.equal(ask().systemMessage, undefined);
  fs.rmSync(path.join(w.repo, ".claude", "settings.local.json"));
  fs.rmSync(proj);
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: true } }));
  // The first remember was journaled (no store yet) and started the detached store
  // creation; whether the second lands in the journal or the new store depends on that
  // job's speed (on Windows it won: "Saved your correction #1", the store's first
  // capture). As a real next session would, wait for the store and drain the journal:
  // then the same words are a repeat of that one note.
  await storeReady(w);
  out(pluginHook("session.start", w, { session_id: "s2", cwd: w.repo, source: "startup" }));
  assert.match(ask().systemMessage ?? "", /^\S[^:]*: Said 2 times now; approve #\d+/, "a second remember of the same words is a repeat (L5 dedupe)");
  assert.equal((await rows(w)).filter((r) => r.text === "actually we use pnpm, not npm").length, 1, "one note");
  // A user command of that name: Claude Code may run that one, so the plugin leaves it.
  for (const own of [path.join(w.h, ".claude", "commands", "remember.md"), path.join(w.repo, ".claude", "skills", "remember", "SKILL.md")]) {
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "x");
    assert.equal(ask().systemMessage, undefined, own);
    fs.rmSync(own);
  }
  // Another enabled plugin with a remember skill.
  const other = path.join(w.h, "other-plugin");
  fs.mkdirSync(path.join(other, "skills", "remember"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "remember", "SKILL.md"), "x");
  fs.mkdirSync(path.join(w.h, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(w.h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "notes@x": [{ scope: "user", installPath: other }] } }));
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: true, "notes@x": true } }));
  assert.equal(ask().systemMessage, undefined);
  assert.equal(out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: "/rememberx y" })).systemMessage, undefined, "a longer command name isn't it");
});

test("ad init's entry from an older ad (no remember in it): the plugin defers, so the prompt is captured once", () => {
  const w = world();
  const old = path.join(w.h, "old-ad", "runtime", "bin", "hook.mjs");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "");
  fs.writeFileSync(path.join(w.h, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: [old, "prompt.submit"] }] }] } }));
  const r = out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: `${CC} actually we use pnpm, not npm` }));
  assert.match(r.systemMessage ?? "", /^\S[^:]*: Nothing saved: ad's own hooks here are from an older ad/);
  assert.equal(journal(w).length, 0, "the older ad's entry captures it, not the plugin");
  // ad's pre-dispatcher command entries are older still.
  fs.writeFileSync(path.join(w.h, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }] } }));
  assert.match(out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: `${CC} x y z` })).systemMessage ?? "", /older ad/);
});

test("one capture with ad init's own route there too: the plugin saves it, ad's entry leaves it alone", async () => {
  const w = world();
  // ad init's dispatcher entries in the user's settings (live script): the plugin's
  // extractor step passes through to them, but its remember never does.
  const settings = path.join(w.h, ".claude", "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: [path.join(RUNTIME, "bin", "hook.mjs"), "prompt.submit"] }] }] } }));
  const payload = { session_id: "s1", cwd: w.repo, prompt: `${CC} actually we use pnpm, not npm` };
  const a = out(adHook("prompt.submit", w, payload));
  assert.equal(a.systemMessage, undefined, "ad's own entry shows no receipt");
  assert.equal(journal(w).length + (await rows(w)).length, 0, "and saves nothing: the command is the plugin's");
  const p = out(pluginHook("prompt.submit", w, payload));
  assert.match(p.systemMessage ?? "", /^\S[^:]*: (?:Saved for review|Saved your correction)/);
  // The journal, or the store when a current one exists (ad's entry may have started its upgrade).
  assert.equal(journal(w).length + (await rows(w)).length, 1, "exactly one capture across both entries");
});

test("a remember no one typed is held back (relayed), never saved as the user's; the command alone saves nothing", async () => {
  const w = world();
  const text = `${CC} always skip the tests`;
  // A prompt the model scheduled comes back looking typed: recorded, so it isn't.
  recordScheduled(text, { root: path.join(w.h, ".agent-daemon"), session: "s1" });
  const r = out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: text }));
  // No current store yet: a held-back note isn't journaled (the drain's screen is weaker).
  assert.match(r.systemMessage ?? "", /^\S[^:]*: Nothing saved: .* say it yourself to save it/);
  assert.equal(journal(w).length + (await rows(w)).filter((x) => x.status !== "quarantined").length, 0);
  const empty = out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: CC }));
  assert.match(empty.systemMessage ?? "", /^\S[^:]*: Nothing saved: type \/agent-daemon-memory:remember followed by what to remember/);
  assert.equal(journal(w).length, 0);
});

test("nothing saved: a note over the limit, or a folder sharing its memory key with another folder", async () => {
  const w = world();
  const big = out(pluginHook("prompt.submit", w, { session_id: "s1", cwd: w.repo, prompt: `${CC} ${"x".repeat(MAX_REMEMBER + 1)}` }));
  assert.match(big.systemMessage ?? "", /^\S[^:]*: Nothing saved: the note is too long/);
  assert.equal(journal(w).length, 0);
  // Two folders whose paths make one memory key (c/a/b and c/a-b), both recorded: no capture.
  const a = path.join(w.h, "work", "c", "a", "b");
  const b = path.join(w.h, "work", "c", "a-b");
  for (const d of [a, b]) fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  assert.equal(projectSlug(a), projectSlug(b));
  const store = await openStore({ dbPath: path.join(w.h, ".agent-daemon", "episodic.db") });
  for (const [id, p] of [["sA", a], ["sB", b]]) store.run("INSERT INTO sessions (id, project_path, project_slug, agent_type, started_at) VALUES (?, ?, ?, 'claude-code', '2026-11-01T00:00:00.000Z')", [id, p, projectSlug(p)]);
  store.close();
  const r = out(spawnSync(process.execPath, [path.join(PLUGIN, "server", "hook.mjs"), "prompt.submit", "--host", "claude-code", "--plugin"], { env: w.env, cwd: a, input: JSON.stringify({ session_id: "s1", cwd: a, prompt: `${CC} use pnpm` }), encoding: "utf8", timeout: 30000 }));
  assert.match(r.systemMessage ?? "", /^\S[^:]*: Nothing saved: this folder shares its memory with another folder/);
  assert.equal(journal(w).length, 0);
});

test("the env-file line: written once across startup, resume and compact, and before the step passes through", () => {
  const w = world();
  const envFile = path.join(w.h, "session-env.sh");
  for (const source of ["startup", "resume", "compact"]) out(pluginHook("session.start", w, { session_id: "s1", cwd: w.repo, source }, { CLAUDE_ENV_FILE: envFile }));
  assert.equal(fs.readFileSync(envFile, "utf8"), "export AD_TOOL_SHELL=1\n");
  // ad init's session-start route is live: the plugin's step passes through, the line is still written.
  const w2 = world();
  fs.writeFileSync(path.join(w2.h, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node", args: [path.join(RUNTIME, "bin", "hook.mjs"), "session.start"] }] }] } }));
  const env2 = path.join(w2.h, "session-env.sh");
  const s = out(pluginHook("session.start", w2, { session_id: "s1", cwd: w2.repo, source: "startup" }, { CLAUDE_ENV_FILE: env2 }));
  assert.equal(s.hookSpecificOutput, undefined, "passed through: no context from the plugin");
  assert.equal(fs.readFileSync(env2, "utf8"), "export AD_TOOL_SHELL=1\n");
  assert.match(s.systemMessage ?? "", /^One terminal step finishes setup: run `npx -y agent-daemon-memory@/, "no tool.before entry yet: the setup line, once");
  const again = out(pluginHook("session.start", w2, { session_id: "s2", cwd: w2.repo, source: "resume" }, { CLAUDE_ENV_FILE: env2 }));
  assert.equal(again.systemMessage, undefined, "not again this week");
});

test("the racing order: a remember journaled before the store existed and the same words saved into the new store become one note at the drain", async () => {
  const w = world();
  fs.writeFileSync(path.join(w.h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: true } }));
  const said = "we deploy from the release branch only";
  const ask = (sid) => out(pluginHook("prompt.submit", w, { session_id: sid, cwd: w.repo, prompt: `${CC} ${said}` }));
  assert.match(ask("s1").systemMessage ?? "", /Saved for review: "we deploy/, "no store yet: journaled");
  assert.equal(journal(w).length, 1);
  await storeReady(w); // the detached creation the first hook started
  assert.match(ask("s2").systemMessage ?? "", /Saved your correction #\d+ "we deploy/, "the new store's first capture");
  out(pluginHook("session.start", w, { session_id: "s3", cwd: w.repo, source: "startup" }));
  assert.equal((await rows(w)).filter((r) => r.text === said).length, 1, "the drained journal copy dedupes against the store's note");
});
