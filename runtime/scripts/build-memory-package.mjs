#!/usr/bin/env node
// Build the agent-daemon-memory npm package (P5.3) from the runtime's sources.
//   node runtime/scripts/build-memory-package.mjs [--out <package dir>]
// Default out: packages/agent-daemon-memory (its dist/ and LICENSE are ignored by
// git). With --out, a full package folder is written there (package.json,
// README.md, LICENSE, dist/), which is what the tests pack.
//
// dist/ is the import closure of the CLI and the memory server, copied with
// their runtime-relative paths, plus dist/cli.mjs (the bin) and dist/package.json
// (name and version, read by the code at run time). The closure must not reach
// ad's engine, harness or terminal UI, and may import only node:*, the two
// approved parsers, and better-sqlite3 as an optional driver (node:sqlite is used
// when it is missing).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(RUNTIME, "..");
const TEMPLATE = path.join(REPO, "packages", "agent-daemon-memory");
export const ENTRIES = ["src/memory-install/cli.mjs", "src/mcp/memory-server.mjs"];
export const ALLOWED_BARE = new Set(["jsonc-parser", "smol-toml", "better-sqlite3"]);
export const FORBIDDEN = [/^src\/engine\/codex\//, /^src\/harness\//, /^src\/tui\//];
const FORBIDDEN_BARE = new Set(["@openai/codex", "chokidar"]);

// import … from "x"; import "x"; export … from "x"; import("x") with a literal.
const SPEC_RE = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w${},*\s]+?\s*from\s*)?["']([^"']+)["']|(?:^|[^\w$.])import\(\s*["']([^"']+)["']\s*\)/g;

/** Every specifier a source file imports (comments stripped first). */
export function specifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [...code.matchAll(SPEC_RE)].map((m) => m[1] ?? m[2]);
}

/**
 * The files the entries reach, runtime-relative with "/" separators.
 * @returns {{files: string[], bare: string[], problems: string[]}}
 */
export function closure(entries = ENTRIES, root = RUNTIME) {
  const seen = new Set();
  const bare = new Set();
  const problems = [];
  const queue = entries.map((e) => path.join(root, e));
  while (queue.length) {
    const file = queue.pop();
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (FORBIDDEN.some((re) => re.test(rel))) problems.push(`${rel} is outside the memory package's allowed code`);
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      problems.push(`${rel} is imported but missing`);
      continue;
    }
    for (const spec of specifiers(src)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), spec.split("?")[0]));
        continue;
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      bare.add(name);
      if (FORBIDDEN_BARE.has(name)) problems.push(`${rel} imports ${name}`);
      else if (!ALLOWED_BARE.has(name)) problems.push(`${rel} imports ${name}, which the package doesn't depend on`);
    }
  }
  return { files: [...seen].sort(), bare: [...bare].sort(), problems };
}

const BIN = `#!/usr/bin/env node
// agent-daemon-memory: the npm bin (built by runtime/scripts/build-memory-package.mjs).
import { main } from "./src/memory-install/cli.mjs";
const code = await main();
if (code !== null) process.exitCode = code;
`;

export function build({ out = TEMPLATE } = {}) {
  const c = closure();
  if (c.problems.length) throw new Error(`memory package closure:\n  ${c.problems.join("\n  ")}`);
  const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE, "package.json"), "utf8"));
  const runtimeVersion = JSON.parse(fs.readFileSync(path.join(RUNTIME, "package.json"), "utf8")).version;
  if (tpl.version !== runtimeVersion) throw new Error(`packages/agent-daemon-memory/package.json is ${tpl.version}, the runtime ${runtimeVersion}: bump them together`);
  const dist = path.join(out, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  for (const rel of c.files) {
    const dest = path.join(dist, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, rel), dest);
  }
  fs.writeFileSync(path.join(dist, "cli.mjs"), BIN);
  fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({ name: tpl.name, version: tpl.version, type: "module", private: true }, null, 2) + "\n");
  if (path.resolve(out) !== TEMPLATE) {
    fs.copyFileSync(path.join(TEMPLATE, "package.json"), path.join(out, "package.json"));
    fs.copyFileSync(path.join(TEMPLATE, "README.md"), path.join(out, "README.md"));
  }
  fs.copyFileSync(path.join(REPO, "LICENSE"), path.join(out, "LICENSE"));
  return { out, files: c.files.length + 2, version: tpl.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = build({ out: i > 0 ? path.resolve(process.argv[i + 1]) : TEMPLATE });
  console.log(`agent-daemon-memory ${r.version}: ${r.files} files in ${r.out}`);
}
