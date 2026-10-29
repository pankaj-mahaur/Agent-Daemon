// The names a bundle may hold (P7.1b), checked on export (P7.2's plan step) and on import (P7.3):
// a name that could leave the bundle's own folder, or that one OS can't create, is refused.
//
//   validateEntryName(name, { dir }) → null when fine, else the reason (a short sentence)
//
// A name is "manifest.json", or lives under "global/" or "projects/<id>/". It is relative, uses
// "/" only, has no empty, "." or ".." segment, no control character or one Windows forbids, no
// segment ending in a dot or a space, no Windows device name, is NFC, and is at most 240 bytes
// (each segment at most 200).

import { PROJECT_ID_RE } from "../memory/projects.mjs";

const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

export function validateEntryName(name, { dir = false } = {}) {
  if (typeof name !== "string" || !name) return "an empty name";
  if (name.normalize("NFC") !== name) return "a name that isn't in Unicode NFC form";
  if (Buffer.byteLength(name) > 240) return "a name longer than 240 bytes";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an absolute name";
  if (name.includes("\\")) return "a backslash in a name";
  const bare = dir && name.endsWith("/") ? name.slice(0, -1) : name;
  const segs = bare.split("/");
  for (const s of segs) {
    if (!s) return "an empty segment";
    if (s === "." || s === "..") return "a . or .. segment";
    if (BAD_CHARS.test(s)) return "a character a file name can't hold on every OS";
    if (/[. ]$/.test(s)) return "a segment ending in a dot or a space";
    if (DEVICE.test(s)) return "a Windows device name";
    if (Buffer.byteLength(s) > 200) return "a segment longer than 200 bytes";
  }
  if (bare === "manifest.json") return dir ? "the manifest as a directory" : null;
  if (segs[0] === "global") return segs.length > 1 || dir ? null : "global/ as a file";
  if (segs[0] === "projects") {
    if (segs.length < 2 || !PROJECT_ID_RE.test(segs[1])) return "a projects/ entry without a project id";
    return segs.length > 2 || dir ? null : "a project folder as a file";
  }
  return "a name outside global/ and projects/<id>/";
}
