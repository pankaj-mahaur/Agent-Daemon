// L3 Decision 20: the memory product's command skills (remember, recall, report),
// rendered for the Claude Code plugin and for Codex. Explicit only on both hosts,
// pinned commands, bare tool names in the text, both prefixed forms in allowed-tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, codexSkillName, invocation, renderCommandSkill, reportCommand, searchToolNames } from "../src/memory-install/command-skills.mjs";
import { validateSkill } from "../src/skill-lint.mjs";
import { PRODUCT } from "../src/product.mjs";

const VERSION = "3.1.0";
const LAUNCHER = "C:\\Users\\x\\.agent-daemon\\memory\\launch\\run.mjs";

// The two YAML shapes the renderer writes: `key: <JSON string | true | false | plain>`,
// nested one level by two spaces.
function parseYaml(text) {
  const out = {};
  let parent = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^( {2})?([\w-]+):(?: (.*))?$/.exec(line);
    assert.ok(m, `a YAML line the reader knows: ${line}`);
    const raw = m[3];
    const value = raw === undefined ? {} : raw === "true" ? true : raw === "false" ? false : raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (m[1]) parent[m[2]] = value;
    else {
      out[m[2]] = value;
      parent = raw === undefined ? value : null;
    }
  }
  return out;
}
const frontOf = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "frontmatter between --- lines");
  return parseYaml(m[1]);
};
const skill = (host, c) => renderCommandSkill(host, c, { version: VERSION, launcher: LAUNCHER });
const md = (host, c) => skill(host, c).find((f) => f.path === "SKILL.md").text;

test("both hosts: every command is explicit-only, named for its folder, with the pinned version", () => {
  for (const host of ["claude-code", "codex"]) {
    for (const c of COMMANDS) {
      const f = frontOf(md(host, c));
      assert.equal(f["disable-model-invocation"], true, `${host} ${c}`);
      assert.equal(f.name, host === "codex" ? `${PRODUCT.package}-${c}` : c, "the name is the folder name");
      assert.match(f.description, new RegExp(invocation(host, c).replace(/[$/:]/g, "\\$&")), "the description says what to type");
      assert.ok(md(host, c).includes(`npx -y ${PRODUCT.package}@${VERSION} `), `${host} ${c}: commands pinned to the installed version`);
    }
  }
  for (const host of ["claude-code", "codex"]) {
    for (const c of COMMANDS) assert.deepEqual(validateSkill(host === "codex" ? codexSkillName(c) : c, md(host, c)).filter((i) => i.severity === "error"), [], `${host} ${c}: the repo's own skill lint`);
  }
  assert.equal(invocation("claude-code", "remember"), `/${PRODUCT.plugin}:remember`);
  assert.equal(invocation("codex", "remember"), `$${PRODUCT.package}-remember`);
  assert.equal(codexSkillName("recall"), `${PRODUCT.package}-recall`);
});

test("Codex: agents/openai.yaml turns implicit invocation off; Claude Code gets SKILL.md only", () => {
  for (const c of COMMANDS) {
    const files = skill("codex", c);
    assert.deepEqual(files.map((f) => f.path).sort(), ["SKILL.md", "agents/openai.yaml"]);
    const y = parseYaml(files.find((f) => f.path === "agents/openai.yaml").text);
    assert.equal(y.policy.allow_implicit_invocation, false);
    assert.deepEqual(skill("claude-code", c).map((f) => f.path), ["SKILL.md"]);
  }
});

test("tools by bare name in the text; recall's allowed-tools lists both prefixed forms", () => {
  for (const host of ["claude-code", "codex"]) {
    for (const c of COMMANDS) assert.doesNotMatch(md(host, c).split("\n---\n")[1], /mcp__/, `${host} ${c}: no prefixed tool name in the body`);
  }
  assert.match(md("claude-code", "recall"), /memory_search/);
  const allowed = frontOf(md("claude-code", "recall"))["allowed-tools"].split(/,\s*/);
  assert.deepEqual(allowed, searchToolNames());
  assert.deepEqual(allowed, [`mcp__plugin_${PRODUCT.plugin}_${PRODUCT.mcpServerKey}__memory_search`, `mcp__${PRODUCT.mcpServerKey}__memory_search`]);
  assert.equal(frontOf(md("codex", "recall"))["allowed-tools"], undefined, "Codex has no allowed-tools");
});

test("report: the plugin's own copy (allowed-tools scoped to it) or the launcher setup installed", () => {
  const cc = md("claude-code", "report");
  assert.ok(cc.includes('node "${CLAUDE_PLUGIN_ROOT}/server/report.mjs"'));
  assert.equal(frontOf(cc)["allowed-tools"], 'Bash(node "${CLAUDE_PLUGIN_ROOT}/server/report.mjs":*)', "Bash scoped to the report only");
  const cx = md("codex", "report");
  assert.ok(cx.includes('node "C:/Users/x/.agent-daemon/memory/launch/run.mjs" report'), "forward slashes: one spelling in every shell");
  assert.throws(() => reportCommand("codex", {}), /launcher/);
});

test("remember: points at the receipt and the review, and says not to save it twice", () => {
  for (const host of ["claude-code", "codex"]) {
    const t = md(host, "remember");
    assert.match(t, /Saved for review/);
    assert.ok(t.includes(`npx -y ${PRODUCT.package}@${VERSION} review`));
    assert.match(t, /capture isn't running/);
    assert.match(t, /line from agent-daemon memory about the note/, "relays the hook's line, saved or not");
    assert.match(t, /Don't record or save the note again/);
  }
});

test("bad input is refused", () => {
  assert.throws(() => renderCommandSkill("cursor", "remember", { version: VERSION }), /unknown host/);
  assert.throws(() => renderCommandSkill("codex", "forget", { version: VERSION }), /unknown command/);
  assert.throws(() => renderCommandSkill("codex", "remember", {}), /version/);
});
