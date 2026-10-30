// P7.1b: the portable state format: path tokens, entry names, the .adstate codec, the manifest
// and the inventory of everything ad keeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fromToken, isToken, tokenRoots, toToken } from "../src/portability/paths.mjs";
import { validateEntryName } from "../src/portability/names.mjs";
import { ArchiveError, readArchive, writeArchive } from "../src/portability/archive.mjs";
import { buildManifest, newExportId, validateManifest } from "../src/portability/manifest.mjs";
import { CLASSES, classify, OPTIONAL_CLASSES } from "../src/portability/inventory.mjs";
import { legacyHomeName } from "../src/engine/attribution.mjs";

const PRJ = "prj_01J00000000000000000000000";

// ---- path tokens ---------------------------------------------------------------------------------
test("tokens: a Windows source matches case-insensitively and the longest root wins; round trip to POSIX", () => {
  const roots = tokenRoots({ home: "C:\\Users\\X", adRoot: "C:\\Users\\X\\.agent-daemon", projects: [{ id: PRJ, path: "c:\\users\\x\\work\\app" }] });
  assert.deepEqual(toToken("C:\\Users\\X\\Work\\App\\src\\a.js", roots, { caseInsensitive: true }), { value: `{PROJECT:${PRJ}}/src/a.js`, token: true });
  assert.deepEqual(toToken("C:\\Users\\X\\.agent-daemon\\tui\\prefs.json", roots, { caseInsensitive: true }).value, "{AD_ROOT}/tui/prefs.json", "AD_ROOT beats HOME");
  assert.equal(toToken("C:\\Users\\X\\Work\\App\\a.js", [...roots].reverse(), { caseInsensitive: true }).value, `{PROJECT:${PRJ}}/a.js`, "the longest root wins, whatever the order");
  assert.deepEqual(toToken("C:\\Users\\X\\notes.txt", roots, { caseInsensitive: true }).value, "{HOME}/notes.txt");
  assert.equal(toToken("C:\\Users\\X\\Work\\App", roots, { caseInsensitive: true }).value, `{PROJECT:${PRJ}}`);
  const posix = tokenRoots({ home: "/home/x", projects: [{ id: PRJ, path: "/home/x/code/app" }] });
  assert.equal(fromToken(`{PROJECT:${PRJ}}/src/a.js`, posix, { join: path.posix.join }), "/home/x/code/app/src/a.js");
  assert.equal(fromToken("{HOME}", posix, { join: path.posix.join }), "/home/x");
  assert.equal(fromToken("{PROJECT:prj_unknown}/a", posix), "{PROJECT:prj_unknown}/a", "an unknown token stays literal");
  assert.equal(isToken("{AD_ROOT}/x"), true);
});

test("tokens: a Linux source with another case stays literal; a UNC path stays literal; prefixes don't match part of a name", () => {
  const roots = tokenRoots({ projects: [{ id: PRJ, path: "/work/App" }] });
  assert.deepEqual(toToken("/work/app/src/a.js", roots), { value: "/work/app/src/a.js", token: false });
  assert.deepEqual(toToken("\\\\server\\share\\a.txt", tokenRoots({ home: "C:\\Users\\X" }), { caseInsensitive: true }), { value: "\\\\server\\share\\a.txt", token: false });
  assert.deepEqual(toToken("/work/App-b/x", roots), { value: "/work/App-b/x", token: false }, "/work/App-b isn't under /work/App");
});

// ---- entry names ---------------------------------------------------------------------------------
test("entry names: only manifest.json, global/… and projects/<id>/…; nothing that leaves the bundle or one OS can't create", () => {
  for (const ok of ["manifest.json", "global/episodic.db", `projects/${PRJ}/memory/a.md`, "global/tui/prefs.json"]) assert.equal(validateEntryName(ok), null, ok);
  assert.equal(validateEntryName("global/handoffs", { dir: true }), null);
  for (const bad of ["", "/etc/passwd", "C:/x", "global\\x", "global/../x", "global/./x", "global//x", "other/x", "projects/not-an-id/x", `projects/${PRJ}`, "global", "global/a:b", "global/con", "global/aux.txt", "global/x.", "global/x ", "global/a\u0000b", "global/e\u0301", `global/${"a".repeat(201)}`]) {
    assert.notEqual(validateEntryName(bad), null, JSON.stringify(bad));
  }
});

// ---- the archive ----------------------------------------------------------------------------------
const ENTRIES = [
  { name: "manifest.json", data: "{}" },
  { name: "global/episodic.db", data: Buffer.from([0, 1, 2, 3]) },
  { name: "global/handoffs", dir: true },
  { name: `projects/${PRJ}/memory/${"long-name-".repeat(12)}é.md`, data: "x".repeat(1000) },
];

test("archive: a round trip gives every entry back, byte for byte, and the same input always writes the same bytes", () => {
  const a = writeArchive(ENTRIES);
  const b = writeArchive([...ENTRIES].reverse());
  assert.ok(a.equals(b), "deterministic, order-independent");
  const back = readArchive(a);
  assert.deepEqual(back.map((e) => e.name), ["manifest.json", "global/episodic.db", "global/handoffs/", `projects/${PRJ}/memory/${"long-name-".repeat(12)}é.md`]);
  assert.deepEqual(back[1].data, Buffer.from([0, 1, 2, 3]));
  assert.equal(back[3].data.toString(), "x".repeat(1000), "a long name through a pax header");
  assert.throws(() => writeArchive([{ name: "global/../x", data: "" }]), ArchiveError);
  assert.throws(() => writeArchive([{ name: "global/a", data: "" }, { name: "global/a", data: "" }]), /twice/);
});

