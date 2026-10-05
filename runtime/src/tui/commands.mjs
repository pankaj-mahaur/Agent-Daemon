// Codex-parity commands (plan Part 8), kept out of app.mjs: pure renderers
// for /mcp, /hooks, /skills, /usage and /terminal-setup, the transcript for
// /export, /raw and the Ctrl+T pager, the clipboard for /copy, and image
// paths for /image and pasted file paths.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sanitize } from "./terminal/sanitize.mjs";
import { truncate } from "./terminal/text.mjs";
import { renderCell } from "./view/cells.mjs";

const DIM = { dim: true };
const BOLD = { bold: true };
const OK = { fg: "green" };
const BAD = { fg: "red" };
const clean = (t) => sanitize(String(t ?? ""), "transcript").replace(/\s*\n\s*/g, " ").replace(/\t/g, " ");
const row = (width, ...spans) => truncate(spans, width);

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

export function renderMcp(servers, { width = 80 } = {}) {
  if (!servers?.length) return [[{ text: "No MCP servers configured for ad's Codex.", style: DIM }]];
  const out = [[{ text: "MCP servers", style: BOLD }]];
  for (const s of servers) {
    const status = clean(s.runtimeStatus ?? "unknown");
    const good = /ready|connected|running/i.test(status);
    out.push(row(width, { text: `  ${clean(s.name)}`.padEnd(24) }, { text: status, style: good ? OK : /fail|error/i.test(status) ? BAD : DIM }, { text: s.httpOrigin ? `  ${clean(s.httpOrigin)}` : "", style: DIM }));
  }
  return out;
}

export function renderHooks(hooks, { width = 80, hooksFile = null } = {}) {
  if (!hooks?.length) return [[{ text: "No hooks.", style: DIM }]];
  const out = [[{ text: "Hooks", style: BOLD }]];
  for (const h of hooks) {
    const ours = hooksFile && path.resolve(String(h.sourcePath ?? "")).toLowerCase() === path.resolve(hooksFile).toLowerCase();
    const trusted = h.trustStatus === "trusted";
    out.push(row(width, { text: `  ${clean(h.eventName)}`.padEnd(22) }, { text: trusted ? "trusted" : clean(h.trustStatus ?? "untrusted"), style: trusted ? OK : BAD }, { text: `  ${ours ? "ad" : clean(h.sourcePath)}`, style: DIM }));
  }
  return out;
}

export function renderSkills(entries, { width = 80 } = {}) {
  const skills = (entries ?? []).flatMap((e) => e.skills ?? []);
  if (!skills.length) return [[{ text: "No skills found.", style: DIM }]];
  const out = [[{ text: `Skills (${skills.length})`, style: BOLD }]];
  for (const s of skills) {
    out.push(row(width, { text: `  ${clean(s.name)}`, style: s.enabled === false ? DIM : { fg: "cyan" } }, { text: `  ${clean(s.shortDescription ?? s.description ?? "")}`, style: DIM }));
  }
  return out;
}

