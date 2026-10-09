// Keys as actions (codex-parity-2 1d), under Codex's contexts, action names
// and key spelling (codex-rs/config/src/tui_keymap.rs at the pinned tag), so
// `tui.keymap` in ad's config.toml means the same here as in the stock UI,
// whose /keymap edits it. Only the actions ad has are listed; an override for
// another one is ignored. ad reads tui.keymap and never writes it (P3).
//
//   createKeymap({overrides}) → {is(ctx, action, ev), keys(ctx, action), label(ctx, action), warnings}
//   parseKey("ctrl-t") → {key: "t", ctrl: true, alt: false, shift: false}
//
// A key spec is Codex's: modifiers `ctrl-` `alt-` `shift-` (in that order),
// then a printable character or a key name (enter, tab, backspace, esc,
// delete, up, down, left, right, home, end, page-up, page-down, space, minus,
// f1–f12). Several strokes (`ctrl-x f`, a chord) aren't supported by ad yet.

// Codex's defaults for the actions ad has. The comment names what ad does.
export const DEFAULT_KEYMAP = Object.freeze({
  global: {
    open_transcript: ["ctrl-t"], // the Ctrl+T pager
    open_external_editor: ["ctrl-g"], // edit the prompt in $EDITOR
    copy: ["ctrl-o"], // /copy
    clear_terminal: ["ctrl-l"], // ad redraws (Codex clears)
    toggle_raw_output: ["alt-r"], // /raw
  },
  chat: {
    interrupt_turn: ["esc"],
    decrease_reasoning_effort: ["alt-,", "shift-down"],
    increase_reasoning_effort: ["alt-.", "shift-up"],
  },
  composer: {
    queue: ["tab"],
    toggle_shortcuts: ["?", "shift-?"],
  },
  pager: {
    scroll_up: ["up", "k"],
    scroll_down: ["down", "j"],
    page_up: ["page-up", "shift-space", "ctrl-b"],
    page_down: ["page-down", "space", "ctrl-f"],
    half_page_up: ["ctrl-u"],
    half_page_down: ["ctrl-d"],
    jump_top: ["home"],
    jump_bottom: ["end"],
    close: ["q", "ctrl-c"],
    close_transcript: ["ctrl-t"],
  },
});

// Contexts that are live at the same time: one key must not mean two actions there.
const TOGETHER = [["global", "chat", "composer"], ["global", "pager"]];
// Keys the composer itself uses for editing (not remappable in ad yet), and
// ad's own fixed keys: an override can't take them in the main contexts.
export const RESERVED = ["shift-tab", "enter", "ctrl-j", "ctrl-a", "ctrl-e", "ctrl-b", "ctrl-f", "ctrl-k", "ctrl-u", "ctrl-w", "ctrl-y", "ctrl-r", "ctrl-c", "alt-b", "alt-f", "up", "down", "left", "right", "home", "end", "backspace", "delete", "f2"];
// A context without its own binding for an action falls back to global's (Codex's rule).
const FALLBACK = "global";

const NAMES = new Set(["enter", "tab", "backspace", "esc", "delete", "up", "down", "left", "right", "home", "end", "page-up", "page-down", "space", "minus"]);
const ALIASES = { escape: "esc", return: "enter", spacebar: "space", pgup: "page-up", pageup: "page-up", pgdn: "page-down", pagedown: "page-down", del: "delete" };
// Codex's key name → the decoder's (tui/terminal/input.mjs).
const DECODER = { esc: "escape", "page-up": "pageup", "page-down": "pagedown", minus: "-" };

/** One stroke in Codex's spelling → {key, ctrl, alt, shift}; throws on what Codex would refuse. */
export function parseKey(spec) {
  const raw = String(spec ?? "").trim().toLowerCase();
  if (!raw) throw new Error("empty keybinding");
  if (/\s/.test(raw)) throw new Error(`key chords like "${spec}" aren't supported in ad yet`);
  // "-" alone (or as the last character, "ctrl--") is the minus key.
  const parts = raw === "-" ? ["-"] : raw.endsWith("--") ? [...raw.slice(0, -2).split("-"), "-"] : raw.split("-").filter(Boolean);
  const mods = { ctrl: false, alt: false, shift: false };
  let i = 0;
  for (; i < parts.length - 1; i++) {
    const m = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" }[parts[i]];
    if (!m) break;
    if (mods[m]) throw new Error(`duplicate modifier in "${spec}"`);
    mods[m] = true;
  }
  let key = parts.slice(i).join("-");
  key = ALIASES[key] ?? key;
  const fn = /^f(\d{1,2})$/.exec(key);
  if (!(key.length === 1 || NAMES.has(key) || (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 12))) throw new Error(`unknown key "${key}" in "${spec}"`);
  return { key, ...mods };
}

