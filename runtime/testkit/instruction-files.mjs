// Instruction-file fixtures for L4b's import: a sample project with every kind of file
// it reads, ad's own blocks in them, and the units each must give. Written into a temp
// folder by the test (never kept as real CLAUDE.md or AGENTS.md files in this repo, which
// an agent working here would load).

import fs from "node:fs";
import path from "node:path";

export const FILES = {
  "CLAUDE.md": [
    "# Sample shop",
    "",
    "@AGENTS.md",
    "",
    "<!-- agent-daemon:start -->",
    "## agent-daemon",
    "- AD-ONLY: read AD-INSTRUCTIONS.md before any substantial task",
    "<!-- agent-daemon:end -->",
    "",
    "## Conventions",
    "- Use pnpm, never npm or yarn",
    "- Keep API handlers in `src/routes/` thin",
    "",
    "<!-- agent-daemon:learnings:start -->",
    "## Recent learnings (agent-daemon, 2026-09-30)",
    "- **correction**: AD-ONLY mirror: the cart total is computed server-side",
    "<!-- agent-daemon:learnings:end -->",
    "",
    "Prices are stored in cents as integers.",
    "",
  ].join("\r\n"),
  "AGENTS.md": ["# Agents", "", "- Run `pnpm test` before you hand back", "- Never edit generated files under `dist/`", ""].join("\n"),
  "GEMINI.md": ["# Gemini", "", "Write commit messages in the imperative mood.", ""].join("\n"),
  ".github/copilot-instructions.md": ["Prefer named exports over default exports.", "", "- Add a test with every bug fix", ""].join("\n"),
  // A BOM before the front matter (an editor on Windows writes one).
  ".github/instructions/python.instructions.md": ["\u{FEFF}---", "applyTo: '**/*.py'", "---", "Use type hints on every public function.", ""].join("\n"),
  ".cursor/rules/react.mdc": ["---", "description: React components", "globs: src/**/*.tsx", "alwaysApply: false", "---", "- Use function components with hooks", "- Co-locate component tests next to the component", ""].join("\n"),
  ".cursorrules": ["Always answer with the smallest diff that works.", ""].join("\n"),
  ".claude/CLAUDE.md": "- Keep migrations reversible\n",
  "CLAUDE.local.md": "- Use the local test database on port 5433\n",
  "AGENTS.override.md": "- Prefer small commits with clear messages\n",
  ".cursor/rules/style.md": "Indent with two spaces.\n",
};

/** The units each file must give, in order (ad's blocks, the import line and headings never). */
export const EXPECTED = {
  "CLAUDE.md": [
    { text: "Use pnpm, never npm or yarn", heading: "Conventions" },
    { text: "Keep API handlers in `src/routes/` thin", heading: "Conventions" },
    { text: "Prices are stored in cents as integers.", heading: "Conventions" },
  ],
  "AGENTS.md": [
    { text: "Run `pnpm test` before you hand back", heading: "Agents" },
    { text: "Never edit generated files under `dist/`", heading: "Agents" },
  ],
  "GEMINI.md": [{ text: "Write commit messages in the imperative mood.", heading: "Gemini" }],
  ".github/copilot-instructions.md": [
    { text: "Prefer named exports over default exports.", heading: null },
    { text: "Add a test with every bug fix", heading: null },
  ],
  ".github/instructions/python.instructions.md": [{ text: "Use type hints on every public function.", heading: null }],
  ".cursor/rules/react.mdc": [
    { text: "Use function components with hooks", heading: null },
    { text: "Co-locate component tests next to the component", heading: null },
  ],
  ".cursorrules": [{ text: "Always answer with the smallest diff that works.", heading: null }],
  ".claude/CLAUDE.md": [{ text: "Keep migrations reversible", heading: null }],
  "CLAUDE.local.md": [{ text: "Use the local test database on port 5433", heading: null }],
  "AGENTS.override.md": [{ text: "Prefer small commits with clear messages", heading: null }],
  ".cursor/rules/style.md": [{ text: "Indent with two spaces.", heading: null }],
};

/** The kinds, and which launch hosts load each file by themselves. */
export const KINDS = {
  "CLAUDE.md": { kind: "claude", loadedBy: ["claude-code"] },
  // CLAUDE.md imports it; Codex reads AGENTS.override.md in its place.
  "AGENTS.md": { kind: "agents", loadedBy: ["claude-code"] },
  "AGENTS.override.md": { kind: "agents", loadedBy: ["codex"] },
  ".claude/CLAUDE.md": { kind: "claude", loadedBy: ["claude-code"] },
  "CLAUDE.local.md": { kind: "claude", loadedBy: ["claude-code"] },
  ".cursor/rules/style.md": { kind: "cursor", loadedBy: [] },
  "GEMINI.md": { kind: "gemini", loadedBy: [] },
  ".github/copilot-instructions.md": { kind: "copilot", loadedBy: [] },
  ".github/instructions/python.instructions.md": { kind: "copilot", loadedBy: [] },
  ".cursor/rules/react.mdc": { kind: "cursor", loadedBy: [] },
  ".cursorrules": { kind: "cursor", loadedBy: [] },
};

/** Write the sample project (a git root) under `base`; returns its folder. */
export function writeSampleProject(base, files = FILES) {
  const root = path.join(base, "work", "sample-shop");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}
