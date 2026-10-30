// `ad fallback` (P4.4): the fallback order and its rules, from a terminal.
//
//   ad fallback [list] [--json]            the order, what can continue now and why not
//   ad fallback add | remove | order | move | set …   changes (validated, under the lock)
//   ad fallback preview [--error <class>] [--from N]
//   ad fallback test [--live] [--json]
//   ad fallback enable [--yes] | disable
//
// Changes refuse in the agent's own shell (AD_TOOL_SHELL=1, D49): only you choose where your
// code may go. `enable` shows every destination first and asks on a terminal; --yes is the
// explicit non-interactive form and still prints the text (to stderr). Exit: 0 ok, 1 refused
// or invalid, 2 usage.

import { createInterface } from "node:readline";
import { accountName } from "../auth/accounts/target.mjs";
import { resolveAccount } from "../harness/auth-commands.mjs";
import { consentText, explain, rowsOf, rulesLines } from "./preview.mjs";
import { COSTS, FALLBACK_ON, targetInfo, TRIAL_RULES, validatePolicy } from "./policy.mjs";
import { routingContext, isEngineLogin } from "./context.mjs";
import { consentState, disablePolicy, enablePolicy, FALLBACK_TEXTS, readPolicy, updatePolicy } from "./store.mjs";

export const FALLBACK_HELP = `ad fallback: where ad continues a task when a model's limit runs out

  ad fallback [list] [--json]          the order, what can continue now, and why not
  ad fallback add <account>[:<model>] [--model <m>] [--effort <e>] [--at <N>]
  ad fallback remove <N>
  ad fallback order <N> <N> ...        a new order (every row once)
  ad fallback move <N> <M>
  ad fallback set cost freeOnly|noExtraSpend
  ad fallback set on <classes>         ${FALLBACK_ON.join(" ")}
  ad fallback set max-hops <1-5>       how many targets one task may move through
  ad fallback set max-switches <1-20>  switches per hour, across windows
  ad fallback set give-up <seconds>    10-600
  ad fallback set trial ask|never|allow
  ad fallback set keep-running "<command>" ...   long-running commands a switch may leave running (none: clear)
  ad fallback preview [--error <class>] [--from <N>]
  ad fallback test [--live] [--json]   --live sends one tiny request to each target
  ad fallback enable [--yes]           shows every destination, then asks
  ad fallback disable

Changes need your own terminal: the agent's shell can only list, preview and test.
`;

