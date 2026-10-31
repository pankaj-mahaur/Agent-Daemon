// Shared helpers: replace a scenario's temp root with a stable placeholder so
// captured payloads can be committed as fixtures, and print a run compactly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The temp root appears raw, JSON-escaped, with forward slashes, and inside
// Claude Code's project slug (every non-alphanumeric char becomes "-").
export function sanitizer(tmp) {
  const forms = new Set([tmp, tmp.replaceAll("\\", "/"), tmp.replaceAll("\\", "\\\\"), tmp.replace(/[^A-Za-z0-9]/g, "-")]);
  const sorted = [...forms].sort((a, b) => b.length - a.length);
  return (value) => {
    let s = typeof value === "string" ? value : JSON.stringify(value);
    for (const f of sorted) s = s.split(f).join(f.includes("-") && !f.includes("\\") && !f.includes("/") ? "-TMP-" : "<TMP>");
    return typeof value === "string" ? s : JSON.parse(s);
  };
}

// Last pass before a fixture is committed: the account name and this
// checkout's path, in every escaping a payload can carry (raw, JSON, JSON in
// JSON, forward slashes, Git Bash /c/...), become placeholders.
// The profile folder name can differ from the account name (C:\Users\abc
// for account "Abcdef"), so both are replaced.
export function scrub(text, { users = [os.userInfo().username, path.basename(os.homedir())], repo = REPO, home = os.homedir() } = {}) {
  const variants = (p) => {
    const fwd = p.replaceAll("\\", "/");
    const out = new Set([p, fwd, p.replaceAll("\\", "\\\\"), p.replaceAll("\\", "\\\\\\\\"), fwd.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)]);
    return [...out].sort((a, b) => b.length - a.length);
  };
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let s = text;
  for (const v of variants(repo)) s = s.split(v).join("<REPO>");
  // The checkout path also appears as a slug (every non-alphanumeric char a
  // dash) inside temp and transcript folder names.
  // Payload text cut short can end mid-slug, so a 16-char prefix is enough.
  const slug = repo.replace(/[^A-Za-z0-9]/g, "-");
  s = s.replace(new RegExp(`${esc(slug.slice(0, 16))}[A-Za-z0-9-]*`, "g"), "-REPO-");
  for (const v of variants(home)) s = s.replace(new RegExp(esc(v), "gi"), "<HOME>");
  for (const u of [...new Set(users)].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(esc(u), "gi"), "<user>");
  return s;
}

export function readHooks(tmp) {
  const f = path.join(tmp, "hooks.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

if (process.argv[1]?.endsWith("sanitize.mjs") && process.argv[2] === "--scrub") {
  // node sanitize.mjs --scrub <fixture dir>: rewrite every file in place.
  const dir = path.resolve(process.argv[3]);
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    const before = fs.readFileSync(p, "utf8");
    const after = scrub(before);
    if (after !== before) fs.writeFileSync(p, after);
  }
} else if (process.argv[1]?.endsWith("sanitize.mjs")) {
  const tmp = path.resolve(process.argv[2]);
  const clean = sanitizer(tmp);
  for (const r of readHooks(tmp)) {
    console.log(r.at.slice(11, 23), r.label, "ppid", r.ppid, JSON.stringify(clean(r.env)), JSON.stringify(r.shellHints));
    console.log("   ", JSON.stringify(clean(r.payload)).slice(0, Number(process.argv[3] ?? 900)));
  }
}
