// Start-up isolation (P0.2a): homeLayerRisk says whether the engine would
// load the user's own ~/.codex as a project layer for a working folder, and
// launchDir picks a launch folder outside every project. Temp trees only.

import { test } from "node:test";
import { projectConfigFolder } from "../src/engine/attribution.mjs";
const DOT = projectConfigFolder; // the engine's per-project folder name
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeLayerRisk, launchDir } from "../src/engine/codex/home.mjs";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ad-hlr-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, userHomes: [join(home, DOT)], done: () => rmSync(root, { recursive: true, force: true }) };
}
const put = (p, s = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
const skill = (dotCodex, name = "mine") => put(join(dotCodex, "skills", name, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
const gitRepo = (dir) => put(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

test("cwd = home with ~/.codex/skills/x/SKILL.md → home, loads [skills]", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  const r = homeLayerRisk({ cwd: home, userHomes });
  assert.equal(r?.kind, "home");
  assert.deepEqual(r.loads, ["skills"]);
  assert.equal(r.dotCodex, join(home, DOT));
});

test("cwd = home, ~/.codex absent or without skills, and no trust → null", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  assert.equal(homeLayerRisk({ cwd: home, userHomes }), null, "no ~/.codex");
  put(join(home, DOT, "config.toml"), 'model = "x"\n');
  mkdirSync(join(home, DOT, "skills", "empty"), { recursive: true });
  assert.equal(homeLayerRisk({ cwd: home, userHomes }), null, "settings without trust and an empty skills folder load nothing");
});

test("the engine's bundled skills/.system don't count", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  put(join(home, DOT, "skills", ".system", "imagegen", "SKILL.md"));
  assert.equal(homeLayerRisk({ cwd: home, userHomes }), null);
  skill(join(home, DOT), "deep/a/b/c");
  assert.deepEqual(homeLayerRisk({ cwd: home, userHomes })?.loads, ["skills"], "a nested skill counts");
});

test("skills deeper than the engine searches don't count", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  put(join(home, DOT, "skills", "1", "2", "3", "4", "5", "6", "7", "SKILL.md"));
  assert.equal(homeLayerRisk({ cwd: home, userHomes }), null);
});

test("settings count only when the layer is trusted", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  put(join(home, DOT, "config.toml"), 'model = "x"\n');
  const trusted = (dir) => dir === home;
  assert.deepEqual(homeLayerRisk({ cwd: home, userHomes, isTrusted: trusted })?.loads, ["settings"]);
  put(join(home, DOT, "config.toml"), "");
  assert.equal(homeLayerRisk({ cwd: home, userHomes, isTrusted: trusted }), null, "an empty config.toml loads nothing");
});

test("a git home, non-git subfolder → home-repo; a plain home's subfolder → null", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  mkdirSync(join(home, "sub", "deeper"), { recursive: true });
  assert.equal(homeLayerRisk({ cwd: join(home, "sub", "deeper"), userHomes }), null, "no marker: the root is the folder itself");
  gitRepo(home);
  const r = homeLayerRisk({ cwd: join(home, "sub", "deeper"), userHomes });
  assert.equal(r?.kind, "home-repo");
  assert.deepEqual(r.loads, ["skills"]);
});

test("a project with its own .git inside a git home → null", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  gitRepo(home);
  gitRepo(join(home, "proj"));
  mkdirSync(join(home, "proj", "src"), { recursive: true });
  assert.equal(homeLayerRisk({ cwd: join(home, "proj", "src"), userHomes }), null);
});

test(".git without HEAD doesn't count; a .git file does", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  mkdirSync(join(home, ".git"), { recursive: true });
  mkdirSync(join(home, "sub"), { recursive: true });
  assert.equal(homeLayerRisk({ cwd: join(home, "sub"), userHomes }), null, "an empty .git folder is no marker");
  rmSync(join(home, ".git"), { recursive: true });
  put(join(home, ".git"), "gitdir: elsewhere\n");
  assert.equal(homeLayerRisk({ cwd: join(home, "sub"), userHomes })?.kind, "home-repo");
});

