// A throwaway ad home for the state export/import tests (P7.2, P7.3): two projects, A and B, each
// with its own sentinel text, path, slug and id, so a test can prove nothing of the project it
// didn't pick reaches a bundle. Never the user's own folders.
//
//   makeStateFixture({ root }) → { root, ad, env, A, B, SECRET, KEYISH, close() }
//     A / B: { id, dir, slug, sentinel }
//     SECRET: the value in secrets/ (must never appear anywhere)
//     KEYISH: a key-shaped string inside one of A's lessons (the scan must find it)

import fs from "node:fs";
import path from "node:path";

const ID_A = "prj_01J0AAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "prj_01J0BBBBBBBBBBBBBBBBBBBBBB";

export async function makeStateFixture({ root, keyish = true }) {
  const ad = path.join(root, ".agent-daemon");
  const env = { ...process.env, AD_ROOT: ad, HOME: root, USERPROFILE: root };
  delete env.AD_TOOL_SHELL;
  const mk = (name, id, sentinel) => {
    const dir = path.join(root, "work", name);
    fs.mkdirSync(path.join(dir, ".agent-daemon", "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agent-daemon", "memory", "notes.md"), `# notes\n${sentinel} lives here\n`);
    fs.writeFileSync(path.join(dir, ".agent-daemon", "project.json"), JSON.stringify({ id }));
    fs.mkdirSync(path.join(dir, ".agent-daemon", "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agent-daemon", "logs", "x.log"), "machine-local\n");
    return { id, dir, slug: path.normalize(dir).replace(/[\\/:]/g, "-"), handoff: dir.replace(/[\\/:\s]+/g, "-").toLowerCase().replace(/^-+|-+$/g, ""), sentinel };
  };
  const A = mk("app-a", ID_A, "SENTINEL-ALPHA-7781");
  const B = mk("app-b", ID_B, "SENTINEL-BRAVO-4410");
  const SECRET = ["SEC", "RET", "VALUE", "99137"].join("-");
  const KEYISH = ["sk", "proj", "Zq9Xw2Lm4Np6Rt8Vb1Cd3Fg5Hj7Kl0Qa"].join("-");
  fs.mkdirSync(ad, { recursive: true });
  const w = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(ad, rel)), { recursive: true });
    fs.writeFileSync(path.join(ad, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  };
  w("projects.json", { schemaVersion: 1, revision: 1, projects: [A, B].map((p) => ({ id: p.id, name: path.basename(p.dir), paths: [{ path: p.dir, lastSeenAt: "2026-10-01T00:00:00.000Z" }], aliases: { episodic: [p.slug], handoff: [p.handoff] }, gitRemote: null, createdAt: "2026-10-01T00:00:00.000Z" })) });
  w("secrets/acct-work.dpapi", SECRET);
  w("accounts/registry.json", { schemaVersion: 1, revision: 1, salt: "b64:SALTSALT", engines: { api: { home: "api" } }, defaults: { target: null }, accounts: [{ id: "acct_work", provider: "openrouter", label: "work", method: "api-key", status: "ready", keyHint: "1111", credential: { kind: "secret", ref: "acct-work" }, identity: null }] });
  w("schedules.json", { jobs: [{ id: "aaa111", kind: "run", prompt: `nightly ${A.sentinel}`, cwd: A.dir, cron: "@daily" }, { id: "bbb222", kind: "run", prompt: `nightly ${B.sentinel}`, cwd: B.dir, cron: "@daily" }] });
  w("tui/prefs.json", { "limits.warnAt": 90 });
  w("locks/x.json", { pid: 1 });
  w("user.md", "# me\nlikes tabs\n");
  w(`handoffs/${A.handoff}/last.md`, `handoff ${A.sentinel}`);
  w(`handoffs/${B.handoff}/last.md`, `handoff ${B.sentinel}`);
  w(`projects/${A.id}/activeContext.md`, `context ${A.sentinel}`);
  w(`projects/${B.id}/activeContext.md`, `context ${B.sentinel}`);
  w("sessions/index.json", { schemaVersion: 1, revision: 1, sessions: { ses_A1: { cwd: A.dir, title: "a" }, ses_B1: { cwd: B.dir, title: `b ${B.sentinel}` } }, threads: { "api|t1": "ses_A1", "api|t2": "ses_B1" } });
  w("sessions/ses_A1.jsonl", `${JSON.stringify({ v: 1, type: "created", cwd: A.dir })}\n`);
  w("sessions/ses_B1.jsonl", `${JSON.stringify({ v: 1, type: "created", cwd: B.dir, note: B.sentinel })}\n`);

  // The memory DB, through ad's own open() (schema and migrations), then rows for A and B.
  const saved = process.env.AD_ROOT;
  process.env.AD_ROOT = ad;
  const { open } = await import("../src/memory/sqlite.mjs");
  const db = await open({ dbPath: path.join(ad, "episodic.db") });
  process.env.AD_ROOT = saved;
  if (saved === undefined) delete process.env.AD_ROOT;
  const raw = db.raw;
  const ins = (p, text, i) => raw.prepare("INSERT INTO learnings (project_slug, project_id, category, text, status, content_hash) VALUES (?, ?, 'pattern', ?, 'active', ?)").run(p.slug, p.id, text, `h${p.id.slice(-4)}${i}`);
  for (let i = 0; i < 3; i++) ins(A, `${A.sentinel} lesson ${i} about pnpm workspace hoisting`, i);
  if (keyish) ins(A, `the old key was ${KEYISH} before rotation`, 9);
  for (let i = 0; i < 3; i++) ins(B, `${B.sentinel} lesson ${i}`, i);
  raw.prepare("INSERT INTO sessions (id, project_path, project_slug, project_id, started_at) VALUES (?, ?, ?, ?, ?)").run("s-a", A.dir, A.slug, A.id, "2026-10-01T00:00:00Z");
  raw.prepare("INSERT INTO sessions (id, project_path, project_slug, project_id, started_at) VALUES (?, ?, ?, ?, ?)").run("s-b", B.dir, B.slug, B.id, "2026-10-01T00:00:00Z");
  raw.prepare("INSERT INTO user_facts (category, text, project_ids) VALUES ('preference', ?, ?)").run(`fact for A ${A.sentinel}`, JSON.stringify([A.id]));
  raw.prepare("INSERT INTO user_facts (category, text, project_ids) VALUES ('preference', ?, ?)").run(`fact for B ${B.sentinel}`, JSON.stringify([B.id]));
  raw.prepare("INSERT INTO user_facts (category, text, project_ids) VALUES ('identity', 'GLOBAL-FACT-5521', '[]')").run();
  await db.close?.();
  return { root, ad, env, A, B, SECRET, KEYISH };
}
