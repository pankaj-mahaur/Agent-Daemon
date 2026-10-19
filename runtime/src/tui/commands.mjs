// Parity commands (plan Part 8), kept out of app.mjs: pure renderers
// for /mcp, /hooks, /skills, /usage and /terminal-setup, the transcript for
// /export, /raw and the Ctrl+T pager, the clipboard for /copy, and image
// paths for /image and pasted file paths.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sanitize } from "./terminal/sanitize.mjs";
import { truncate } from "./terminal/text.mjs";
import { graphemes } from "./terminal/width.mjs";
import { keyLabel } from "./keymap.mjs";
import { renderCell } from "./view/cells.mjs";
import { wrapPrefixed } from "./view/markdown.mjs";
import { T } from "./view/theme.mjs";

const DIM = T.dim;
const BOLD = T.bold;
const OK = T.success;
const BAD = T.error;
const clean = (t) => sanitize(String(t ?? ""), "transcript").replace(/\s*\n\s*/g, " ").replace(/\t/g, " ");
const row = (width, ...spans) => truncate(spans, width);

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

export function renderMcp(servers, { width = 80 } = {}) {
  if (!servers?.length) return [[{ text: "No MCP servers configured for ad's engine.", style: DIM }]];
  const out = [[{ text: "MCP servers", style: BOLD }]];
  for (const s of servers) {
    const status = clean(s.runtimeStatus ?? "unknown");
    const good = /ready|connected|running/i.test(status);
    out.push(row(width, { text: `  ${clean(s.name)}`.padEnd(24) }, { text: status, style: good ? OK : /fail|error/i.test(status) ? BAD : DIM }, { text: s.httpOrigin ? `  ${clean(s.httpOrigin)}` : "", style: DIM }));
  }
  return out;
}

/**
 * /keymap: the keys in effect by context (ad's defaults with the engine's
 * tui.keymap on top), what was dropped and why, and where they're edited.
 */
/** The example /keymap shows; test/tui-keymap.test.mjs proves ad's own reader accepts it. */
export const KEYMAP_EXAMPLE = Object.freeze({ table: "tui.keymap.global", action: "open_transcript", key: "alt-y" });

export function renderKeymap(keymap, { width = 80, label = (k) => k, settingsPath = null } = {}) {
  const out = [[{ text: "Keymap", style: BOLD }]];
  let ctx = null;
  for (const b of keymap.bindings()) {
    if (b.ctx !== ctx) {
      ctx = b.ctx;
      out.push([{ text: `  ${ctx}`, style: DIM }]);
    }
    out.push(row(width, { text: `    ${b.action}`.padEnd(32) }, { text: b.keys.length ? b.keys.map(label).join(", ") : "unbound", style: b.keys.length ? T.code : DIM }, ...(b.custom ? [{ text: "  (yours)", style: DIM }] : [])));
  }
  // The leader key (engine 0.163+): what "leader <key>" bindings start with.
  const leader = keymap.leader?.();
  out.push(row(width, { text: "  leader".padEnd(34) }, { text: leader ? label(leader) : "none", style: leader ? T.code : DIM }, { text: "  (global.leader; \"leader c\" = the leader, then c)", style: DIM }));
  for (const w of keymap.warnings ?? []) out.push(row(width, { text: `  ${clean(w)}`, style: T.warning }));
  const foot = [
    "  Keys are set in the engine's settings file, under [tui.keymap]" + (settingsPath ? `: ${settingsPath}` : "."),
    `  For example, to open the transcript with ${keyLabel(KEYMAP_EXAMPLE.key)}:`,
    `    [${KEYMAP_EXAMPLE.table}]`,
    `    ${KEYMAP_EXAMPLE.action} = "${KEYMAP_EXAMPLE.key}"`,
    "  ad reads these keys and never writes them. /keymap debug shows what a key sends.",
  ];
  for (const line of foot) out.push(row(width, { text: clean(line), style: DIM }));
  return out;
}

/* ------------------------------------------------------------------ */
/* /approve (parity Part 10)                                         */
/* ------------------------------------------------------------------ */

// A shell word as shlex would quote it.
const shellWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'"'"'`)}'`);