// A hand-built tar: one header (with any type and name) plus data, for the reader's refusals.
function rawTar(blocks) {
  const out = [];
  for (const { name = "global/x", type = "0", data = Buffer.alloc(0), prefix = "" } of blocks) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000600\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.fill(0x20, 148, 156);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    out.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(out));
}

test("archive reader: a symlink, a hardlink, a global pax header, a pax path of ../x, a ustar prefix of .. and a cut bundle are refused", () => {
  assert.throws(() => readArchive(rawTar([{ type: "2" }])), /neither a file nor a folder/);
  assert.throws(() => readArchive(rawTar([{ type: "1" }])), /neither a file nor a folder/);
  assert.throws(() => readArchive(rawTar([{ type: "g", data: Buffer.from("13 path=a/b\n") }])), /neither a file nor a folder/);
  const pax = Buffer.from("13 path=../x\n");
  assert.throws(() => readArchive(rawTar([{ type: "x", data: pax }, { name: "global/benign" }])), /\.\. segment/, "the effective name is checked, not the benign ustar one");
  assert.throws(() => readArchive(rawTar([{ type: "x", data: Buffer.from("15 mtime=12345\n") }, { name: "global/x" }])), /pax key/);
  assert.throws(() => readArchive(rawTar([{ name: "x", prefix: ".." }])), /\.\. segment/);
  const whole = writeArchive(ENTRIES);
  assert.throws(() => readArchive(whole.subarray(0, whole.length - 20)), /isn't a complete gzip|cut short/);
  assert.throws(() => readArchive(Buffer.from("not gzip")), ArchiveError);
});

// ---- the manifest ----------------------------------------------------------------------------------
const sha = "a".repeat(64);
test("manifest: a sound one passes; an unknown version, unknown content, outside paths, duplicates and unknown projects are refused", () => {
  const m = buildManifest({ scope: { projects: "selected", globalMemory: false }, projects: [{ id: PRJ, name: "app", pathToken: `{PROJECT:${PRJ}}` }], files: [{ path: `projects/${PRJ}/memory/a.md`, size: 3, sha256: sha, class: "project-memory" }], db: [{ file: "global/episodic.db", tables: { learnings: { rows: 1, byProject: { [PRJ]: 1 } } } }] });
  assert.match(m.exportId, /^exp_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual(validateManifest(m), []);
  assert.match(validateManifest({ ...m, formatVersion: 2 })[0], /formatVersion 2/);
  assert.ok(validateManifest({ ...m, extra: { a: 1 } }).some((p) => /unknown field with content: extra/.test(p)));
  assert.deepEqual(validateManifest({ ...m, extra: null }), [], "an empty unknown field is tolerated");
  assert.ok(validateManifest({ ...m, files: [...m.files, { path: "../x", size: 1, sha256: sha }] }).some((p) => /\.\. segment/.test(p)));
  assert.ok(validateManifest({ ...m, files: [m.files[0], m.files[0]] }).some((p) => /twice/.test(p)));
  assert.ok(validateManifest({ ...m, files: [{ path: "projects/prj_01J11111111111111111111111/a", size: 1, sha256: sha }] }).some((p) => /doesn't declare/.test(p)));
  assert.ok(validateManifest({ ...m, db: [{ tables: { learnings: { byProject: { global: 3 } } } }] }).some((p) => /global/.test(p)), "global counts need global memory in scope");
  assert.ok(validateManifest({ ...m, secretPolicy: "included" }).some((p) => /never carries secrets/.test(p)));
  assert.notEqual(newExportId(), newExportId());
});

// ---- the inventory --------------------------------------------------------------------------------
test("inventory: secrets, auth.json and engine homes are never taken; locks are machine-local; journals and rollouts are opt", () => {
  for (const p of ["secrets/acct-x.dpapi", "a/ab12/auth.json", "engine/auth.json", "engine/config.toml", legacyHomeName]) assert.equal(classify(p).default, "never", p);
  assert.equal(classify("locks/x.json").default, "out");
  assert.equal(classify("sessions.jsonl", "project").id, "project-journals");
  assert.equal(classify("sessions.jsonl", "project").default, "opt");
  assert.equal(classify("engine/sessions/2026/10/r.jsonl").id, "engine-rollouts");
  assert.ok(OPTIONAL_CLASSES.includes("tui-history"));
  assert.equal(new Set(CLASSES.map((c) => c.id)).size, CLASSES.length, "ids are unique");
});

test("inventory: every folder or file ad's code puts under its state root has exactly one class", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".mjs")) files.push(path.join(d, e.name));
    }
  };
  walk(src);
  const names = new Set();
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/join\(\s*adRoot\([^)]*\)\s*,\s*"([^"]+)"/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 5, `found ${[...names].join(", ")}`);
  const missing = [...names].filter((n) => !classify(n) && !classify(`${n}/x`));
  assert.deepEqual(missing, [], "each needs a class in portability/inventory.mjs");
});
