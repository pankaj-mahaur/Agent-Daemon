// The FC3 live script (docs/manual-test.md, section 6), automated: the REAL
// `ad tui` in a real pseudo-terminal (ConPTY on Windows, as Windows Terminal
// uses), the REAL pinned Codex, and a mock model (testkit/mock-responses.mjs).
// The screen is xterm.js (headless), which also answers the TUI's queries.
//
// Opt-in: AD_REAL_ENGINE=1. Everything runs in throwaway folders: a fake
// HOME / USERPROFILE (so ad's memory, state and locks are temp ones), a temp
// CODEX_HOME (AD_CODEX_HOME) with only the mock provider, and a scratch git
// repo as the working folder. Never the user's ~/.codex or ~/.agent-daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import xtermHeadless from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import { defaultScript, ev, lastUserText, startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";
import { resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { MANAGED_MARKER } from "../src/engine/codex/home.mjs";

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const wanted = process.env.AD_REAL_ENGINE === "1";
const skip = !wanted ? "set AD_REAL_ENGINE=1 to run ad tui on the real Codex binary" : resolveCodexCommand({}).source !== "pinned" ? "the pinned Codex binary isn't installed" : false;
const STEP_MS = 90_000; // a first Codex start can be slow while antivirus scans the binary

async function removeWithRetry(dir) {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// The scratch world: user home, Codex home, a git project.
function world(mockUrl) {
  const root = mkdtempSync(join(tmpdir(), "ad-live-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeMockCodexHome(codexHome, { url: mockUrl });
  // Already set up: the no-admin Windows sandbox, as `ad` would configure it.
  writeFileSync(join(codexHome, "config.toml"), `${readFileSync(join(codexHome, "config.toml"), "utf8")}\n[windows]\nsandbox = "unelevated"\n`);
  // ad-managed, as its own home is: ad writes its hooks, memory server and skills into it.
  writeFileSync(join(codexHome, MANAGED_MARKER), "");
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a + b;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_CODEX_HOME: codexHome, AD_TUI: "1" };
  for (const k of Object.keys(env)) if (/^CODEX_/.test(k) || k === "AD_CODEX_BIN") delete env[k];
  delete env.CI; // the TUI is interactive here
  return { root, home, codexHome, cwd, env, git };
}

// Every pty started, so a test can close them all (an open ConPTY keeps node alive).
const launched = [];

// `ad tui` in a pseudo-terminal, shown on xterm.js.
async function launch(w, args = [], { cols = 100, rows = 30 } = {}) {
  const pty = (await import("@lydell/node-pty")).default ?? (await import("@lydell/node-pty"));
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const child = pty.spawn(process.execPath, [CLI, "tui", ...args], { name: "xterm-256color", cols, rows, cwd: w.cwd, env: w.env });
  let exited = null;
  const exit = new Promise((resolve) => child.onExit((e) => resolve((exited = e))));
  let raw = "";
  child.onData((d) => {
    raw += d;
    term.write(d);
  });
  term.onData((d) => exited || child.write(d)); // the terminal's answers (cursor position, …)
  const text = () => {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n");
  };
  const screen = () => {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return out.join("\n");
  };
  const until = async (pred, what, ms = STEP_MS) => {
    const end = Date.now() + ms;
    for (;;) {
      await new Promise((r) => term.write("", r));
      const t = text();
      if (typeof pred === "function" ? pred(t) : pred.test(t)) return t;
      if (exited && !(typeof pred === "function")) throw new Error(`ad tui exited (${JSON.stringify(exited)}) waiting for ${what}\n--- screen ---\n${t.slice(-3000)}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- screen ---\n${t.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const type = (s) => child.write(s);
  const count = (re, s = text()) => (s.match(re) ?? []).length;
  // Idle: the footer offers shortcuts (a running turn offers steer instead).
  const idle = () => /\? shortcuts/.test(screen()) && !/esc to interrupt/.test(screen());
  const kill = () => {
    try {
      child.kill();
    } catch {
      // gone already
    }
    term.dispose();
  };
  launched.push(kill);
  return { term, child, exit, text, screen, until, type, count, idle, kill, raw: () => raw, get exited() { return exited; } };
}

// Starts ad tui and answers the first-run trust question; resolves at the composer.
async function start(w, args) {
  const t = await launch(w, args);
  await t.until(/Do you trust|>_ Agent Daemon/, "the trust question or the header");
  if (/Do you trust/.test(t.text())) t.type("\r");
  await t.until(/>_ Agent Daemon[\s\S]*\? for shortcuts/, "the header card and the composer");
  return t;
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// The default mock script, plus answers for a steer and a queued prompt.
function liveScript(body) {
  const text = lastUserText(body);
  const input = Array.isArray(body?.input) ? body.input : [];
  // A tool's result after the prompt (Codex may add items after it, e.g. once a command was approved).
  const lastUser = input.findLastIndex((i) => i?.type === "message" && i.role === "user");
  const output = input.slice(lastUser + 1).findLast((i) => i?.type === "function_call_output");  if (output) return [ev.created(), ev.message(`done after ${output.call_id}`), ev.completed()];
  {
    if (text.includes("STEERED")) return [ev.created(), ev.message("steer received"), ev.completed()];
    if (text.includes("QUEUED")) return [ev.created(), ev.message("queue ran"), ev.completed()];
  }
  return defaultScript(body);
}

test("FC3 live script: ad tui on the real Codex binary, end to end", { skip, timeout: 15 * 60_000 }, async () => {
  const mock = await startMockResponses({ script: liveScript });
  const w = world(mock.url);
  let t;
  // A patch turn in Auto. Where Codex's sandbox can't run the edit (GitHub's
  // Windows runners), Codex asks to retry without it: that's approved too.
  // The first sandboxed action in a fresh Codex home sets up the Windows sandbox (~35 s, once).
  const patchTurn = async (prompt, what) => {
    const done = () => t.count(/done after call-patch/g);
    const retries = () => t.count(/retry without sandbox\?/g);
    const [n0, r0] = [done(), retries()];
    t.type(`${prompt}\r`);
    // Up to 3 min: the sandbox setup takes longer on a busy machine.
    await t.until(() => done() > n0 || (retries() > r0 && /No, and stop/.test(t.screen())), what, 180_000);
    if (done() === n0) {
      await settle(600);
      t.type("y");
      await t.until(() => done() > n0, `${what}, outside the sandbox`);
    }
    await t.until(() => t.idle(), `${what}: its end`);
  };
  try {
    // 1. First run: trust, then the header card.
    t = await start(w);
    const head = t.text();
    assert.match(head, /on Codex 0\.\d+\.\d+ \(tested\)/);
    assert.match(head, /directory: .*git: (main|master)/);
    assert.match(head, /sandbox: +workspace-write/);

    // 2. Ask: a streamed answer, "Worked for".
    t.type("PING please\r");
    await t.until(/pong/, "the streamed answer");
    await t.until(/Worked for/, "the turn summary");

    // 3. Exec approval: the full command in a box. `y` right as it opens does
    // nothing (the 400 ms guard); Esc is "No, and stop": the turn ends.
    let n = t.count(/Run command\?/g);
    t.type("ESCALATE please\r");
    await t.until((s) => t.count(/Run command\?/g, s) > n, "the exec approval");
    await t.until(/1\. Yes +\(y\)/, "the approval choices");
    t.type("y");
    await settle(150);
    assert.match(t.screen(), /1\. Yes +\(y\)/, "y within 400 ms of opening does nothing");
    t.type("\x1b");
    await t.until(() => !/No, and stop/.test(t.screen()) && t.idle(), "the modal closed and the turn stopped");
    let ran = t.count(/done after call-escalate/g);
    assert.equal(ran, 0, "the declined command's turn didn't carry on");
    // Again, approved once the guard has passed: it runs and the agent carries on.
    n = t.count(/Run command\?/g);
    t.type("ESCALATE again\r");
    await t.until((s) => t.count(/Run command\?/g, s) > n, "the second exec approval");
    await settle(600);
    t.type("y");
    await t.until((s) => t.count(/done after call-escalate/g, s) > ran, "the agent carrying on after the approval");
    await t.until(() => t.idle(), "the turn's end");

    // 4a. A patch in Auto (workspace-write) applies without asking; /undo puts it back.
    await patchTurn("PATCH please", "the patch turn");
    await t.until(() => existsSync(join(w.cwd, "hello.txt")), "hello.txt written");
    t.type("/undo\r");
    await t.until(/Undid the last turn: 1 file put back/, "the undo");
    assert.ok(!existsSync(join(w.cwd, "hello.txt")), "the agent's file is gone again");
    await t.until(/PATCH please\s*$/m, "the prompt back in the composer");
    t.type("\x7f".repeat(20));

    // 4b. Read only: the patch asks first; `y` approves and the file changes.
    t.type("/permissions\r");
    await t.until(/Read only/, "the permissions picker");
    t.type("\r"); // Read only is first
    await settle();
    n = t.count(/done after call-patch/g);
    const asks = t.count(/Apply file changes\?/g);
    t.type("PATCH again\r");
    await t.until((s) => t.count(/Apply file changes\?/g, s) > asks && /4\. No, and stop/.test(t.screen()), "the patch approval");
    assert.match(t.screen(), /hello\.txt\s+\(\+1 -0\)[\s\S]*\+ hello from the mock/, "the diff in the box");
    await settle(600);
    t.type("y");
    await t.until((s) => t.count(/done after call-patch/g, s) > n, "the approved patch turn");
    await t.until(() => t.idle(), "the turn's end");
    assert.equal(readFileSync(join(w.cwd, "hello.txt"), "utf8").trim(), "hello from the mock");
    t.type("/permissions\r");
    await t.until(/Auto/, "the permissions picker again");
    t.type("\x1b[B\r"); // Auto
    await settle();

    // 5. Steer: text sent while a turn runs joins it.
    t.type("HOLD a long answer\r");
    await mock.held();
    await t.until(/enter steer/, "the steer hint");
    t.type("STEERED make it short\r");
    await settle(500);
    mock.release();
    await t.until(/steer received/, "the answer following the steer");
    await t.until(() => t.idle(), "the turn's end");

    // 6. Queue: Tab while a turn runs queues it; it runs after.
    await t.until(() => t.idle(), "idle again");
    t.type("HOLD another\r");
    await mock.held();
    t.type("QUEUED next\t");
    await t.until(/queued: QUEUED next/, "the queued row");
    mock.release();
    await t.until(/queue ran/, "the queued prompt's answer");
    await t.until(() => t.idle(), "the turn's end");

    // 7. Interrupt: Esc on a running turn.
    const hangups = mock.hangups;
    t.type("HOLD third\r");
    await mock.held();
    await settle(300);
    t.type("\x1b");
    await t.until(/Interrupting/, "Interrupting…");
    await t.until(() => mock.hangups > hangups, "Codex hanging up the model request");
    await t.until(() => t.idle(), "idle after the interrupt");

    // Esc Esc while idle: the rewind picker; Esc closes it.
    await settle(300);
    t.type("\x1b");
    await t.until(/Esc again to rewind/, "the rewind hint");
    t.type("\x1b");
    await t.until(/Rewind to/, "the rewind picker");
    t.type("\x1b");
    await settle();

    // /undo refuses a file the user changed after the turn; force puts it back.
    rmSync(join(w.cwd, "hello.txt"));
    await patchTurn("PATCH once more", "the third patch");
    writeFileSync(join(w.cwd, "hello.txt"), "the user's own words\n");
    t.type("/undo\r");
    await t.until(/Not undone: hello\.txt \(changed since the agent's edit\)/, "the refusal");
    assert.equal(readFileSync(join(w.cwd, "hello.txt"), "utf8"), "the user's own words\n");
    const undone = t.count(/Undid the last turn: 1 file put back/g);
    t.type("/undo force\r");
    await t.until((s) => t.count(/Undid the last turn: 1 file put back/g, s) > undone, "the forced undo");
    assert.ok(!existsSync(join(w.cwd, "hello.txt")));
    await settle();
    t.type("\x7f".repeat(30));

    // Ctrl+T: the transcript in a pager; Esc closes it.
    t.type("\x14");
    await t.until(() => /Transcript \d+.\d+ of \d+/.test(t.screen()), "the pager");
    t.type("\x1b");
    await t.until(() => !/Transcript \d+.\d+ of \d+/.test(t.screen()) && t.idle(), "the pager closed");

    // Narrower, then wider: no ghost copies of the footer on screen.
    t.child.resize(70, 30);
    t.term.resize(70, 30);
    await settle(800);
    t.child.resize(100, 30);
    t.term.resize(100, 30);
    await settle(800);
    assert.equal((t.screen().match(/\? shortcuts/g) ?? []).length, 1, `one footer after resizing:\n${t.screen()}`);

    // 8. /codex and back: the stock Codex UI on the same conversation.
    t.type("/codex\r");
    await t.until(/OpenAI Codex/, "the stock Codex UI", 120_000);
    await settle(3000);
    // Ctrl+C until the stock UI is gone (as a person would).
    for (let i = 0; i < 4 && !/Back from the stock Codex UI/.test(t.text()); i++) {
      t.type("\x03");
      await settle(1500);
      if (t.exited) assert.fail(`ad exited (${JSON.stringify(t.exited)}) after ${i + 1} Ctrl+C`);
    }
    await t.until(/Back from the stock Codex UI \(exit \d+\)/, "back in ad", 60_000);
    await t.until(() => t.idle(), "ad's composer again");

    // 9. Quit: Ctrl+C twice on an empty prompt.
    t.type("\x03");
    await t.until(/Ctrl\+C again/, "the quit arming hint");
    t.type("\x03");
    const e = await t.exit;
    assert.equal(e.exitCode, 0, t.text().slice(-2000));
    const thread = /ad tui --resume (\S+)/.exec(t.text())?.[1];
    assert.ok(thread, "the resume hint");

    // 10. ad tui --last: the same conversation, and it carries on.
    t = await launch(w, ["--last"]);
    await t.until(/queue ran/, "the earlier turns, resumed");
    await t.until(() => t.idle(), "the composer");
    n = t.count(/pong/g);
    t.type("PING after resume\r");
    await t.until((s) => t.count(/pong/g, s) > n, "an answer in the resumed conversation");
    t.type("\x03");
    await settle(200);
    t.type("\x03");
    const e2 = await t.exit;
    assert.equal(e2.exitCode, 0);
    assert.match(t.text(), new RegExp(`ad tui --resume ${thread.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the same thread");
  } catch (err) {
    err.message += `\n--- model requests ---\n${mock.requests.map((r) => JSON.stringify(r)).join("\n")}`;
    throw err;
  } finally {
    for (const k of launched.splice(0)) k();
    await mock.close();
    await removeWithRetry(w.root);
  }
});

test("FC4 live: ad's own features in ad tui on the real Codex binary", { skip, timeout: 10 * 60_000 }, async () => {
  const mock = await startMockResponses({ script: liveScript });
  const w = world(mock.url);
  let t;
  const run = async (cmd, expect, what) => {
    t.type(`${cmd}\r`);
    await t.until(expect, what);
    await t.until(() => t.idle(), `idle after ${cmd}`);
  };
  try {
    t = await start(w);
    await run("/memory", /ad memory: 0 learnings/, "the memory summary");

    // /private: the model gets the wrapper; the transcript shows the prompt as typed.
    await run("/private", /Private: your prompts are wrapped/, "private on");
    await run("PING privately", /pong/, "the private turn");
    assert.ok(mock.requests.some((r) => r.text === "<private>PING privately</private>"), "the model got the wrapped prompt");
    assert.match(t.text(), /› PING privately {2}\(private\)/);
    await run("/private", /Private is off/, "private off");

    // A correction: captured by ad's hooks during the turn, shown right after it.
    await run("actually we use pnpm, not npm", /Learned: pnpm, not npm/, "the learned row");
    await run("/memory recent", /\[correction\] pnpm, not npm/, "the captured learning");
    await run("/schedule", /No scheduled jobs/, "schedules");
    await run("/team", /No teams/, "teams");
    await run("/proposals", /No skill proposals waiting/, "proposals");

    // /loop: a real `ad loop` in the background, a row per iteration; /loop stop ends it.
    t.type('/loop "PING loop objective"\r');
    await t.until(/Loop: started/, "the loop start");
    await t.until(/Loop: iteration 1 completed/, "the first iteration", 120_000);
    t.type("/loop stop\r");
    await t.until(/Loop: finished after \d+ iterations?/, "the loop's end", 120_000);
    assert.ok(mock.requests.some((r) => /Objective:\s*PING loop objective/.test(r.text)), "the loop prompted the model");

    t.type("\x03");
    await settle(200);
    t.type("\x03");
    assert.equal((await t.exit).exitCode, 0);
  } catch (err) {
    err.message += `\n--- model requests ---\n${mock.requests.map((r) => JSON.stringify(r.text)).join("\n")}`;
    throw err;
  } finally {
    for (const k of launched.splice(0)) k();
    await mock.close();
    await removeWithRetry(w.root);
  }
});