export const FALLBACK_CLI_TEXTS = Object.freeze({
  TOOL_SHELL: "ad fallback can't be changed from the agent's own shell. Run it in your terminal.",
  EMPTY: "No fallback order yet. Add a target: ad fallback add <account>[:<model>]",
  OFF_PREVIEW: "Fallback is off; this is what it would do once it's on (ad fallback enable).",
  ENABLE_NEEDS_TTY: "ad fallback enable only runs in your own terminal: it lists where your code may go, and you confirm it there (--yes skips the question, not the terminal).",
  ENABLED: "Fallback is on.",
  NOT_ENABLED: "Fallback stays off.",
  DISABLED: "Fallback is off.",
  LIVE_ASK: "This sends one tiny request to each target (it counts against free limits). Go on? [y/N] ",
  LIVE_NEEDS_TTY: "ad fallback test --live sends to every target, so it only runs in your own terminal (--yes skips the question there).",
  TRIAL_ASK: (label, note) => `${label} is a trial endpoint: ${note}. Keep it in the order? [y/N] `,
  TRIAL_NEEDS_TTY: (label) => `${label} is a trial endpoint: confirm it in your own terminal (--yes skips the question there, not the terminal).`,
  NO_MODEL: (ref) => `Name the model: ad fallback add ${ref} --model <model> (ad auth models ${ref} lists them).`,
  NOT_A_ROW: (n, len) => `There's no row ${n}: the order has ${len} target${len === 1 ? "" : "s"}.`,
  BAD_ORDER: (len) => `Give every row once, 1 to ${len}: ad fallback order 2 1 3`,
  ENGINE_TEST: (name) => `${name}: not sent; ad doesn't start a second engine for a test. Last known limits shown.`,
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const usage = (text = FALLBACK_HELP) => fail("USAGE", text);
const MUTATING = new Set(["add", "remove", "order", "move", "set", "enable"]);
const COMMANDS = new Set(["list", "add", "remove", "order", "move", "set", "preview", "test", "enable", "disable"]);
const EXIT_2 = new Set(["USAGE"]);

const realTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function askYes(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return /^\s*y/i.test(await new Promise((resolve) => rl.question(prompt, resolve)));
  } finally {
    rl.close();
  }
}

const rowNumber = (v, len, { extra = 0 } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw usage(`Not a row number: ${v ?? "(none)"}`);
  if (n > len + extra) throw fail("NOT_A_ROW", FALLBACK_CLI_TEXTS.NOT_A_ROW(n, len));
  return n;
};
const intArg = (v, what) => {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw usage(`ad fallback set ${what} needs a number.`);
  return n;
};

function listText(policy, ctx) {
  const lines = [`Fallback order: ${policy.enabled ? "on" : "off"} \u{b7} ${policy.cost === "freeOnly" ? "free only" : "no extra spend"}`];
  const state = consentState(policy, ctx.accounts);
  if (policy.enabled && !state.ok) lines.push(state.text);
  const rows = rowsOf(policy, ctx);
  if (!rows.length) lines.push(FALLBACK_CLI_TEXTS.EMPTY);
  const w = Math.min(56, Math.max(0, ...rows.map((r) => r.label.length)));
  for (const r of rows) {
    const facts = [r.cost, r.limits].filter(Boolean).join(" \u{b7} ");
    lines.push(` ${String(r.index + 1).padStart(2)}  ${r.label.padEnd(w)}  ${facts}  ${r.ok ? "\u{2713}" : `skipped now: ${r.why}`}`.trimEnd());
  }
  lines.push(...rulesLines(policy));
  return lines;
}

function warningLines(warnings) {
  return warnings.map((w) => `  ! ${w.index !== undefined ? `row ${w.index + 1}: ` : ""}${w.text}`);
}

export async function cmdFallback(sub, args = [], o = {}) {
  const out = o.out ?? process.stdout;
  const err = o.err ?? process.stderr;
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? realTTY;
  const ask = o.ask ?? ((q) => askYes(q, { stdin: o.stdin ?? process.stdin, stderr: err }));
  const now = o.now ?? Date.now();
  const say = (lines) => out.write(`${[].concat(lines).join("\n")}\n`);
  sub ??= "list";
  try {
    if (o.help || sub === "help") {
      out.write(FALLBACK_HELP);
      return 0;
    }
    if (!COMMANDS.has(sub)) throw usage();
    if ((MUTATING.has(sub) || (sub === "test" && o.live)) && env.AD_TOOL_SHELL === "1") {
      err.write(`${FALLBACK_CLI_TEXTS.TOOL_SHELL}\n`);
      return 1;
    }
    const ctx = o.context ?? routingContext({ root: o.root, now });
    const save = async (mutate, extra = {}) => {
      const r = await updatePolicy(mutate, { ...ctx, ...extra });
      if (r.warnings.length) say(warningLines(r.warnings));
      if (r.consentCleared) say(FALLBACK_TEXTS.CLEARED);
      return r;
    };

    if (sub === "list") {
      const policy = readPolicy({ root: ctx.root });
      if (o.json) {
        const { warnings } = validatePolicy(policy, ctx);
        out.write(`${JSON.stringify({ policy, consent: consentState(policy, ctx.accounts), rows: rowsOf(policy, ctx).map(({ target: _t, ...r }) => r), warnings })}\n`);
      } else {
        say(listText(policy, ctx));
        const { warnings } = validatePolicy(policy, ctx);
        if (warnings.length) say(warningLines(warnings));
      }
      return 0;
    }

    if (sub === "add") {
      if (!args[0]) throw usage("Usage: ad fallback add <account>[:<model>] [--model <m>] [--effort <e>] [--at <N>]");
      const colon = args[0].indexOf(":");
      const ref = colon > 0 ? args[0].slice(0, colon) : args[0];
      const a = resolveAccount({ accounts: ctx.accounts }, ref);
      const model = o.model ?? (colon > 0 ? args[0].slice(colon + 1) : null) ?? a.defaultModel ?? null;
      if (!model) throw usage(FALLBACK_CLI_TEXTS.NO_MODEL(ref));
      const t = { account: a.id, model, ...(o.effort ? { effort: o.effort } : {}) };
      const info = targetInfo(t, ctx);
      const policy = readPolicy({ root: ctx.root });
      if (info.trial && (policy.dataRules?.trialEndpoints ?? "ask") === "ask") {
        // Consent to a trial endpoint is yours: never without a terminal, even with --yes
        // (another host's agent shell has no AD_TOOL_SHELL, and no terminal either).
        if (!isTTY()) throw fail("NEEDS_TTY", FALLBACK_CLI_TEXTS.TRIAL_NEEDS_TTY(info.label));
        if (!o.yes) {
          if (!(await ask(FALLBACK_CLI_TEXTS.TRIAL_ASK(info.label, info.note ?? "its provider may keep what you send")))) {
            say("Not added.");
            return 0;
          }
        }
        t.trialConsent = true;
      }
      let at;
      await save((p) => {
        at = o.at !== undefined ? rowNumber(o.at, p.targets.length, { extra: 1 }) : p.targets.length + 1;
        p.targets.splice(at - 1, 0, t);
      });
      say(`Added ${at}. ${info.label}.`);
      return 0;
    }

    if (sub === "remove") {
      let gone;
      await save((p) => {
        const n = rowNumber(args[0], p.targets.length);
        [gone] = p.targets.splice(n - 1, 1);
      });
      say(`Removed ${targetInfo(gone, ctx).label}.`);
      return 0;
    }

    if (sub === "order" || sub === "move") {
      await save((p) => {
        const len = p.targets.length;
        if (sub === "move") {
          const from = rowNumber(args[0], len);
          const to = rowNumber(args[1], len);
          const [t] = p.targets.splice(from - 1, 1);
          p.targets.splice(to - 1, 0, t);
          return;
        }
        const nums = args.map(Number);
        if (nums.length !== len || new Set(nums).size !== len || nums.some((n) => !Number.isInteger(n) || n < 1 || n > len)) throw usage(FALLBACK_CLI_TEXTS.BAD_ORDER(len));
        p.targets = nums.map((n) => p.targets[n - 1]);
      });
      say(listText(readPolicy({ root: ctx.root }), ctx));
      return 0;
    }

    if (sub === "set") {
      const [what, ...vals] = args;
      const v = vals[0];
      const change = {
        cost: (p) => {
          const c = { "free-only": "freeOnly", "no-extra-spend": "noExtraSpend" }[v] ?? v;
          if (!COSTS.includes(c)) throw usage(`ad fallback set cost ${COSTS.join("|")}`);
          p.cost = c;
        },
        on: (p) => {
          const classes = vals.flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
          if (!classes.length) throw usage(`ad fallback set on <classes>: ${FALLBACK_ON.join(" ")}`);
          p.on = classes;
        },
        "max-hops": (p) => void (p.maxHops = intArg(v, "max-hops")),
        "max-switches": (p) => void (p.maxSwitchesPerHour = intArg(v, "max-switches")),
        "give-up": (p) => void (p.recoveryBudgetMs = Math.round(intArg(v, "give-up") * 1000)),
        trial: (p) => {
          if (!TRIAL_RULES.includes(v)) throw usage(`ad fallback set trial ${TRIAL_RULES.join("|")}`);
          p.dataRules = { ...p.dataRules, trialEndpoints: v };
        },
        "keep-running": (p) => void (p.allowRunningBackground = vals.map((x) => String(x).trim()).filter(Boolean)),
      }[what];
      if (!change) throw usage();
      const r = await save(change);
      say(["Saved.", ...rulesLines(r.policy)]);
      return 0;
    }

    if (sub === "preview") {
      const policy = readPolicy({ root: ctx.root });
      if (!policy.targets.length) {
        say(FALLBACK_CLI_TEXTS.EMPTY);
        return 0;
      }
      const failure = o.error ?? "quotaExhausted";
      if (!FALLBACK_ON.includes(failure)) throw usage(`--error is one of: ${FALLBACK_ON.join(" ")}`);
      const from = o.from !== undefined ? policy.targets[rowNumber(o.from, policy.targets.length) - 1] : undefined;
      const lines = explain(policy, { from, failure }, ctx);
      say(policy.enabled ? lines : [FALLBACK_CLI_TEXTS.OFF_PREVIEW, ...lines]);
      return 0;
    }

    if (sub === "test") {
      const policy = readPolicy({ root: ctx.root });
      if (o.live) {
        if (!isTTY()) throw fail("NEEDS_TTY", FALLBACK_CLI_TEXTS.LIVE_NEEDS_TTY);
        if (!o.yes && !(await ask(FALLBACK_CLI_TEXTS.LIVE_ASK))) return 0;
      }
      const results = [];
      for (const row of rowsOf(policy, ctx)) {
        const info = targetInfo(row.target, ctx);
        const r = { row: row.index + 1, label: row.label, account: info.account?.status ?? "removed", catalog: !info.account ? null : isEngineLogin(info.account) ? "the engine's own models" : info.entry ? `listed (${row.cost})` : "not listed: ad auth models <account> --refresh", limits: row.limits ?? "not seen yet", canContinue: row.ok, why: row.why };
        if (o.live && info.account) {
          // A ChatGPT sign-in is never tested by starting an engine: its home may be in use in
          // another window (T3-M3); its limits come from what the engines last reported.
          if (isEngineLogin(info.account)) r.live = { sent: false, detail: FALLBACK_CLI_TEXTS.ENGINE_TEST(accountName(info.account)) };
          else r.live = { sent: true, ...(await (o.testTarget ?? defaultLiveTest)(info.account, row.target.model, o)) };
        }
        results.push(r);
      }
      if (o.json) out.write(`${JSON.stringify({ rows: results })}\n`);
      else {
        if (!results.length) say(FALLBACK_CLI_TEXTS.EMPTY);
        for (const r of results) {
          say([`${r.row}. ${r.label}`, `   account: ${r.account} \u{b7} models: ${r.catalog ?? "-"} \u{b7} limits: ${r.limits}`, `   ${r.canContinue ? "can continue a task now" : `skipped now: ${r.why}`}`]);
          if (r.live) say(`   live: ${r.live.sent ? (r.live.ok ? "answered" : `failed: ${r.live.detail}`) : r.live.detail}`);
        }
      }
      return results.some((r) => r.live && r.live.sent && !r.live.ok) ? 1 : 0;
    }

    if (sub === "enable") {
      const policy = readPolicy({ root: ctx.root });
      const { errors } = validatePolicy(policy, { ...ctx, enabling: true });
      if (errors.length) throw fail("FALLBACK_INVALID", errors.map((e) => e.text).join("\n"));
      const text = consentText(policy, ctx);
      // Only in your own terminal, --yes or not: an agent in another host has no AD_TOOL_SHELL.
      if (!isTTY()) {
        say(text);
        err.write(`${FALLBACK_CLI_TEXTS.ENABLE_NEEDS_TTY}\n`);
        return 1;
      }
      if (o.yes) err.write(`${text.join("\n")}\n`);
      else {
        say(text);
        if (!(await ask("Turn it on? [y/N] "))) {
          say(FALLBACK_CLI_TEXTS.NOT_ENABLED);
          return 0;
        }
      }
      // What was shown is what is confirmed: a change made meanwhile is refused.
      await enablePolicy({ ...ctx, expectedRevision: policy.revision });
      say(FALLBACK_CLI_TEXTS.ENABLED);
      return 0;
    }

    // disable: also from the agent's shell; turning fallback off is always safe.
    await disablePolicy(ctx);
    say(FALLBACK_CLI_TEXTS.DISABLED);
    return 0;
  } catch (e) {
    if (!e?.code || !(EXIT_2.has(e.code) || /^(FALLBACK_|ACCOUNT_|NOT_A_ROW|NEEDS_TTY|REGISTRY_)/.test(e.code))) throw e;
    err.write(`${e.message}\n`);
    return EXIT_2.has(e.code) ? 2 : 1;
  }
}

/** One small request to an API account's model, the way `ad auth test --model` sends it. */
async function defaultLiveTest(account, model, o) {
  const [{ testKey }, { presetFor }, { createSecretStore }] = await Promise.all([import("../auth/accounts/signin.mjs"), import("../providers/registry.mjs"), import("../auth/secrets.mjs")]);
  const store = o.store ?? createSecretStore();
  const key = account.credential?.kind === "secret" ? store.get(account.credential.ref) : null;
  if (account.credential?.kind === "secret" && !key) return { ok: false, detail: "its stored key is missing" };
  const v = await testKey(presetFor(account.provider), { key, endpoint: account.endpoint, fetch: o.fetch, clientVersion: o.clientVersion, insecure: Boolean(account.insecure), probe: true, model });
  return v.status === "ready" ? { ok: true } : { ok: false, detail: v.status === "refused" ? `the key was refused (HTTP ${v.http})` : (v.detail ?? v.status) };
}

