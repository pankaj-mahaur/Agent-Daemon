// The rule matcher (plan L4c, used by L7's hook and by replay). Does one tool
// call run what a rule forbids?
//
// Rules use the neutral schema the L0 corpora were written against:
//   {type:"command", program, subcommands: string[]|null, flags: string[]|null}
//     program: matched after the path and .exe/.cmd/.bat/.ps1 are stripped
//              (case-insensitive on Windows and in PowerShell);
//     subcommands: must contain the first argument that isn't an option;
//     flags: at least one must be present ("-rf" also matches "-r -f" and "-fr");
//     both conditions hold when both are set.
//   {type:"write", globs: string[]}  project-relative; Write, Edit and apply_patch targets.
// A command rule never looks inside a file the agent writes, and a write rule
// never reads a shell command: a shell redirect into a protected path is a
// stated limit.
//
// A call: {tool, input, os, cwd, project_root, host?}. Pure: no fs, no spawn.

import { commandsIn, programName } from "./shell.mjs";
import { projectRelative, globsMatch } from "./paths.mjs";
import { patchPaths } from "../hooks/io.mjs";

const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "shell_command", "exec_command", "local_shell", "exec", "container.exec"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch"]);

/** Which shell language a call's command is written in. */
export function dialectOf(call) {
  const tool = String(call.tool ?? "").toLowerCase();
  if (tool === "powershell") return "powershell";
  if (tool === "bash") return "bash";
  // Codex runs its shell tool through PowerShell on Windows.
  return call.os === "windows" ? "powershell" : "bash";
}

/** The command text or argv a shell call carries. */
function commandOf(input) {
  const c = input?.command ?? input?.cmd ?? input?.action?.command;
  return c;
}

/** A patch sent through Codex's shell tool: ["apply_patch", patch], or "apply_patch <<'EOF' …". */
function shellPatch(command) {
  if (Array.isArray(command) && programName(String(command[0] ?? "")) === "apply_patch") return String(command[1] ?? "");
  if (typeof command === "string" && /^\s*apply_patch\b/.test(command) && command.includes("*** Begin Patch")) return command;
  return null;
}

/** The files a write call touches (Write/Edit path, or every path in a patch). */
export function writeTargets(call) {
  const tool = String(call.tool ?? "").toLowerCase();
  const input = call.input ?? {};
  if (tool === "apply_patch") return patchPaths(input.patch ?? input.input ?? input.command ?? "", "", { resolve: false });
  if (COMMAND_TOOLS.has(tool)) {
    const patch = shellPatch(commandOf(input));
    return patch ? patchPaths(patch, "", { resolve: false }) : [];
  }
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return p ? [String(p)] : [];
}

const isOption = (a, windows) => (a.startsWith("-") && a.length > 1) || (a.startsWith("+") && a.length > 1) || (windows && /^\/[A-Za-z?]{1,3}(?::.*)?$/.test(a));

