#!/usr/bin/env node
// Build the host packages of agent-daemon-memory (P5.4) from one source.
//   node runtime/scripts/build-host-packages.mjs --out <dir> [--target claude-code,agent-plugin]
//
// Targets (P5.4a):
//   claude-code   <out>/claude-code: a marketplace repo tree
//                   .claude-plugin/marketplace.json
//                   plugins/agent-daemon-memory/{.claude-plugin/plugin.json, .mcp.json,
//                     hooks/hooks.json, skills/agent-daemon-memory/SKILL.md, server/}
//                 hooks: UserPromptSubmit (capture, recall) and SessionStart; capture
//                 files go to projectDataDir (P5.2), so no repo gets a folder.
//   agent-plugin  <out>/agent-plugin/agent-daemon-memory: Agent Plugins 1.0.0
//                 (VS Code, Copilot, Kiro, OpenHands…): plugin.json, mcp.json, skills/,
//                 server/; record tools only. These hosts start servers in the plugin
//                 folder, so the server is unbound unless the client names a project.
//
// server/ is the import closure of the memory server and the plugin hook runner
// (P5.3's closure rules): Node built-ins only, better-sqlite3 optional, so it runs
// with no install step. Every manifest carries the package version.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closure } from "./build-memory-package.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(RUNTIME, "..");
export const NAME = "agent-daemon-memory";
export const TARGETS = ["claude-code", "agent-plugin"];
const SERVER_ENTRIES = ["src/mcp/memory-server.mjs", "src/memory/plugin-hook.mjs"];
const SKILL = path.join(REPO, "skills", "daemon", "agent-daemon-memory", "SKILL.md");
const DESCRIPTION = "Local memory for coding agents: lessons and corrections from past sessions in this project, recalled when they matter. Nothing leaves your computer.";
const AUTHOR = { name: "Agent Daemon", url: "https://github.com/pankaj-mahaur/Agent-Daemon" };
const REPOSITORY = "https://github.com/pankaj-mahaur/Agent-Daemon";
const AP_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

const SERVER_MAIN = `// agent-daemon-memory's MCP server (built by runtime/scripts/build-host-packages.mjs).
import "./src/mcp/memory-server.mjs";
`;
const HOOK_MAIN = `// agent-daemon-memory's hook runner for host plugins (built by runtime/scripts/build-host-packages.mjs).
import { runPluginHook } from "./src/memory/plugin-hook.mjs";
process.exitCode = await runPluginHook(process.argv.slice(2));
`;

export const packageVersion = () => JSON.parse(fs.readFileSync(path.join(REPO, "packages", NAME, "package.json"), "utf8")).version;

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

/** The server bundle: closure files under server/, plus server.mjs, hook.mjs, package.json. */
export function writeServer(dir, version) {
  const c = closure(SERVER_ENTRIES);
  const bare = c.bare.filter((b) => b !== "better-sqlite3");
  if (c.problems.length || bare.length) throw new Error(`plugin server closure:\n  ${[...c.problems, ...bare.map((b) => `needs ${b}, which a plugin can't install`)].join("\n  ")}`);
  for (const rel of c.files) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, rel), dest);
  }
  fs.writeFileSync(path.join(dir, "server.mjs"), SERVER_MAIN);
  fs.writeFileSync(path.join(dir, "hook.mjs"), HOOK_MAIN);
  writeJson(path.join(dir, "package.json"), { name: NAME, version, type: "module", private: true });
  return c.files.length + 3;
}