/** What an auto-review denial was about, in upstream's words (tui/src/auto_review_denials.rs). */
export function denialSummary(a) {
  switch (a?.type) {
    case "command":
      return String(a.command ?? "");
    case "execve":
      return a.argv?.length ? a.argv.map(shellWord).join(" ") : String(a.program ?? "");
    case "writeStdin": {
      const g = graphemes(`send input to terminal ${a.processId}: ${JSON.stringify(String(a.stdin ?? ""))}`);
      return g.length > 80 ? `${g.slice(0, 79).join("")}\u{2026}` : g.join("");
    }
    case "applyPatch":
      return a.files?.length === 1 ? `apply_patch touching ${a.files[0]}` : `apply_patch touching ${a.files?.length ?? 0} files`;
    case "networkAccess":
      return `network access to ${a.target ?? a.host ?? ""}`;
    case "mcpToolCall":
      return `MCP ${a.toolName} on ${a.connectorName ?? a.server}`;
    case "requestPermissions":
      return a.reason ? `permission request: ${a.reason}` : "permission request";
    default:
      return "an action";
  }
}

/* ------------------------------------------------------------------ */
/* /debug-config (parity Part 10)                                    */
/* ------------------------------------------------------------------ */

// Secrets are never shown: a value under a key that names one (api_key,
// bearer_token, password; not tui.keymap), every value of a header or env map,
// a URL's user:password, and a command argument that looks like a token or
// follows a flag naming one. A number (a token limit) stays.
const SECRET_KEY = /(?:^|[_.-])(?:api[_-]?key|key|pat|pass|auth)$|token|secret|passw(?:or)?d|credential/i;
const ALL_SECRET = /(?:^|_)(?:headers|env)$/i;
const SECRET_FLAG = /^--?[\w-]*(?:key|token|secret|pass|pat|auth)[\w-]*$/i;
const SECRET_SHAPE = /^(?:sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|glpat-|Bearer\s)/i;
const MASK = "****";
const maskUrl = (s) => s.replace(/(\b[a-z][\w+.-]*:\/\/)[^/\s@]+@/gi, `$1${MASK}@`);
const maskDeep = (v, key = "", all = false) => {
  if (typeof v === "string") return v && (all || SECRET_KEY.test(key) || SECRET_SHAPE.test(v)) ? MASK : maskUrl(v);
  if (Array.isArray(v)) {
    if (key === "args") return v.map((x, i) => (typeof x === "string" && (SECRET_SHAPE.test(x) || (i > 0 && SECRET_FLAG.test(String(v[i - 1])))) ? MASK : maskDeep(x, "", all)));
    return v.map((x) => maskDeep(x, key, all));
  }
  if (v && typeof v === "object") {
    if (SECRET_KEY.test(key)) return MASK;
    const inner = all || ALL_SECRET.test(key);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, k, inner)]));
  }
  return v;
};
const tomlValue = (v) =>
  typeof v === "string"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(tomlValue).join(", ")}]`
      : v && typeof v === "object"
        ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join(", ")} }`
        : String(v);
const flatten = (obj, prefix = "", out = []) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
};

/** A config layer's source as the engine names it ("user (…/config.toml)", "session-flags"). */
export function layerSource(n) {
  const sep = (p) => (String(p).includes("\\") ? "\\" : "/");
  switch (n?.type) {
    case "packagedDefaults":
      return `packaged defaults (${n.file})`;
    case "mdm":
      return `MDM (${n.domain}:${n.key})`;
    case "system":
      return `system (${n.file})`;
    case "enterpriseManaged":
      return `enterprise-managed (${n.name}, ${n.id})`;
    case "user":
      return `user (${n.file}${n.profile ? `, profile ${n.profile}` : ""})`;
    case "project":
      return `project (${n.projectFolder}${sep(n.projectFolder)}config.toml)`;
    case "sessionFlags":
      return "session-flags";
    case "legacyManagedConfigTomlFromFile":
      return `legacy managed_config.toml (${n.file})`;
    case "legacyManagedConfigTomlFromMdm":
      return "legacy managed_config.toml (MDM)";
    default:
      return String(n?.type ?? "unknown");
  }
}

const snakeCase = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const requirementValue = (v) =>
  Array.isArray(v)
    ? v.length
      ? v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ")
      : "<empty>"
    : v && typeof v === "object"
      ? Object.entries(v).map(([k, x]) => `${k}=${x && typeof x === "object" ? JSON.stringify(x) : x}`).join(", ") || "<empty>"
      : String(v);

