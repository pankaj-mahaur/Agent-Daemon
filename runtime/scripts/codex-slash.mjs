#!/usr/bin/env node
// Codex's slash command names at the pinned tag, from
// codex-rs/tui/src/slash_command.rs (plan Part 7). ad's own commands must not
// reuse a Codex name for something else: when Codex adds one, the collision
// test fails in the upgrade PR.
//
//   node scripts/codex-slash.mjs [--tag rust-v0.160.0] [--file slash_command.rs]
//     → writes src/tui/codex-slash.json
//
// Without --file it downloads the file with `gh api` (public repo, read-only).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();

/** The names (every spelling) of `enum SlashCommand`, in order. */
export function parseSlashCommands(rs) {
  const body = /pub enum SlashCommand\s*\{([\s\S]*?)\n\}/.exec(rs)?.[1];
  if (!body) throw new Error("enum SlashCommand not found");
  const out = [];
  let attrs = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const attr = /^#\[strum\((.*)\)\]$/.exec(line);
    if (attr) {
      attrs.push(attr[1]);
      continue;
    }
    const v = /^([A-Z]\w*),?$/.exec(line);
    if (!v) continue;
    const names = [];
    for (const a of attrs) for (const m of a.matchAll(/(?:serialize|to_string)\s*=\s*"([^"]+)"/g)) names.push(m[1]);
    out.push({ variant: v[1], names: names.length ? [...new Set(names)] : [kebab(v[1])] });
    attrs = [];
  }
  if (out.length < 10) throw new Error(`only ${out.length} slash commands parsed: the file changed shape`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@openai/codex"];
  const tag = opt("--tag") ?? `rust-v${pinned}`;
  const rs = opt("--file")
    ? readFileSync(opt("--file"), "utf8")
    : execFileSync("gh", ["api", `repos/openai/codex/contents/codex-rs/tui/src/slash_command.rs?ref=${tag}`, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8" });
  const commands = parseSlashCommands(rs);
  const out = { tag, names: commands.flatMap((c) => c.names) };
  writeFileSync(fileURLToPath(new URL("../src/tui/codex-slash.json", import.meta.url)), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${out.names.length} names from ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
