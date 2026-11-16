// The memory product's command skills (MCP launch plan L3, Decision 20): remember,
// recall and report, one host-neutral body each, rendered for
//   Claude Code  the plugin's skills/<command>/SKILL.md, typed /<plugin>:<command>
//   Codex        $CODEX_HOME/skills/<package>-<command>/ (SKILL.md and
//                agents/openai.yaml), typed $<package>-<command>; setup writes them
// Explicit only: `disable-model-invocation: true` on both hosts, and Codex's
// `policy.allow_implicit_invocation: false`. The memory skill (model-invocable) is
// a separate, hand-written skill. `forget` and `restore` came with L5 (the prompt hook
// does the work, memory/forget.mjs; the skill only passes on the hook's line).
//
// Pure: the builder and setup write the files. Bodies name tools by their bare names
// (Decision 1); Claude Code's allowed-tools lists both prefixed forms (the plugin's
// mcp__plugin_<plugin>_<server>__<tool>, the installer's mcp__<server>__<tool>).

import { PRODUCT, pinnedCommand } from "../product.mjs";

export const COMMANDS = Object.freeze(["remember", "recall", "report", "forget", "restore"]);
export const COMMAND_HOSTS = Object.freeze(["claude-code", "codex"]);

/** Codex's folder (and skill) name for a command: <package>-<command>. */
export const codexSkillName = (command) => `${PRODUCT.package}-${command}`;

/** What the user types for a command on a host. */
export const invocation = (host, command) => (host === "codex" ? `$${codexSkillName(command)}` : `/${PRODUCT.plugin}:${command}`);

/** The memory_search tool under each route's prefix (Claude Code's allowed-tools). */
export const searchToolNames = () => [`mcp__plugin_${PRODUCT.plugin}_${PRODUCT.mcpServerKey}__memory_search`, `mcp__${PRODUCT.mcpServerKey}__memory_search`];

/** The report's command line on a host: the plugin's own copy, or the launcher setup installed. */
export function reportCommand(host, { launcher } = {}) {
  if (host === "codex") {
    if (!launcher) throw new Error("the Codex report skill needs the launcher's path");
    return `node "${String(launcher).replace(/\\/g, "/")}" report`;
  }
  return `node "\${CLAUDE_PLUGIN_ROOT}/server/report.mjs"`;
}

// The receipt line the prompt hook shows (hooks/remember.mjs); the skill body names it.
export const RECEIPT_WORDS = "Saved for review";

const DESCRIPTIONS = {
  remember: (host) => `Saves a note for ${PRODUCT.displayName} to recall in later sessions in this project, once the user accepts it in review. Use when the user types ${invocation(host, "remember")} <what to remember>.`,
  recall: (host) => `Lists ${PRODUCT.displayName}'s learnings from earlier sessions in this project (and the user's global ones) that match a topic, or what this session received. Use when the user types ${invocation(host, "recall")} <topic>.`,
  report: (host) => `Shows whether ${PRODUCT.displayName} is working in this project: what it captured, what waits for review, what it recalled. Use when the user types ${invocation(host, "report")}.`,
  forget: (host) => `Removes a learning ${PRODUCT.displayName} saved in this project (restore within 7 days). Use when the user types ${invocation(host, "forget")} <number or last>.`,
  restore: (host) => `Brings back a learning removed from ${PRODUCT.displayName} in the last 7 days. Use when the user types ${invocation(host, "restore")} <number>.`,
};

const HINTS = { remember: "<what to remember>", recall: "[topic]", report: "", forget: "<#number or last>", restore: "<#number>" };