test("markers [] → the root is the folder itself", (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  gitRepo(home);
  mkdirSync(join(home, "sub"), { recursive: true });
  assert.equal(homeLayerRisk({ cwd: join(home, "sub"), userHomes, markers: [] }), null);
  assert.equal(homeLayerRisk({ cwd: home, userHomes, markers: [] })?.kind, "home");
  put(join(home, "sub", ".marker"));
  put(join(home, "sub", "a", "b"), "");
  assert.equal(homeLayerRisk({ cwd: join(home, "sub", "a"), userHomes, markers: [".marker"] }), null, "a custom marker below home stops the walk");
});

test("case and trailing separators of the folder", { skip: process.platform !== "win32" && "case-insensitive paths: Windows" }, (t) => {
  const { home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  assert.equal(homeLayerRisk({ cwd: home.toUpperCase() + "\\", userHomes })?.kind, "home");
});

test("an inherited engine home with another name never matches a project layer", (t) => {
  const { root, home, done } = tree();
  t.after(done);
  const other = join(home, "engine-other");
  skill(other);
  skill(join(home, DOT));
  assert.equal(homeLayerRisk({ cwd: home, userHomes: [other] }), null, "only user homes named like the project folder are project layers");
  void root;
});

test("a link inside the git home to an outside folder, given as the inside path → home-repo; the reverse → null", (t) => {
  const { root, home, userHomes, done } = tree();
  t.after(done);
  skill(join(home, DOT));
  gitRepo(home);
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(home, "sub"), { recursive: true });
  symlinkSync(outside, join(home, "proj-link"), "junction");
  symlinkSync(join(home, "sub"), join(outside, "link-in"), "junction");
  assert.equal(homeLayerRisk({ cwd: join(home, "proj-link"), userHomes })?.kind, "home-repo", "the engine walks the path as given");
  assert.equal(homeLayerRisk({ cwd: join(outside, "link-in"), userHomes }), null, "an outside path pointing in walks outside ancestors");
});

test("a skills folder that links elsewhere is followed, and a link loop ends", (t) => {
  const { root, home, userHomes, done } = tree();
  t.after(done);
  const store = join(root, "store");
  put(join(store, "a", "SKILL.md"));
  mkdirSync(join(home, DOT), { recursive: true });
  symlinkSync(store, join(home, DOT, "skills"), "junction");
  assert.deepEqual(homeLayerRisk({ cwd: home, userHomes })?.loads, ["skills"]);
  rmSync(join(store, "a"), { recursive: true });
  symlinkSync(store, join(store, "loop"), "junction");
  assert.equal(homeLayerRisk({ cwd: home, userHomes }), null);
});

test("launchDir: the ad-root candidate outside any repo is used as is", (t) => {
  const { root, done } = tree();
  t.after(done);
  const r = launchDir({ adRoot: join(root, "ad"), platform: "win32" });
  assert.equal(r.dir, join(root, "ad", "launch"));
  assert.deepEqual(r.codexArgs, []);
  assert.equal(r.mode, "root");
});

test("launchDir: a candidate inside a repo is skipped; all inside → the -c fallback", (t) => {
  const { root, home, done } = tree();
  t.after(done);
  gitRepo(home);
  const adRoot = join(home, ".agent-daemon");
  const win = launchDir({ adRoot, platform: "win32" });
  assert.equal(win.dir, join(adRoot, "launch"));
  assert.deepEqual(win.codexArgs, ["-c", "project_root_markers=[]"]);
  assert.equal(win.mode, "markers-off");
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  const posix = launchDir({ adRoot, platform: "linux", tmp });
  assert.equal(posix.mode, "temp");
  assert.deepEqual(posix.codexArgs, []);
  assert.match(posix.dir, /agent-daemon-launch-/);
  assert.notEqual(launchDir({ adRoot, platform: "linux", tmp }).dir, posix.dir, "a fresh mkdtemp folder each time, never a fixed name");
  gitRepo(root);
  assert.equal(launchDir({ adRoot, platform: "linux", tmp }).mode, "markers-off", "a temp folder inside a repo is skipped too");
});
