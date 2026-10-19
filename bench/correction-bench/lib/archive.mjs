// The test split stays outside the repository until the pre-registration tag
// (PROTOCOL.md "Keeping the test split private"). Only its hash is committed, so
// anyone can check later that the published archive is the one fixed in advance.
//
//   node lib/archive.mjs hash   <dir>                 print the folder's hash
//   node lib/archive.mjs write  <dir> <file.sha256>   write the hash file (once, before the dev pilot)
//   node lib/archive.mjs verify <dir> <file.sha256>   exit 1 when the folder changed
//
// The hash covers every file's relative path and bytes, sorted by path; nothing
// is normalized (archive the folder as it is, never through a git checkout that
// rewrites line ends).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function hashTree(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) files.push([r, sha(fs.readFileSync(a))]);
      else throw new Error(`not a plain file: ${r}`);
    }
  };
  walk(dir, "");
  if (!files.length) throw new Error(`empty folder: ${dir}`);
  files.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { hash: sha(files.map(([r, h]) => `${r}\0${h}\n`).join("")), files: files.length };
}

/** "<sha256>  <label>  (<n> files)" — one line, the format of tasks/test.sha256. */
export function writeHashFile(dir, file, label = path.basename(file, ".sha256")) {
  const { hash, files } = hashTree(dir);
  fs.writeFileSync(file, `${hash}  ${label}  (${files} files)\n`);
  return hash;
}

export function readHashFile(file) {
  const m = /^([0-9a-f]{64})\s/.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file}: no sha256 on the first line`);
  return m[1];
}

/** → { ok, expected, actual } */
export function verify(dir, file) {
  const expected = readHashFile(file);
  const { hash } = hashTree(dir);
  return { ok: hash === expected, expected, actual: hash };
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  const [cmd, dir, file] = process.argv.slice(2);
  try {
    if (cmd === "hash" && dir) console.log(hashTree(dir).hash);
    else if (cmd === "write" && dir && file) {
      if (fs.existsSync(file)) throw new Error(`${file} exists: the hash is fixed once; delete it on purpose to re-fix it`);
      console.log(writeHashFile(dir, file));
    } else if (cmd === "verify" && dir && file) {
      const r = verify(dir, file);
      console.log(r.ok ? `OK ${r.actual}` : `CHANGED: expected ${r.expected}, found ${r.actual}`);
      process.exitCode = r.ok ? 0 : 1;
    } else {
      console.error("usage: node lib/archive.mjs hash <dir> | write <dir> <file.sha256> | verify <dir> <file.sha256>");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