function writeSkill(pluginDir) {
  const dest = path.join(pluginDir, "skills", NAME, "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(SKILL, dest);
}

function writeCommon(pluginDir, version) {
  writeSkill(pluginDir);
  writeServer(path.join(pluginDir, "server"), version);
  fs.copyFileSync(path.join(REPO, "LICENSE"), path.join(pluginDir, "LICENSE"));
}

// One hook command: node and the runner by the plugin's own path, quoted (a path may have spaces).
const claudeHook = (name) => ({ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/server/hook.mjs" ${name} --host claude-code`, timeout: 10 });

function buildClaudeCode(out, version) {
  const root = path.join(out, "claude-code");
  const plugin = path.join(root, "plugins", NAME);
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "agent-daemon",
    owner: { name: AUTHOR.name, url: AUTHOR.url },
    metadata: { description: "Agent Daemon's plugins for Claude Code.", version },
    plugins: [{ name: NAME, source: `./plugins/${NAME}`, description: DESCRIPTION, version }],
  });
  writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
    name: NAME,
    version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: REPOSITORY,
    repository: REPOSITORY,
    license: "MIT",
    keywords: ["memory", "mcp", "corrections"],
  });
  // The project: Claude Code substitutes CLAUDE_PROJECT_DIR in args (whether it also
  // exports it to plugin servers is unclear), so it is passed explicitly.
  writeJson(path.join(plugin, ".mcp.json"), {
    // ${VAR:-} so a session without the variable isn't a config error; the server
    // then falls back to CLAUDE_PROJECT_DIR in its environment, then the working folder.
    mcpServers: { [NAME]: { command: "node", args: [...NODE_ARGS, "${CLAUDE_PLUGIN_ROOT}/server/server.mjs", "serve", "--host", "claude-code", "--capture", "hooks", "--project", "${CLAUDE_PROJECT_DIR:-}"] } },
  });
  writeJson(path.join(plugin, "hooks", "hooks.json"), {
    description: "agent-daemon-memory: capture the user's corrections, recall notes for the prompt, show this project's notes at session start.",
    hooks: {
      UserPromptSubmit: [{ hooks: [claudeHook("user-prompt-extract"), claudeHook("query-retrieve")] }],
      SessionStart: [{ hooks: [claudeHook("session-start")] }],
    },
  });
  writeCommon(plugin, version);
  fs.writeFileSync(
    path.join(root, "README.md"),
    `# Agent Daemon plugins for Claude Code\n\n\`\`\`\n/plugin marketplace add <this repository>\n/plugin install ${NAME}@agent-daemon\n\`\`\`\n\n${DESCRIPTION}\n\nGenerated from ${REPOSITORY} (version ${version}); don't edit here.\n`
  );
  return root;
}

function buildAgentPlugin(out, version) {
  const plugin = path.join(out, "agent-plugin", NAME);
  writeJson(path.join(plugin, "plugin.json"), {
    $schema: AP_PLUGIN_SCHEMA,
    name: NAME,
    version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: REPOSITORY,
    repository: REPOSITORY,
    license: "MIT",
    keywords: ["memory", "mcp", "corrections"],
  });
  // ${PLUGIN_ROOT} is expanded in args only, never in command: command is bare node.
  writeJson(path.join(plugin, "mcp.json"), {
    $schema: AP_MCP_SCHEMA,
    mcpServers: { [NAME]: { type: "stdio", command: "node", args: [...NODE_ARGS, "${PLUGIN_ROOT}/server/server.mjs", "serve", "--host", "agent-plugins", "--capture", "tools"] } },
  });
  writeCommon(plugin, version);
  return plugin;
}

const BUILDERS = { "claude-code": buildClaudeCode, "agent-plugin": buildAgentPlugin };

// A folder this script made: only such a folder (or an empty one) is ever emptied.
export const BUILD_MARK = ".agent-daemon-host-build";
const sameDir = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Refuse an output folder that would delete something it shouldn't. */
export function checkOut(out) {
  const abs = path.resolve(out);
  const inside = (child, parent) => sameDir(child, parent) || (process.platform === "win32" ? child.toLowerCase() : child).startsWith((process.platform === "win32" ? parent.toLowerCase() : parent) + path.sep);
  if (sameDir(abs, path.parse(abs).root) || sameDir(abs, path.resolve(os.homedir())) || inside(REPO, abs)) throw new Error(`refusing --out ${out}: it is a drive root, your home folder or holds this repository`);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length && !fs.existsSync(path.join(abs, BUILD_MARK))) throw new Error(`refusing --out ${out}: the folder isn't empty and wasn't made by this script (pick an empty folder)`);
  return abs;
}

/** Build `targets` into `out` (emptied first, if this script made it). → { version, built: {target: dir} } */
export function build({ out, targets = TARGETS } = {}) {
  if (!out) throw new Error("--out <dir> is required");
  const version = packageVersion();
  const runtimeVersion = JSON.parse(fs.readFileSync(path.join(RUNTIME, "package.json"), "utf8")).version;
  if (version !== runtimeVersion) throw new Error(`packages/${NAME}/package.json is ${version}, the runtime ${runtimeVersion}: bump them together`);
  out = checkOut(out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, BUILD_MARK), "Made by runtime/scripts/build-host-packages.mjs; the next build empties this folder.\n");
  const built = {};
  for (const t of targets) {
    if (!BUILDERS[t]) throw new Error(`unknown target "${t}" (${TARGETS.join(", ")})`);
    built[t] = BUILDERS[t](out, version);
  }
  return { version, built };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const r = build({ out: arg("--out") && path.resolve(arg("--out")), targets: arg("--target")?.split(",") ?? TARGETS });
    for (const [t, d] of Object.entries(r.built)) console.log(`${t}: ${d}`);
    console.log(`agent-daemon-memory ${r.version}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