/**
 * The engine's /debug-config from config/read's layers (highest precedence first,
 * shown lowest first, as the engine does) and configRequirements/read: each layer's
 * source and state, the session flags' keys, then the requirements. Secret
 * values are masked (the engine prints its in-process config unmasked).
 */
export function renderDebugConfig({ layers, requirements }, { width = 80 } = {}) {
  const line = (indent, spans) => wrapPrefixed(spans, width, [{ text: indent }], [{ text: `${indent}  ` }]);
  const out = [[{ text: "/debug-config", style: T.commandEcho }], [], [{ text: "Config layer stack (lowest precedence first):", style: BOLD }]];
  const stack = [...(layers ?? [])].reverse();
  if (!stack.length) out.push([{ text: "  <none>", style: DIM }]);
  stack.forEach((l, i) => {
    out.push(...line("  ", [{ text: `${i + 1}. ${clean(layerSource(l.name))} (${l.disabledReason ? "disabled" : "enabled"})` }]));
    if (l.name?.type === "sessionFlags") {
      const keys = flatten(maskDeep(l.config)).sort(([a], [b]) => a.localeCompare(b));
      if (!keys.length) out.push([{ text: "     - <none>", style: DIM }]);
      for (const [k, v] of keys) out.push(...line("     ", [{ text: `- ${clean(k)} = ${clean(tomlValue(v))}` }]));
    }
    if (l.disabledReason) out.push(...line("     ", [{ text: `reason: ${clean(l.disabledReason)}`, style: DIM }]));
  });
  out.push([], [{ text: "Requirements:", style: BOLD }]);
  const reqs = Object.entries(maskDeep(requirements ?? {})).filter(([, v]) => v !== null && v !== undefined);
  if (!reqs.length) out.push([{ text: "  <none>", style: DIM }]);
  for (const [k, v] of reqs) out.push(...line("  ", [{ text: `- ${snakeCase(k)}: ${clean(requirementValue(v))}` }]));
  return out;
}

/**
 * /keymap debug, the Keypress Inspector: the last key ad received, its
 * config spelling and the actions it presses.
 */
export function renderKeyInspector(last, { width = 80 } = {}) {
  const out = [[{ text: "Keypress Inspector", style: BOLD }], [{ text: "Press any key to see what ad receives. Esc is inspected; Ctrl+C closes.", style: DIM }]];
  if (!last) return [...out, [{ text: "Waiting for a keypress...", style: T.code }], [{ text: "Tip: ad can only inspect keys your terminal sends.", style: DIM }]];
  out.push(row(width, { text: "Detected: ", style: DIM }, { text: clean(last.label) }));
  out.push(row(width, { text: "Config key: ", style: DIM }, { text: last.spec ? clean(last.spec) : "unsupported", style: last.spec ? T.code : DIM }));
  out.push(row(width, { text: "Raw event: ", style: DIM }, { text: JSON.stringify(last.raw ?? "").slice(1, -1) }));
  out.push([{ text: "Assigned actions:", style: DIM }]);
  if (!last.actions.length) out.push([{ text: "  none", style: DIM }]);
  for (const a of last.actions) out.push(row(width, { text: `  ${a}` }));
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
    out.push(row(width, { text: `  ${clean(s.name)}`, style: s.enabled === false ? DIM : T.code }, { text: `  ${clean(s.shortDescription ?? s.description ?? "")}`, style: DIM }));
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
    if (l) out.push(row(width, { text: `  ${clean(l)}`, style: (w.usedPercent ?? 0) >= 80 ? T.warning : undefined }));
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
    else if (it.kind === "agentMessage") out.push("## Agent", "", text(it.text), "");
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
export function imagePath(raw, cwd, { platform = process.platform, pasted = false } = {}) {
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
  // A bare name ("a.png") pasted into a sentence is text: only pasted paths attach (/image takes names).
  if (pasted && !quoted && !/[\\/]/.test(p)) return null;
  // Never touch the network for a pasted UNC path.
  if (/^(\\\\|\/\/)/.test(p)) return null;
  const abs = path.resolve(cwd, p);
  try {
    return existsSync(abs) && statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}
