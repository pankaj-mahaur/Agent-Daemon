// Readiness: the plain-text lines `<pkg> doctor` prints after its checks (MCP launch plan
// L8b, Decision 22). One block per host that is set up, each line only for a feature the
// installed version has (a missing module prints no line, never a score), each gap ending
// with the one command that fixes it. Read-only: the store is opened read-only, nothing is
// written. Package-safe: imports only modules the npm closure ships (closure test).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.mjs";
import { hostById } from "./hosts.mjs";
import { installedPlugin } from "./doctor-product.mjs";
import { codexTrust } from "./setup.mjs";
import { codexMarkerMissing } from "../memory/codex-marker.mjs";
import { itemsOf } from "../memory/ledger-read.mjs";
import { PROVISIONAL_ALLOW_LIST } from "../hooks/host-capabilities.mjs";
import { entryAlive, ourHandlers } from "../hooks/routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_HOSTS = new Set(["claude-code", "codex"]);

/**
 * Features that may be missing from an installed version: id → the file (relative to this
 * module) that holds it. L7b's starter policy lands as memory/starter-policy.mjs.
 */
export const FEATURES = Object.freeze({
  rules: "../memory/rules-service.mjs",
  policy: "../memory/starter-policy.mjs",
});

/** `text` with the user's home folder shown the way ctx.display shows it (~ on a home path). */
export function redactHome(ctx, text) {
  if (!ctx.home || typeof text !== "string" || !text.includes(ctx.home)) return text;
  const label = ctx.display(ctx.home + path.sep + "x").slice(0, -2);
  return text.split(ctx.home).join(label);
}

const fmt = (n) => Number(n).toLocaleString("en-US");

