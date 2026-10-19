// Where ad keeps a project's capture files (P5.2): the learning journal and
// its archive, proposals, the session log, telemetry and the memory file. A
// project the user set up (ad init, or 3.0's hooks) keeps them in its own
// .agent-daemon folder; any other folder gets one under ad's root, so capture
// never creates a folder inside a repo the user didn't set up.
//
//   projectDataDir(cwd)        <cwd>/.agent-daemon when it exists, else
//                              adRoot()/projects/<slug>-<8 hex of the path>
//                              (the hash keeps folders whose slugs collide apart)
//   ensureProjectDataDir(cwd)  the same folder, created; inside a project's own
//                              .agent-daemon it writes the ignore file once
//   globalProposedDir()        adRoot()/proposed/_global

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { projectIdOf } from "./projects.mjs";

export const PROJECT_FOLDER = ".agent-daemon";
export const IGNORE_LINES = ["learning-journal*.jsonl", "*.draining-*.jsonl", "proposed/", "applied/"];
const IGNORE_TEXT = `# agent-daemon: capture files stay on this machine\n${IGNORE_LINES.join("\n")}\n`;

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Under node --test with the user's real home, a per-process temp folder:
// no test writes the user's ad root (lock.mjs does the same for locks).
function root() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.AD_ROOT) {
    let real = null;
    try {
      real = os.userInfo().homedir;
    } catch {
      // no passwd entry: treat the home as faked
    }
    if (real && path.resolve(real).toLowerCase() === path.resolve(os.homedir()).toLowerCase()) return path.join(os.tmpdir(), `ad-test-root-${process.pid}`);
  }
  return adRoot();
}

/** The folder name under adRoot()/projects for `dir`. */
export function projectFolderName(dir, { platform = process.platform } = {}) {
  const abs = path.resolve(dir);
  // Windows paths ignore case: one folder for C:\Work\App and c:\work\app.
  const spelled = platform === "win32" ? abs.toLowerCase() : abs;
  const slug = spelled.replace(/[\\/:]/g, "-").replace(/[^A-Za-z0-9._-]/g, "_").slice(-60);
  const hash = createHash("sha256").update(spelled).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * The folder outside the project for its capture files: adRoot()/projects/<project id>
 * (P7.1a); a folder from before ids (projects/<path key>) is used until the backfill
 * (project-db.mjs, a long-lived process) moves it to the id.
 */
export function outsideDir(cwd) {
  const legacy = path.join(root(), "projects", projectFolderName(cwd));
  const id = projectIdOf(path.resolve(cwd), { create: !isDir(legacy) });
  if (!id) return legacy;
  const byId = path.join(root(), "projects", id);
  return isDir(byId) || !isDir(legacy) ? byId : legacy;
}

/** Move a project's folder from its path key to its id (the backfill). Best effort. */
export function moveToIdFolder(dir, id) {
  const legacy = path.join(root(), "projects", projectFolderName(dir));
  const byId = path.join(root(), "projects", id);
  if (!isDir(legacy) || isDir(byId)) return false;
  try {
    fs.renameSync(legacy, byId);
    return true;
  } catch {
    return false; // in use: next time
  }
}

/** @returns {string} where this project's capture files go (not created) */
export function projectDataDir(cwd) {
  const own = path.join(path.resolve(cwd), PROJECT_FOLDER);
  const outside = outsideDir(cwd);
  if (!isDir(own)) return outside;
  // The project got its own folder (ad init) after capture started outside it:
  // bring those files in, so no journal, proposal or memory file is stranded.
  // The folder is claimed by a rename first, so two processes never both adopt it.
  if (isDir(outside)) {
    const claimed = `${outside}.adopting-${process.pid}`;
    try {
      fs.renameSync(outside, claimed);
      ensureIgnoreFile(own); // the capture files now sit in the repo: keep them out of git
      adoptFolder(claimed, own);
      // Whatever couldn't move goes back, for the next try.
      if (isDir(claimed)) fs.renameSync(claimed, outside);
    } catch {
      // another process is adopting it, or it can't move yet: next time
    }
  }
  return own;
}

// Lines appended (journals, logs, memory), other files moved unless the
// destination has one already. Best effort: what can't move stays and is
// tried again next time.
const appendable = (name) => name.endsWith(".jsonl") || name === "activeContext.md";
function adoptFolder(from, to) {
  const walk = (src, dst) => {
    let entries = [];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      try {
        if (e.isDirectory()) walk(s, d);
        else if (!fs.existsSync(d)) fs.renameSync(s, d);
        else if (appendable(e.name)) {
          const text = fs.readFileSync(s, "utf8");
          const sep = text && !fs.readFileSync(d, "utf8").endsWith("\n") ? "\n" : "";
          fs.appendFileSync(d, sep + text, "utf8");
          fs.rmSync(s, { force: true });
        } else if (fs.readFileSync(s).equals(fs.readFileSync(d))) fs.rmSync(s, { force: true });
        else fs.renameSync(s, path.join(dst, `outside-${Date.now().toString(36)}-${e.name}`));
      } catch {
        // next time
      }
    }
    try {
      fs.rmdirSync(src);
    } catch {
      // not empty: kept for next time
    }
  };
  walk(from, to);
}

/** True when `dir` is the project's own .agent-daemon folder (not one under ad's root). */
export function isOwnProjectFolder(cwd, dir) {
  return path.resolve(dir) === path.join(path.resolve(cwd), PROJECT_FOLDER);
}

/** projectDataDir(cwd), created. In the project's own folder the ignore file is written once. */
export function ensureProjectDataDir(cwd) {
  // Capture belongs to a real folder: no capture folder for a path that isn't one.
  if (!isDir(cwd)) throw new Error(`not a folder: ${cwd}`);
  const dir = projectDataDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  if (isOwnProjectFolder(cwd, dir)) ensureIgnoreFile(dir);
  return dir;
}

/** Writes <dir>/.gitignore when it is missing; never touches an existing one. */
export function ensureIgnoreFile(dir) {
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), IGNORE_TEXT, { flag: "wx" });
    return true;
  } catch {
    return false; // already there (or unwritable): leave it
  }
}

/** Proposals that belong to no single project (3.0 global rows). */
export function globalProposedDir() {
  return path.join(root(), "proposed", "_global");
}

/** Every capture folder under ad's root (the journal scrub walks them). */
export function rootProjectDirs() {
  const base = path.join(root(), "projects");
  try {
    return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}
