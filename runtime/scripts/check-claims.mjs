#!/usr/bin/env node
// The claims lint (P8.1): public copy says only what shipped code and a published source back.
//
//   checkClaims(text, { testedLive, hosts, file }) → [{ file, line, rule, text }]
//   renderHosts(text, testedLive) → "{{hosts}}" replaced by the tested-live hosts
//   readMatrix(file) → { hosts: [name], testedLive: [name] }   from docs/support-matrix.md
//
// Rules, per sentence:
//   banned       "#1", "best", "state of the art", "SOTA", "revolutionary"
//   number       a percentage or "N×" needs a markdown link on its line and a named baseline
//                ("no memory", "own memory", "rules file") in its sentence
//   host         a host name not in the support matrix's tested-live rows, anywhere
//   reviewed     "reviewed" next to lessons/notes without "agent" or "skills" in the sentence
//   cross        "never" + "another project" except the one approved sentence (it has its own test)
//
// node runtime/scripts/check-claims.mjs [files…]   (default: the public copy) → exit 1 on a finding.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const APPROVED_CROSS = "Notes from one project are never served in another unless you accept them as cross-project";
// Hosts people know by name; the matrix adds its own rows.
const OTHER_HOSTS = ["Claude Code", "Cursor", "Windsurf", "VS Code", "Copilot", "Gemini CLI", "Kiro", "OpenHands", "OpenCode", "Devin Desktop", "Zed", "Cline", "Aider", "Continue", "Amp", "JetBrains"];
const BANNED = /(^|[^\w])(#1|best|state[ -]of[ -]the[ -]art|SOTA|revolutionary)(?=$|[^\w])/i;
const NUMBER = /\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[x×](?=\s|$|[.,;:)])/;
const BASELINE = /no memory|own memory|rules file/i;

export function readMatrix(file = path.join(ROOT, "docs", "support-matrix.md")) {
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /^\|[^-|][^|]*\|[^|]*\|[^|]*\|/.test(l) && !/^\|\s*Host\s*\|/.test(l));
  const cells = rows.map((l) => l.split("|").map((c) => c.trim()));
  const hosts = [...new Set(cells.map((c) => c[1]))];
  const testedLive = [...new Set(cells.filter((c) => /^tested live$/i.test(c[3])).map((c) => c[1]))];
  return { hosts, testedLive };
}

export const renderHosts = (text, testedLive) => text.replace(/\{\{hosts\}\}/g, testedLive.join(", "));

const sentences = (line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"`*_[(])/);
// "VS Code (Copilot)" → its names: "VS Code", "Copilot".
const namesOf = (h) => h.replace(/[()]/g, ",").split(",").map((s) => s.trim()).filter(Boolean);

export function checkClaims(text, { testedLive = [], hosts = [], file = "(text)" } = {}) {
  const live = new Set(testedLive.flatMap(namesOf).map((s) => s.toLowerCase()));
  const known = [...new Set([...hosts.flatMap(namesOf), ...OTHER_HOSTS])].filter((h) => !live.has(h.toLowerCase()));
  const out = [];
  let fence = false;
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return; // commands and code are not claims
    for (const s of sentences(line)) {
      const hit = (rule) => out.push({ file, line: i + 1, rule, text: s.trim().slice(0, 160) });
      if (BANNED.test(s)) hit("banned");
      if (NUMBER.test(s) && !(/\]\(/.test(line) && BASELINE.test(s))) hit("number");
      for (const h of known) if (new RegExp(`(^|[^\\w])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w])`).test(s)) hit(`host:${h}`);
      if (/\breviewed\b/i.test(s) && /\b(lessons?|notes?)\b/i.test(s) && !/\bagent|skills?\b/i.test(s)) hit("reviewed");
      if (/\bnever\b/i.test(s) && /another project/i.test(s) && !s.includes(APPROVED_CROSS)) hit("cross");
    }
  });
  return out;
}

// The public copy the lint covers (P8.1); files that don't exist yet are skipped.
export const PUBLIC_COPY = ["README.md", "docs/compare.md", "docs/memory", "docs/site", "packages/host-templates"];

function filesOf(p) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  const out = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) go(q);
      else if (/\.(md|html|json)$/.test(e.name)) out.push(q);
    }
  };
  go(abs);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { hosts, testedLive } = readMatrix();
  const targets = process.argv.slice(2).length ? process.argv.slice(2).map((f) => path.resolve(f)) : PUBLIC_COPY.flatMap(filesOf);
  const found = targets.flatMap((f) => checkClaims(renderHosts(fs.readFileSync(f, "utf8"), testedLive), { hosts, testedLive, file: path.relative(ROOT, f) }));
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  console.log(found.length ? `${found.length} claim(s) to fix (rules: runtime/scripts/check-claims.mjs).` : `No claim problems in ${targets.length} file(s).`);
  process.exit(found.length ? 1 : 0);
}