function windowLabel(w) {
  if (!w) return null;
  const mins = w.windowDurationMins;
  const span = mins ? (mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h`) : "window";
  const reset = w.resetsAt ? `, resets ${new Date(Number(w.resetsAt) * 1000).toLocaleString()}` : "";
  return `${span}: ${Math.round(w.usedPercent ?? 0)}% used${reset}`;
}

export function renderUsage({ rateLimits, usage, tokens } = {}, { width = 80 } = {}) {
  const out = [[{ text: "Usage", style: BOLD }]];
  const rl = rateLimits?.rateLimits ?? rateLimits;
  for (const w of [rl?.primary, rl?.secondary]) {
    const l = windowLabel(w);
    if (l) out.push(row(width, { text: `  ${clean(l)}`, style: (w.usedPercent ?? 0) >= 80 ? { fg: "yellow" } : undefined }));
  }
  if (tokens?.total?.total) out.push(row(width, { text: `  this conversation: ${tokens.total.total.toLocaleString("en-US")} tokens` }));
  const s = usage?.summary;
  if (s?.lifetimeTokens != null) out.push(row(width, { text: `  lifetime: ${Number(s.lifetimeTokens).toLocaleString("en-US")} tokens`, style: DIM }));
  if (s?.currentStreakDays) out.push(row(width, { text: `  streak: ${s.currentStreakDays} days (longest ${s.longestStreakDays ?? s.currentStreakDays})`, style: DIM }));
  if (out.length === 1) out.push([{ text: "  No usage data from this account (API keys don't report it).", style: DIM }]);
  return out;
}

/** /terminal-setup: what to change in the terminal so Shift+Enter makes a newline. Print-only. */
export function terminalSetup(terminal) {
  if (terminal === "windows-terminal") {
    return [
      "Windows Terminal: make Shift+Enter send a newline to ad.",
      "Settings → Open JSON file, and add to \"actions\":",
      '  { "command": { "action": "sendInput", "input": "\\u001b[13;2u" }, "keys": "shift+enter" }',
      "Windows Terminal 1.25 and later already send it. Ctrl+Enter and Ctrl+J work without any setup.",
    ];
  }
  if (terminal === "vscode") {
    return [
      "VS Code: make Shift+Enter send a newline to ad. In keybindings.json add:",
      '  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",',
      '    "args": { "text": "\\u001b[13;2u" }, "when": "terminalFocus" }',
      "Ctrl+J works without any setup.",
    ];
  }
  if (terminal === "zed") return ["Zed already sends Shift+Enter as a newline. Nothing to set up."];
  return ["Ctrl+J (or \\ then Enter) adds a newline in every terminal.", "If your terminal supports the kitty keyboard protocol, Shift+Enter works too."];
}

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

const rootItems = (st) => [...st.items.values()].filter((it) => !st.thread || it.threadId === st.thread.id || it.threadId == null);

/** The last agent message's text, as written (markdown). */
export function lastAgentText(st) {
  const msgs = rootItems(st).filter((i) => i.kind === "agentMessage" && i.text);
  return msgs.length ? String(msgs.at(-1).text) : null;
}

/** The conversation as markdown, for /export. Untrusted text is sanitized. */
export function exportMarkdown(st, { title = "Conversation" } = {}) {
  const text = (t) => sanitize(String(t ?? ""), "transcript");
  const out = [`# ${text(st.thread?.name ?? title).replace(/\s*\n\s*/g, " ")}`, ""];
  if (st.thread?.id) out.push(`Thread: \`${text(st.thread.id)}\``, "");
  for (const it of rootItems(st)) {
    if (it.kind === "userMessage") out.push("## You", "", text(it.text), "");
    else if (it.kind === "agentMessage") out.push("## Codex", "", text(it.text), "");
    else if (it.kind === "commandExecution") {
      const body = [`$ ${text(it.command)}`, ...text(it.output ?? "").replace(/\n+$/, "").split("\n").slice(-50)];
      // A fence longer than any backtick run inside, so the output can't close it.
      const longest = Math.max(2, ...body.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));
      const fence = "`".repeat(longest + 1);
      out.push(`${fence}console`, ...body, fence, "");
    } else if (it.kind === "fileChange") out.push(`Edited: ${(it.changes ?? []).map((c) => `\`${text(c.path)}\``).join(", ")}`, "");
  }
  return out.join("\n");
}

/** Every item rendered, for the Ctrl+T pager. */
export function transcriptLines(st, { width = 80 } = {}) {
  const out = [];
  for (const it of rootItems(st)) {
    const lines = renderCell(it, { width });
    if (!lines.length) continue;
    if (out.length) out.push([]);
    out.push(...lines);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

const CLIPBOARD_TOOLS = {
  win32: [["clip.exe", []]],
  darwin: [["pbcopy", []]],
  linux: [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ],
};

function runWithInput(cmd, args, input, spawnFn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
    // A tool that exits without reading (xclip with no display) makes the write fail: that's a "no".
    child.stdin.on?.("error", () => resolve(false));
    child.stdin.end(input);
  });
}

/**
 * Copies text: OSC 52 to the terminal (works over SSH, when the terminal
 * allows it) and the platform's clipboard tool. Resolves with how it went.
 */
export async function copyText(text, { write, platform = process.platform, spawnFn = spawn, osc52 = true } = {}) {
  const value = String(text ?? "");
  let viaTerminal = false;
  if (osc52 && write && Buffer.byteLength(value) <= 100_000) {
    write(`\x1b]52;c;${Buffer.from(value, "utf8").toString("base64")}\x07`);
    viaTerminal = true;
  }
  for (const [cmd, args] of CLIPBOARD_TOOLS[platform] ?? CLIPBOARD_TOOLS.linux) {
    // clip.exe reads the console code page; UTF-16LE with a BOM is what it takes for Unicode.
    const input = cmd === "clip.exe" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]) : value;
    if (await runWithInput(cmd, args, input, spawnFn)) return { ok: true, via: cmd };
  }
  return { ok: viaTerminal, via: viaTerminal ? "terminal" : null };
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * A pasted or typed image path → an absolute path of an image file that
 * exists, or null. Quotes from drag-and-drop are removed.
 */
export function imagePath(raw, cwd, { platform = process.platform } = {}) {
  let p = String(raw ?? "").trim();
  const quoted = /^(["']).*\1$/.test(p);
  if (quoted) p = p.slice(1, -1);
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
    } catch {
      return null;
    }
    if (platform === "win32") p = p.replace(/^\/([A-Za-z]:)/, "$1"); // file:///C:/x → C:/x
  }
  // A drag on macOS/Linux escapes spaces ("my\ pic.png").
  if (platform !== "win32") p = p.replace(/\\ /g, " ");
  if (!p || !IMAGE_EXT.test(p) || /[\n\r\0]/.test(p)) return null;
  // A bare name ("a.png") pasted into a sentence is text: only paths attach.
  if (!quoted && !/[\\/]/.test(p)) return null;
  // Never touch the network for a pasted UNC path.
  if (/^(\\\\|\/\/)/.test(p)) return null;
  const abs = path.resolve(cwd, p);
  try {
    return existsSync(abs) && statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}
