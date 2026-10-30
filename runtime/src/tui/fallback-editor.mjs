// /fallback (P4.4): the minimal fallback editor. Pure state and keys; the app draws its lines
// below the composer and gives it the keys while it is open. Every change is validated and
// saved at once (the store's lock and revision check); a change that would add a problem
// stays in the draft, its errors under the rows, until fixed or discarded with esc.
//
//   createFallbackEditor({ host }) → { open(), key(name) → Promise<"close"|undefined>, render() → [{ text, tone }] }
//   host: { load() → { policy, ctx }, save(draft, { expectedRevision }), enable({ expectedRevision }),
//           disable(), pickTarget() → target | null, liveTest(policy) → [lines] }
//   fallbackHost({ root }) → the host's store half (the app adds pickTarget)
//
// Keys: ↑/↓ choose · [ ] move · a add · d remove · enter rules · t test · l live test (asks)
//       p preview (tab: another error) · e turn on (consent) / off · esc close

import { FALLBACK_ON, targetInfo, validatePolicy } from "../routing/policy.mjs";
import { readCatalog } from "../providers/catalog.mjs";
import { consentText, costText, explain, giveUpText, ON_WORDS, rowsOf, rulesLines } from "../routing/preview.mjs";
import { consentState, disablePolicy, enablePolicy, readPolicy, updatePolicy } from "../routing/store.mjs";
import { isEngineLogin, routingContext } from "../routing/context.mjs";

export const FALLBACK_EDITOR_TEXTS = Object.freeze({
  FOOTER_OFF: "enter rules \u{b7} a add \u{b7} d remove \u{b7} [ ] move \u{b7} t test \u{b7} l live test \u{b7} p preview \u{b7} e turn on \u{b7} esc close",
  FOOTER_ON: "enter rules \u{b7} a add \u{b7} d remove \u{b7} [ ] move \u{b7} t test \u{b7} l live test \u{b7} p preview \u{b7} e turn off \u{b7} esc close",
  ADD: "    + add a target (a)",
  CHANGED: "Changed: fallback is off until you turn it on again (e).",
  DISCARD: "Discard changes? y/n",
  LIVE_ASK: "This sends one tiny request to each target (it counts against free limits). Go on? y/n",
  TRIAL_ASK: (label, note) => `${label} is a trial endpoint: ${note}. Keep it in the order? y/n`,
  NOTHING_TO_TEST: "No targets yet: a adds one.",
  BACK: "esc back",
  PREVIEW_BACK: "tab another error \u{b7} esc back",
  RULES_BACK: "enter change \u{b7} esc back",
  KEEP_RUNNING: (list) => `Keep running: ${list.length ? list.join(", ") : "none"} (ad fallback set keep-running, in a terminal)`,
  ON: "Fallback is on.",
  OFF: "Fallback is off.",
  BUTTONS: ["Turn on", "Save, keep off", "Cancel"],
});

const GIVE_UP = [30_000, 60_000, 120_000, 300_000, 600_000];
const TRIAL = ["ask", "never", "allow"];
const EDITABLE = ["targets", "on", "cost", "maxHops", "recoveryBudgetMs", "maxSwitchesPerHour", "dataRules", "allowRunningBackground"];
const next = (list, v) => list[(list.indexOf(v) + 1) % list.length];

/** The store half of the host, on ad's own files (tests pass a temp root). */
export function fallbackHost({ root } = {}) {
  const ctx = () => routingContext({ root });
  return {
    load: async () => {
      const c = ctx();
      return { policy: readPolicy({ root: c.root }), ctx: c };
    },
    save: (draft, { expectedRevision } = {}) =>
      updatePolicy((p) => {
        for (const k of EDITABLE) p[k] = structuredClone(draft[k]);
      }, { ...ctx(), expectedRevision }),
    // The accounts the consent showed are the ones confirmed (a change since reads as changed).
    enable: ({ expectedRevision, accounts } = {}) => enablePolicy({ ...ctx(), ...(accounts ? { accounts } : {}), expectedRevision }),
    disable: () => disablePolicy(ctx()),
    // An account's models for the picker: its catalog, or a ChatGPT sign-in's known ones.
    models: (a, { current = null } = {}) => {
      if (isEngineLogin(a)) return [...new Set([a.defaultModel, current].filter(Boolean))].map((id) => ({ id, hint: "your plan" }));
      const c = ctx();
      return (readCatalog(a.id, { root: c.root })?.entries ?? []).map((e) => ({ id: e.model, hint: costText(targetInfo({ account: a.id, model: e.model }, c), c.now), noTools: e.caps?.tools === false }));
    },
    liveTest: async () => {
      const { cmdFallback } = await import("../routing/cli.mjs");
      let text = "";
      const sink = { write: (s) => ((text += s), true) };
      // The editor asked already, in the terminal ad tui runs in.
      await cmdFallback("test", [], { live: true, yes: true, json: true, out: sink, err: sink, env: {}, isTTY: () => true, context: ctx() });
      try {
        return JSON.parse(text).rows.map((r) => `${r.row}. ${r.label}: ${r.live ? (r.live.sent ? (r.live.ok ? "answered" : `failed: ${r.live.detail}`) : r.live.detail) : "not tested"}`);
      } catch {
        return text.trim().split("\n");
      }
    },
  };
}

