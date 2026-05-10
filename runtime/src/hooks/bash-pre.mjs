// PreToolUse hook for Bash — guards against risky shell invocations.
// Ported from everything-claude-code/.cursor/hooks/before-shell-execution.js
// + scripts/hooks/block-no-verify.js + pre-bash-git-push-reminder.js.
//
// Blocks (exit with decision: block):
//   - `git commit --no-verify` / `git push --no-verify` (skips hooks — almost never wanted)
//   - dev-server commands not wrapped in tmux on Linux/macOS (so logs are reachable)
//
// Warns to stderr (still allows):
//   - `git push` without prior diff review

import { readStdinJson, approve, block, warn } from "./io.mjs";

function getCommand(input) {
  return String(input?.tool_input?.command || input?.command || "");
}

const NO_VERIFY_RE = /\bgit\s+(commit|push)\b[^|;&\n]*--no-verify\b/;
const DEV_SERVER_RE = /\b(npm\s+run\s+dev|pnpm(?:\s+run)?\s+dev|yarn\s+dev|bun\s+run\s+dev)\b/;
const TMUX_LAUNCH_RE = /^\s*tmux\s+(new|new-session|new-window|split-window)\b/;
const GIT_PUSH_RE = /\bgit\s+push\b/;

export async function bashPre() {
  const input = await readStdinJson();
  const cmd = getCommand(input);

  if (NO_VERIFY_RE.test(cmd)) {
    block(
      "Refusing to skip git hooks via --no-verify. Hooks exist to catch lint/format/type errors before they hit CI. If a hook is genuinely broken, fix the hook — don't bypass it.",
    );
    return;
  }

  if (process.platform !== "win32" && DEV_SERVER_RE.test(cmd) && !TMUX_LAUNCH_RE.test(cmd)) {
    block(
      "Dev server should run inside tmux so its logs stay reachable across tool calls. Try: tmux new-session -d -s dev '<your dev command>'",
    );
    return;
  }

  if (GIT_PUSH_RE.test(cmd)) {
    warn("git push detected — review changes first with: git diff origin/main...HEAD");
  }

  approve();
}
