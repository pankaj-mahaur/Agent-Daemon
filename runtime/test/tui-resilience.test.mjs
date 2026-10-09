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
import { parseSlashCommands, parseSlashMeta } from "../scripts/codex-slash.mjs";
import { NOT_IN_AD, SLASH_COMMANDS, notInAd, slashCollisions } from "../src/tui/app.mjs";
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
      for (const prompt of ["hello", "fail-turn", "early-complete", "subagent", "user-input", "elicitation", "edit-file", "two-approvals", "ask-permission"]) {
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

test("every Codex command has a decision in ad: it runs, or ad says why not (never sent to the model)", () => {
  const mirrored = new Set(SLASH_COMMANDS.filter((c) => c.source === "codex").map((c) => c.name));
  for (const c of CODEX_SLASH.commands) {
    const decided = mirrored.has(c.name) + (c.name in NOT_IN_AD);
    assert.equal(decided, 1, `/${c.name}: ${decided ? "both run and answered" : "no decision (run it, or add it to NOT_IN_AD)"}`);
  }
  const codexNames = new Set(CODEX_SLASH.commands.map((c) => c.name));
  for (const k of Object.keys(NOT_IN_AD)) assert.ok(codexNames.has(k), `NOT_IN_AD has /${k}, which isn't a Codex command`);
  for (const c of CODEX_SLASH.commands) {
    for (const n of [c.name, ...c.aliases]) {
      const said = notInAd(n);
      if (mirrored.has(c.name)) assert.equal(said, null, `/${n} runs in ad`);
      else assert.ok(said && said.length > 10, `/${n} has an answer`);
    }
  }
  assert.equal(notInAd("recap"), "/recap isn't in ad yet. /codex opens the stock Codex UI on this conversation.");
  assert.equal(notInAd("plan"), null, "ad runs /plan (Part 4)");
  assert.equal(notInAd("clean"), null, "ad runs /stop, and its alias /clean (Part 5)");
  assert.equal(notInAd("pet"), notInAd("pets"), "an alias answers as its command does");
  assert.equal(notInAd("btw"), null, "ad runs /side, and its alias /btw (Part 7)");
  assert.equal(notInAd("remember"), null, "ad's own commands aren't Codex's");
});

test("parseSlashMeta: descriptions, inline args, busy rules, side allowlist, visibility, popup", () => {
  const rs = `pub enum SlashCommand {
    Model,
    #[strum(to_string = "pwd", serialize = "cwd")]
    Pwd,
    Side,
    Btw,
    App,
    Rollout,
    Quit,
    DebugConfig,
    Apps,
    Bb, Cc,
}
impl SlashCommand {
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::Model => "choose a model",
            SlashCommand::Pwd => {
                "show the \\"current\\" directory"
            }
            SlashCommand::Side | SlashCommand::Btw => "a side chat",
            SlashCommand::App => "desktop",
            SlashCommand::Rollout => "path",
            SlashCommand::Quit => "exit",
            SlashCommand::DebugConfig => "layers",
            SlashCommand::Apps => "apps",
            SlashCommand::Bb | SlashCommand::Cc => "x",
        }
    }
    pub fn supports_inline_args(self) -> bool {
        matches!(self, SlashCommand::Pwd | SlashCommand::Side | SlashCommand::Btw)
    }
    pub fn available_in_side_conversation(self) -> bool {
        matches!(self, SlashCommand::Pwd)
    }
    pub fn available_during_task(self) -> bool {
        match self {
            SlashCommand::Model | SlashCommand::Bb => false,
            SlashCommand::Pwd
            | SlashCommand::Side
            | SlashCommand::Btw => true,
            SlashCommand::App | SlashCommand::Rollout | SlashCommand::Quit | SlashCommand::DebugConfig | SlashCommand::Apps | SlashCommand::Cc => true,
        }
    }
    fn is_visible(self) -> bool {
        match self {
            SlashCommand::App => cfg!(any(target_os = "macos", target_os = "windows")),
            SlashCommand::Rollout => cfg!(debug_assertions),
            _ => true,
        }
    }
}`;
  const popup = `const ALIAS_COMMANDS: &[SlashCommand] = &[SlashCommand::Quit, SlashCommand::Btw];
    .filter_map(|command| match command {
        SlashCommandItem::Builtin(cmd) => (!cmd.command().starts_with("debug")
            && cmd != SlashCommand::Apps)`;
  const many = rs.replace("    Bb, Cc,\n", ["Bb", "Cc", "Dd"].map((v) => `    ${v},\n`).join("")).replace("SlashCommand::Bb | SlashCommand::Cc =>", "SlashCommand::Bb | SlashCommand::Cc | SlashCommand::Dd =>").replace("| SlashCommand::Cc => true", "| SlashCommand::Cc | SlashCommand::Dd => true");
  const meta = Object.fromEntries(parseSlashMeta(many, popup).map((c) => [c.name, c]));
  assert.deepEqual(meta.pwd, { name: "pwd", aliases: ["cwd"], desc: 'show the "current" directory', args: true, duringTask: true, sideAllowed: true, visible: "always", popup: "shown" });
  assert.equal(meta.model.duringTask, false);
  assert.equal(meta.btw.desc, "a side chat");
  assert.equal(meta.btw.popup, "unfiltered");
  assert.equal(meta.quit.popup, "unfiltered");
  assert.equal(meta["debug-config"].popup, "hidden");
  assert.equal(meta.apps.popup, "hidden");
  assert.equal(meta.app.visible, "os:macos,windows");
  assert.equal(meta.rollout.visible, "debug");
  // Shapes the parser can't read fail loudly, so the upgrade PR can't silently drop a rule.
  assert.throws(() => parseSlashMeta(many.replace("SlashCommand::Model | SlashCommand::Bb => false,", "SlashCommand::Bb => false,"), popup), /available_during_task doesn't cover SlashCommand::Model/);
  assert.throws(() => parseSlashMeta(many.replace('cfg!(debug_assertions)', 'feature_on()'), popup), /unknown expression/);
  assert.throws(() => parseSlashMeta(many, popup.replace("ALIAS_COMMANDS", "ALIASES")), /ALIAS_COMMANDS not found/);
  // The committed list carries the metadata for every command.
  assert.ok(CODEX_SLASH.commands.length >= 60 && CODEX_SLASH.commands.every((c) => typeof c.duringTask === "boolean" && c.popup));
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
  // The upgrade bot leaves the note to a human (and says so in its PR); everywhere else it must exist.
  if (process.env.AD_COMPAT_NOTE_PENDING !== "1") assert.ok(c.whatChanged[pinned], `write compat.json's "what changed" for ${pinned}`);
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

test("docs/codex-parity.md lists every Codex command, and says 'yes' exactly for the ones ad runs", () => {
  const doc = readFileSync(new URL("../../docs/codex-parity.md", import.meta.url), "utf8");
  const rows = new Map();
  for (const line of doc.split(/\r?\n/)) {
    const m = /^\| (`\/[^|]+) \| (yes|no|not yet) \|/.exec(line);
    if (m) for (const n of m[1].match(/\/[\w-]+/g)) rows.set(n.slice(1), m[2]);
  }
  const runs = new Set(SLASH_COMMANDS.filter((c) => c.source === "codex").map((c) => c.name));
  for (const c of CODEX_SLASH.commands) {
    for (const n of [c.name, ...c.aliases]) assert.ok(rows.has(n), `docs/codex-parity.md has no row for /${n}`);
    assert.equal(rows.get(c.name) === "yes", runs.has(c.name), `/${c.name}: the doc says "${rows.get(c.name)}"`);
  }
});
