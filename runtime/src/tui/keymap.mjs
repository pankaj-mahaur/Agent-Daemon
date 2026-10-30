// Keys as actions (parity 1d), under the engine's contexts, action names
// and key spelling (codex-rs/config/src/tui_keymap.rs at the pinned tag), so
// `tui.keymap` in ad's config.toml means the same here as in the stock UI,
// whose /keymap edits it. Only the actions ad has are listed; an override for
// another one is ignored. ad reads tui.keymap and never writes it (P3).
//
//   createKeymap({overrides}) → {is(ctx, action, ev), keys(ctx, action), label(ctx, action), warnings}
//   parseKey("ctrl-t") → {key: "t", ctrl: true, alt: false, shift: false}
//
// A key spec is the engine's: modifiers `ctrl-` `alt-` `shift-` (in that order),
// then a printable character or a key name (enter, tab, backspace, esc,
// delete, up, down, left, right, home, end, page-up, page-down, space, minus,
// f1–f12). A binding may also be a two-stroke chord (`ctrl-x ctrl-s`) or a
// leader chord (`leader c`); see parseBinding and chords().

// The engine's defaults for the actions ad has. The comment names what ad does.
export const DEFAULT_KEYMAP = Object.freeze({
  global: {
    open_transcript: ["ctrl-t"], // the Ctrl+T pager
    open_external_editor: ["ctrl-g"], // edit the prompt in $EDITOR
    copy: ["ctrl-o"], // /copy
    clear_terminal: ["ctrl-l"], // ad redraws (the engine clears)
    toggle_raw_output: ["alt-r"], // /raw
    toggle_side_conversation: ["ctrl-/"], // focus between a /side panel and the main prompt
    find_transcript: ["f3"], // Find in the fullscreen transcript (inline: the pager in Find)
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
    find: ["f3", "/"], // Find in the pager
  },
});

// Contexts that are live at the same time: one key must not mean two actions there.
const TOGETHER = [["global", "chat", "composer"], ["global", "pager"]];
// Keys the composer itself uses for editing (not remappable in ad yet), and
// ad's own fixed keys: an override can't take them in the main contexts.
export const RESERVED = ["shift-tab", "enter", "ctrl-j", "ctrl-a", "ctrl-e", "ctrl-b", "ctrl-f", "ctrl-k", "ctrl-u", "ctrl-w", "ctrl-y", "ctrl-r", "ctrl-c", "alt-b", "alt-f", "up", "down", "left", "right", "home", "end", "backspace", "delete", "f2"];
// A context without its own binding for an action falls back to global's (upstream's rule).
const FALLBACK = "global";

const NAMES = new Set(["enter", "tab", "backspace", "esc", "delete", "up", "down", "left", "right", "home", "end", "page-up", "page-down", "space", "minus"]);
const ALIASES = { escape: "esc", return: "enter", spacebar: "space", pgup: "page-up", pageup: "page-up", pgdn: "page-down", pagedown: "page-down", del: "delete" };
// The engine's key name → the decoder's (tui/terminal/input.mjs).
const DECODER = { esc: "escape", "page-up": "pageup", "page-down": "pagedown", minus: "-" };

