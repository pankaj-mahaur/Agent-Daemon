// Chrome and popups (plan Part 5d): the header card, the status line, the
// adaptive footer, the `?` shortcut overlay and a filterable list picker.
// Pure; values that come from outside (folder, model, account, branch) are
// sanitized here.
//
//   renderHeader({title, rows}, {width})      rows: [{label, value, hint}]
//   renderStatus({label, elapsedMs, frame, queued}, {width})
//   renderFooter({hints, chips, meters}, {width})
//   newlineHint({terminal, csiU})
//   renderShortcuts({newline}, {width})
//   createPicker({items, title, placeholder}) → {handle, render}
//   createChecklist({items, title, reorder, onChange}) → {handle, render, values}

import { sanitize } from "../terminal/sanitize.mjs";
import { lineWidth, normalize, truncate } from "../terminal/text.mjs";
import { stringWidth } from "../terminal/width.mjs";
import { createComposer } from "./composer.mjs";
import { T } from "./theme.mjs";

const S = {
  border: T.dim,
  label: T.dim,
  hint: T.dim,
  title: T.bold,
  accent: T.accent,
  dim: T.dim,
  warn: T.warning,
  sel: T.accent,
};

const clean = (t) => sanitize(String(t ?? ""), "transcript").replace(/\s*\n\s*/g, " ").replace(/\t/g, " ");
const pad = (n) => ({ text: " ".repeat(Math.max(0, n)) });

/** "D:\a\b\c\project" → "D:\…\c\project" when it is too wide. */
export function shortenPath(path, max) {
  const p = clean(path);
  if (stringWidth(p) <= max) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep);
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const out = [parts[0], "\u{2026}", ...parts.slice(parts.length - keep)].join(sep);
    if (stringWidth(out) <= max) return out;
  }
  return truncate([{ text: p }], max)[0]?.text ?? "";
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

/**
 * The boxed header card. Lines are at most `width - 2` wide (78 at 80
 * columns). Under 40 columns it is one line: the title.
 */
