// Modals (plan Part 5d): what Codex asks the user, as pure state machines.
// Each takes a PendingRequest (engine/codex/events.mjs classifyRequest) and
// returns, through handle(ev), the answer session.resolve() takes.
//
//   createRequestModal(request, {now, armMs, diff})  → the right modal for request.kind
//     .handle(ev)  → {answer} | {changed: true} | null (not ours)
//     .render({width, height}) → lines (the live region)
//     .history({width}) → the full request, for the scrollback, when it opens
//   createConfirm({title, body, yes, no}, {now, armMs}) → a yes/no question ad asks itself
//
// Safety:
//   - Everything the user approves is shown with sanitize(…, "approval"): no
//     control, bidi, zero-width or look-alike space can hide part of it.
//   - An answer that grants something is taken only `armMs` after the modal
//     opened and after the last key, so type-ahead, a held key or its
//     auto-repeat never approves. Declining is always immediate.
//   - A command taller than the screen scrolls inside the modal (PgUp/PgDn);
//     the whole request is also in the scrollback.

import { sanitize } from "../terminal/sanitize.mjs";
import { normalize, truncate, wrap } from "../terminal/text.mjs";
import { renderDiff } from "./cells.mjs";
import { createComposer } from "./composer.mjs";
import { T } from "./theme.mjs";

export const ARM_MS = 400;

const S = {
  title: T.bold,
  dim: T.dim,
  key: T.accent,
  sel: T.accent,
  warn: T.warning,
  cmd: T.code,
};

const shown = (t) => sanitize(String(t ?? ""), "approval");
// For one-row text (choice labels, errors): tab and newline become visible
// symbols, so a label can't draw extra rows (fake options) or misalign.
const oneRow = (t) => String(t).replace(/\t/g, "\u{2409}").replace(/\r?\n/g, "\u{2424}");