// Global options that take a value before the verb: git -C dir push, npm --prefix web install.
const VALUE_OPTIONS = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"],
  npm: ["--prefix", "-w", "--workspace", "--cache", "--userconfig", "--globalconfig", "--registry", "-C"],
  pnpm: ["-C", "--dir", "--filter", "-F", "--workspace-dir", "--config-dir"],
  yarn: ["--cwd"],
  bun: ["--cwd", "-c", "--config"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user", "--token", "-l", "--selector"],
  helm: ["-n", "--namespace", "--kube-context", "--kubeconfig", "--registry-config", "--repository-config"],
  docker: ["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
  "docker-compose": ["-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory"],
  cargo: ["-Z", "--config", "--color", "-C"],
  gcloud: ["--project", "--account", "--configuration", "--region", "--zone", "--format", "--verbosity"],
  aws: ["--profile", "--region", "--output", "--endpoint-url", "--query"],
  az: ["--subscription", "--output", "-o", "--query"],
  terraform: [],
  make: ["-C", "-f", "--file", "--directory", "-j", "--jobs", "-I", "-o", "-W"],
  dotnet: [],
  go: ["-C"],
};

/** The first argument that isn't an option (after "--", the next one), skipping a program's valued options. */
export function firstNonOption(args, { windows = false, program = "" } = {}) {
  const valued = VALUE_OPTIONS[String(program).toLowerCase()] ?? [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") return args[i + 1] ?? null;
    if (valued.includes(args[i])) {
      i++;
      continue;
    }
    if (!isOption(args[i], windows)) return args[i];
  }
  return null;
}

const SHORT_CLUSTER = /^-[A-Za-z]{1,6}$/;
// A rule flag read as letters: -rf, -fdx. A longer one (-delete, -exec) is a
// word, so find's -depth -mtime -ls never spell it.
const RULE_CLUSTER = /^-[A-Za-z]{1,3}$/;
// Long options that mean a short letter, and letters that mean the same (rm -R is rm -r).
const LONG_LETTERS = {
  rm: { "--recursive": "r", "--force": "f", "--dir": "d", "--verbose": "v" },
  cp: { "--recursive": "r", "--force": "f" },
  mv: { "--force": "f" },
  chmod: { "--recursive": "R" },
  chown: { "--recursive": "R" },
  git: { "--force": "f", "--delete": "d", "--all": "a" },
};
const SAME_LETTER = { rm: { R: "r" }, cp: { R: "r" } };
const isCmdlet = (name) => /^[a-z]+-[a-z]+$/i.test(name);

/**
 * Is at least one of the rule's flags present?
 * Case is exact for native programs (git branch -d is not -D, rubocop -a is not -A);
 * PowerShell cmdlet parameters and Windows /x options ignore case, and a cmdlet
 * parameter may be shortened (-r, -Rec for -Recurse).
 */
export function flagsPresent(ruleFlags, args, { program = "", cmdlet = isCmdlet(program) } = {}) {
  const p = String(program).toLowerCase();
  const end = args.indexOf("--");
  const opts = end < 0 ? args : args.slice(0, end);
  const eq = (a, b) => (cmdlet || /^\//.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
  const same = (ch) => SAME_LETTER[p]?.[ch] ?? ch;
  // Short options given apart or together: -r -f, -rf, -fr, -R -f, --recursive --force.
  const letters = new Set();
  const clusters = !cmdlet;
  if (clusters) {
    for (const a of opts) {
      if (SHORT_CLUSTER.test(a)) for (const ch of a.slice(1)) letters.add(same(ch));
      const long = LONG_LETTERS[p]?.[a.split("=")[0]];
      if (long) letters.add(same(long));
    }
  }
  for (const f of ruleFlags ?? []) {
    for (const a of opts) {
      if (eq(a, f)) return true;
      // --flag=value, PowerShell -Flag:value
      if (a.length > f.length && eq(a.slice(0, f.length), f) && (a[f.length] === "=" || (cmdlet && a[f.length] === ":"))) return true;
      if (cmdlet && /^-[a-z]+$/i.test(f) && /^-[a-z]+(?::.*)?$/i.test(a)) {
        const name = a.split(":")[0].toLowerCase();
        if (name.length >= 2 && f.toLowerCase().startsWith(name)) return true;
      }
    }
    if (clusters && RULE_CLUSTER.test(f) && [...f.slice(1)].every((ch) => letters.has(same(ch)))) return true;
  }
  return false;
}

const list = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : null);

/** Does this argv run what the command rule forbids? */
export function argvMatches(rule, argv, { os = "linux", dialect = "bash" } = {}) {
  const fold = os === "windows" || dialect === "powershell";
  const norm = (s) => (fold ? String(s).toLowerCase() : String(s));
  if (!argv.length || norm(programName(argv[0])) !== norm(programName(rule.program))) return false;
  const args = argv.slice(1);
  const program = programName(rule.program);
  const subs = list(rule.subcommands);
  if (subs?.length) {
    const first = firstNonOption(args, { windows: os === "windows", program });
    if (first === null || !subs.some((s) => norm(s) === norm(first))) return false;
  }
  const flags = list(rule.flags);
  if (flags?.length && !flagsPresent(flags, args, { program })) return false;
  return true;
}

// Replay asks the same call about many rules: parse its command once.
const parsed = new WeakMap();
function commandsOfCall(input, command, dialect, os) {
  const key = typeof input === "object" && input ? input : null;
  const tag = `${dialect}|${os}`;
  const hit = key && parsed.get(key);
  if (hit && hit.tag === tag) return hit.commands;
  const commands = commandsIn(command, { dialect, os });
  if (key) parsed.set(key, { tag, commands });
  return commands;
}

/**
 * Does the call run what the rule forbids?
 * @param {{type:string, program?:string, subcommands?:string[]|null, flags?:string[]|null, globs?:string[]}} rule
 * @param {{tool:string, input:object, os?:string, cwd?:string, project_root?:string}} call
 * @returns {{match:boolean, argv?:string[], path?:string, incomplete?:boolean, error?:string}}
 *   incomplete: the command was too long or nested too deep to read whole, and
 *   names the rule's program: a hook should ask. error: the rule or call was
 *   malformed (no match; a hook decides what that means).
 */
export function matchRule(rule, call) {
  try {
    return decide(rule, call);
  } catch (err) {
    return { match: false, error: String(err?.message ?? err) };
  }
}

function decide(rule, call) {
  const tool = String(call?.tool ?? "").toLowerCase();
  const os = call?.os ?? "linux";
  if (rule?.type === "command") {
    if (!COMMAND_TOOLS.has(tool) || typeof rule.program !== "string" || !rule.program) return { match: false };
    const command = commandOf(call.input);
    if (command == null) return { match: false };
    const commands = commandsOfCall(call.input, command, dialectOf(call), os);
    for (const { argv, dialect } of commands) {
      if (argvMatches(rule, argv, { os, dialect })) return { match: true, argv };
    }
    if (commands.incomplete) {
      const text = Array.isArray(command) ? command.join(" ") : String(command);
      const name = programName(rule.program).replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
      if (new RegExp(`(?:^|[^\\w-])${name}(?:$|[^\\w-])`, "i").test(text)) return { match: true, incomplete: true };
    }
    return { match: false };
  }
  if (rule?.type === "write") {
    const globs = list(rule.globs);
    if (!globs?.length || (!WRITE_TOOLS.has(tool) && !COMMAND_TOOLS.has(tool))) return { match: false };
    for (const target of writeTargets(call)) {
      const rel = projectRelative(target, { cwd: call.cwd ?? call.project_root, root: call.project_root ?? call.cwd, os });
      if (rel !== null && globsMatch(globs, rel, { os })) return { match: true, path: rel };
    }
    return { match: false };
  }
  return { match: false };
}