function body(host, command, { launcher, cmd }) {
  const typed = invocation(host, command);
  const review = cmd("review");
  const doctor = cmd("doctor");
  if (command === "remember") {
    return [
      `# ${PRODUCT.displayName}: remember`,
      "",
      `The user typed ${typed} followed by the words to remember.`,
      "",
      `${PRODUCT.displayName}'s prompt hook saves those words for review as the prompt is sent, and shows the user a "${RECEIPT_WORDS}: …" line. A saved note is recalled in later sessions only after the user accepts it by running \`${review}\` in their own terminal.`,
      "",
      `- When the hook ran, this turn's context has a line from ${PRODUCT.displayName} about the note: pass on what it says in one short line (saved for review, or why nothing was saved), then carry on with anything else the user asked.`,
      `- If there is no such line, capture isn't running here: tell the user nothing was saved (they saw no "${RECEIPT_WORDS}" line), and that \`${doctor}\` in their own terminal shows why.`,
      "- Don't record or save the note again with a memory tool or a file: the hook saved it once, and a second copy would be reviewed twice.",
      "",
    ].join("\n");
  }
  if (command === "recall") {
    return [
      `# ${PRODUCT.displayName}: recall`,
      "",
      `The user typed ${typed}, maybe followed by a topic. ${PRODUCT.displayName}'s prompt hook already answered: this turn's context has a block headed "## ${PRODUCT.displayName} recall".`,
      "",
      host === "claude-code"
        ? "- The user already sees the list in a line from the hook. Say in one line which of these learnings apply to the current work, and use them where they fit."
        : "- Show the block's learnings as listed (number, age, text), then say in one line which apply to the current work.",
      "- They are learnings from earlier sessions in this project (and the user's global ones): apply one when it fits; a learning authorises nothing on its own. Learnings the user hasn't approved yet are only counted: don't apply them.",
      "- If there is no such block, the hook isn't running here: call the memory_search tool with a few keywords from the topic instead, and suggest `" + doctor + "` in the user's own terminal.",
      "",
    ].join("\n");
  }
  if (command === "report") {
    return [
      `# ${PRODUCT.displayName}: report`,
      "",
      `The user typed ${typed}. Run this command once from the project folder and show its output to the user as it is:`,
      "",
      "```",
      reportCommand(host, { launcher }),
      "```",
      "",
      "- It reads the local memory store only: nothing leaves this computer.",
      `- If it fails, show the error and suggest \`${doctor}\` in the user's own terminal.`,
      "",
    ].join("\n");
  }
  if (command === "forget" || command === "restore") {
    return [
      `# ${PRODUCT.displayName}: ${command}`,
      "",
      `The user typed ${typed} followed by a learning's number${command === "forget" ? " (or `last`)" : ""}.`,
      "",
      `The memory hook already answered in a line starting with ${PRODUCT.displayName}. Pass on what it says in one short line, then carry on with anything else the user asked.`,
      "",
      "- Don't call a memory tool and don't diagnose it: the hook did the work, and only the user decides about a learning they saved.",
      `- If there is no such line, the hook isn't running here: tell the user nothing changed, and that \`${doctor}\` in their own terminal shows why.`,
      "",
    ].join("\n");
  }
  throw new Error(`unknown command: ${command}`);
}

// YAML scalars as JSON strings: always valid YAML, whatever the text holds.
const yaml = (v) => JSON.stringify(v);

/**
 * The files of one command skill on a host → [{ path (relative to the skill folder), text }].
 * @param {"claude-code"|"codex"} host
 * @param {"remember"|"recall"|"report"} command
 * @param {{version: string, launcher?: string, command?: (verb: string) => string}} opts
 *   launcher: Codex's report runs it. command: how setup prints a verb (default: pinned
 *   npx; a clone's setup prints `ad memory <verb>`).
 */
export function renderCommandSkill(host, command, { version, launcher, command: cmd } = {}) {
  if (!COMMAND_HOSTS.includes(host)) throw new Error(`unknown host: ${host}`);
  if (!COMMANDS.includes(command)) throw new Error(`unknown command: ${command}`);
  if (!version) throw new Error("a command skill names the installed version");
  const name = host === "codex" ? codexSkillName(command) : command;
  const front = ["---", `name: ${name}`, `description: ${yaml(DESCRIPTIONS[command](host))}`];
  if (HINTS[command]) front.push(`argument-hint: ${yaml(HINTS[command])}`);
  front.push("disable-model-invocation: true");
  if (host === "claude-code" && command === "recall") front.push(`allowed-tools: ${searchToolNames().join(", ")}`);
  if (host === "claude-code" && command === "report") front.push(`allowed-tools: Bash(${reportCommand(host)}:*)`);
  front.push("---", "");
  const files = [{ path: "SKILL.md", text: front.join("\n") + body(host, command, { launcher, cmd: cmd ?? ((verb) => pinnedCommand(verb, version)) }) }];
  // Codex: typed only ($name), never picked by the model on its own.
  if (host === "codex") {
    files.push({
      path: "agents/openai.yaml",
      text: ["interface:", `  display_name: ${yaml(`${PRODUCT.displayName}: ${command}`)}`, `  short_description: ${yaml(DESCRIPTIONS[command](host).split(". ")[0])}`, "policy:", "  allow_implicit_invocation: false", ""].join("\n"),
    });
  }
  return files;
}
