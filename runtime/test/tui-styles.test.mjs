// Styles, not just text (codex-parity-2 P8): the other goldens strip styles,
// so a colour changing by accident would pass them. This sheet keeps every
// span's style, so moving the colours into tui/view/theme.mjs (or any later
// change) can't recolour the UI unnoticed. AD_UPDATE_GOLDEN=1 rewrites it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { classifyRequest } from "../src/engine/codex/events.mjs";
import { renderAdRow, renderCell, renderNotice, renderPlan } from "../src/tui/view/cells.mjs";
import { createPicker, renderFooter, renderHeader, renderShortcuts, renderStatus } from "../src/tui/view/chrome.mjs";
import { createComposer } from "../src/tui/view/composer.mjs";
import { createRequestModal } from "../src/tui/view/modals.mjs";
import { renderHooks, renderMcp, renderSkills, renderUsage } from "../src/tui/commands.mjs";

// "text" for a plain span, "⟦fg=cyan,bold⟧text" for a styled one.
const styled = (lines) =>
  lines
    .map((l) =>
      l
        .map((s) => {
          const st = Object.entries(s.style ?? {}).filter(([k, v]) => v !== undefined && v !== false && k !== "link").sort(([a], [b]) => a.localeCompare(b));
          return st.length ? `\u{27e6}${st.map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(",")}\u{27e7}${s.text}` : s.text;
        })
        .join("")
        .replace(/ +$/, ""),
    )
    .join("\n");

const W = 80;
const CELLS = {
  user: { kind: "userMessage", text: "fix the login test" },
  agent: { kind: "agentMessage", text: "# Title\n\n## Fix\n\nUse **`refresh()`** and *real* timers, ~~not fake~~. See [docs](https://example.com).\n\n> a quote\n\n- one\n\n```ts\nconst a = 1;\n```\n\n---" },
  reasoning: { kind: "reasoning", summaryText: "**Checking** the refresh path." },
  ran: { kind: "commandExecution", command: "npm test", status: "completed", exitCode: 0, durationMs: 4200, output: "ok\n", actions: [] },
  failed: { kind: "commandExecution", command: "npm test", status: "failed", exitCode: 1, durationMs: 900, output: "1 failing\n", actions: [] },
  declined: { kind: "commandExecution", command: "rm -rf build", status: "declined", actions: [] },
  edited: { kind: "fileChange", status: "completed", changes: [{ path: "src/auth.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n same\n" }] },
  mcpFail: { kind: "mcpToolCall", server: "memory", tool: "search", status: "failed", arguments: {}, error: { message: "MCP down" } },
  web: { kind: "webSearch", query: "vitest timers" },
  agents: { kind: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["t2"], prompt: "Check signup" },
};

function sheet() {
  const out = [];
  const add = (name, lines) => out.push(`── ${name} ──`, styled(lines));
  for (const [name, item] of Object.entries(CELLS)) add(name, renderCell(item, { width: W }));
  add("plan", renderPlan([{ step: "Reproduce", status: "completed" }, { step: "Fix", status: "inProgress" }, { step: "Test", status: "pending" }], { width: W, explanation: "Small" }));
  add("notices", [...renderNotice({ level: "info", message: "info" }, { width: W }), ...renderNotice({ level: "warn", message: "warn" }, { width: W }), ...renderNotice({ level: "error", message: "error" }, { width: W })]);
  add("ad rows", [...renderAdRow("recalled", "3 learnings", { width: W }), ...renderAdRow("guard", "blocked", { width: W })]);
  add("header", renderHeader({ title: "ad", rows: [{ label: "model", value: "gpt", hint: "/model" }, { label: "sandbox", value: "none", warn: true }] }, { width: W }));
  add("status", renderStatus({ label: "Working", elapsedMs: 3000, frame: 1, queued: ["later"] }, { width: W }));
  add("footer", [renderFooter({ hints: ["? shortcuts"], chips: [{ full: "private", short: "P" }], meters: [{ text: "ctx 40%" }, { text: "5h 85%", warn: true }] }, { width: W })]);
  add("shortcuts", renderShortcuts({ newline: "ctrl+j" }, { width: W }));
  const picker = createPicker({ items: [{ label: "one", hint: "first", value: 1 }, { label: "two", value: 2 }], title: "Pick" });
  add("picker", picker.render({ width: W, height: 6 }));
  const composer = createComposer();
  composer.set("hello");
  add("composer", composer.render({ width: W, prompt: "\u{203a} " }).lines);
  add("composer empty", createComposer().render({ width: W, prompt: "\u{203a} ", placeholder: "Ask" }).lines);
  const exec = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", turnId: "u", itemId: "c", command: "npm install", cwd: "/w", reason: "needs network", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }, 7);
  add("exec approval", createRequestModal(exec, { now: () => 0 }).render({ width: W, height: 20 }));
  const patch = classifyRequest("item/fileChange/requestApproval", { threadId: "t", turnId: "u", itemId: "p", reason: "fix" }, 8);
  add("patch approval", createRequestModal(patch, { now: () => 0, diff: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }] }).render({ width: W, height: 20 }));
  add("mcp", renderMcp([{ name: "memory", runtimeStatus: "ready" }, { name: "broken", runtimeStatus: "failed" }], { width: W }));
  add("hooks", renderHooks([{ event: "SessionStart", command: "ad hook", trusted: true }], { width: W, hooksFile: "/h/hooks.json" }));
  add("skills", renderSkills([{ skills: [{ name: "debug", description: "bugs", enabled: true }, { name: "old", description: "off", enabled: false }] }], { width: W }));
  add("usage", renderUsage({ rateLimits: { primary: { usedPercent: 38, windowDurationMins: 300 }, secondary: { usedPercent: 85, windowDurationMins: 10080 } } }, { width: W }));
  return out.join("\n");
}

test("styles golden: every span's style, so a colour can't change unnoticed", () => {
  assertGolden("tui/styles-80.txt", sheet());
});

test("colours have one home: no fg/bg literal in the UI outside tui/view/theme.mjs", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../src/tui/", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "terminal") walk(p); // terminal/ is the SGR layer itself
      } else if (e.name.endsWith(".mjs") && e.name !== "theme.mjs") {
        readFileSync(p, "utf8").split("\n").forEach((l, i) => /\b(fg|bg):\s*["'#]/.test(l) && offenders.push(`${p}:${i + 1}`));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "use a token from tui/view/theme.mjs");
});