export function renderHeader({ title, rows = [] }, { width = 80 } = {}) {
  if (width < 40) return [truncate([{ text: clean(title), style: S.title }], width)];
  const inner = Math.min(74, width - 6); // text cells between "│ " and " │": 78 wide at 80 columns
  const labelW = Math.max(0, ...rows.map((r) => (r.label ? stringWidth(r.label) + 2 : 0)));
  const row = (spans) => {
    const cut = truncate(spans, inner);
    return normalize([{ text: "\u{2502} ", style: S.border }, ...cut, pad(inner - lineWidth(cut)), { text: " \u{2502}", style: S.border }]);
  };
  const out = [[{ text: `\u{256d}${"\u{2500}".repeat(inner + 2)}\u{256e}`, style: S.border }]];
  out.push(row([{ text: clean(title), style: S.title }]));
  if (rows.length) out.push(row([]));
  for (const r of rows) {
    const label = r.label ? [{ text: `${r.label}:`.padEnd(labelW), style: S.label }] : [];
    const room = inner - labelW;
    const hint = r.hint ? clean(r.hint) : "";
    // The hint goes right when the value leaves room for it, else it is dropped.
    const valueMax = hint && room - stringWidth(hint) - 2 >= 12 ? room - stringWidth(hint) - 2 : room;
    const value = r.path ? shortenPath(r.value, valueMax) : (truncate([{ text: clean(r.value) }], valueMax)[0]?.text ?? "");
    const spans = [...label, { text: value, style: r.warn ? S.warn : undefined }];
    if (hint && valueMax < room) spans.push(pad(room - stringWidth(value) - stringWidth(hint)), { text: hint, style: S.hint });
    out.push(row(spans));
  }
  out.push([{ text: `\u{2570}${"\u{2500}".repeat(inner + 2)}\u{256f}`, style: S.border }]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Status line and footer                                              */
/* ------------------------------------------------------------------ */

const FRAMES = ["\u{25e6}", "\u{2022}"];

function duration(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "◦ Working (14s · esc to interrupt)" and the queued prompts under it. */
export function renderStatus({ label = "Working", elapsedMs = 0, frame = 0, queued = [], interruptKey = "esc" } = {}, { width = 80 } = {}) {
  const out = [
    truncate([{ text: `${FRAMES[frame % FRAMES.length]} `, style: S.accent }, { text: clean(label), style: S.title }, { text: ` (${duration(elapsedMs)} \u{b7} ${interruptKey} to interrupt)`, style: S.dim }], width),
  ];
  queued.forEach((q, i) => {
    const hint = i === queued.length - 1 ? "tab: edit" : "";
    const head = [{ text: "  \u{21b3} queued: ", style: S.dim }];
    const room = width - lineWidth(head) - (hint ? stringWidth(hint) + 2 : 0);
    const text = truncate([{ text: clean(q) }], Math.max(1, room));
    const line = [...head, ...text];
    if (hint && room > 4) line.push(pad(width - lineWidth(line) - stringWidth(hint)), { text: hint, style: S.dim });
    out.push(truncate(line, width));
  });
  return out;
}

/** The newline key to advertise (FC0): never Alt+Enter, Windows Terminal's fullscreen toggle. */
export function newlineHint({ terminal = "unknown", csiU = false } = {}) {
  if (csiU || terminal === "zed") return "shift+enter";
  if (terminal === "windows-terminal") return "ctrl+enter";
  return "ctrl+j";
}

/**
 * hints: ["? shortcuts", …] on the left; chips [{full, short}] and meters
 * [{text, warn}] on the right. Too wide: hints go first (from the end), then
 * chips shorten, then chips go, and meters last.
 */
export function renderFooter({ hints = [], chips = [], meters = [] } = {}, { width = 80 } = {}) {
  let h = hints.map(clean);
  let c = chips.map((x) => ({ text: clean(x.full), short: clean(x.short ?? x.full) }));
  let m = meters.map((x) => ({ text: clean(x.text), warn: !!x.warn }));
  const build = () => {
    const left = h.length ? [{ text: `  ${h.join(" \u{b7} ")}`, style: S.dim }] : [];
    const right = [];
    [...m.map((x) => ({ text: x.text, style: x.warn ? S.warn : S.dim })), ...c.map((x) => ({ text: x.text, style: S.dim }))].forEach((x, i) => {
      if (i) right.push({ text: " \u{b7} ", style: S.dim });
      right.push(x);
    });
    const gap = width - lineWidth(left) - lineWidth(right);
    return { line: normalize([...left, pad(Math.max(left.length && right.length ? 3 : 0, gap)), ...right]), fits: gap >= (left.length && right.length ? 3 : 0) };
  };
  for (;;) {
    const { line, fits } = build();
    if (fits || (!h.length && !c.length && !m.length)) return truncate(line, width);
    if (h.length) h = h.slice(0, -1);
    else if (c.some((x) => x.text !== x.short)) c = c.map((x) => ({ ...x, text: x.short }));
    else if (c.length) c = c.slice(0, -1);
    else m = m.slice(0, -1);
  }
}

/* ------------------------------------------------------------------ */
/* Popups                                                              */
/* ------------------------------------------------------------------ */

/** The `?` overlay. */
export function renderShortcuts({ newline = "ctrl+j", keymap = null } = {}, { width = 80 } = {}) {
  // Keys that can be remapped (tui.keymap) come from the keymap; the rest are fixed.
  const k = (ctx, action, fallback) => (keymap ? keymap.label(ctx, action) : fallback);
  const keys = [
    ["enter", "send (steers a running turn)"],
    [newline, "new line (\\ + enter works too)"],
    [k("composer", "queue", "tab"), "queue for after this turn"],
    [k("chat", "interrupt_turn", "esc"), "interrupt the turn"],
    ["ctrl+c", "clear, interrupt, then quit"],
    ["\u{2191} / \u{2193}", "history (at the first/last line)"],
    ["ctrl+r", "search history"],
    ["@", "mention a file"],
    ["/", "commands"],
    ["!", "run a shell command (unsandboxed)"],
    ["esc esc", "rewind to an earlier prompt"],
    [k("global", "open_transcript", "ctrl+t"), "the whole transcript"],
    [k("global", "open_external_editor", "ctrl+g"), "edit the prompt in your editor"],
    [`${k("chat", "decrease_reasoning_effort", "alt+,")} ${k("chat", "increase_reasoning_effort", "alt+.")}`, "lower / raise reasoning effort"],
    [k("global", "copy", "ctrl+o"), "copy the last answer"],
    [k("global", "toggle_raw_output", "alt+r"), "the last answer as plain text"],
    ["f2", "warnings"],
    [k("global", "clear_terminal", "ctrl+l"), "redraw the screen"],
  ].filter(([key]) => key.trim()); // an unbound action isn't listed
  const kw = Math.max(...keys.map(([key]) => stringWidth(key))) + 2;
  return [
    [{ text: "Shortcuts", style: S.title }],
    ...keys.map(([k, what]) => truncate([{ text: `  ${k.padEnd(kw)}`, style: S.accent }, { text: what }], width)),
  ];
}

/**
 * A list of options to switch on and off (codex-parity-2 1b: /statusline,
 * /title…): ↑/↓ move, Space toggles, ←/→ move the current option up or down
 * the order (with `reorder`), Enter saves, Esc cancels. `onChange(values)`
 * sees every change, for a live preview.
 *   items: [{label, hint?, value, checked?}]
 *   handle(ev) → {select: [values checked, in order]} | {cancel: true} | {changed: true} | null
 */
export function createChecklist({ items = [], title = "", reorder = false, onChange = null } = {}) {
  const list = items.map((it) => ({ ...it, checked: Boolean(it.checked) }));
  let index = 0;
  let top = 0;
  const values = () => list.filter((it) => it.checked).map((it) => it.value);
  const changed = () => {
    onChange?.(values());
    return { changed: true };
  };
  return {
    handle(ev) {
      if (ev.type !== "key" && ev.type !== "text") return null;
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return { cancel: true };
      if (ev.type === "key" && ev.name === "enter" && !ev.alt) return { select: values() };
      if (ev.type === "key" && (ev.name === "up" || ev.name === "down") && !ev.alt) {
        if (list.length) index = (index + (ev.name === "up" ? -1 : 1) + list.length) % list.length;
        return { changed: true };
      }
      if (reorder && ev.type === "key" && (ev.name === "left" || ev.name === "right")) {
        const to = index + (ev.name === "left" ? -1 : 1);
        if (to < 0 || to >= list.length) return { changed: false };
        [list[index], list[to]] = [list[to], list[index]];
        index = to;
        return changed();
      }
      if ((ev.type === "key" && ev.name === "space") || (ev.type === "text" && ev.text === " ")) {
        if (!list[index]) return { changed: false };
        list[index].checked = !list[index].checked;
        return changed();
      }
      return { changed: false }; // a checklist takes every key while it's open
    },
    render({ width = 80, height = 10 } = {}) {
      const out = [];
      if (title) out.push(truncate([{ text: clean(title), style: S.title }], width));
      const hint = truncate([{ text: `  space toggles${reorder ? " \u{b7} \u{2190}\u{2192} reorder" : ""} \u{b7} enter saves \u{b7} esc cancels`, style: S.dim }], width);
      const rows = Math.max(1, height - out.length - 1);
      index = Math.min(index, Math.max(0, list.length - 1));
      if (index < top) top = index;
      if (index >= top + rows) top = index - rows + 1;
      for (let i = top; i < Math.min(list.length, top + rows); i++) {
        const it = list[i];
        const cur = i === index;
        const line = [{ text: cur ? "\u{203a} " : "  ", style: S.sel }, { text: it.checked ? "[x] " : "[ ] ", style: it.checked ? S.accent : S.dim }, { text: clean(it.label), style: cur ? S.sel : undefined }];
        if (it.hint) line.push({ text: `  ${clean(it.hint)}`, style: S.dim });
        out.push(truncate(line, width));
      }
      out.push(hint);
      return out;
    },
    get values() {
      return values();
    },
  };
}

/**
 * A filterable list: typing filters (every word must match, case-folded),
 * ↑/↓ move, Enter picks, Esc closes.
 * items: [{label, hint?, value}]
 */
export function createPicker({ items = [], title = "", placeholder = "type to filter", showQuery = true } = {}) {
  const query = createComposer();
  let index = 0;
  let top = 0;

  const filtered = () => {
    const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      const hay = `${clean(it.label)} ${clean(it.hint ?? "")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  };

  return {
    handle(ev) {
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return { cancel: true };
      const list = filtered();
      if (ev.type === "key" && (ev.name === "up" || ev.name === "down")) {
        if (list.length) index = (index + (ev.name === "up" ? -1 : 1) + list.length) % list.length;
        return { changed: true };
      }
      if (ev.type === "key" && (ev.name === "enter" || ev.name === "tab") && !ev.alt) {
        const it = list[index];
        return it ? { select: it.value, item: it } : { changed: false };
      }
      const r = query.handle(ev);
      index = 0;
      top = 0;
      return r && "submit" in r ? { changed: true } : (r ?? null);
    },
    render({ width = 80, height = 10 } = {}) {
      const list = filtered();
      index = Math.min(index, Math.max(0, list.length - 1));
      const rows = Math.max(1, height - (showQuery ? 2 : 1));
      if (index < top) top = index;
      if (index >= top + rows) top = index - rows + 1;
      const out = [];
      const q = query.render({ width, prompt: title ? `${clean(title)} \u{203a} ` : "\u{203a} ", placeholder });
      if (showQuery) out.push(...q.lines.slice(0, 1));
      if (!list.length) out.push([{ text: "  no matches", style: S.dim }]);
      for (let i = top; i < Math.min(list.length, top + rows); i++) {
        const it = list[i];
        const cur = i === index;
        const line = [{ text: cur ? "\u{203a} " : "  ", style: S.sel }, { text: clean(it.label), style: cur ? S.sel : undefined }];
        if (it.hint) line.push({ text: `  ${clean(it.hint)}`, style: S.dim });
        out.push(truncate(line, width));
      }
      if (list.length > top + rows) out.push([{ text: `  \u{2026} ${list.length - top - rows} more`, style: S.dim }]);
      return out;
    },
    get query() {
      return query.text;
    },
  };
}
