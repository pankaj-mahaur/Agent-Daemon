// Resilience (plan Part 7): the fake server speaks the pinned protocol; a
// synthetic newer Codex doesn't break ad; slash names don't collide with
// Codex's; compat.json tracks the pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { codexCompat } from "../src/engine/codex/doctor.mjs";
import { parseSlashCommands } from "../scripts/codex-slash.mjs";
import { SLASH_COMMANDS, slashCollisions } from "../src/tui/app.mjs";
import { renderCell } from "../src/tui/view/cells.mjs";
import { checkMessage } from "../testkit/protocol-check.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const CODEX_SLASH = JSON.parse(readFileSync(new URL("../src/tui/codex-slash.json", import.meta.url), "utf8"));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const until = async (pred, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function withEngine(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-resil-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks") });
  try {
    await fn({ engine, session });
  } finally {
    session.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("the fake server only sends what the pinned Codex could (required fields, enums, variants)", async () => {
  await withEngine(async ({ engine, session }) => {
    const problems = [];
    engine.server.on("notification", (m) => problems.push(...checkMessage(m)));
    engine.server.on("server-request", (m) => problems.push(...checkMessage(m, { kind: "request" })));
    const answer = () => {
      for (const r of session.state.requests) {
        const req = r.request;
        session.resolve(req.id, req.kind === "user-input" ? { q: ["A"] } : req.kind === "elicitation" ? { action: "decline" } : req.options[0]);
      }
    };
    const timer = setInterval(answer, 20);
    try {
      for (const prompt of ["hello", "fail-turn", "early-complete", "subagent", "user-input", "elicitation", "patch"]) {
        await session.submit(prompt).done;
      }
      const hang = session.submit("hang");
      await hang.accepted;
      await session.interrupt();
      await hang.done;
    } finally {
      clearInterval(timer);
    }
    assert.deepEqual([...new Set(problems)], []);
  });
});

test("a synthetic newer Codex: unknown methods, items, fields, enum values and requests don't break ad", async () => {
  await withEngine(async ({ engine, session }) => {
    const r = session.submit("future");
    const done = await r.done;
    assert.equal(done.status, "completed");
    const items = [...session.state.items.values()];
    const agent = items.filter((i) => i.kind === "agentMessage").map((i) => i.text).join(" ");
    assert.match(agent, /from the future/);
    assert.match(agent, /future\[-32601\]/, "the unknown request was refused, not left hanging");
    const holo = items.find((i) => i.id === "holo-1");
    assert.equal(holo.kind, "unknown");
    const shown = renderCell(holo, { width: 60 }).map((l) => l.map((s) => s.text).join("")).join("\n");
    assert.match(shown, /not shown: hologramProjection/);
    const cmd = items.find((i) => i.id === "cmd-f");
    assert.ok(renderCell(cmd, { width: 60 }).length > 0, "an unknown status still renders");
    assert.deepEqual(Object.keys(engine.unknownCounts()), ["thread/hologram/updated"]);
    assert.ok(session.state.plan.steps.length === 1);
  });
});

test("slash names: ad's own never collide with Codex's; mirrored ones stay Codex's", () => {
  assert.deepEqual(slashCollisions(SLASH_COMMANDS, CODEX_SLASH.names), []);
  // A Codex release that adds /remember would fail here, in the upgrade PR.
  assert.deepEqual(slashCollisions(SLASH_COMMANDS, [...CODEX_SLASH.names, "remember"]), ["/remember is ad's own but Codex now has it too"]);
  assert.deepEqual(slashCollisions(SLASH_COMMANDS, CODEX_SLASH.names.filter((n) => n !== "diff")), ["/diff mirrors Codex but Codex no longer has it"]);
  assert.equal(CODEX_SLASH.tag, `rust-v${PKG.dependencies["@openai/codex"]}`, "regenerate codex-slash.json for the pinned Codex");
});

test("parseSlashCommands: kebab-case names and strum renames", () => {
  const rs = `pub enum SlashCommand {
    Model,
    DebugConfig,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    #[strum(to_string = "pwd", serialize = "cwd")]
    Pwd,
    // a comment
    Quit, A1, A2, A3, A4, A5, A6,
}`;
  assert.throws(() => parseSlashCommands(rs), /only/);
  const many = rs.replace("Quit, A1, A2, A3, A4, A5, A6,", ["Quit", "Aa", "Bb", "Cc", "Dd", "Ee", "Ff"].join(",\n    ") + ",");
  assert.deepEqual(parseSlashCommands(many).map((c) => c.names), [["model"], ["debug-config"], ["setup-default-sandbox"], ["pwd", "cwd"], ["quit"], ["aa"], ["bb"], ["cc"], ["dd"], ["ee"], ["ff"]]);
});

test("compat.json tracks the pinned Codex and says what changed", () => {
  const c = codexCompat();
  const pinned = PKG.dependencies["@openai/codex"];
  assert.equal(c.pinned, pinned);
  assert.ok(c.tested.includes(pinned));
  assert.ok(c.whatChanged[pinned]);
});

test("the protocol check itself catches missing fields, bad enums, unknown variants and methods", () => {
  assert.deepEqual(checkMessage({ method: "turn/completed", params: { threadId: "t" } }), ["turn/completed: missing required turn"]);
  const bad = checkMessage({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", items: [], status: "paused" } } });
  assert.ok(bad.some((p) => /"paused" is not one of/.test(p)), bad.join("\n"));
  const item = checkMessage({ method: "item/completed", params: { threadId: "t", turnId: "u", completedAtMs: 0, item: { type: "hologram", id: "x" } } });
  assert.ok(item.some((p) => /unknown variant "hologram"/.test(p)), item.join("\n"));
  assert.deepEqual(checkMessage({ method: "thread/hologram/updated", params: {} }), ["thread/hologram/updated: not a notification the pinned Codex sends"]);
  assert.deepEqual(checkMessage({ method: "item/teleport/requestApproval", params: {} }, { kind: "request" }), ["item/teleport/requestApproval: not a request the pinned Codex sends"]);
});
