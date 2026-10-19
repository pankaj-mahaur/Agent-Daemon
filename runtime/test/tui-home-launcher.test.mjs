// "Pick a project folder" (P0.2a): `ad` started in a folder that would load
// the user's own ~/.codex shows the launcher before the engine starts. Unit
// tests of its pieces, then `ad tui` in a real pty on the fake engine
// (testkit/tui-fake.mjs), with HOME/USERPROFILE pointed at a temp home.

import { test } from "node:test";
import { projectConfigFolder } from "../src/engine/attribution.mjs";
const DOT = projectConfigFolder; // the engine's per-project folder name
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xtermHeadless from "@xterm/headless";
import { spawnSync } from "node:child_process";
import { launcherItems, LAUNCHER_TITLE } from "../src/tui/home-launcher.mjs";
import { homeFolderAllowed, recentProjects } from "../src/harness/home-folder.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pty = null;
try {
  pty = (await import("@lydell/node-pty")).default;
} catch {
  pty = null;
}

const put = (p, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};
function tree({ skills = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ad-launcher-"));
  const home = path.join(root, "userhome");
  if (skills) put(path.join(home, DOT, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
  else mkdirSync(home, { recursive: true });
  const proj = path.join(home, "shop-app");
  put(path.join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { root, home, proj, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("launcherItems: the last project first, then the two ways to open home", () => {
  const items = launcherItems({ recent: ["/w/a", "/w/b"], risk: { loads: ["skills"] } });
  assert.deepEqual(items.map((i) => i.label), ["/w/a", "/w/b", "Open home anyway", "Always open home without asking"]);
  assert.equal(items[0].hint, "last used");
  assert.deepEqual(items[0].value, { cwd: "/w/a" });
  assert.match(items[2].hint, /loads your own \S+ skills from ~\/\.\w+/);
  assert.deepEqual(items[3].value, { allow: true, always: true });
});

test("recentProjects: newest first; missing, refused and excluded folders left out", (t) => {
  const { root, home, proj, done } = tree();
  t.after(done);
  const other = path.join(root, "other");
  mkdirSync(other, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v))));
  const state = {
    k1: { lastSeen: 100, path: other },
    k2: { lastSeen: 300, path: proj },
    k3: { lastSeen: 400, path: path.join(root, "gone") },
    k4: { lastSeen: 500, path: home },
    k5: "junk",
  };
  assert.deepEqual(recentProjects(state), [proj, other]);
  assert.deepEqual(recentProjects(state, { exclude: [proj] }), [other]);
});

test("homeFolderAllowed: the flag, AD_ALLOW_HOME_FOLDER=1, the pref; nothing else", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ad-prefs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefsFile = path.join(dir, "prefs.json");
  assert.deepEqual(homeFolderAllowed({ env: {}, prefsFile }), { allowed: false, source: null });
  assert.equal(homeFolderAllowed({ flag: true, env: {}, prefsFile }).source, "flag");
  assert.equal(homeFolderAllowed({ env: { AD_ALLOW_HOME_FOLDER: "1" }, prefsFile }).source, "env");
  assert.equal(homeFolderAllowed({ env: { AD_ALLOW_HOME_FOLDER: "true" }, prefsFile }).allowed, false, "only 1");
  writeFileSync(prefsFile, JSON.stringify({ allowHomeFolder: true }));
  assert.equal(homeFolderAllowed({ env: {}, prefsFile }).source, "pref");
  writeFileSync(prefsFile, JSON.stringify({ allowHomeFolder: "yes" }));
  assert.equal(homeFolderAllowed({ env: {}, prefsFile }).allowed, false, "only true");
});

// ---- `ad tui` in a pty ----

function screenText(term) {
  const b = term.buffer.active;
  const rows = [];
  for (let i = 0; i < b.length; i++) rows.push(b.getLine(i).translateToString(true));
  return rows.join("\n");
}
async function waitFor(fn, what, ms = 30000, screen = () => "") {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}\n--- screen ---\n${screen().slice(-2000)}`);
}

// Starts tui-fake in `cwd` with the temp user home.
function startTui({ root, home, cwd }) {
  const term = new xtermHeadless.Terminal({ cols: 100, rows: 30, scrollback: 500, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color", HOME: home, USERPROFILE: home };
  for (const k of ["WT_SESSION", "TERM_PROGRAM", "CODEX_HOME", "AD_CODEX_HOME", "AD_ENGINE_DIR", "AD_ALLOW_HOME_FOLDER"]) delete env[k];
  const child = pty.spawn(process.execPath, [path.join(here, "..", "testkit", "tui-fake.mjs"), path.join(root, "ad"), cwd], { cols: 100, rows: 30, cwd, env, name: "xterm-256color" });
  let exit = null;
  child.onData((d) => term.write(d));
  child.onExit((e) => (exit = e));
  term.onData((d) => child.write(d));
  return {
    term,
    child,
    text: () => screenText(term),
    exited: () => exit,
    close() {
      // The whole tree on Windows (tui-fake starts the fake engine), then the pty
      // itself: kill() also frees the ConPTY handles of an exited child.
      if (process.platform === "win32" && exit === null && child.pid) {
        spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
      try {
        child.kill();
      } catch {
        // gone
      }
      term.dispose();
    },
  };
}
const ptyOpts = { skip: !pty && "node-pty unavailable", timeout: 120000 };
const COMPOSER = /\? for shortcuts/;

// To the composer, answering the first-run trust question for a new folder.
async function toComposer(ui) {
  await waitFor(() => /Do you trust|\? for shortcuts/.test(ui.text()), "the trust question or the composer", 30000, ui.text);
  if (/Do you trust/.test(ui.text())) ui.child.write("\r");
  await waitFor(() => COMPOSER.test(ui.text()), "the composer", 30000, ui.text);
}

// Ctrl+C twice on an empty prompt.
async function quit(ui) {
  ui.child.write("\x03");
  await waitFor(() => /Ctrl\+C again/.test(ui.text()), "the quit hint", 10000, ui.text);
  ui.child.write("\x03");
  await waitFor(() => ui.exited() !== null, "ad to exit", 15000, ui.text);
}

test("ad in a refused home: 'Pick a project folder' with the last project first; Enter opens it", ptyOpts, async (t) => {
  const { root, home, proj, done } = tree();
  t.after(done);
  put(path.join(root, "ad", "state.json"), JSON.stringify({ k: { lastSeen: Date.now(), path: proj } }));
  const ui = startTui({ root, home, cwd: home });
  t.after(() => ui.close());
  await waitFor(() => ui.text().includes(LAUNCHER_TITLE), "the launcher", 30000, ui.text);
  assert.match(ui.text(), /Your home folder's ~\/\.\w+ has your own \S+ skills; ad would load them here/);
  assert.ok(ui.text().indexOf(proj) < ui.text().indexOf("Open home anyway"), "the last project is listed first");
  ui.child.write("\r");
  await toComposer(ui);
  assert.ok(ui.text().includes("shop-app"), "the header names the project folder");
  await quit(ui);
});

test("Always open home saves the pref; the next start opens home with the note", ptyOpts, async (t) => {
  const { root, home, done } = tree();
  t.after(done);
  const first = startTui({ root, home, cwd: home });
  t.after(() => first.close());
  await waitFor(() => first.text().includes("Always open home without asking"), "the launcher", 30000, first.text);
  // No recent projects: the first row is Open home anyway; one down is Always.
  first.child.write("\x1b[B");
  await new Promise((r) => setTimeout(r, 150));
  first.child.write("\r");
  await toComposer(first);
  await quit(first);
  const prefs = path.join(root, "ad", "prefs.json");
  assert.ok(existsSync(prefs), "prefs.json written");
  assert.equal(JSON.parse(readFileSync(prefs, "utf8")).allowHomeFolder, true);
  const second = startTui({ root, home, cwd: home });
  t.after(() => second.close());
  await toComposer(second);
  assert.ok(!second.text().includes(LAUNCHER_TITLE));
  assert.match(second.text(), /Working in your home folder/);
  await quit(second);
});

test("a home whose ~/.codex has no skills opens with no launcher", ptyOpts, async (t) => {
  const { root, home, done } = tree({ skills: false });
  t.after(done);
  const ui = startTui({ root, home, cwd: home });
  t.after(() => ui.close());
  await toComposer(ui);
  assert.ok(!ui.text().includes(LAUNCHER_TITLE));
  await quit(ui);
});

// A git home whose ~/.codex has settings only: the folder's trust decides.
function gitHomeWithSettings() {
  const t = tree({ skills: false });
  put(path.join(t.home, ".git", "HEAD"), "ref: refs/heads/main\n");
  put(path.join(t.home, DOT, "config.toml"), 'model = "mine"\n');
  mkdirSync(path.join(t.home, "work"), { recursive: true });
  return t;
}

test("an already trusted folder under a git home with home settings: the launcher comes after the engine starts", ptyOpts, async (t) => {
  const { root, home, proj, done } = gitHomeWithSettings();
  t.after(done);
  const engineHome = path.join(root, "ad", "home");
  put(path.join(engineHome, "fake-config.json"), JSON.stringify({ projects: { [path.join(home, "work")]: { trust_level: "trusted" } } }));
  put(path.join(engineHome, ".agent-daemon-managed"), "test\n");
  put(path.join(root, "ad", "state.json"), JSON.stringify({ k: { lastSeen: Date.now(), path: proj } }));
  const ui = startTui({ root, home, cwd: path.join(home, "work") });
  t.after(() => ui.close());
  await waitFor(() => ui.text().includes(LAUNCHER_TITLE), "the launcher", 30000, ui.text);
  assert.match(ui.text(), /your own \S+ settings/);
  ui.child.write("\r");
  await toComposer(ui);
  assert.ok(ui.text().includes("shop-app"));
  await quit(ui);
});

test("a new folder under a git home with home settings: no trust question, a note says why", ptyOpts, async (t) => {
  const { root, home, done } = gitHomeWithSettings();
  t.after(done);
  const ui = startTui({ root, home, cwd: path.join(home, "work") });
  t.after(() => ui.close());
  await waitFor(() => COMPOSER.test(ui.text()) || /Do you trust/.test(ui.text()), "the composer", 30000, ui.text);
  assert.doesNotMatch(ui.text(), /Do you trust/);
  assert.match(ui.text(), /didn't offer to trust this folder/);
  await quit(ui);
});

test("the late launcher checks the folder it opens: another trusted folder under the git home shows it again", ptyOpts, async (t) => {
  const { root, home, done } = gitHomeWithSettings();
  t.after(done);
  mkdirSync(path.join(home, "work2"), { recursive: true });
  const engineHome = path.join(root, "ad", "home");
  const trusted = { trust_level: "trusted" };
  put(path.join(engineHome, "fake-config.json"), JSON.stringify({ projects: { [path.join(home, "work")]: trusted, [path.join(home, "work2")]: trusted } }));
  put(path.join(engineHome, ".agent-daemon-managed"), "test\n");
  put(path.join(root, "ad", "state.json"), JSON.stringify({ k: { lastSeen: Date.now(), path: path.join(home, "work2") } }));
  const ui = startTui({ root, home, cwd: path.join(home, "work") });
  t.after(() => ui.close());
  await waitFor(() => ui.text().includes(LAUNCHER_TITLE), "the launcher", 30000, ui.text);
  const firstAt = ui.text().lastIndexOf(LAUNCHER_TITLE);
  ui.child.write("\r"); // work2: refused as well, once the engine runs there
  await waitFor(() => ui.text().lastIndexOf(LAUNCHER_TITLE) > firstAt || ui.exited() !== null, "the launcher again", 30000, ui.text);
  assert.ok(ui.text().lastIndexOf(LAUNCHER_TITLE) > firstAt, "shown again for work2");
  ui.child.write("\x1b");
  await waitFor(() => ui.exited() !== null, "ad to exit on Esc", 15000, ui.text);
  assert.equal(ui.exited().exitCode, 2);
});
