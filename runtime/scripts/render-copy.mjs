#!/usr/bin/env node
// Listing copy from evidence (P5.6): the hosts named in any copy come from the
// support matrix's "tested live" rows, never from a hand-written list.
//
//   node runtime/scripts/render-copy.mjs --out <dir>   writes short.txt and long.md
//
// Templates: packages/agent-daemon-memory/listing/{short.txt,long.md}, with {{hosts}}.
// Evidence:  docs/support-matrix.md, the "## Hosts" table (Host | Route | Status | Evidence).
// lintCopy() is the claims rule for templates: no host named by hand, no
// percentages or rankings, no "reviewed lessons" without saying what waits for review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MATRIX = path.join(REPO, "docs", "support-matrix.md");
export const TEMPLATES = path.join(REPO, "packages", "agent-daemon-memory", "listing");
export const TESTED = "tested live";
export const STATUSES = new Set([TESTED, "built"]);
// Every host name copy could mention: none may appear in a template by hand.
export const HOST_NAMES = ["Claude Code", "Claude", "Codex", "Cursor", "VS Code", "VSCode", "Visual Studio Code", "Copilot", "Gemini CLI", "Gemini", "OpenCode", "Windsurf", "Kiro", "OpenHands", "Devin", "Hermes", "Cline", "Zed"];

const cellsOf = (l) => l.trim().split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());

/**
 * The first table under "## Hosts" (up to the next heading of any level):
 * [{ host, route, status, evidence }]. One host per row, statuses from STATUSES:
 * anything else fails, so a typo can't silently drop or add a host.
 */
export function parseSupportMatrix(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Hosts\b/.test(l));
  if (start < 0) throw new Error("support matrix: no \"## Hosts\" section");
  const rows = [];
  let header = null;
  for (const raw of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(raw)) break;
    const l = raw.trim();
    if (!l.startsWith("|")) {
      if (header) break; // the end of the first table
      continue;
    }
    if (/^\|\s*:?-/.test(l)) continue;
    const cells = cellsOf(l);
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      if (header.slice(0, 3).join("|") !== "host|route|status") throw new Error(`support matrix: the Hosts table must start with Host | Route | Status, not ${cells.join(" | ")}`);
      continue;
    }
    const [host, route, status = "", evidence = ""] = cells;
    if (/[,;/]|\band\b/.test(host)) throw new Error(`support matrix: one host per row ("${host}")`);
    if (!STATUSES.has(status.toLowerCase())) throw new Error(`support matrix: unknown status "${status}" for ${host} (${[...STATUSES].join(", ")})`);
    rows.push({ host, route, status: status.toLowerCase(), evidence });
  }
  if (!header) throw new Error("support matrix: no table under \"## Hosts\"");
  return rows;
}

/** Host names with at least one route tested live, in matrix order. */
export function testedHosts(rows) {
  return [...new Set(rows.filter((r) => r.status === TESTED).map((r) => r.host))];
}

/** "A", "A and B", "A, B and C". */
export const listOf = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function renderCopy(template, hosts) {
  if (template.includes("{{hosts}}") && !hosts.length) throw new Error("no host is tested live yet: copy that names hosts can't be rendered");
  return template.split("{{hosts}}").join(listOf(hosts));
}

/** The claims rule for a template → problems (empty when fine). */
export function lintCopy(text) {
  const problems = [];
  for (const h of HOST_NAMES) if (new RegExp(`\\b${h.replace(/ /g, "\\s*")}\\b`, "i").test(text)) problems.push(`names a host by hand: ${h} (use {{hosts}})`);
  if (/\d\s*%|\bper\s*cent\b|\bpercent\b|\b\d+(\.\d+)?\s*x\b/i.test(text)) problems.push("a percentage or multiplier before the benchmark is published");
  if (/#\s*1\b|\bstate[- ]of[- ]the[- ]art\b|\bbest\b(?![- ]effort)|\bfastest\b|\bleading\b|\bunmatched\b/i.test(text)) problems.push("a ranking claim");
  if (/\breviewed (lessons|notes|memory)\b/i.test(text)) problems.push('"reviewed …" without saying which notes wait for review');
  // Only hook capture applies at once: on hosts without hooks the agent records the
  // user's corrections, and they wait for review like its own notes.
  if (text.split(/(?<=[.!?])\s+/).some((s) => /corrections? (apply|applies|(are |get |is )?applied|takes? effect|works?)\s+(right away|at once|immediately)/i.test(s) && !/\bhooks?\b/i.test(s))) problems.push("corrections apply right away only where ad's hooks capture them: say so in the same sentence");
  if (/never reads? another project/i.test(text))problems.push('use the precise sentence: "Notes from one project are never served in another unless you accept them as cross-project."');
  return problems;
}

/** Render every template → { "short.txt": text, "long.md": text }. */
export function renderAll({ matrix = MATRIX, templates = TEMPLATES } = {}) {
  const hosts = testedHosts(parseSupportMatrix(fs.readFileSync(matrix, "utf8")));
  const out = {};
  for (const f of fs.readdirSync(templates).sort()) {
    const t = fs.readFileSync(path.join(templates, f), "utf8");
    const problems = lintCopy(t);
    if (problems.length) throw new Error(`${f}: ${problems.join("; ")}`);
    out[f] = renderCopy(t, hosts);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  try {
    const files = renderAll();
    if (i < 0) for (const [f, t] of Object.entries(files)) console.log(`== ${f}\n${t}`);
    else {
      const dir = path.resolve(process.argv[i + 1]);
      fs.mkdirSync(dir, { recursive: true });
      for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
      console.log(`copy in ${dir}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