// Text lines wrapped with an indent, each source line on its own.
function block(text, width, style, indent = "  ") {
  const out = [];
  for (const src of String(text).split("\n")) {
    for (const l of wrap([{ text: src, style }], Math.max(1, width - indent.length))) out.push(normalize([{ text: indent }, ...l]));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* A list of choices with arming                                       */
/* ------------------------------------------------------------------ */

/**
 * choices: [{label, key, value, safe}] — `key` a single character (or
 * "esc"), `safe` true for answers that grant nothing (decline, cancel).
 */
function createChoices(choices, { now, armMs }) {
  let index = 0;
  let armedAt = now();
  const armed = () => now() - armedAt >= armMs;

  function pick(c) {
    if (c.safe || armed()) return { answer: c.value };
    armedAt = now(); // too soon: the window starts again
    return { changed: true };
  }

  return {
    get index() {
      return index;
    },
    armed,
    handle(ev) {
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) {
        const out = choices.find((c) => c.key === "esc") ?? choices.findLast((c) => c.safe);
        if (out) return { answer: out.value };
      }
      if (ev.type === "key" && !ev.ctrl && !ev.alt && (ev.name === "up" || ev.name === "down")) {
        index = (index + (ev.name === "up" ? -1 : 1) + choices.length) % choices.length;
        armedAt = now();
        return { changed: true };
      }
      if (ev.type === "key" && ev.name === "enter" && !ev.alt && !ev.shift && !ev.ctrl) return pick(choices[index]);
      // Exactly one character: a burst or a repeat in one chunk is never an answer.
      const ch = ev.type === "text" ? ev.text : ev.type === "key" && !ev.ctrl && !ev.alt ? ev.name : "";
      let c = ch.length === 1 ? choices.find((x) => x.key === ch.toLowerCase()) : null;
      // The numbers shown in the list pick too, unless a choice already uses that key.
      if (!c && /^[1-9]$/.test(ch) && !choices.some((x) => x.key === ch)) c = choices[Number(ch) - 1] ?? null;
      if (c) return pick(c);
      if (ev.type === "key" || ev.type === "text" || ev.type === "paste") {
        armedAt = now();
        return { changed: true };
      }
      return null;
    },
    render(width) {
      const ready = armed();
      return choices.map((c, i) => {
        const cur = i === index;
        const keyText = c.key === "esc" ? "esc" : c.key;
        const line = [
          { text: cur ? "\u{203a} " : "  ", style: S.sel },
          { text: `${i + 1}. `, style: S.dim },
          { text: oneRow(c.label), style: cur ? S.sel : undefined },
          ...(c.hint ? [{ text: `  ${oneRow(c.hint)}`, style: S.dim }] : []),
          ...(c.key ? [{ text: "  " }, { text: `(${keyText})`, style: ready || c.safe ? S.key : S.dim }] : []),
        ];
        return truncate(line, width);
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

function execChoice(o) {
  if (o === "accept") return { label: "Yes", key: "y", value: o };
  if (o === "acceptForSession") return { label: "Yes, and don't ask again this session", key: "a", value: o };
  if (o === "decline") return { label: "No, and tell Codex what to do instead", key: "n", value: o, safe: true };
  if (o === "cancel") return { label: "No, and stop", key: "esc", value: o, safe: true };
  if (o && typeof o === "object" && o.acceptWithExecpolicyAmendment) {
    // Tokens with spaces are quoted: ["git", "push --force"] must not read like git push --force.
    const prefix = (o.acceptWithExecpolicyAmendment.execpolicy_amendment ?? []).map((t) => (/\s|^$/.test(String(t)) ? JSON.stringify(String(t)) : String(t))).join(" ");
    return { label: `Yes, and don't ask again for commands starting with \`${shown(prefix)}\``, key: "p", value: o };
  }
  if (o && typeof o === "object" && o.applyNetworkPolicyAmendment) {
    const host = o.applyNetworkPolicyAmendment.network_policy_amendment?.host ?? "this host";
    return { label: `Yes, and always allow ${shown(host)}`, key: "h", value: o };
  }
  return null;
}

const PATCH = {
  accept: { label: "Yes", key: "y" },
  acceptForSession: { label: "Yes, and don't ask again for these files this session", key: "a" },
  decline: { label: "No, and tell Codex what to do instead", key: "n", safe: true },
  cancel: { label: "No, and stop", key: "esc", safe: true },
};
const PERMS = {
  turn: { label: "Yes, for this turn", key: "y" },
  session: { label: "Yes, for this session", key: "a" },
  decline: { label: "No", key: "n", safe: true },
};

function approvalBody(req, width, diff) {
  const d = req.display ?? {};
  const out = [];
  const who = req.agentLabel ? `[${shown(req.agentLabel)}] ` : "";
  out.push(...block(`${who}${shown(d.title ?? "Approve?")}`, width, S.title, ""));
  if (req.kind === "approval-exec") {
    if (d.command != null) out.push(...block(`$ ${shown(d.command)}`, width, S.cmd));
    if (d.detail) out.push(...block(shown(d.detail), width, S.dim));
    if (d.cwd) out.push(...block(`in ${shown(d.cwd)}`, width, S.dim));
  } else if (req.kind === "approval-patch") {
    if (diff?.length) out.push(...renderDiff(diff, { width, maxLines: Infinity, verb: "Edit", mode: "approval" }));
    if (d.grantRoot) out.push(...block(`and allow writes under ${shown(d.grantRoot)} for this session`, width, S.warn));
  } else if (req.kind === "approval-permissions") {
    out.push(...block(shown(JSON.stringify(d.permissions ?? {}, null, 1).replace(/\n\s*/g, " ")), width, S.cmd));
    if (d.cwd) out.push(...block(`in ${shown(d.cwd)}`, width, S.dim));
  }
  if (d.reason) out.push(...block(`Reason: ${shown(d.reason)}`, width, S.dim));
  return out;
}

function createApprovalModal(req, { now, armMs, diff }) {
  let choices;
  if (req.kind === "approval-exec") choices = req.options.map(execChoice).filter(Boolean);
  else if (req.kind === "approval-patch") choices = req.options.filter((o) => PATCH[o]).map((o) => ({ ...PATCH[o], value: o }));
  else choices = req.options.filter((o) => PERMS[o]).map((o) => ({ ...PERMS[o], value: o }));
  if (!choices.some((c) => c.safe)) choices.push({ label: "No", key: "n", value: req.kind === "approval-permissions" ? "decline" : "cancel", safe: true });
  const list = createChoices(choices, { now, armMs });
  let scroll = 0;
  let maxScroll = Infinity; // from the last render

  return {
    kind: req.kind,
    handle(ev) {
      if (ev.type === "key" && (ev.name === "pageup" || ev.name === "pagedown")) {
        scroll = Math.max(0, Math.min(maxScroll, scroll + (ev.name === "pageup" ? -5 : 5)));
        return { changed: true };
      }
      return list.handle(ev);
    },
    render({ width = 80, height = 24 } = {}) {
      const body = approvalBody(req, width, diff);
      const opts = list.render(width);
      // The options always show; the body scrolls in what is left.
      const room = Math.max(1, height - opts.length - 1);
      let shownBody = body;
      if (body.length > room) {
        const view = Math.max(1, room - 1);
        maxScroll = body.length - view;
        scroll = Math.min(scroll, maxScroll);
        shownBody = [...body.slice(scroll, scroll + view), [{ text: `  \u{2195} lines ${scroll + 1}\u{2013}${scroll + view} of ${body.length} (pgup/pgdn; the full request is in the scrollback)`, style: S.warn }]].map((l) => truncate(l, width));
      }
      return [...shownBody, [], ...opts];
    },
    history({ width = 80 } = {}) {
      return approvalBody(req, width, diff);
    },
  };
}

/* ------------------------------------------------------------------ */
/* User input (request_user_input)                                     */
/* ------------------------------------------------------------------ */

function createUserInputModal(req, { now, armMs }) {
  const questions = req.questions ?? [];
  const answers = {};
  let qi = 0;
  let list = null;
  let field = null; // a composer for free text

  function setup() {
    const q = questions[qi];
    if (!q) return;
    const choices = q.options.map((o, i) => ({ label: shown(o.label), hint: o.description ? shown(o.description) : null, key: i < 9 ? String(i + 1) : null, value: o.label }));
    if (q.other || !choices.length) field = createComposer({ mask: q.secret, pasteLines: Infinity, pasteChars: Infinity });
    else field = null;
    list = choices.length ? createChoices([...choices, { label: "Skip", key: "esc", value: null, safe: true }], { now, armMs }) : null;
  }
  setup();

  function next(value) {
    const q = questions[qi];
    if (value != null) answers[q.id] = [value];
    qi++;
    if (qi >= questions.length) return { answer: answers };
    setup();
    return { changed: true };
  }

  return {
    kind: "user-input",
    handle(ev) {
      if (qi >= questions.length) return { answer: answers };
      // Typing goes to the free-text field; arrows and Enter on an empty field go to the list.
      if (field && (ev.type === "text" || ev.type === "paste" || (ev.type === "key" && !["up", "down", "escape", "enter"].includes(ev.name)) || (ev.type === "key" && ev.name === "enter" && field.text))) {
        if (ev.type === "key" && ev.name === "enter") return next(field.expanded());
        const r = field.handle(ev);
        return r?.submit != null ? next(r.submit) : (r ?? { changed: true });
      }
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return next(null);
      if (!list) return null;
      const r = list.handle(ev);
      if (r && "answer" in r) return next(r.answer);
      return r;
    },
    render({ width = 80 } = {}) {
      const q = questions[qi];
      if (!q) return [];
      const out = [];
      const who = req.agentLabel ? `[${shown(req.agentLabel)}] ` : "";
      const head = questions.length > 1 ? ` (${qi + 1}/${questions.length})` : "";
      out.push(...block(`${who}${shown(q.header || "Question")}${head}`, width, S.title, ""));
      out.push(...block(shown(q.question), width));
      if (list) out.push([], ...list.render(width));
      if (field) {
        const r = field.render({ width, prompt: q.secret ? "\u{1f512} " : "\u{203a} ", placeholder: list ? "or type an answer" : "Type your answer" });
        out.push([], ...r.lines);
      }
      return out;
    },
    history({ width = 80 } = {}) {
      return questions.flatMap((q) => block(`${shown(q.header)}: ${shown(q.question)}`, width, S.dim, ""));
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP elicitation                                                     */
/* ------------------------------------------------------------------ */

function coerce(f, raw) {
  if (f.type === "boolean") return raw;
  if (f.type === "number" || f.type === "integer") {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) return undefined;
    if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return undefined;
    return n;
  }
  if (f.type === "string") {
    if ((f.minLength != null && raw.length < f.minLength) || (f.maxLength != null && raw.length > f.maxLength)) return undefined;
  }
  return raw;
}

function createElicitationModal(req, { now, armMs }) {
  const form = req.form ?? {};
  const fields = form.mode === "form" ? (form.fields ?? []) : [];
  const values = {};
  let fi = 0;
  let error = null;
  let list = null;
  let field = null;
  let multi = null; // Set of chosen values for a multiselect
  let done = false;

  function confirmChoices() {
    return createChoices(
      [
        { label: form.mode === "url" ? "Open it, then continue" : "Submit", key: "y", value: "accept" },
        { label: "Decline", key: "n", value: "decline", safe: true },
        { label: "Cancel", key: "esc", value: "cancel", safe: true },
      ].filter((c) => form.mode !== "openaiForm" || c.safe),
      { now, armMs },
    );
  }

  function setup() {
    error = null;
    field = null;
    multi = null;
    list = null;
    if (fi >= fields.length) {
      done = true;
      list = confirmChoices();
      return;
    }
    const f = fields[fi];
    if (f.type === "boolean") list = createChoices([{ label: "Yes", key: "y", value: true }, { label: "No", key: "n", value: false }], { now, armMs: 0 });
    else if (f.type === "select") list = createChoices(f.options.map((o, i) => ({ label: shown(o.label), key: i < 9 ? String(i + 1) : null, value: o.value })), { now, armMs: 0 });
    else if (f.type === "multiselect") {
      multi = new Set();
      list = createChoices(f.options.map((o, i) => ({ label: shown(o.label), key: i < 9 ? String(i + 1) : null, value: o.value })), { now, armMs: 0 });
    } else {
      field = createComposer({ mask: f.format === "password", pasteLines: Infinity, pasteChars: Infinity });
      if (f.default != null) field.set(String(f.default));
    }
  }
  setup();

  function store(f, v) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
      if (f.required) {
        error = `${shown(f.title)} is required${f.type === "number" || f.type === "integer" ? " (a number in range)" : ""}`;
        return { changed: true };
      }
    } else values[f.name] = v;
    fi++;
    setup();
    return { changed: true };
  }

  return {
    kind: "elicitation",
    handle(ev) {
      if (!done && ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return { answer: { action: "cancel" } };
      if (done) {
        const r = list.handle(ev);
        if (r && "answer" in r) return { answer: r.answer === "accept" ? { action: "accept", content: values } : { action: r.answer } };
        return r;
      }
      const f = fields[fi];
      if (field) {
        if (ev.type === "key" && ev.name === "enter" && !ev.alt) return store(f, coerce(f, field.expanded()));
        return field.handle(ev) ?? null;
      }
      if (multi) {
        if (ev.type === "key" && ev.name === "enter") {
          if (f.min != null && multi.size < f.min) {
            error = `Pick at least ${f.min}`;
            return { changed: true };
          }
          return store(f, [...multi]);
        }
        if (ev.type === "text" && ev.text === " ") {
          const v = f.options[list.index]?.value;
          if (multi.has(v)) multi.delete(v);
          else if (f.max == null || multi.size < f.max) multi.add(v);
          return { changed: true };
        }
        const r = list.handle(ev);
        if (r && "answer" in r) {
          if (multi.has(r.answer)) multi.delete(r.answer);
          else if (f.max == null || multi.size < f.max) multi.add(r.answer);
          return { changed: true };
        }
        return r;
      }
      const r = list.handle(ev);
      if (r && "answer" in r) return store(f, r.answer);
      return r;
    },
    render({ width = 80 } = {}) {
      const out = [];
      out.push(...block(`${shown(form.server ?? "An MCP server")} asks:`, width, S.title, ""));
      out.push(...block(shown(form.message), width));
      if (form.mode === "url" && form.url) out.push(...block(`URL: ${shown(form.url)}`, width, S.cmd));
      if (form.mode === "openaiForm") out.push(...block("This form needs the stock UI: answer it with /codex.", width, S.warn));
      if (!done) {
        const f = fields[fi];
        out.push([]);
        out.push(...block(`${shown(f.title)}${f.required ? " *" : ""} (${fi + 1}/${fields.length})`, width, S.title, ""));
        if (f.description) out.push(...block(shown(f.description), width, S.dim));
        if (list) {
          const rows = list.render(width);
          out.push(...(multi ? rows.map((l, i) => normalize([{ text: multi.has(f.options[i].value) ? "[x] " : "[ ] ", style: S.dim }, ...l])) : rows));
          if (multi) out.push([{ text: "  space toggles \u{b7} enter confirms", style: S.dim }]);
        }
        if (field) out.push(...field.render({ width, prompt: "\u{203a} " }).lines);
      } else {
        for (const f of fields) if (values[f.name] !== undefined) out.push(...block(`${shown(f.title)}: ${f.format === "password" ? "\u{2022}\u{2022}\u{2022}\u{2022}" : shown(JSON.stringify(values[f.name]))}`, width, S.dim));
        out.push([], ...list.render(width));
      }
      if (error) out.push(truncate([{ text: oneRow(error), style: S.warn }], width));
      return out;
    },
    history({ width = 80 } = {}) {
      return block(`${shown(form.server ?? "MCP")}: ${shown(form.message)}`, width, S.dim, "");
    },
  };
}

/* ------------------------------------------------------------------ */
/* A question ad asks itself                                           */
/* ------------------------------------------------------------------ */

/**
 * Yes or no, for a step ad takes on its own (codex-parity-2 1a: /archive,
 * /delete, /stop…). "No" comes first and is focused; Esc or Ctrl+C is "no"
 * at once; either answer waits for the arm delay, like an approval, so a key
 * typed before it opened (or held down) can't answer it.
 *   createConfirm({title, body, yes, no}, {now, armMs})
 *     .handle(ev) → {answer: true|false} | {changed: true} | null
 *     .render({width, height}) → lines
 */
export function createConfirm({ title, body = "", yes = "Yes", no = "No" } = {}, { now = () => Date.now(), armMs = ARM_MS } = {}) {
  const choices = createChoices(
    [
      { label: no, key: "n", value: false },
      { label: yes, key: "y", value: true },
    ],
    { now, armMs },
  );
  return {
    kind: "confirm",
    handle(ev) {
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return { answer: false };
      return choices.handle(ev);
    },
    render({ width = 80, height = 12 } = {}) {
      const head = [truncate([{ text: oneRow(shown(title)), style: S.title }], width), ...(body ? block(shown(body), width, S.dim) : []), []];
      const list = choices.render(width);
      const hint = truncate([{ text: choices.armed() ? "  y/n \u{b7} esc = no" : "  \u{2026}", style: S.dim }], width);
      // The choices always show; a long body is cut from its end.
      const room = Math.max(0, height - list.length - 1);
      return [...head.slice(0, room), ...list, hint];
    },
  };
}

/** The modal for a PendingRequest, or null for a kind no modal handles. */
export function createRequestModal(request, { now = () => Date.now(), armMs = ARM_MS, diff = null } = {}) {
  if (request?.kind?.startsWith("approval-")) return createApprovalModal(request, { now, armMs, diff });
  if (request?.kind === "user-input") return createUserInputModal(request, { now, armMs });
  if (request?.kind === "elicitation") return createElicitationModal(request, { now, armMs });
  return null;
}