/** One stroke in the engine's spelling → {key, ctrl, alt, shift}; throws on what the engine would refuse. */
export function parseKey(spec) {
  const raw = String(spec ?? "").trim().toLowerCase();
  if (!raw) throw new Error("empty keybinding");
  if (/\s/.test(raw)) throw new Error(`"${spec}": ad doesn't support chords or leader keys yet`);
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

/**
 * A decoded key event in the engine's config spelling ("ctrl-t", "alt-.", "esc",
 * "page-up"), as /keymap debug shows it; null for what isn't a key.
 */
export function eventSpec(ev) {
  if (ev?.type !== "key" || !ev.name) return null;
  const back = Object.fromEntries(Object.entries(DECODER).map(([upstream, decoder]) => [decoder, upstream]));
  const name = back[ev.name] ?? ev.name;
  return [ev.ctrl && "ctrl", ev.alt && "alt", ev.shift && name.length > 1 && "shift", name].filter(Boolean).join("-");
}

/** "ctrl-t" → "ctrl+t", as ad shows keys. */
export const keyLabel = (spec) => (spec === "-" ? "-" : spec.replace(/-(?=.)/g, "+").replace(/^shift\+\?$/, "?").replace("page+up", "pgup").replace("page+down", "pgdn"));

/**
 * A binding in the engine's spelling → {leader, strokes}: one stroke
 * ("ctrl-t"), a two-stroke chord ("ctrl-x ctrl-s"), or a leader chord
 * ("leader c": the global.leader key, then c). Throws on what the engine
 * refuses: more than two strokes, `leader` without exactly one key, plain
 * esc in a chord (it cancels a pending chord).
 */
export function parseBinding(spec) {
  const raw = String(spec ?? "").trim().toLowerCase();
  if (!raw) throw new Error("empty keybinding");
  const words = raw.split(/\s+/);
  const leader = words[0] === "leader";
  const rest = leader ? words.slice(1) : words;
  if (leader && rest.length === 0) throw new Error(`"${spec}": leader needs one key after it`);
  if (words.length > 2) throw new Error(`"${spec}": key chords may have at most 2 strokes`);
  const strokes = rest.map(parseKey);
  if ((leader || strokes.length === 2) && strokes.some(isPlainEsc)) throw new Error(`"${spec}": plain esc cancels a pending chord, so it can't be in one`);
  return { leader, strokes };
}

const isPlainEsc = (s) => s.key === "esc" && !s.ctrl && !s.alt && !s.shift;
const isCharacter = (s) => s.key.length === 1 || s.key === "space";
const strokeId = (s) => JSON.stringify(s);
const isChordSpec = (spec) => /\s/.test(spec.trim());
const normSpec = (spec) => spec.trim().toLowerCase().split(/\s+/).join(" ");

// The engine's chord timeout (keymap/chords.rs KEY_CHORD_TIMEOUT); leader chords don't expire.
export const CHORD_TIMEOUT_MS = 1000;
const DEFAULT_LEADER = "ctrl-x";

/**
 * The keymap with `overrides` (the `tui.keymap` table) on top of ad's
 * defaults. An override that can't be read, or that would give one key two
 * meanings where they're live together, is dropped with a warning and the
 * default kept (one warning per bad value). Chords follow the engine's 0.163
 * rules (keymap/chords.rs, leader.rs); chords() matches them as keys arrive.
 */
export function createKeymap({ overrides = null, platform = process.platform } = {}) {
  const warnings = [];
  const map = {};
  for (const [ctx, actions] of Object.entries(DEFAULT_KEYMAP)) map[ctx] = Object.fromEntries(Object.entries(actions).map(([a, keys]) => [a, { keys: [...keys], custom: false }]));
  const restore = (ctx, action) => (map[ctx][action] = { keys: [...DEFAULT_KEYMAP[ctx][action]], custom: false });
  const singles = (b) => b.keys.filter((k) => !isChordSpec(k));
  const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : null);
  for (const [ctx, actions] of Object.entries(overrides && typeof overrides === "object" ? overrides : {})) {
    if (!actions || typeof actions !== "object") continue;
    for (const [action, value] of Object.entries(actions)) {
      // An action ad doesn't have (or a context it doesn't use) is the stock UI's business.
      if (!map[ctx]?.[action] && !(ctx === FALLBACK && Object.values(map).some((c) => c[action]))) continue;
      // The engine serialises an unset action as null: that's the default, not a mistake.
      if (value === null || value === undefined) continue;
      const list = asList(value);
      if (!list || list.some((k) => typeof k !== "string")) {
        warnings.push(`tui.keymap.${ctx}.${action}: not a key or a list of keys; ad keeps its default`);
        continue;
      }
      try {
        list.forEach(parseBinding);
      } catch (err) {
        warnings.push(`tui.keymap.${ctx}.${action}: ${err.message}; ad keeps its default`);
        continue;
      }
      const targets = map[ctx]?.[action] ? [[ctx, action]] : Object.entries(map).filter(([c, acts]) => c !== FALLBACK && acts[action] && !overrides?.[c]?.[action]).map(([c]) => [c, action]);
      for (const [c, a] of targets) map[c][a] = { keys: list.map(normSpec), custom: true };
    }
  }
  // A custom key the composer or ad already uses for something else gives way.
  const reserved = new Set(RESERVED.map((k) => strokeId(parseKey(k))));
  for (const ctx of TOGETHER[0]) {
    for (const [action, b] of Object.entries(map[ctx])) {
      const taken = b.custom && singles(b).find((k) => reserved.has(strokeId(parseKey(k))));
      if (!taken) continue;
      warnings.push(`tui.keymap.${ctx}.${action}: "${taken}" is one of ad's editing keys; ad keeps its default`);
      restore(ctx, action);
    }
  }
  // One key, two actions, in contexts that are live together: the custom one gives way.
  for (const group of TOGETHER) {
    const owner = new Map();
    for (const ctx of group) {
      for (const [action, b] of Object.entries(map[ctx] ?? {})) {
        for (const k of singles(b)) {
          const id = strokeId(parseKey(k));
          const prev = owner.get(id);
          if (!prev) {
            owner.set(id, { ctx, action, b });
            continue;
          }
          const loser = b.custom ? { ctx, action } : prev.b.custom ? prev : null;
          if (!loser) continue;
          warnings.push(`tui.keymap.${loser.ctx}.${loser.action}: "${k}" is already ${loser === prev ? `${ctx}.${action}` : `${prev.ctx}.${prev.action}`}; ad keeps its default`);
          restore(loser.ctx, loser.action);
        }
      }
    }
  }

  // The leader (keymap/leader.rs): global.leader, else ctrl-x unless a configured
  // key or chord already uses ctrl-x. It must be one key, with ctrl or alt when it
  // is a character; ctrl-z suspends on Unix; ad's reserved keys can't be it.
  const usesCtrlX = Object.values(map).some((acts) => Object.values(acts).some((b) => b.custom && b.keys.some((k) => {
    const p = parseBinding(k);
    return !p.leader && strokeId(p.strokes[0]) === strokeId(parseKey(DEFAULT_LEADER));
  })));
  const leaderSetting = overrides?.global?.leader;
  let leaders = [];
  if (leaderSetting === null || leaderSetting === undefined) {
    if (!usesCtrlX) leaders = [DEFAULT_LEADER];
  } else {
    const list = asList(leaderSetting);
    const why = (() => {
      if (!list || list.some((k) => typeof k !== "string")) return "not a key or a list of keys";
      for (const spec of list) {
        if (/\s/.test(spec.trim())) return "use a single prefix key";
        let s;
        try {
          s = parseKey(spec);
        } catch (err) {
          return err.message;
        }
        if (isCharacter(s) && !s.ctrl && !s.alt) return `"${spec}": use ctrl, alt, or a non-character key so typing isn't intercepted`;
        if (platform !== "win32" && s.key === "z" && s.ctrl && !s.alt && !s.shift) return `"${spec}": ctrl-z suspends the terminal`;
        if (reserved.has(strokeId(s))) return `"${spec}" is one of ad's editing keys`;
      }
      return null;
    })();
    if (why) warnings.push(`tui.keymap.global.leader: ${why}; ad has no leader key`);
    else leaders = list.map((k) => k.trim().toLowerCase());
  }
  const leaderStrokes = leaders.map(parseKey);

  // Chords: the shapes the engine refuses, the leader with no key, a prefix that
  // shadows a single key live in the same place, the same chord twice.
  const groupsOf = (ctx) => TOGETHER.filter((g) => g.includes(ctx));
  const liveTogether = (a, b) => a === b || groupsOf(a).some((g) => g.includes(b));
  const chordList = [];
  for (const [ctx, actions] of Object.entries(map)) {
    for (const [action, b] of Object.entries(actions)) {
      if (!b.custom) continue;
      const mine = [];
      let bad = null;
      for (const spec of b.keys.filter(isChordSpec)) {
        const p = parseBinding(spec);
        const completion = p.strokes.at(-1);
        const completionSpec = spec.split(" ").at(-1);
        const prefix = p.leader ? null : p.strokes[0];
        const prefixSpec = p.leader ? null : spec.split(" ")[0];
        if (p.leader && !leaderStrokes.length) bad = `"${spec}": global.leader has no key, so the chord can't start`;
        else if (prefix && isCharacter(prefix) && !prefix.ctrl && !prefix.alt) bad = `"${spec}": a chord's first key needs ctrl, alt, or a non-character key so typing isn't intercepted`;
        else if (TOGETHER[0].includes(ctx) && [prefix, completion].some((s) => s && reserved.has(strokeId(s)))) bad = `"${spec}" uses one of ad's editing keys`;
        else if (p.leader && leaderStrokes.some((l) => strokeId(l) === strokeId(completion))) bad = `"${spec}": the leader again cancels a pending chord`;
        else if (platform !== "win32" && p.strokes.some((s) => s.key === "z" && s.ctrl && !s.alt && !s.shift)) bad = `"${spec}": ctrl-z suspends the terminal`;
        if (!bad && prefix) {
          for (const [c2, acts] of Object.entries(map)) {
            if (!liveTogether(ctx, c2)) continue;
            const hit = Object.entries(acts).find(([, b2]) => singles(b2).some((k) => strokeId(parseKey(k)) === strokeId(prefix)));
            if (hit) {
              bad = `"${spec}": its first key is already ${c2}.${hit[0]}`;
              break;
            }
          }
        }
        if (!bad) {
          const dup = chordList.find((o) => liveTogether(o.ctx, ctx) && o.leader === p.leader && strokeId(o.prefix) === strokeId(prefix) && strokeId(o.completion) === strokeId(completion));
          if (dup) bad = `"${spec}": the same chord is already ${dup.ctx}.${dup.action}`;
        }
        if (bad) break;
        mine.push({ ctx, action, leader: p.leader, prefix, prefixSpec, completion, completionSpec, spec });
      }
      if (bad) {
        warnings.push(`tui.keymap.${ctx}.${action}: ${bad}; ad keeps its default`);
        restore(ctx, action);
      } else chordList.push(...mine);
    }
  }

  const parsed = {};
  for (const [ctx, actions] of Object.entries(map)) parsed[ctx] = Object.fromEntries(Object.entries(actions).map(([a, b]) => [a, singles(b).map(parseKey)]));
  // A chord's first keys: the leader's for a leader chord, else its own.
  const startsOf = (c) => (c.leader ? leaders.map((spec, i) => ({ stroke: leaderStrokes[i], spec })) : [{ stroke: c.prefix, spec: c.prefixSpec }]);
  const label = (spec) => (isChordSpec(spec) ? spec.split(" ").map((w) => (w === "leader" ? (leaders[0] ? keyLabel(leaders[0]) : "leader") : keyLabel(w))).join(" ") : keyLabel(spec));
  return {
    warnings,
    /** One line for /warnings (null when every key setting was usable); /keymap lists each. */
    summary: warnings.length ? `tui.keymap: ${warnings.length} key setting(s) ad can't use; it keeps its defaults. /keymap lists them.` : null,
    /** Every binding: [{ctx, action, keys, custom}], contexts and actions in ad's order. */
    bindings() {
      return Object.entries(map).flatMap(([ctx, actions]) => Object.entries(actions).map(([action, b]) => ({ ctx, action, keys: [...b.keys], custom: b.custom })));
    },
    /** Does `ev` press `action` in `ctx`? A completed chord ({type: "chord", ctx, action}) does too. */
    is(ctx, action, ev) {
      const ks = parsed[ctx]?.[action];
      if (!ks) throw new Error(`no action ${ctx}.${action} in ad's keymap`);
      if (ev?.type === "chord") return ev.ctx === ctx && ev.action === action;
      return ks.some((k) => matchKey(ev, k));
    },
    /** Its keys in the engine's spelling ([] when unbound). */
    keys(ctx, action) {
      return [...(map[ctx]?.[action]?.keys ?? [])];
    },
    /** How ad shows its keys: "ctrl+t", "alt+, / alt+.", "ctrl+x c", or "" when unbound. */
    label(ctx, action, { all = false } = {}) {
      const ks = map[ctx]?.[action]?.keys ?? [];
      return (all ? ks : ks.slice(0, 1)).map(label).join(" / ");
    },
    /** The leader key in the engine's spelling, or null. */
    leader() {
      return leaders[0] ?? null;
    },
    /**
     * Chord matching, one stroke at a time: feed(ev, contexts, now) →
     *   {kind: "pass"}: not part of a chord, handle ev as usual;
     *   {kind: "pending", hint}: a chord started (the key is used);
     *   {kind: "done", ev: {type: "chord", ctx, action}}: route ev like a key;
     *   {kind: "cancelled"}: Esc, or the leader again, ended a pending chord.
     * A second key that completes nothing is passed through (it may start
     * another chord); a pending chord ends when `contexts` change, and an
     * ordinary one 1 s after its first stroke.
     */
    chords() {
      let pending = null;
      const active = (c, contexts) => contexts.includes(c.ctx);
      const hint = (start, contexts) => [
        { keys: keyLabel(start.spec), label: "then" },
        ...chordList.filter((c) => active(c, contexts) && startsOf(c).some((s) => strokeId(s.stroke) === strokeId(start.stroke))).slice(0, 6).map((c) => ({ keys: keyLabel(c.completionSpec), label: c.action.replace(/_/g, " ") })),
        { keys: "esc", label: "cancel" },
      ];
      return {
        feed(ev, contexts, now) {
          if (!ev || (ev.type !== "key" && ev.type !== "text")) return { kind: "pass" };
          if (pending && (pending.contexts.join() !== contexts.join() || (pending.startedAt !== null && now - pending.startedAt >= CHORD_TIMEOUT_MS))) pending = null;
          if (pending) {
            const p = pending;
            pending = null;
            const esc = ev.type === "key" && ev.name === "escape" && !ev.ctrl && !ev.alt && !ev.shift;
            if (esc || (p.persistent && matchKey(ev, p.start.stroke))) return { kind: "cancelled" };
            const done = chordList.find((c) => active(c, contexts) && startsOf(c).some((s) => strokeId(s.stroke) === strokeId(p.start.stroke)) && matchKey(ev, c.completion));
            if (done) return { kind: "done", ev: { type: "chord", ctx: done.ctx, action: done.action } };
          }
          for (const c of chordList) {
            if (!active(c, contexts)) continue;
            const start = startsOf(c).find((s) => matchKey(ev, s.stroke));
            if (!start) continue;
            // As the engine: a chord that starts with the leader key waits for its second key
            // (spelled "leader c", or with the leader written out in a global context).
            const isLeader = leaderStrokes.some((l) => strokeId(l) === strokeId(start.stroke));
            const persistent = chordList.some((o) => active(o, contexts) && startsOf(o).some((s) => strokeId(s.stroke) === strokeId(start.stroke)) && (o.leader || (isLeader && contexts.includes("global"))));
            pending = { start, contexts: [...contexts], startedAt: persistent ? null : now, persistent };
            return { kind: "pending", hint: hint(start, contexts) };
          }
          return { kind: "pass" };
        },
        /** The pending chord ({keys, hint}) or null. */
        pending() {
          return pending ? { keys: keyLabel(pending.start.spec), hint: hint(pending.start, pending.contexts), expiresAt: pending.startedAt === null ? null : pending.startedAt + CHORD_TIMEOUT_MS } : null;
        },
        cancel() {
          pending = null;
        },
        /** Drops a pending ordinary chord whose time is up (for a timer); → whether it did. */
        expire(now) {
          if (!pending || pending.startedAt === null || now - pending.startedAt < CHORD_TIMEOUT_MS) return false;
          pending = null;
          return true;
        },
      };
    },
  };
}