/** Does a decoder event press this stroke? */
export function matchKey(ev, k) {
  if (!ev) return false;
  if (ev.type === "text") {
    // Plain typing: one printable character, no Ctrl/Alt. Shift is in the character itself.
    if (k.ctrl || k.alt || ev.text.length !== 1) return false;
    if (k.key === "space") return ev.text === " " && !k.shift;
    if (k.key.length !== 1) return false;
    return k.shift && /[a-z]/.test(k.key) ? ev.text === k.key.toUpperCase() : ev.text === k.key;
  }
  if (ev.type !== "key") return false;
  const name = DECODER[k.key] ?? k.key;
  if (ev.name !== name || Boolean(ev.ctrl) !== k.ctrl || Boolean(ev.alt) !== k.alt) return false;
  // A shifted symbol ("?") may come with or without the shift flag, depending on the terminal.
  if (k.key.length === 1 && !/[a-z]/.test(k.key)) return true;
  return Boolean(ev.shift) === k.shift;
}

/** "ctrl-t" → "ctrl+t", as ad shows keys. */
export const keyLabel = (spec) => (spec === "-" ? "-" : spec.replace(/-(?=.)/g, "+").replace(/^shift\+\?$/, "?").replace("page+up", "pgup").replace("page+down", "pgdn"));

/**
 * The keymap with `overrides` (the `tui.keymap` table) on top of ad's
 * defaults. An override that can't be read, or that would give one key two
 * meanings where they're live together, is dropped with a warning and the
 * default kept.
 */
export function createKeymap({ overrides = null } = {}) {
  const warnings = [];
  const map = {};
  for (const [ctx, actions] of Object.entries(DEFAULT_KEYMAP)) map[ctx] = Object.fromEntries(Object.entries(actions).map(([a, keys]) => [a, { keys: [...keys], custom: false }]));
  const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : null);
  for (const [ctx, actions] of Object.entries(overrides && typeof overrides === "object" ? overrides : {})) {
    if (!actions || typeof actions !== "object") continue;
    for (const [action, value] of Object.entries(actions)) {
      // An action ad doesn't have (or a context it doesn't use) is the stock UI's business.
      if (!map[ctx]?.[action] && !(ctx === FALLBACK && Object.values(map).some((c) => c[action]))) continue;
      const list = asList(value);
      if (!list) {
        warnings.push(`tui.keymap.${ctx}.${action}: not a key or a list of keys; ad keeps its default`);
        continue;
      }
      try {
        list.forEach(parseKey);
      } catch (err) {
        warnings.push(`tui.keymap.${ctx}.${action}: ${err.message}; ad keeps its default`);
        continue;
      }
      const targets = map[ctx]?.[action] ? [[ctx, action]] : Object.entries(map).filter(([c, acts]) => c !== FALLBACK && acts[action] && !overrides?.[c]?.[action]).map(([c]) => [c, action]);
      for (const [c, a] of targets) map[c][a] = { keys: list.map((k) => k.trim().toLowerCase()), custom: true };
    }
  }
  // A custom key the composer or ad already uses for something else gives way.
  const reserved = new Set(RESERVED.map((k) => JSON.stringify(parseKey(k))));
  for (const ctx of TOGETHER[0]) {
    for (const [action, b] of Object.entries(map[ctx])) {
      const taken = b.custom && b.keys.find((k) => reserved.has(JSON.stringify(parseKey(k))));
      if (!taken) continue;
      warnings.push(`tui.keymap.${ctx}.${action}: "${taken}" is one of ad's editing keys; ad keeps its default`);
      map[ctx][action] = { keys: [...DEFAULT_KEYMAP[ctx][action]], custom: false };
    }
  }
  // One key, two actions, in contexts that are live together: the custom one gives way.
  for (const group of TOGETHER) {
    const owner = new Map();
    for (const ctx of group) {
      for (const [action, b] of Object.entries(map[ctx] ?? {})) {
        for (const k of b.keys) {
          const id = JSON.stringify(parseKey(k));
          const prev = owner.get(id);
          if (!prev) {
            owner.set(id, { ctx, action, b });
            continue;
          }
          const loser = b.custom ? { ctx, action } : prev.b.custom ? prev : null;
          if (!loser) continue;
          warnings.push(`tui.keymap.${loser.ctx}.${loser.action}: "${k}" is already ${loser === prev ? `${ctx}.${action}` : `${prev.ctx}.${prev.action}`}; ad keeps its default`);
          map[loser.ctx][loser.action] = { keys: [...DEFAULT_KEYMAP[loser.ctx][loser.action]], custom: false };
        }
      }
    }
  }
  const parsed = {};
  for (const [ctx, actions] of Object.entries(map)) parsed[ctx] = Object.fromEntries(Object.entries(actions).map(([a, b]) => [a, b.keys.map(parseKey)]));
  return {
    warnings,
    /** Does `ev` press `action` in `ctx`? */
    is(ctx, action, ev) {
      const ks = parsed[ctx]?.[action];
      if (!ks) throw new Error(`no action ${ctx}.${action} in ad's keymap`);
      return ks.some((k) => matchKey(ev, k));
    },
    /** Its keys in Codex's spelling ([] when unbound). */
    keys(ctx, action) {
      return [...(map[ctx]?.[action]?.keys ?? [])];
    },
    /** How ad shows its keys: "ctrl+t", "alt+, / alt+.", or "" when unbound. */
    label(ctx, action, { all = false } = {}) {
      const ks = map[ctx]?.[action]?.keys ?? [];
      return (all ? ks : ks.slice(0, 1)).map(keyLabel).join(" / ");
    },
  };
}