/** SQL-backed counts from a read-only store: { accepted, waiting, provisional, rules, policy, mode } (null when no store). */
async function storeFacts(ctx, have) {
  let store = null;
  try {
    const { readOnlyStore } = await import("../memory/recall-doctor.mjs");
    store = await readOnlyStore(path.join(ctx.root, "episodic.db"));
    if (!store) return null;
    const t = await import("../memory/trust.mjs");
    const l = store.get(`SELECT COALESCE(SUM(${t.acceptedSql()}), 0) AS a, COALESCE(SUM(${t.pendingSql()}), 0) AS p, COALESCE(SUM(${t.provisionalSql()}), 0) AS v FROM learnings`) ?? {};
    const facts = { accepted: l.a ?? 0, waiting: l.p ?? 0, provisional: l.v ?? 0, rules: null, policy: null, mode: "auto" };
    if (have("rules")) {
      try {
        const r = store.get("SELECT COUNT(*) AS n, COALESCE(SUM(source = 'policy'), 0) AS pol FROM rules WHERE orphaned_at IS NULL") ?? {};
        facts.rules = r.n ?? 0;
        facts.policy = r.pol ?? 0;
      } catch {
        facts.rules = 0; // an older store with no rules table
        facts.policy = 0;
      }
    }
    try {
      facts.mode = (await import("../memory/review-mode.mjs")).reviewMode(store);
    } catch {
      // keep auto
    }
    return facts;
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * @param {object} ctx  install's context (home, env, root, display, command, claudeVersion)
 * @param {{cwd?: string, have?: (id: string) => boolean, claudeVersion?: string|null, recallRows?: {code: string, note: string}[]}} [o]
 * @returns {Promise<{host: string, name: string, lines: {code: string, ok: boolean, text: string, fix?: string}[]}[]>}
 */
export async function readiness(ctx, o = {}) {
  const cwd = o.cwd ?? process.cwd();
  const have = o.have ?? ((id) => fs.existsSync(path.join(HERE, FEATURES[id] ?? "\0")));
  const ledger = readLedger(ctx.root);
  const plugin = installedPlugin(ctx);
  const ids = new Set(Object.keys(ledger.hosts));
  if (plugin) ids.add("claude-code");
  if (!ids.size) return [];

  const facts = await storeFacts(ctx, have);
  const cmd = (verb) => (ctx.command ? ctx.command(verb) : verb);
  const out = [];
  const needHooks = [...ids].some((id) => HOOK_HOSTS.has(id));
  let sources = [];
  let guards = null;
  let version = null;
  let failRows = [];
  if (needHooks && ids.has("claude-code")) {
    try {
      const routes = await import("../hooks/routes.mjs");
      const hd = await import("../hooks/hook-doctor.mjs");
      sources = routes.claudeHookSources({ home: ctx.home, cwd });
      version = o.claudeVersion !== undefined ? o.claudeVersion : await Promise.resolve(ctx.claudeVersion?.()).catch(() => null);
      if (have("rules")) {
        const { loadGuards } = await import("../hooks/guards.mjs");
        guards = loadGuards({ root: ctx.root });
        failRows = hd.failClosedRows({ sources, rules: hd.ruleCount(guards.snapshot), claudeVersion: version });
      }
    } catch {
      sources = [];
    }
  }
  let recallRows = o.recallRows;
  if (!recallRows && needHooks) {
    try {
      recallRows = await (await import("../memory/recall-doctor.mjs")).recallDoctorRows({ cwd, home: ctx.home, env: ctx.env, command: cmd });
    } catch {
      recallRows = [];
    }
  }

  for (const id of ids) {
    const host = hostById(id);
    if (!host) continue;
    let codexRulesRoute = false;
    const lines = [];
    const add = (code, ok, text, fix) => lines.push({ code, ok, text: redactHome(ctx, text), ...(fix ? { fix } : {}) });
    const installFix = cmd(`install --host ${id}`);

    // installed
    const rec = ledger.hosts[id];
    if (id === "claude-code" && plugin) add("installed", plugin.enabled, `the ${plugin.id} plugin${plugin.version ? ` ${plugin.version}` : ""}${plugin.enabled ? "" : " (turned off in Claude Code)"}`, plugin.enabled ? undefined : "turn it on in Claude Code's /plugin menu");
    else add("installed", Boolean(rec), rec ? (rec.file ? `memory entry in ${ctx.display(rec.file)}` : "memory entry added through the host's own command") : "not set up", rec ? undefined : installFix);

    if (HOOK_HOSTS.has(id)) {
      // hooks wired / trusted
      if (id === "claude-code") {
        const ours = sources.flatMap((s) => ourHandlers(s.hooks)).filter((o) => entryAlive(o.info));
        const wired = Boolean(plugin?.enabled) || ours.length > 0;
        add("hooks", wired, wired ? "wired: Claude Code runs them (no trust step)" : "not wired: nothing is captured or recalled automatically", wired ? undefined : installFix);
      } else {
        let trust = [];
        try {
          trust = codexTrust(ctx);
        } catch {
          trust = [];
        }
        codexRulesRoute = trust.some((t) => /pretooluse|tool_?before|tool\.before/i.test(String(t.item?.locator?.event ?? "")));
        const bad = trust.filter((t) => ["pending", "modified", "unknown", "disabled", "gone", "changed"].includes(t.state));
        const lost = bad.some((t) => t.state === "gone" || t.state === "changed");
        if (!trust.length) add("hooks", false, "none of ad's hooks found in Codex's hooks file", installFix);
        else if (bad.length) add("hooks", false, `${bad.length} of ${trust.length} not trusted yet in Codex, or gone or changed (it skips such a hook silently)`, lost ? cmd("repair --host codex") : "open Codex and run /hooks");
        else add("hooks", true, `${trust.length} trusted in Codex`);
      }
      // enforcement: only when the rules check exists here
      if (have("rules")) {
        if (id === "claude-code" && failRows[0]) add("enforcement", failRows[0].ok, failRows[0].note, failRows[0].ok ? undefined : cmd("install --host claude-code"));
        else if (id === "codex" && codexRulesRoute) add("enforcement", true, "advisory: Codex runs the tool when a hook fails or times out, and doesn't support ask, so rules answer deny there");
      }
      // injection channel and its tokens
      const tokens = recallRows?.find((r) => r.code === "recall.tokens");
      if (tokens) add("injection", true, `hook context at session start and each prompt, sent to the model like the rest of the chat. ${tokens.note}`);
    }

    // capture
    const allowed = PROVISIONAL_ALLOW_LIST.some((e) => e.host === id);
    if (facts?.mode === "strict") add("capture", true, "review-first, strict: every learning waits for your OK");
    else if (allowed) add("capture", true, "provisional: a correction you type applies at once, tagged, and you can undo it");
    else add("capture", true, "review-first: a correction is saved for your review (provisional capture isn't on for this host)");
    if (id === "codex" && itemsOf(ctx.root, "codex", "env").length) {
      const missing = codexMarkerMissing(ctx.root);
      add("marker", !missing, missing ? "the agent-shell marker (AD_TOOL_SHELL) is gone from Codex's config.toml, so review can't be told apart from the agent's own commands" : "the agent-shell marker is set", missing ? cmd("repair --host codex") : undefined);
    }

    // counts
    if (facts) {
      const l = `${fmt(facts.accepted)} learning${facts.accepted === 1 ? "" : "s"} in use${facts.waiting ? `, ${fmt(facts.waiting)} waiting for review` : ""}${facts.provisional ? `, ${fmt(facts.provisional)} provisional` : ""}`;
      add("learnings", true, l, facts.waiting ? cmd("review") : undefined);
      if (facts.rules !== null) {
        const learned = facts.rules - facts.policy;
        add("rules", true, `${fmt(facts.rules)} rule${facts.rules === 1 ? "" : "s"}${have("policy") ? ` (${fmt(learned)} from your learnings, ${fmt(facts.policy)} from the starter policy)` : ""}`);
      }
    } else add("learnings", true, "no memory store yet: nothing learned");
    if (have("policy") && facts?.policy !== null && facts?.policy !== undefined) {
      add("policy", facts.policy > 0, facts.policy > 0 ? "the starter safety policy is on" : "the starter safety policy is off", facts.policy > 0 ? undefined : cmd("policy on"));
    }

    // coexisting tools (information; L7b adds dcg and claude-code-safety-net)
    // Claude Code's own auto memory and the 3.x mirror load in Claude Code only; claude-mem names its hosts.
    if (HOOK_HOSTS.has(id)) {
      for (const r of recallRows ?? []) {
        if (!r.code.startsWith("coexist.")) continue;
        if (r.code !== "coexist.claude-mem" && id !== "claude-code") continue;
        add(r.code, true, r.note);
      }
    }
    out.push({ host: id, name: host.name, lines });
  }
  return out;
}

/** The lines to print: a heading, then each host's block. */
export function renderReadiness(sections) {
  if (!sections.length) return [];
  const lines = ["", "Readiness"];
  for (const s of sections) {
    lines.push(s.name);
    for (const l of s.lines) lines.push(`  ${l.ok ? "✓" : "✗"} ${l.code}: ${l.text}${l.fix ? ` → ${l.fix}` : ""}`);
  }
  return lines;
}

/** The same lines as doctor --json rows. */
export function readinessRows(sections) {
  return sections.flatMap((s) => s.lines.map((l) => ({ code: `ready.${l.code}`, ok: l.ok, note: `${l.text}${l.fix ? ` → ${l.fix}` : ""}`, host: s.host, section: "readiness" })));
}
