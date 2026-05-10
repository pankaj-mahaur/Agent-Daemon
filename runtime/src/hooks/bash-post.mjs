// PostToolUse hook for Bash — surfaces useful artifacts from shell output.
// Ported from everything-claude-code/.cursor/hooks/after-shell-execution.js
// + scripts/hooks/post-bash-pr-created.js + post-bash-build-complete.js.
//
// Pulls the PR URL out of `gh pr create` output and reminds how to review it.
// Tags `npm/pnpm/yarn build` completion. Pure stderr — never blocks.

import { readStdinJson, passthrough, warn } from "./io.mjs";

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

export async function bashPost() {
  const input = await readStdinJson();
  const cmd = String(input?.tool_input?.command || input?.command || "");
  const output = String(input?.tool_response?.output || input?.output || input?.result || "");

  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const m = output.match(PR_URL_RE);
    if (m) {
      warn(`PR created: ${m[0]}`);
      const repoMatch = m[0].match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (repoMatch) warn(`Review with: gh pr view ${repoMatch[2]} --repo ${repoMatch[1]}`);
    }
  }

  if (/\b(npm run build|pnpm build|yarn build|bun run build)\b/.test(cmd)) {
    warn("build completed — sanity-check size diff before pushing");
  }

  passthrough();
}
