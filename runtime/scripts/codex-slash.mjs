#!/usr/bin/env node
// Codex's slash commands at the pinned tag, from codex-rs/tui/src/slash_command.rs
// (and bottom_pane/command_popup.rs for what the popup hides). ad's own
// commands must not reuse a Codex name for something else, and every Codex
// command needs a decision in ad (run it, or answer why not): when Codex adds
// or changes one, a test fails in the upgrade PR.
//
//   node scripts/codex-slash.mjs [--tag rust-v0.160.0] [--file slash_command.rs] [--popup command_popup.rs]
//     → writes src/tui/codex-slash.json
//
// Without --file / --popup it downloads them with `gh api` (public repo, read-only).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();

/** The names (every spelling) of `enum SlashCommand`, in order. The first is the one Codex shows. */
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
    const shown = [];
    const other = [];
    for (const a of attrs) for (const m of a.matchAll(/(serialize|to_string)\s*=\s*"([^"]+)"/g)) (m[1] === "to_string" ? shown : other).push(m[2]);
    const names = [...new Set([...shown, ...other])];
    out.push({ variant: v[1], names: names.length ? names : [kebab(v[1])] });
    attrs = [];
  }
  if (out.length < 10) throw new Error(`only ${out.length} slash commands parsed: the file changed shape`);
  return out;
}

/** The body of `fn <name>(...)`, braces matched. */
function fnBody(rs, name) {
  const at = new RegExp(`fn ${name}\\s*\\(`).exec(rs);
  if (!at) throw new Error(`fn ${name} not found`);
  const open = rs.indexOf("{", at.index);
  let depth = 0;
  for (let i = open; i < rs.length; i++) {
    if (rs[i] === "{") depth++;
    else if (rs[i] === "}" && --depth === 0) return rs.slice(open + 1, i);
  }
  throw new Error(`fn ${name}: unbalanced braces`);
}

const variantsIn = (s) => [...s.matchAll(/SlashCommand::(\w+)/g)].map((m) => m[1]);

/** `pattern => value` arms of a match, as [variants, value] (value is the raw expression). */
function arms(body, valueRe) {
  const out = [];
  const re = new RegExp(`((?:\\s*\\|?\\s*SlashCommand::\\w+)+)\\s*=>\\s*(${valueRe})`, "g");
  for (const m of body.matchAll(re)) out.push([variantsIn(m[1]), m[2]]);
  return out;
}

/** cfg!(…) visibility → "always" | "debug" | "os:a,b" | "not-os:a". */
function visibility(expr) {
  const e = expr.trim();
  if (e === "true") return "always";
  if (e === "cfg!(debug_assertions)") return "debug";
  const oses = (s) => [...s.matchAll(/target_os\s*=\s*"([^"]+)"/g)].map((m) => m[1]).join(",");
  if (/^cfg!\((?:any\()?target_os/.test(e)) return `os:${oses(e)}`;
  if (/^!cfg!\(target_os/.test(e)) return `not-os:${oses(e)}`;
  throw new Error(`is_visible: unknown expression ${e}`);
}

/**
 * Everything ad needs per command: the name Codex shows, its other spellings,
 * the description, whether it takes inline text, whether it runs during a
 * task, whether it works inside a side conversation, where it's visible, and
 * whether the popup hides it ("unfiltered": only while nothing is typed).
 */
export function parseSlashMeta(rs, popupRs = null) {
  const commands = parseSlashCommands(rs);
  const variants = new Set(commands.map((c) => c.variant));
  const desc = new Map();
  for (const [vs, v] of arms(fnBody(rs, "description"), `\\{?\\s*"(?:[^"\\\\]|\\\\.)*"`)) for (const x of vs) desc.set(x, JSON.parse(v.replace(/^\{\s*/, "")));
  const args = new Set(variantsIn(fnBody(rs, "supports_inline_args")));
  const side = new Set(variantsIn(fnBody(rs, "available_in_side_conversation")));
  const during = new Map();
  for (const [vs, v] of arms(fnBody(rs, "available_during_task"), "true|false")) for (const x of vs) during.set(x, v === "true");
  const visible = new Map();
  // An arm's value runs to the comma that ends its line (cfg!(any(…)) has commas inside).
  for (const [vs, v] of arms(fnBody(rs, "is_visible"), "[^\\n]+?(?=,[ \\t]*\\r?\\n)")) for (const x of vs) visible.set(x, visibility(v));
  let hideAlways = new Set();
  let hideUnfiltered = new Set();
  let hidePrefixes = [];
  if (popupRs) {
    const alias = /ALIAS_COMMANDS\s*:\s*&\[SlashCommand\]\s*=\s*&\[([^\]]*)\]/.exec(popupRs);
    if (!alias) throw new Error("command_popup.rs: ALIAS_COMMANDS not found");
    hideUnfiltered = new Set(variantsIn(alias[1]));
    hideAlways = new Set([...popupRs.matchAll(/cmd\s*!=\s*SlashCommand::(\w+)/g)].map((m) => m[1]));
    hidePrefixes = [...popupRs.matchAll(/cmd\.command\(\)\.starts_with\("([^"]+)"\)/g)].map((m) => m[1]);
    if (!hidePrefixes.length) throw new Error("command_popup.rs: the hidden-prefix filter changed shape");
  }
  for (const v of [...desc.keys(), ...args, ...side, ...during.keys(), ...visible.keys(), ...hideAlways, ...hideUnfiltered]) {
    if (!variants.has(v)) throw new Error(`SlashCommand::${v} is used but not in the enum: the file changed shape`);
  }
  return commands.map(({ variant, names: [name, ...aliases] }) => {
    if (!desc.has(variant)) throw new Error(`no description for SlashCommand::${variant}`);
    if (!during.has(variant)) throw new Error(`available_during_task doesn't cover SlashCommand::${variant}`);
    const popup = hideAlways.has(variant) || hidePrefixes.some((p) => name.startsWith(p)) ? "hidden" : hideUnfiltered.has(variant) ? "unfiltered" : "shown";
    return { name, aliases, desc: desc.get(variant), args: args.has(variant), duringTask: during.get(variant), sideAllowed: side.has(variant), visible: visible.get(variant) ?? "always", ...(popupRs ? { popup } : {}) };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@openai/codex"];
  const tag = opt("--tag") ?? `rust-v${pinned}`;
  const fetch = (path) => execFileSync("gh", ["api", `repos/openai/codex/contents/codex-rs/tui/src/${path}?ref=${tag}`, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8" });
  const rs = opt("--file") ? readFileSync(opt("--file"), "utf8") : fetch("slash_command.rs");
  const popupRs = opt("--popup") ? readFileSync(opt("--popup"), "utf8") : fetch("bottom_pane/command_popup.rs");
  const commands = parseSlashMeta(rs, popupRs);
  const out = { tag, names: commands.flatMap((c) => [c.name, ...c.aliases]), commands };
  writeFileSync(fileURLToPath(new URL("../src/tui/codex-slash.json", import.meta.url)), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${commands.length} commands (${out.names.length} names) from ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
