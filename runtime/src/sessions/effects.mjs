// What a tool call did, for the session ledger (P4.1). Pure: no I/O, no engine imports.
//
//   effectOf(item)            "read" | "exec" | "write" | "external" | "agent" | null (not a tool)
//   isReadOnlyCommand(cmd)    ad's own conservative check: true only for plain read commands
//   toolStatus(item)          "running" | "succeeded" | "failed" | "declined" | "unknown"
//   settleTurn(tools, rootTurnId)  → the tools of that root turn (children included) still
//                             running become unknown; live background terminals stay running
//
// The engine's commandActions are UI summaries, not safety facts (it reads `find . -delete`
// as a search and drops `tee` as formatting), so a command counts as a read only when ad's
// own parser agrees. A false "exec" only makes ad pause more; a false "read" would let it
// continue past a write.

const READ_COMMANDS = new Set(["cat", "ls", "rg", "grep", "find", "head", "tail", "wc", "pwd", "type", "dir", "get-content", "get-childitem", "select-string", "gc", "gci", "sls"]);
const GIT_READS = new Set(["status", "diff", "log", "show"]);
const READ_ACTIONS = new Set(["read", "listFiles", "search"]);
const FIND_WRITES = /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(\s|$)/;

// The program a shell wrapper runs (`bash -lc "…"`, `cmd /c …`, `powershell -Command …`).
export const innerCommand = (command) => unwrap(command);
function unwrap(command) {
  let s = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  for (let i = 0; i < 3; i++) {
    const m = /^\s*(?:"?[\w./\\:-]*?(?:bash|sh|zsh|cmd(?:\.exe)?|pwsh(?:\.exe)?|powershell(?:\.exe)?)"?)\s+(?:-l\s+)?(?:-lc|-c|\/d\s+\/c|\/c|-Command|-NoProfile\s+-Command|-NoLogo\s+-NoProfile\s+-Command)\s+([\s\S]+)$/i.exec(s);
    if (!m) break;
    s = m[1].trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  }
  return s;
}

export function isReadOnlyCommand(command) {
  const s = unwrap(command);
  if (!s.trim()) return false;
  // Writes and anything ad can't follow: more than one line, redirection, substitution (also
  // PowerShell's (…) and @(…)), background, here-docs.
  if (/[\r\n()@]|[<>]|\$\(|`|(^|[^&])&(?!&)|<<|\|\s*tee\b|\bxargs\b/.test(s.replace(/2>&1/g, ""))) return false;
  // Every piece joined by && || ; | must be a plain read.
  const pieces = s.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);
  if (!pieces.length) return false;
  for (const p of pieces) {
    // As the shell sees them: quotes come off before a program reads its flags ('--pre').
    const tokens = p.split(/\s+/).map((t) => t.replace(/["']/g, ""));
    const bare = tokens.join(" ");
    const prog = tokens[0].replace(/\.exe$/i, "").split(/[\\/]/).pop().toLowerCase();
    if (prog === "git") {
      const sub = tokens[1]?.toLowerCase();
      // --output writes a file, --ext-diff runs a program; git takes abbreviations (--outp=).
      if (tokens.some((t) => /^--(o(?!neline$)|ext)/i.test(t))) return false;
      if (GIT_READS.has(sub)) continue;
      if (sub === "branch" && tokens.slice(2).every((t) => t === "--list" || t === "-l" || t === "-a" || t === "-v")) continue;
      return false;
    }
    if (!READ_COMMANDS.has(prog)) return false;
    if (prog === "find" && FIND_WRITES.test(bare)) return false;
    if (prog === "rg" && tokens.some((t) => /^--pre/.test(t))) return false; // runs a program per file
    if ((prog === "sed" || prog === "perl") && /\s-i/.test(bare)) return false;
  }
  return true;
}

export function effectOf(item) {
  switch (item?.type) {
    case "commandExecution": {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const allRead = actions.length > 0 && actions.every((a) => READ_ACTIONS.has(a?.type));
      return allRead && isReadOnlyCommand(item.command) ? "read" : "exec";
    }
    case "fileChange":
    case "imageGeneration":
      return "write";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "external";
    case "collabAgentToolCall":
      return "agent";
    case "webSearch":
    case "imageView":
      return "read";
    default:
      return null; // messages, reasoning, plans, hook prompts, compaction, sleep…
  }
}

export function toolStatus(item) {
  const s = item?.status;
  if (item?.type === "collabAgentToolCall" && s === "interrupted") return "unknown"; // the subagent may have edited files
  if (s === "completed") return item.type === "commandExecution" && Number.isInteger(item.exitCode) && item.exitCode !== 0 ? "failed" : "succeeded";
  if (s === "failed") return "failed";
  if (s === "declined" && item?.type !== "mcpToolCall") return "declined";
  if (s === "inProgress" || s === "running" || s == null) return "running";
  return "unknown";
}

/**
 * tools: Map<key, { rootTurnId, status, background }>. Returns the keys it settled.
 * A background terminal completes only when its process exits: it stays running.
 */
export function settleTurn(tools, rootTurnId) {
  const settled = [];
  for (const [key, t] of tools) {
    if (t.rootTurnId !== rootTurnId || t.status !== "running" || t.background) continue;
    t.status = "unknown";
    settled.push(key);
  }
  return settled;
}
