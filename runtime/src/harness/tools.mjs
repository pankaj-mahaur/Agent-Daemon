// `ad tools list | enable <tool> | disable <tool>` — optional agent tools
// for the harness, written to its CODEX_HOME config through Codex.
//
//   browser     Playwright MCP (accessibility-tree browser control, no
//               vision model needed), pinned; launched via node's own
//               npx-cli.js so Windows needs no .cmd shim
//   web-search  Codex web search in "live" mode (default is "cached": an
//               OpenAI-maintained index, no live fetches)
//
// Opt-in on purpose: both reach the network, and the browser downloads its
// package on first use.

import { existsSync } from "node:fs";
import path from "node:path";
import { createEngine } from "../engine/index.mjs";
import { isManagedHome } from "../engine/codex/home.mjs";

export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";

export function npxCommand(execPath = process.execPath) {
  const cli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return existsSync(cli) ? { command: execPath, args: [cli] } : { command: "npx", args: [] };
}

export const TOOLS = {
  browser: {
    label: "Browser automation (Playwright MCP)",
    enable: () => {
      const npx = npxCommand();
      return [["mcp_servers.playwright", { command: npx.command, args: [...npx.args, "-y", PLAYWRIGHT_MCP], startup_timeout_sec: 90 }]];
    },
    disable: () => [["mcp_servers.playwright", null]],
    enabled: (cfg) => Boolean(cfg.mcp_servers?.playwright),
  },
  "web-search": {
    label: "Live web search",
    enable: () => [["web_search", "live"]],
    disable: () => [["web_search", null]], // back to Codex's default (cached)
    enabled: (cfg) => cfg.web_search === "live",
  },
};

export async function cmdTools(sub, name, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  if (!["list", "enable", "disable"].includes(sub ?? "list")) {
    err.write(`Usage: ad tools list | enable <${Object.keys(TOOLS).join("|")}> | disable <tool>\n`);
    return 1;
  }
  let engine;
  try {
    engine = await createEngine({ home: opts.home, command: opts.command, clientVersion: opts.clientVersion });
    const cfg = await engine.readConfig();
    if (!sub || sub === "list") {
      for (const [id, t] of Object.entries(TOOLS)) out.write(`${t.enabled(cfg) ? "on " : "off"}  ${id.padEnd(11)} ${t.label}\n`);
      return 0;
    }
    const tool = TOOLS[name];
    if (!tool) {
      err.write(`Unknown tool "${name}". Known: ${Object.keys(TOOLS).join(", ")}\n`);
      return 1;
    }
    if (!isManagedHome(engine.home) && !opts.force) {
      err.write(`Refusing to change ${engine.home}: it was not created by ad. Re-run with --force.\n`);
      return 2;
    }
    // No MCP reload here: this app-server exits right away, and a reload
    // would only start (and kill) a throwaway npx download. The next
    // ad run / chat picks the change up.
    await engine.writeConfig(sub === "enable" ? tool.enable() : tool.disable());
    out.write(`${name}: ${sub === "enable" ? "on" : "off"}\n`);
    return 0;
  } catch (e) {
    err.write(`ad tools: ${e.message}\n`);
    return 1;
  } finally {
    await engine?.close();
  }
}
