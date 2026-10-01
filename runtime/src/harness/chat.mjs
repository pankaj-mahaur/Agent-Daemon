// `ad chat` — interactive agent session on the Codex engine (zero-dep:
// readline + ANSI).
//
// The session logic (createChatSession) is terminal-free so it can be tested:
// it takes lines, an `ask` function for approval prompts, and output sinks.
// cmdChat wires it to readline:
//   - approvals are asked one at a time (a second request waits its turn;
//     readline silently drops a question asked while one is pending)
//   - Ctrl+C at an approval prompt declines it; during a turn it interrupts;
//     when idle it exits
//   - piped stdin (`ad chat < script.txt`) is a script: lines run in order,
//     a queued line answers the next approval, EOF waits for the queue to
//     finish and declines any later approval

import { createInterface } from "node:readline";
import { DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX } from "../engine/index.mjs";
import { describeItem } from "./run.mjs";
import { startHarnessEngine } from "./start.mjs";

const useColor = (stream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const paint = (on, code, s) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
const COMPACT_TIMEOUT_MS = 5 * 60_000;
const LIST_SOURCES = ["cli", "vscode", "exec", "appServer"];

export const HELP_TEXT = `Commands:
  /help               this help
  /new                start a fresh thread
  /threads            list recent threads for this folder
  /resume <id>        continue an earlier thread
  /model <name>       use a different model from the next turn on (/model alone: back to the default)
  /goal <objective>   set a durable goal for this thread (/goal clear to remove)
  /compact            summarize the thread to free context
  /status             login, model, folder, thread
  /exit               quit (Ctrl+C interrupts a running turn)
`;

export function parseCommand(line) {
  const m = /^\/(\S+)\s*(.*)$/.exec(line.trim());
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

// y / a / n → approval words understood by engine/codex/approvals.mjs
export function parseApprovalAnswer(answer) {
  const a = String(answer ?? "").trim().toLowerCase();
  if (a === "y" || a === "yes") return "accept";
  if (a === "a" || a === "always") return "acceptForSession";
  return "decline";
}

export function approvalQuestion(req, fileChanges = new Map()) {
  const p = req.params ?? {};
  const why = p.reason ? `\n  reason: ${p.reason}` : "";
  if (req.kind === "command") {
    const cmd = Array.isArray(p.command) ? p.command.join(" ") : p.command;
    return `Run command?\n  $ ${cmd}${p.cwd ? `\n  in ${p.cwd}` : ""}${why}\n[y]es / [a]lways this session / [n]o: `;
  }
  if (req.kind === "fileChange") {
    const changes = fileChanges.get(p.itemId)?.changes ?? [];
    const list = changes.length ? changes.map((c) => `  ${c.kind?.type ?? c.kind ?? "edit"} ${c.path}`).join("\n") : "  (files not listed)";
    return `Apply file changes?\n${list}${p.grantRoot ? `\n  grants write access to ${p.grantRoot}` : ""}${why}\n[y]es / [a]lways this session / [n]o: `;
  }
  return `Grant extra permissions?\n  ${JSON.stringify(p.permissions ?? {})}${why}\n[y]es / [a]lways this session / [n]o: `;
}

// Serialize approval prompts: each ask() waits for the previous one.
export function serializedAsk(askOnce) {
  let chain = Promise.resolve();
  return (q) => {
    const p = chain.then(() => askOnce(q));
    chain = p.catch(() => {});
    return p;
  };
}

export function createChatSession({ engine, cwd, out, err, ask, model, sandbox }) {
  const color = { out: useColor(out), err: useColor(err) };
  const state = { threadId: null, model, defaultModel: null, turn: null, fileChanges: new Map(), lastStreamed: null };

  engine.onApproval = async (req) => parseApprovalAnswer(await ask(approvalQuestion(req, state.fileChanges)));
  engine.on("itemStarted", ({ item }) => {
    if (item.type === "fileChange") state.fileChanges.set(item.id, item);
  });

  const ensureThread = async () => {
    if (!state.threadId) {
      const t = await engine.startThread({ cwd, model: state.model, sandbox });
      state.threadId = t.threadId;
      state.defaultModel ??= t.model;
    }
    return state.threadId;
  };

  // Separate consecutive agent messages (commentary, then the answer).
  const beginMessage = (itemId) => {
    if (state.lastStreamed && state.lastStreamed !== itemId) out.write("\n\n");
    state.lastStreamed = itemId;
  };

  function onEvent(evt) {
    if (evt.type === "turnStarted" && state.turn) state.turn.turnId = evt.turnId;
    else if (evt.type === "delta") {
      beginMessage(evt.itemId);
      state.turn?.streamed.add(evt.itemId);
      out.write(evt.text);
    } else if (evt.type === "item" && evt.item?.type === "agentMessage" && !state.turn?.streamed.has(evt.item.id)) {
      // Some messages arrive whole, without deltas — print those too.
      beginMessage(evt.item.id);
      out.write(evt.item.text ?? "");
    } else if (evt.type === "itemStarted") {
      const line = describeItem(evt.item);
      if (line) err.write(`\n${paint(color.err, "2", line)}\n`);
    } else if (evt.type === "error") err.write(`\n${paint(color.err, "33", `[${evt.willRetry ? "retrying" : "error"}] ${evt.message}`)}\n`);
  }

  async function runTurn(text) {
    const threadId = await ensureThread();
    state.turn = { threadId, turnId: null, streamed: new Set() };
    state.lastStreamed = null;
    // No timeout: a chat turn may legitimately run long, and time spent at
    // an approval prompt must not count against it. Ctrl+C interrupts.
    const turn = engine.turn({ threadId, text, onEvent, model: state.model, timeoutMs: 0 });
    try {
      const r = await turn;
      out.write("\n");
      if (r.status !== "completed") err.write(paint(color.err, "33", `[turn ${r.status}${r.error?.message ? `: ${r.error.message}` : ""}]`) + "\n");
      return r;
    } finally {
      state.turn = null;
      state.fileChanges.clear();
    }
  }

  // Ctrl+C: interrupt a running turn; returns false when idle (caller exits).
  async function interrupt() {
    if (!state.turn) return false;
    const { threadId, turnId } = state.turn;
    if (!turnId) {
      err.write("[turn is still starting — press Ctrl+C again in a moment]\n");
      return true;
    }
    await engine.interrupt(threadId, turnId).catch((e) => err.write(`[interrupt failed: ${e.message}]\n`));
    return true;
  }

  async function command({ cmd, arg }) {
    switch (cmd) {
      case "help":
        out.write(HELP_TEXT);
        return {};
      case "exit":
      case "quit":
        return { exit: true };
      case "new":
        state.threadId = null;
        out.write("new thread\n");
        return {};
      case "threads": {
        const threads = await engine.listThreads({ cwd, limit: 15, sourceKinds: LIST_SOURCES });
        if (!threads.length) out.write("no threads yet\n");
        for (const t of threads) out.write(`${t.id}  ${String(t.name ?? t.preview ?? "").replace(/\s+/g, " ").slice(0, 70)}\n`);
        return {};
      }
      case "resume": {
        if (!arg) {
          err.write("usage: /resume <thread id>   (see /threads)\n");
          return {};
        }
        // Same safety settings as a new thread, whatever the old one used.
        const t = await engine.resumeThread(arg, { cwd, sandbox: sandbox ?? DEFAULT_SANDBOX, approvalPolicy: DEFAULT_APPROVAL_POLICY });
        state.threadId = t.threadId;
        state.defaultModel ??= t.model;
        out.write(`resumed ${state.threadId}\n`);
        return {};
      }
      case "model":
        // turn/start's model sticks "for this turn and subsequent turns",
        // so resetting means sending the default explicitly.
        state.model = arg || state.defaultModel || undefined;
        out.write(`model: ${state.model ?? "(default)"}\n`);
        return {};
      case "goal": {
        const threadId = await ensureThread();
        if (arg === "clear") {
          await engine.clearGoal(threadId);
          out.write("goal cleared\n");
        } else if (arg) {
          const goal = await engine.setGoal(threadId, arg);
          out.write(`goal set: ${goal?.objective ?? arg}\n`);
        } else err.write("usage: /goal <objective> | /goal clear\n");
        return {};
      }
      case "compact": {
        if (!state.threadId) {
          err.write("nothing to compact yet\n");
          return {};
        }
        const threadId = state.threadId;
        const done = engine.waitForNotification("thread/compacted", (p) => p.threadId === threadId, { timeoutMs: COMPACT_TIMEOUT_MS });
        done.catch(() => {}); // awaited below
        await engine.compactThread(threadId);
        out.write("compacting…\n");
        await done;
        out.write("compacted\n");
        return {};
      }
      case "status": {
        const acct = await engine.account();
        const a = acct.account;
        out.write(`login:  ${a ? (a.type === "chatgpt" ? `ChatGPT ${a.planType ?? ""}` : a.type) : acct.requiresOpenaiAuth ? "not logged in" : "provider key"}\n`);
        out.write(`model:  ${state.model ?? state.defaultModel ?? "(default)"}\nfolder: ${cwd}\nthread: ${state.threadId ?? "(none yet)"}\n`);
        return {};
      }
      default:
        err.write(`unknown command /${cmd} — /help lists them\n`);
        return {};
    }
  }

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return {};
    const c = parseCommand(text);
    try {
      if (c) return await command(c);
      await runTurn(text);
    } catch (e) {
      err.write(`${paint(color.err, "31", `error: ${e.message}`)}\n`);
    }
    return {};
  }

  return { state, handleLine, interrupt };
}

export async function cmdChat(opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;
  const cwd = opts.cwd ?? process.cwd();
  const interactive = Boolean(stdin.isTTY);
  let engine;
  let rl;
  try {
    const started = await startHarnessEngine({ cwd, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, platform: opts.platform, err });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;

    rl = createInterface({ input: stdin, output: out, terminal: interactive });
    const queue = [];
    let inputEnded = false;
    let pending = null; // { resolve, abort } for the approval being asked

    // One approval prompt. Script mode: answered by the next queued line.
    const askOnce = (question) =>
      new Promise((resolve) => {
        const q = `\n${question}`; // the prompt may interrupt streamed text mid-line
        if (inputEnded && interactive) {
          // Ctrl+D/Ctrl+Z closed input: rl.question would throw. Decline.
          out.write(`${q}(input closed — declined)\n`);
          return resolve("");
        }
        if (!interactive) {
          out.write(q);
          const line = queue.shift();
          if (line !== undefined || inputEnded) {
            out.write(`${line ?? ""}\n`);
            return resolve(line ?? "");
          }
          pending = { resolve: (a) => ((pending = null), resolve(a)), abort: () => ((pending = null), resolve("")) };
          return;
        }
        const ac = new AbortController();
        pending = { abort: () => (ac.abort(), (pending = null), out.write("\n"), resolve("")) };
        rl.question(q, { signal: ac.signal }, (a) => ((pending = null), resolve(a)));
      });
    const session = createChatSession({ engine, cwd, out, err, ask: serializedAsk(askOnce), model: opts.model, sandbox: opts.sandbox });
    if (opts.resume) await session.handleLine(`/resume ${opts.resume}`);

    out.write(`Agent Daemon chat — ${cwd}\nType a request, /help for commands, Ctrl+C to interrupt.\n`);
    return await new Promise((resolve) => {
      let busy = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve(0);
      };
      rl.setPrompt("› ");
      const next = async () => {
        if (busy || finished) return;
        const line = queue.shift();
        if (line === undefined) {
          if (inputEnded) return finish();
          return rl.prompt();
        }
        busy = true;
        const r = await session.handleLine(line);
        busy = false;
        if (r.exit) return finish();
        next();
      };
      rl.on("line", (line) => {
        if (pending?.resolve) return pending.resolve(line); // script mode answer
        queue.push(line);
        next();
      });
      rl.on("SIGINT", async () => {
        if (pending) return pending.abort(); // declines the approval
        if (!(await session.interrupt())) finish();
        else err.write("\n[interrupting…]\n");
      });
      rl.on("close", () => {
        inputEnded = true;
        pending?.abort();
        if (!busy) next();
      });
      rl.prompt();
    });
  } catch (e) {
    err.write(`ad chat: ${e.message}\n`);
    return 1;
  } finally {
    rl?.close();
    await engine?.close();
  }
}
