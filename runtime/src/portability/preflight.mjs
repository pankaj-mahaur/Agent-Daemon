// An import's first look at a bundle (P7.3a): everything checked before anything is written
// outside the import's own staging folder. A bundle is untrusted input.
//
//   preflight(buffer, { maxSize, maxEntries }) → { manifest, entries }   or throws IMPORT_REFUSED
//
// Caps: compressed size, unpacked size (at most 8 GiB and 1,000 times the compressed size),
// entry count, one file's size. The first entry is manifest.json and passes the manifest
// validator (a newer format says to update ad). Every effective name passes validateEntryName
// (the reader does it); no two names are equal after NFC and case folding; every file matches
// the manifest's size and hash, and nothing is extra or missing.

import { createHash } from "node:crypto";
import { readArchive } from "./archive.mjs";
import { FORMAT_VERSION, validateManifest } from "./manifest.mjs";

export const IMPORT_LIMITS = Object.freeze({ maxSize: 8 * 2 ** 30, maxEntries: 200_000, maxFile: 4 * 2 ** 30, ratio: 1000 });

export const PREFLIGHT_TEXTS = Object.freeze({
  NEWER: (v) => `This bundle was made by a newer ad (format ${v}). Update ad here, then import again.`,
  REFUSED: (why) => `Import refused: ${why}.`,
});

const refuse = (why, extra = {}) => Object.assign(new Error(PREFLIGHT_TEXTS.REFUSED(why)), { code: "IMPORT_REFUSED", why, ...extra });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function preflight(buffer, { maxSize = IMPORT_LIMITS.maxSize, maxEntries = IMPORT_LIMITS.maxEntries, maxFile = IMPORT_LIMITS.maxFile } = {}) {
  if (buffer.length > maxSize) throw refuse(`the file is larger than ${maxSize} bytes`);
  let entries;
  try {
    entries = readArchive(buffer, { maxBytes: Math.min(IMPORT_LIMITS.maxSize, Math.max(buffer.length, 1) * IMPORT_LIMITS.ratio) });
  } catch (e) {
    throw refuse(e.message);
  }
  if (entries.length > maxEntries) throw refuse(`it has more than ${maxEntries} entries`);
  if (entries[0]?.name !== "manifest.json") throw refuse("the manifest isn't the first entry");
  let manifest;
  try {
    manifest = JSON.parse(entries[0].data.toString("utf8"));
  } catch {
    throw refuse("the manifest isn't JSON");
  }
  if (Number.isInteger(manifest?.formatVersion) && manifest.formatVersion > FORMAT_VERSION) throw Object.assign(new Error(PREFLIGHT_TEXTS.NEWER(manifest.formatVersion)), { code: "IMPORT_NEWER" });
  const problems = validateManifest(manifest);
  if (problems.length) throw refuse(problems[0], { problems });
  // Names equal after NFC and case folding: refused on every OS (one of them can't hold both).
  const folded = new Map();
  for (const e of entries) {
    const k = e.name.normalize("NFC").toLowerCase();
    if (folded.has(k)) throw refuse(`${JSON.stringify(e.name)} and ${JSON.stringify(folded.get(k))} differ only by case`);
    folded.set(k, e.name);
  }
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const e of entries.slice(1)) {
    if (e.dir) continue;
    if (e.data.length > maxFile) throw refuse(`${e.name} is larger than ${maxFile} bytes`);
    const f = listed.get(e.name);
    if (!f) throw refuse(`${e.name} isn't in the manifest`);
    if (f.size !== e.data.length || f.sha256 !== sha256(e.data)) throw refuse(`${e.name} doesn't match its size or hash`);
    listed.delete(e.name);
  }
  if (listed.size) throw refuse(`${[...listed.keys()][0]} is in the manifest but not in the bundle`);
  return { manifest, entries: entries.slice(1).filter((e) => !e.dir) };
}
