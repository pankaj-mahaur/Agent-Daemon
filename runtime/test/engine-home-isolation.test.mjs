// Start-up isolation in the façade (P0.2a): the engine runs in a neutral
// folder; every thread-creating call checks the folder the thread will run in
// against the user's own ~/.codex; in the markers-off launch mode every thread
// passes the real project markers; trusted home entries are deleted. Against
// the fake app-server, with HOME/USERPROFILE pointed at a temp home.

import { test } from "node:test";
import { projectConfigFolder } from "../src/engine/attribution.mjs";
const DOT = projectConfigFolder; // the engine's per-project folder name
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const put = (p, s = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};

// A temp user home (with ~/.codex/skills unless skills: false), a project with
// its own .git, and ad's engine home; HOME/USERPROFILE point at the temp home.
async function withHome({ skills = true, config, env = {}, ...opts } = {}, fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-iso-"));
  const home = join(root, "home");
  const project = join(home, "proj");
  put(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (skills) put(join(home, DOT, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
  else put(join(home, DOT, "config.toml"), 'model = "mine"\n');
  const engineHome = join(root, "engine");
  if (config) {
    // An ad-managed home (only those are ever written) that already has settings.
    put(join(engineHome, "fake-config.json"), JSON.stringify(config(home)));
    put(join(engineHome, ".agent-daemon-managed"), "test\n");
  }
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  let engine;
  try {
    engine = await createEngine({ home: engineHome, command, cwd: project, env, ...opts });
    await fn({ engine, home, project, root });
  } finally {
    await engine?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
const state = (engine) => engine.testRequest("debug/state", {});
const refused = { code: "HOME_FOLDER_REFUSED" };

test("the engine is launched in the neutral folder, not the work folder", async () => {
  await withHome({}, async ({ engine, project, home }) => {
    const { cwd } = await engine.testRequest("debug/processCwd", {});
    assert.equal(cwd, engine.launch.dir);
    assert.equal(engine.launch.dir, join(home, ".agent-daemon", "launch"));
    assert.notEqual(cwd, project);
    assert.equal(engine.launch.mode, "root");
  });
});

test("startThread without cwd sends the work folder; resume and fork add no default", async () => {
  await withHome({}, async ({ engine, project }) => {
    const { threadId } = await engine.threads.start({});
    let st = await state(engine);
    assert.equal(st.lastParams["thread/start"].cwd, project);
    await engine.threads.resume(threadId);
    await engine.threads.fork(threadId);
    st = await state(engine);
    assert.equal(st.lastParams["thread/resume"].cwd, undefined);
    assert.equal(st.lastParams["thread/fork"].cwd, undefined);
  });
});

test("start, resume and fork whose explicit or stored folder is refused throw HOME_FOLDER_REFUSED", async () => {
  await withHome({ env: { FAKE_THREAD_CWD: "" } }, async ({ engine, home, project }) => {
    await assert.rejects(engine.threads.start({ cwd: home }), refused);
    const { threadId } = await engine.threads.start({ cwd: project });
    await assert.rejects(engine.threads.resume(threadId, { cwd: home }), refused);
    await assert.rejects(engine.threads.fork(threadId, { cwd: home }), refused);
    // A thread whose stored folder is the home folder (started by an older ad).
    const { threadId: other } = await (async () => {
      const e2 = engine;
      e2.allowHomeFolder = true;
      try {
        return await e2.threads.start({ cwd: home });
      } finally {
        e2.allowHomeFolder = false;
      }
    })();
    await assert.rejects(engine.threads.resume(other), refused, "resume keeps the stored folder, so it is checked");
    await assert.rejects(engine.threads.fork(other), refused, "fork keeps the source thread's folder");
    const err = await engine.threads.start({ cwd: home }).catch((e) => e);
    assert.match(err.message, /Run this in a project folder/);
    assert.match(err.message, /--allow-home-folder/);
  });
});

test("a plain home's subfolder is fine; under a git home it is refused (home-repo)", async () => {
  await withHome({}, async ({ engine, home }) => {
    mkdirSync(join(home, "notes"), { recursive: true });
    await engine.threads.start({ cwd: join(home, "notes") });
    put(join(home, ".git", "HEAD"), "ref: refs/heads/main\n");
    await assert.rejects(engine.threads.start({ cwd: join(home, "notes") }), refused);
  });
});

test("allowHomeFolder: the home folder is not refused", async () => {
  await withHome({ allowHomeFolder: true }, async ({ engine, home }) => {
    await engine.threads.start({ cwd: home });
    assert.equal(await engine.homeFolderRisk(home), null);
  });
});

test("a ~/.codex with nothing loadable (settings, no trust) is never refused and costs no thread/read", async () => {
  await withHome({ skills: false }, async ({ engine, home }) => {
    const { threadId } = await engine.threads.start({ cwd: home });
    await engine.threads.resume(threadId);
    const st = await state(engine);
    assert.ok(!st.calls.includes("thread/read"), `calls: ${st.calls}`);
  });
});

test("in markers-off mode, start, resume, fork, the completion thread and structuredRequest pass project_root_markers", async () => {
  const config = () => ({ project_root_markers: [".git", ".hg"] });
  const root = mkdtempSync(join(tmpdir(), "ad-iso-launch-"));
  try {
    const launch = { dir: root, codexArgs: ["-c", "project_root_markers=[]"], mode: "markers-off" };
    await withHome({ config, launch }, async ({ engine, project }) => {
      const { argv } = await engine.testRequest("debug/processCwd", {});
      assert.deepEqual(argv.slice(-3), ["app-server", "-c", "project_root_markers=[]"]);
      const { threadId } = await engine.threads.start({});
      await engine.threads.resume(threadId);
      await engine.threads.fork(threadId);
      const st = await state(engine);
      for (const m of ["thread/start", "thread/resume", "thread/fork"]) assert.deepEqual(st.lastParams[m].config?.project_root_markers, [".git", ".hg"], m);
      await engine.complete({ user: "hi", cwd: project });
      assert.deepEqual((await state(engine)).lastParams["thread/start"].config?.project_root_markers, [".git", ".hg"], "the completion thread in a project");
      await engine.structuredRequest({ cwd: project, text: "recap", outputSchema: { type: "object" } }).catch(() => {});
      assert.deepEqual((await state(engine)).lastParams["thread/start"].config?.project_root_markers, [".git", ".hg"], "structuredRequest");
    });
    await withHome({ config }, async ({ engine }) => {
      await engine.threads.start({});
      assert.equal((await state(engine)).lastParams["thread/start"].config?.project_root_markers, undefined, "a neutral launch folder needs no markers");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the completion path swaps a refused folder for the launch folder", async () => {
  await withHome({}, async ({ engine, home, project }) => {
    await engine.complete({ user: "hi", cwd: home });
    assert.equal((await state(engine)).lastParams["thread/start"].cwd, engine.launch.dir);
    await engine.complete({ user: "hi", cwd: project });
    assert.equal((await state(engine)).lastParams["thread/start"].cwd, project);
  });
});

test("every trusted spelling of the home folder is deleted; others stay; untrusted is never written", async () => {
  const spellings = (home) => [home, home + sep, ...(process.platform === "win32" ? [home.toUpperCase()] : [])];
  const config = (home) => ({ projects: { ...Object.fromEntries(spellings(home).map((k) => [k, { trust_level: "trusted" }])), [join(home, "proj")]: { trust_level: "trusted" }, [join(home, "elsewhere")]: { trust_level: "untrusted" } } });
  await withHome({ config }, async ({ engine, home }) => {
    const projects = (await engine.readConfig()).projects ?? {};
    assert.deepEqual(Object.keys(projects).sort(), [join(home, "elsewhere"), join(home, "proj")].sort());
    assert.deepEqual(engine.homeEvents?.find((e) => e.type === "trustRemoved")?.keys.sort(), spellings(home).sort());
    const st = await state(engine);
    assert.ok(!JSON.stringify(st.lastParams["config/batchWrite"]).includes('"untrusted"'), "never writes untrusted");
  });
});

test("when a delete leaves a spelling behind, the table is replaced with expectedVersion", async () => {
  const config = (home) => ({ projects: { [home]: { trust_level: "trusted" }, [join(home, "proj")]: { trust_level: "trusted" } } });
  await withHome({ config, env: { FAKE_NULL_DELETE_NOOP: "1" } }, async ({ engine, home }) => {
    const st = await state(engine);
    assert.equal(st.lastParams["config/batchWrite"].expectedVersion, "u1");
    assert.deepEqual(Object.keys((await engine.readConfig()).projects ?? {}), [join(home, "proj")]);
  });
});

test("a managed home with no trusted home entry writes nothing", async () => {
  await withHome({ config: () => ({ projects: {} }) }, async ({ engine }) => {
    const st = await state(engine);
    assert.ok(!st.calls.includes("config/batchWrite"), `calls: ${st.calls}`);
    assert.equal(engine.homeEvents?.some((e) => e.type === "trustRemoved") ?? false, false);
  });
});

// Review round 1 (P0.2a).

test("markers-off with the launch folder under a git home: completions and structuredRequest run there with markers []", async () => {
  const config = () => ({ project_root_markers: [".git"] });
  await withHome({ config }, async ({ engine: probe, home }) => {
    await probe.close();
    put(join(home, ".git", "HEAD"), "ref: refs/heads/main\n");
    const dir = join(home, ".agent-daemon", "launch-under-git");
    mkdirSync(dir, { recursive: true });
    const engine = await createEngine({ home: join(home, "..", "engine"), command, cwd: join(home, "proj"), launch: { dir, codexArgs: ["-c", "project_root_markers=[]"], mode: "markers-off" } });
    try {
      const r = await engine.complete({ user: "hi" });
      assert.equal(r.ok, true, r.error);
      let st = await state(engine);
      assert.equal(st.lastParams["thread/start"].cwd, dir);
      assert.deepEqual(st.lastParams["thread/start"].config.project_root_markers, []);
      const r2 = await engine.complete({ user: "hi", cwd: home });
      assert.equal(r2.ok, true, r2.error);
      await engine.structuredRequest({ text: "recap", outputSchema: { type: "object" } }).catch(() => {});
      st = await state(engine);
      assert.equal(st.lastParams["thread/start"].cwd, dir, "no cwd: the launch folder, said explicitly");
      assert.deepEqual(st.lastParams["thread/start"].config.project_root_markers, []);
    } finally {
      await engine.close();
    }
  });
});

test("a trusted working folder under a git home trusts the home layer: settings alone refuse it", async () => {
  const config = (home) => ({ projects: { [join(home, "work")]: { trust_level: "trusted" } } });
  await withHome({ skills: false, config }, async ({ engine, home }) => {
    put(join(home, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(home, "work"), { recursive: true });
    mkdirSync(join(home, "other"), { recursive: true });
    const err = await engine.threads.start({ cwd: join(home, "work") }).catch((e) => e);
    assert.equal(err.code, "HOME_FOLDER_REFUSED");
    assert.match(err.message, /your own \S+ settings/);
    await engine.threads.start({ cwd: join(home, "other") });
  });
});

test("trust removal: a rejected delete still ends in the replace; an inherited engine home with another name keeps its parent's trust", async () => {
  const config = (home) => ({ projects: { [home]: { trust_level: "trusted" }, [join(home, "work")]: { trust_level: "trusted" } } });
  await withHome({ config, env: { FAKE_NULL_DELETE_FAIL: "1", CODEX_HOME: "" } }, async ({ engine, home }) => {
    assert.deepEqual(Object.keys((await engine.readConfig()).projects ?? {}), [join(home, "work")]);
    assert.equal((await state(engine)).lastParams["config/batchWrite"].expectedVersion, "u1");
  });
  const saved = process.env.CODEX_HOME;
  try {
    const root = mkdtempSync(join(tmpdir(), "ad-iso-ch-"));
    process.env.CODEX_HOME = join(root, "work", `tools${DOT}`);
    try {
      await withHome({ config: () => ({ projects: { [join(root, "work")]: { trust_level: "trusted" } } }) }, async ({ engine }) => {
        assert.deepEqual(Object.keys((await engine.readConfig()).projects ?? {}), [join(root, "work")]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test("ad engine ui refuses a folder that loads the user's own ~/.codex unless --allow-home-folder", async () => {
  const { runStockUi } = await import("../src/engine/codex/stock-ui.mjs");
  await withHome({}, async ({ home, root }) => {
    let spawned = false;
    const spawnFn = () => {
      spawned = true;
      throw new Error("not in this test");
    };
    await assert.rejects(runStockUi({ cwd: home, home: join(root, "ui-home"), spawnFn, store: { get: () => null }, lockDir: join(root, "locks") }), { code: "HOME_FOLDER_REFUSED" });
    assert.equal(spawned, false);
    await assert.rejects(runStockUi({ args: ["--allow-home-folder"], cwd: home, home: join(root, "ui-home"), spawnFn, store: { get: () => null }, lockDir: join(root, "locks") }), /not in this test/);
    assert.equal(spawned, true);
  });
});
