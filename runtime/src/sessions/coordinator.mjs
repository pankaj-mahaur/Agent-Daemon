// The session coordinator (P4.1): a session's observer events → its ledger and the index.
// One logical session follows the conversation across threads and homes (a switch, a fork,
// a fallback), recording which binding ran each turn and what each tool call did.
//
//   createCoordinator({ cwd, origin, root, homeKey, targetOf, now }) → {
//     observer(ev)     pass to createSession({ observer })
//     markAdTurn()     the next turn is ad's own (a continuation, P4.5): trigger "ad"
//     sessionId()      null until the first prompt (creation is lazy)
//     status()         { sessionId, gen } for /status
//     close()          ends the binding, closes the ledger, marks the session closed
//   }
// homeKey(): the engine home the window runs in ("engine", "a/7q2k"…); targetOf(): the
// window's target { accountId, provider, model, effort, key }.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { targetKey } from "../auth/accounts/target.mjs";
import { openLedger, readLedger, SESSION_TEXTS } from "./ledger.mjs";
import { readIndex, sessionForThread, threadKey, updateIndex } from "./index.mjs";
import { effectOf, innerCommand, settleTurn, toolStatus } from "./effects.mjs";
import { recoverSwitch } from "./switch.mjs";
import { classifyTurnError, engineInfo } from "../providers/errors.mjs";
import { adRoot } from "../ad-root.mjs";
import { ulid } from "../ids.mjs";

// As the screen hides it (app.mjs): a prompt with <private> anywhere, an image after it too.
const PRIVATE = /<private>/;
const DETACH_REASON = { closed: "close", abandoned: "newThread", notResumed: "threadNotResumed" };
const DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel", "answered", "withdrawn"]);

// Only the enum reaches the ledger: a free-text answer never does.
function decisionOf(d) {
  if (DECISIONS.has(d)) return d;
  if (d === "session") return "acceptForSession"; // a permission granted for the session
  if (d === "turn") return "accept";
  return "answered";
}