export function createFallbackEditor({ host }) {
  let policy = null; // as saved
  let draft = null; // what the rows show
  let ctx = null;
  let sel = 0;
  let mode = "list"; // list | rules | preview | message | consent | ask
  let errors = [];
  let warnings = [];
  let notice = null;
  let messageLines = [];
  let previewFailure = "quotaExhausted";
  let rulesSel = 0;
  let button = 0;
  let pending = null; // { text, yes: async () => {} }
  let drawn = null; // render()'s lines until the next key (rows read the quota store)
  // On, and confirmed for these destinations; on but changed since reads as off.
  const live = () => Boolean(policy?.enabled && consentState(policy, ctx.accounts).ok);
  const dirty = () => JSON.stringify(EDITABLE.map((k) => draft?.[k])) !== JSON.stringify(EDITABLE.map((k) => policy?.[k]));

  async function reload() {
    const r = await host.load();
    policy = r.policy;
    ctx = r.ctx;
    draft = structuredClone(policy);
    sel = Math.min(sel, Math.max(0, draft.targets.length - 1));
  }

  // Save the draft, or keep it with its errors.
  async function commit() {
    try {
      const r = await host.save(draft, { expectedRevision: policy.revision });
      errors = [];
      warnings = r.warnings ?? [];
      policy = r.policy;
      draft = structuredClone(policy);
      if (r.consentCleared) notice = { text: FALLBACK_EDITOR_TEXTS.CHANGED, tone: "warn" };
    } catch (e) {
      if (e.code === "FALLBACK_INVALID") errors = e.errors ?? [{ text: e.message }];
      else if (e.code === "FALLBACK_CONFLICT") {
        await reload();
        notice = { text: e.message, tone: "warn" };
      } else notice = { text: e.message, tone: "warn" };
    }
  }

  const ask = (text, yes) => {
    pending = { text, yes };
    mode = "ask";
  };

  async function addTarget() {
    const t = await host.pickTarget?.();
    if (!t) return;
    const info = targetInfo(t, ctx);
    const insert = async () => {
      draft.targets.splice(draft.targets.length ? sel + 1 : 0, 0, t);
      sel = draft.targets.indexOf(t);
      await commit();
    };
    if (info.trial && (draft.dataRules?.trialEndpoints ?? "ask") === "ask") {
      ask(FALLBACK_EDITOR_TEXTS.TRIAL_ASK(info.label, info.note ?? "its provider may keep what you send"), async () => {
        t.trialConsent = true;
        await insert();
      });
      return;
    }
    await insert();
  }

  function testLines() {
    if (!draft.targets.length) return [FALLBACK_EDITOR_TEXTS.NOTHING_TO_TEST];
    return rowsOf(draft, ctx).map((r) => `${r.index + 1}. ${r.label}: ${r.ok ? "can continue a task now" : `skipped now: ${r.why}`}${r.limits ? ` (${r.limits})` : ""}`);
  }

  function rulesRows() {
    const on = new Set(draft.on ?? []);
    return [
      ...FALLBACK_ON.map((c) => ({ text: `Switch on ${ON_WORDS[c]}: ${on.has(c) ? "yes" : "no"}`, change: () => void (draft.on = on.has(c) ? draft.on.filter((x) => x !== c) : [...(draft.on ?? []), c]) })),
      { text: `Cost: ${draft.cost === "freeOnly" ? "free only" : "no extra spend"}`, change: () => void (draft.cost = draft.cost === "freeOnly" ? "noExtraSpend" : "freeOnly") },
      { text: `Moves per task: ${draft.maxHops}`, change: () => void (draft.maxHops = (draft.maxHops % 5) + 1) },
      { text: `Give up after: ${giveUpText(draft.recoveryBudgetMs)}`, change: () => void (draft.recoveryBudgetMs = next(GIVE_UP, draft.recoveryBudgetMs) ?? GIVE_UP[0]) },
      { text: `Trial endpoints: ${draft.dataRules?.trialEndpoints ?? "ask"}`, change: () => void (draft.dataRules = { ...draft.dataRules, trialEndpoints: next(TRIAL, draft.dataRules?.trialEndpoints ?? "ask") }) },
      { text: FALLBACK_EDITOR_TEXTS.KEEP_RUNNING(draft.allowRunningBackground ?? []), change: null },
    ];
  }

  async function turnOn() {
    if (live()) {
      await host.disable();
      await reload();
      notice = { text: FALLBACK_EDITOR_TEXTS.OFF };
      return;
    }
    if (dirty()) return; // the errors under the rows say why
    await reload(); // the consent shows the accounts as they are now, and confirms those
    const { errors: e } = validatePolicy(draft, { ...ctx, enabling: true });
    if (e.length) {
      errors = e;
      return;
    }
    button = 0;
    mode = "consent";
  }

  const keys = {
    list: async (k) => {
      const n = draft.targets.length;
      if (k === "up") sel = Math.max(0, sel - 1);
      else if (k === "down") sel = Math.min(n, sel + 1); // n: the rules line
      else if ((k === "[" || k === "]") && sel < n && n > 1) {
        const to = k === "[" ? sel - 1 : sel + 1;
        if (to < 0 || to >= n) return;
        [draft.targets[sel], draft.targets[to]] = [draft.targets[to], draft.targets[sel]];
        sel = to;
        await commit();
      } else if (k === "d" && sel < n) {
        draft.targets.splice(sel, 1);
        sel = Math.max(0, Math.min(sel, draft.targets.length - 1));
        await commit();
      } else if (k === "a") await addTarget();
      else if (k === "enter" && sel >= n) {
        rulesSel = 0;
        mode = "rules";
      } else if (k === "t") {
        messageLines = testLines();
        mode = "message";
      } else if (k === "l") {
        if (!draft.targets.length) {
          messageLines = [FALLBACK_EDITOR_TEXTS.NOTHING_TO_TEST];
          mode = "message";
          return;
        }
        ask(FALLBACK_EDITOR_TEXTS.LIVE_ASK, async () => {
          messageLines = await host.liveTest(draft);
          mode = "message";
        });
      } else if (k === "p") {
        previewFailure = "quotaExhausted";
        mode = "preview";
      } else if (k === "e") await turnOn();
      else if (k === "esc") {
        if (!dirty()) return "close";
        ask(FALLBACK_EDITOR_TEXTS.DISCARD, async () => "close");
      }
    },
    rules: async (k) => {
      const rows = rulesRows();
      if (k === "up") rulesSel = Math.max(0, rulesSel - 1);
      else if (k === "down") rulesSel = Math.min(rows.length - 1, rulesSel + 1);
      else if ((k === "enter" || k === "space") && rows[rulesSel].change) {
        rows[rulesSel].change();
        await commit();
      } else if (k === "esc") mode = "list";
    },
    preview: async (k) => {
      if (k === "tab") previewFailure = next(Object.keys(ON_WORDS), previewFailure);
      else if (k === "esc") mode = "list";
    },
    message: async (k) => {
      if (k === "esc" || k === "enter") mode = "list";
    },
    consent: async (k) => {
      if (k === "left") button = (button + 2) % 3;
      else if (k === "right" || k === "tab") button = (button + 1) % 3;
      else if (k === "esc") mode = "list";
      else if (k === "enter") {
        mode = "list";
        if (button !== 0) return; // "Save, keep off": the order is saved already
        try {
          await host.enable({ expectedRevision: policy.revision, accounts: ctx.accounts });
          await reload();
          notice = { text: FALLBACK_EDITOR_TEXTS.ON };
        } catch (e) {
          errors = e.errors ?? [{ text: e.message }];
          await reload();
        }
      }
    },
    ask: async (k) => {
      if (k !== "y" && k !== "n" && k !== "esc") return;
      const p = pending;
      pending = null;
      mode = "list";
      if (k === "y") return p.yes();
    },
  };

  function listLines() {
    const lines = [{ text: `Fallback order${" ".repeat(8)}${live() ? "on" : policy.enabled ? "off until you confirm again" : "off"} \u{b7} ${draft.cost === "freeOnly" ? "free only" : "no extra spend"}`, tone: "title" }];
    const rows = rowsOf(draft, ctx);
    const w = Math.min(48, Math.max(0, ...rows.map((r) => r.label.length)));
    for (const r of rows) {
      const facts = [r.cost, r.limits].filter(Boolean).join(" \u{b7} ");
      lines.push({ text: `${sel === r.index ? "\u{203a}" : " "}${String(r.index + 1).padStart(2)}  ${r.label.padEnd(w)}  ${facts}  ${r.ok ? "\u{2713}" : `skipped: ${r.why}`}`.trimEnd(), tone: sel === r.index ? "selected" : r.ok ? null : "dim" });
    }
    lines.push({ text: FALLBACK_EDITOR_TEXTS.ADD, tone: "dim" });
    const [on, rules] = rulesLines(draft);
    lines.push({ text: `${sel === draft.targets.length ? "\u{203a}" : " "}${on}`, tone: sel === draft.targets.length ? "selected" : null }, { text: ` ${rules}` });
    for (const e of errors) lines.push({ text: ` ! ${e.text}`, tone: "warn" });
    for (const w2 of warnings) lines.push({ text: `   row ${w2.index + 1}: ${w2.text}`, tone: "dim" });
    if (notice) lines.push({ text: ` ${notice.text}`, tone: notice.tone ?? null });
    lines.push({ text: ` ${live() ? FALLBACK_EDITOR_TEXTS.FOOTER_ON : FALLBACK_EDITOR_TEXTS.FOOTER_OFF}`, tone: "dim" });
    return lines;
  }

  return {
    get mode() {
      return mode;
    },
    get policy() {
      return policy;
    },
    get draft() {
      return draft;
    },
    async open() {
      await reload();
      drawn = null;
    },
    async key(k) {
      if (!draft) return undefined;
      drawn = null;
      if (mode === "list" && k !== "esc") notice = null;
      // A draw while the key's work runs (a save, a live test) mustn't outlive it.
      try {
        return await keys[mode](k);
      } finally {
        drawn = null;
      }
    },
    render() {
      drawn ??= draw0();
      return drawn;
    },
  };

  function draw0() {
    if (!draft) return [{ text: "Fallback order: loading\u{2026}", tone: "dim" }];
    if (mode === "rules") return [{ text: "Fallback rules", tone: "title" }, ...rulesRows().map((r, i) => ({ text: `${i === rulesSel ? "\u{203a}" : " "} ${r.text}`, tone: i === rulesSel ? "selected" : r.change ? null : "dim" })), ...errors.map((e) => ({ text: ` ! ${e.text}`, tone: "warn" })), { text: ` ${FALLBACK_EDITOR_TEXTS.RULES_BACK}`, tone: "dim" }];
    if (mode === "preview") return [{ text: `Preview: if it's a ${ON_WORDS[previewFailure]}`, tone: "title" }, ...explain(draft, { failure: previewFailure }, ctx).map((text) => ({ text })), { text: ` ${FALLBACK_EDITOR_TEXTS.PREVIEW_BACK}`, tone: "dim" }];
    if (mode === "message") return [...messageLines.map((text) => ({ text })), { text: ` ${FALLBACK_EDITOR_TEXTS.BACK}`, tone: "dim" }];
    if (mode === "consent") return [...consentText(policy, ctx).map((text, i) => ({ text, tone: i === 0 ? "title" : null })), { text: FALLBACK_EDITOR_TEXTS.BUTTONS.map((b, i) => (i === button ? `[ ${b} ]` : `  ${b}  `)).join(" "), tone: "selected" }];
    if (mode === "ask") return [...listLines().slice(0, -1), { text: ` ${pending.text}`, tone: "warn" }];
    return listLines();
  }
}