// A command as the ledger keeps it: the program the shell wrapper runs, its first line only
// (a here-doc's body is a file's contents), long quoted arguments shortened, 200 at most.
function commandSummary(command) {
  const s = innerCommand(command);
  const lines = s.split(/\r?\n/);
  let first = lines[0].replace(/(["'])([^"']{40,})\1/g, (_, q) => `${q}…${q}`);
  if (lines.length > 1) first += " …";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

function summaryOf(item, cwd) {
  if (item.type === "commandExecution") return commandSummary(item.command);
  if (item.type === "fileChange") return (item.changes ?? []).map((c) => `${c.kind?.type ?? c.kind ?? "edit"} ${rel(c.path, cwd)}`).join(", ");
  if (item.type === "mcpToolCall") return `${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
  if (item.type === "dynamicToolCall") return String(item.tool ?? "tool");
  if (item.type === "collabAgentToolCall") return String(item.tool ?? "agent");
  if (item.type === "webSearch") return String(item.query ?? "web search");
  return item.type;
}

// A session's thread events carry normalized items ({ kind, actions }: the engine's events module);
// the effect rules read the engine's names ({ type, commandActions }).
const asRaw = (item) => (item.type ? item : { ...item, type: item.kind, commandActions: item.actions });

// Paths in the project stay relative; others under the home folder become ~/…
function rel(p, cwd) {
  if (typeof p !== "string") return "";
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (cwd && (p === cwd || p.startsWith(cwd + path.sep) || p.startsWith(cwd + "/"))) return path.relative(cwd, p) || ".";
  if (home && p.startsWith(home)) return `~${p.slice(home.length).replace(/\\/g, "/")}`;
  return p;
}

// A window's engine home as the ledger names it: the default home is "engine", others "a/<id>", "api".
export const ledgerHome = (key) => (!key || key === "@default" ? "engine" : key);

// A binding's target: ids only, with P3.4's key.
export function ledgerTarget({ account = null, provider = null, model = null, effort = null } = {}) {
  return { accountId: account?.id ?? null, provider: account?.provider ?? provider ?? null, model: model ?? null, effort: effort ?? null, key: targetKey({ account, model, effort }) };
}

/**
 * ad run / ad loop drive engine.turn without a harness session: the same record, fed from
 * the engine's own thread events. The record never stops the run; its first failure is one
 * warning. → { prompt(text, via), answered(req, decision), stop() }
 */
export function recordEngineThread(coordinator, { engine, threadId, how = "new", warn = () => {} }) {
  let failed = false;
  const feed = (ev) => {
    try {
      const n = coordinator.observer(ev)?.notice;
      if (n) warn(n.message);
    } catch (err) {
      if (failed) return;
      failed = true;
      warn(typeof err?.notice === "string" ? err.notice : `ad couldn't write this session's record (${err?.message ?? err}); the run goes on.`);
    }
  };
  feed({ type: "thread.attached", threadId, how });
  const unsub = engine.subscribe(threadId, feed);
  const onExit = (info) => feed({ type: "engine.exited", code: info?.code ?? null });
  engine.on?.("exit", onExit);
  return {
    prompt(text, via = "submit") {
      if (via === "ad") coordinator.markAdTurn();
      feed({ type: "user.message", clientId: randomUUID(), input: text, via });
    },
    answered(req, decision) {
      const p = req?.params ?? {};
      feed({ type: "request.answered", request: { kind: req?.kind ?? null, itemId: p.itemId ?? null, turnId: p.turnId ?? null, threadId: p.threadId ?? null }, decision });
    },
    // Before the engine is released: its exit then isn't a lost engine.
    async stop() {
      unsub();
      engine.off?.("exit", onExit);
      await coordinator.close().catch((err) => warn(`ad couldn't close this session's record (${err?.message ?? err}).`));
    },
  };
}

// A home a command chose (tests, scripts) keeps out of ad's shared records unless a caller
// names the root too; AD_LEDGER=0 turns the record off.
export const ledgerEnabled = ({ home, adRoot } = {}) => process.env.AD_LEDGER !== "0" && (!home || Boolean(adRoot));

// classify({ error, status, threadId, turnId, startedAt }) → Failure (P4.3): the failed turn's
// class; by default from the engine's error alone (a window adds the gateway's observation).
const engineOnly = ({ error, status }) => classifyTurnError({ error, status, accountKind: "unknown" });

export function createCoordinator({ cwd, origin = "tui", root = adRoot(), homeKey = () => "engine", targetOf = () => null, classify = engineOnly, enabled = process.env.AD_LEDGER !== "0" } = {}) {
  let ledger = null;
  let sessionId = null;
  let lastId = null; // the session this coordinator wrote last (tests, ad run)
  let gen = 0;
  let binding = null; // { gen, home, threadId, target, how }
  let attached = null; // the thread the window is on
  let adoptFrom = null; // an unknown thread a resume opened (adopted at the first prompt)
  let awaitingThread = false; // the session began before its first thread existed
  let pendingUser = 0;
  let adNext = false;
  let goalActive = false;
  let activeRoot = null; // the root turn running now
  let lastRoot = null;
  const former = new Set(); // threads earlier bindings ran on: a turn there is a violation
  const childRoot = new Map(); // child thread → root turn id
  const turnRoot = new Map(); // turn id → root turn id
  const tools = new Map(); // key → { rootTurnId, status, background, turnId, itemId }
  let lastSwitch = null; // { at, reason } of this session's last switch (for /status)
  const turnStarts = new Map(); // root turn id → when it started (the failure window)

  const target = () => targetOf() ?? null;
  const write = (ev) => ledger?.append(ev);
  let off = !enabled; // also after "open in another window": this window records nothing
  let pendingNotice = null;
  // Index changes run one after another (in order), off the session's path; the first
  // failure is one notice (the ledger itself goes on).
  let indexChain = Promise.resolve();
  let indexWarned = false;
  const index = (fn) => {
    indexChain = indexChain
      .then(() => updateIndex(fn, { root }))
      .catch((err) => {
        if (indexWarned) return;
        indexWarned = true;
        pendingNotice ??= { level: "warn", code: "session.index", message: `ad couldn't update its list of sessions (${err?.message ?? err}); this session's own record goes on.` };
      });
    return indexChain;
  };

  function open(id) {
    try {
      const l = openLedger({ sessionId: id, root });
      if (l.repaired) pendingNotice = { level: "info", code: "session.repaired", message: SESSION_TEXTS.REPAIRED(l.repaired) };
      return l;
    } catch (err) {
      if (err?.code !== "SESSION_LEDGER_BUSY") throw err;
      off = true;
      throw Object.assign(err, { notice: `${err.message} This window doesn't record the session.` });
    }
  }

  function startBinding(threadId, how) {
    gen += 1;
    binding = { gen, home: homeKey(), threadId, target: target(), how, ...(gen > 1 ? { fromGen: gen - 1 } : {}) };
    write({ type: "bindingStarted", gen, binding });
    const b = binding;
    const id = sessionId;
    index((ix) => {
      const s = ix.sessions[id];
      if (s) Object.assign(s, { state: "open", gen: b.gen, binding: { home: b.home, threadId: b.threadId, target: b.target?.key ?? null }, updatedAt: new Date().toISOString() });
      ix.threads[threadKey(b.home, b.threadId)] = id;
    });
  }

  function endBinding(reason) {
    if (!binding) return;
    write({ type: "bindingEnded", gen: binding.gen, reason });
    former.add(binding.threadId);
    binding = null;
  }

  // This session ends here (a new conversation comes next, or the window closes).
  function closeCurrent(reason) {
    if (!ledger) return indexChain;
    endBinding(reason);
    const id = sessionId;
    const closing = ledger;
    ledger = null; // also when its close throws: no write goes to a closed record
    sessionId = null;
    gen = 0;
    awaitingThread = false;
    pendingUser = 0;
    adNext = false;
    activeRoot = null;
    lastRoot = null;
    lastSwitch = null;
    for (const m of [former, childRoot, turnRoot, tools]) m.clear();
    const done = index((ix) => {
      if (ix.sessions[id]) Object.assign(ix.sessions[id], { state: "closed", updatedAt: new Date().toISOString() });
    });
    closing.close();
    return done;
  }

  // The last generation in a session's ledger (the index may lag it).
  function lastGen(events) {
    let g = 0;
    for (const e of events) if (e.type === "bindingStarted" || e.type === "bindingEnded") g = Math.max(g, e.gen ?? e.binding?.gen ?? 0);
    return g;
  }

  // Lazy: the session exists from the first prompt. A thread a session already owns
  // continues it; an unknown thread a resume opened is adopted.
  function ensureSession(firstText) {
    if (ledger || off) return Boolean(ledger);
    const known = attached ? sessionForThread(readIndex({ root }), homeKey(), attached) : null;
    if (known) {
      ledger = open(known);
      sessionId = lastId = known;
      const events = readLedger(known, { root });
      gen = lastGen(events);
      // A switch a crash left open says how it ended (P4.2): moved if its binding was written.
      const unfinished = recoverSwitch(events);
      if (unfinished?.abort) write({ type: "switchAborted", reason: unfinished.abort, target: null });
      else if (unfinished?.commit) write({ type: "switchCommitted", recovered: true, gen: unfinished.commit.gen });
      startBinding(attached, "continuation");
      return true;
    }
    const id = `ses_${ulid()}`;
    ledger = open(id);
    sessionId = lastId = id;
    write({ type: "created", cwd, origin: adoptFrom ? "adopted" : origin, ...(adoptFrom ? { adoptedFrom: adoptFrom } : {}) });
    const title = firstText ? String(firstText).replace(/<\/?private>/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : null;
    const now = new Date().toISOString();
    const created = { cwd, createdAt: now, updatedAt: now, title: PRIVATE.test(firstText ?? "") ? null : title, state: "open", gen: 0, binding: null, origin: adoptFrom ? "adopted" : origin };
    index((ix) => {
      ix.sessions[id] = created;
    });
    if (attached) startBinding(attached, adoptFrom ? "adopted" : "new");
    else awaitingThread = true;
    adoptFrom = null;
    return true;
  }

  function onTool(ev, done) {
    const item = asRaw(ev.item);
    const effect = effectOf(item);
    if (!effect) return;
    const turnId = ev.turnId;
    const rootTurnId = turnRoot.get(turnId) ?? turnId;
    const key = `${item.id}@${turnId}`;
    const thread = ev.threadId !== binding?.threadId ? ev.threadId : undefined;
    const background = item.type === "commandExecution" && item.source === "unifiedExecStartup";
    if (!tools.has(key)) {
      const summary = summaryOf(item, cwd);
      tools.set(key, { rootTurnId, status: "running", background, turnId, itemId: item.id, effect, summary });
      const paths = item.type === "fileChange" ? (item.changes ?? []).slice(0, 20).map((c) => rel(c.path, cwd)) : undefined;
      write({ type: "toolIntent", turnId, rootTurnId, ...(thread ? { thread } : {}), itemId: item.id, key, kind: item.type, effect, summary, ...(paths ? { paths } : {}), ...(background ? { background: true } : {}) });
    }
    // A collab call names its child threads: their turns belong to this root turn.
    for (const child of item.receiverThreadIds ?? []) childRoot.set(child, rootTurnId);
    if (!done) return;
    const t = tools.get(key);
    const late = t.status !== "running"; // settled as unknown before its result came
    t.status = toolStatus(item);
    write({ type: "toolResult", turnId, rootTurnId, itemId: item.id, key, status: t.status, ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}), ...(Number.isInteger(item.durationMs) ? { durationMs: item.durationMs } : {}), ...(late ? { late: true } : {}) });
  }

  function settle(rootTurnId) {
    for (const key of settleTurn(tools, rootTurnId)) {
      const t = tools.get(key);
      write({ type: "toolResult", turnId: t.turnId, rootTurnId, itemId: t.itemId, key, status: "unknown", reason: "turn ended" });
    }
  }

  // A subagent turn that ends: its own tools still running (not background terminals) are
  // unknown. Its siblings, still working, are left alone.
  function settleChildTurn(turnId) {
    for (const [key, t] of tools) {
      if (t.turnId !== turnId || t.status !== "running" || t.background) continue;
      t.status = "unknown";
      write({ type: "toolResult", turnId, rootTurnId: t.rootTurnId, itemId: t.itemId, key, status: "unknown", reason: "turn ended" });
    }
  }

  function observer(ev) {
    if (off) return;
    handle(ev);
    if (!pendingNotice) return;
    const notice = pendingNotice;
    pendingNotice = null;
    return { notice };
  }

  function handle(ev) {
    switch (ev.type) {
      case "thread.attached": {
        const id = ev.threadId;
        const owner = sessionForThread(readIndex({ root }), homeKey(), id);
        if (ledger && binding?.threadId !== id) {
          if (awaitingThread && ev.how === "new") {
            // The first thread of a session that began with its first prompt.
            awaitingThread = false;
            startBinding(id, "new");
          } else if (ev.how === "fork" || ev.how === "continuation" || owner === sessionId || former.has(id)) {
            // (former: this session's own earlier thread, also before the index has it.)
            // The same work on another thread (a switch, /cd, a restart, this session's own thread).
            endBinding("switch");
            startBinding(id, ev.how === "fork" ? "fork" : "continuation");
          } else closeCurrent("switch"); // another session's thread, or an unknown one: its own record
        }
        attached = id;
        adoptFrom = !ledger && ev.how === "resume" && !owner ? id : null;
        return;
      }
      case "thread.detached":
        if (attached === ev.threadId) attached = null;
        if (!ledger) return;
        // "switched": a thread.attached follows and the session goes on there.
        if (ev.reason === "switched") {
          if (binding?.threadId === ev.threadId) endBinding("switch");
          return;
        }
        closeCurrent(DETACH_REASON[ev.reason] ?? "newThread");
        return;
      case "user.message": {
        const text = typeof ev.input === "string" ? ev.input : "";
        if (!ensureSession(text)) return;
        if (ev.via === "submit" || ev.via === "queue") pendingUser += 1;
        // A /private prompt is never stored, also with an image or text around it.
        const priv = PRIVATE.test(text);
        write({ type: "userMessage", clientId: ev.clientId, ...(ev.turnId ? { turnId: ev.turnId } : {}), via: ev.via, text: priv ? null : text, ...(priv ? { private: true } : {}) });
        return;
      }
      case "turn.startFailed":
        if (pendingUser > 0) pendingUser -= 1;
        return;
      case "turn.started": {
        if (!ledger) return;
        const isRoot = ev.threadId === binding?.threadId;
        // Only the bound thread and its descendants reach the observer, so another live thread
        // is a subagent of the root turn (its spawn item may come after its first turn).
        const descendant = !isRoot && (childRoot.has(ev.threadId) || (Boolean(binding) && !former.has(ev.threadId)));
        const parent = isRoot ? null : (childRoot.get(ev.threadId) ?? activeRoot ?? lastRoot ?? null);
        if (!isRoot && !descendant) {
          // A turn on a thread this binding doesn't own (a binding that is no longer current).
          write({ type: "violation", gen: binding?.gen ?? gen, threadId: ev.threadId, turnId: ev.turnId });
          return;
        }
        let trigger = "subagent";
        if (isRoot) {
          if (adNext) {
            trigger = "ad";
            adNext = false;
          } else if (pendingUser > 0) {
            trigger = "user";
            pendingUser -= 1;
          } else trigger = goalActive ? "goal" : "engine";
          activeRoot = lastRoot = ev.turnId;
          turnStarts.set(ev.turnId, Date.now());
        } else if (parent) childRoot.set(ev.threadId, parent);
        // A subagent's wake-up before any root turn of a reopened session is its own root.
        turnRoot.set(ev.turnId, isRoot ? ev.turnId : (parent ?? ev.turnId));
        write({ type: "turnStarted", turnId: ev.turnId, ...(isRoot ? {} : { thread: ev.threadId, parentTurnId: parent }), trigger });
        return;
      }
      case "turn.completed": {
        if (!ledger) return;
        const isRoot = ev.threadId === binding?.threadId;
        if (isRoot) {
          settle(ev.turnId);
          if (activeRoot === ev.turnId) activeRoot = null;
        } else settleChildTurn(ev.turnId); // its root may have ended (and settled) before it
        const e = ev.error;
        let failure = null;
        if (e) {
          try {
            failure = classify({ error: e, status: ev.status, threadId: ev.threadId, turnId: ev.turnId, startedAt: turnStarts.get(ev.turnId) ?? null });
          } catch {
            failure = null; // a classifier's failure leaves the class unknown
          }
        }
        turnStarts.delete(ev.turnId);
        const { status: httpStatus } = engineInfo(e?.info);
        write({ type: "turnCompleted", turnId: ev.turnId, ...(isRoot ? {} : { thread: ev.threadId }), status: ev.status ?? "completed", ...(e ? { error: { info: e.info ?? null, httpStatus, message: String(e.message ?? ""), class: failure?.class ?? "unknown", ...(failure?.resetsAt ? { resetsAt: failure.resetsAt } : {}), ...(failure?.retryAfterMs != null ? { retryAfterMs: failure.retryAfterMs } : {}) } } : {}) });
        return;
      }
      case "item.started":
      case "item.completed":
        if (ledger && ev.item) onTool(ev, ev.type === "item.completed");
        return;
      case "request.answered":
        if (ledger) write({ type: "approvalDecision", turnId: ev.request?.turnId ?? null, itemId: ev.request?.itemId ?? null, requestKind: ev.request?.kind ?? null, decision: decisionOf(ev.decision) });
        return;
      case "request.resolved":
        if (ledger && ev.cancelled) write({ type: "approvalDecision", requestKind: null, decision: "withdrawn" });
        return;
      case "thread.goal": {
        const active = ev.goal?.status === "active";
        if (ledger && active !== goalActive) write({ type: active ? "goalResumed" : "goalPaused", threadId: ev.threadId });
        goalActive = active;
        return;
      }
      case "engine.exited":
        if (!ledger) return;
        // The engine is gone: nothing still running can finish, background terminals included.
        for (const [key, t] of tools) {
          if (t.status !== "running") continue;
          t.status = "unknown";
          write({ type: "toolResult", turnId: t.turnId, rootTurnId: t.rootTurnId, itemId: t.itemId, key, status: "unknown", reason: "engine exited" });
        }
        activeRoot = null;
        // A restart that gets the thread back attaches it again ("continuation"): the same
        // thread, a new binding. Without the end here it would look like the old one going on.
        if (binding) {
          former.delete(binding.threadId);
          write({ type: "bindingEnded", gen: binding.gen, reason: "engineLost" });
          binding = null;
        }
        return;
      default:
    }
  }

  return {
    observer,
    markAdTurn() {
      adNext = true;
    },
    sessionId: () => sessionId ?? lastId,
    /** A switch's own events (P4.2): switchRequested / Committed / Aborted, checkpoint. */
    record(ev) {
      if (!ledger) return;
      write(ev);
      if (ev.type === "switchCommitted") lastSwitch = { at: Date.now(), reason: ev.reason ?? "user" };
    },
    /** The last root turn's tools that may have changed something and whose end is unknown. */
    unknownNonRead() {
      return [...tools.values()].filter((t) => t.status === "unknown" && t.effect !== "read" && !t.background && (t.rootTurnId === lastRoot || t.rootTurnId === activeRoot)).map((t) => t.summary);
    },
    /** The same thread on a new target (a model change on the same account): a new binding. */
    rebind(how = "nextTurn") {
      if (!ledger || !binding) return;
      const id = binding.threadId;
      endBinding("switch");
      former.delete(id);
      startBinding(id, how);
    },
    status: () => (sessionId ? { sessionId, gen, ...(lastSwitch ? { switchedAt: lastSwitch.at, switchReason: lastSwitch.reason } : {}) } : null),
    /** Settles pending index writes (tests, shutdown). */
    flush: () => indexChain,
    async close() {
      await closeCurrent("close");
      await indexChain;
    },
  };
}
