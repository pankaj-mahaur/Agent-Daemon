// Keys as Codex's actions (tui/keymap.mjs, codex-parity-2 1d): Codex's key
// spelling, tui.keymap overrides, conflicts, and the docs naming every key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createKeymap, DEFAULT_KEYMAP, keyLabel, matchKey, parseKey } from "../src/tui/keymap.mjs";

const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const chr = (text) => ({ type: "text", text });

test("parseKey: Codex's spelling, aliases, and what Codex refuses", () => {
  assert.deepEqual(parseKey("Ctrl-T"), { key: "t", ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseKey("option-shift-up"), { key: "up", ctrl: false, alt: true, shift: true });
  assert.equal(parseKey("escape").key, "esc");
  assert.equal(parseKey("pgdn").key, "page-down");
  assert.equal(parseKey("ctrl--").key, "-");
  assert.equal(parseKey("f12").key, "f12");
  assert.throws(() => parseKey("ctrl-x f"), /chords/);
  assert.throws(() => parseKey("ctrl-ctrl-a"), /duplicate modifier/);
  assert.throws(() => parseKey("hyper-a"), /unknown key/);
  assert.throws(() => parseKey("f13"), /unknown key/);
  assert.throws(() => parseKey(""), /empty/);
});

test("matchKey: decoder events against strokes", () => {
  assert.ok(matchKey(key("t", { ctrl: true }), parseKey("ctrl-t")));
  assert.ok(!matchKey(key("t", { ctrl: true, alt: true }), parseKey("ctrl-t")), "extra modifiers don't match");
  assert.ok(matchKey(chr("?"), parseKey("?")));
  assert.ok(matchKey(key("?", { shift: true }), parseKey("?")), "a shifted symbol matches with or without the shift flag");
  assert.ok(matchKey(chr("G"), parseKey("shift-g")));
  assert.ok(!matchKey(chr("g"), parseKey("shift-g")));
  assert.ok(matchKey(chr(" "), parseKey("space")) && matchKey(key("space"), parseKey("space")));
  assert.ok(matchKey(key("space", { shift: true }), parseKey("shift-space")) && !matchKey(key("space", { shift: true }), parseKey("space")));
  assert.ok(matchKey(key("escape"), parseKey("esc")) && matchKey(key("pageup"), parseKey("page-up")));
  assert.ok(!matchKey(key("tab", { shift: true }), parseKey("tab")), "Shift+Tab isn't Tab");
  assert.ok(matchKey(key(",", { alt: true }), parseKey("alt-,")));
  assert.ok(!matchKey(chr("ab"), parseKey("a")), "a burst of text is not a key");
});

test("defaults: every action ad lists is one of Codex's, with Codex's default keys", () => {
  const km = createKeymap();
  assert.deepEqual(km.warnings, []);
  assert.ok(km.is("global", "open_transcript", key("t", { ctrl: true })));
  assert.ok(km.is("chat", "interrupt_turn", key("escape")));
  assert.ok(km.is("chat", "increase_reasoning_effort", key("up", { shift: true })));
  assert.ok(km.is("composer", "queue", key("tab")));
  assert.ok(km.is("pager", "page_down", chr(" ")));
  assert.throws(() => km.is("global", "open_agents", key("a")), /no action/);
  for (const ctx of Object.keys(DEFAULT_KEYMAP)) for (const action of Object.keys(DEFAULT_KEYMAP[ctx])) assert.match(action, /^[a-z_]+$/);
});

test("tui.keymap overrides: replace, a list, unbind, global fallback; unknown actions left to the stock UI", () => {
  const km = createKeymap({
    overrides: {
      global: { copy: "ctrl-x", queue: "alt-q", open_agents: "ctrl-a", toggle_fast_mode: "f9" },
      chat: { interrupt_turn: [] },
      pager: { close: ["x", "escape"] },
      approval: { approve: "y" },
    },
  });
  assert.deepEqual(km.warnings, []);
  assert.ok(km.is("global", "copy", key("x", { ctrl: true })) && !km.is("global", "copy", key("o", { ctrl: true })));
  assert.ok(km.is("composer", "queue", key("q", { alt: true })), "global.queue applies where the context has none (Codex's rule)");
  assert.ok(!km.is("chat", "interrupt_turn", key("escape")), "[] unbinds");
  assert.equal(km.label("chat", "interrupt_turn"), "");
  assert.ok(km.is("pager", "close", chr("x")) && km.is("pager", "close", key("escape")));
});

test("overrides ad can't use are dropped with a warning, and the default kept", () => {
  const km = createKeymap({
    overrides: {
      global: { copy: "ctrl-x f", toggle_raw_output: 42 },
      chat: { interrupt_turn: "ctrl-t" }, // already open_transcript
      composer: { toggle_shortcuts: "ctrl-a" }, // the composer's line start
      pager: { close: "hyper-q" },
    },
  });
  assert.equal(km.warnings.length, 5, km.warnings.join("\n"));
  assert.match(km.warnings.join("\n"), /chords/);
  assert.match(km.warnings.join("\n"), /not a key or a list of keys/);
  assert.match(km.warnings.join("\n"), /"ctrl-t" is already global\.open_transcript/);
  assert.match(km.warnings.join("\n"), /one of ad's editing keys/);
  assert.match(km.warnings.join("\n"), /unknown key/);
  assert.ok(km.is("chat", "interrupt_turn", key("escape")), "the default stays");
  assert.ok(km.is("global", "copy", key("o", { ctrl: true })));
});

test("labels: how ad shows keys", () => {
  assert.equal(keyLabel("ctrl-t"), "ctrl+t");
  assert.equal(keyLabel("alt-,"), "alt+,");
  assert.equal(keyLabel("page-up"), "pgup");
  assert.equal(keyLabel("-"), "-");
  assert.equal(createKeymap().label("chat", "decrease_reasoning_effort", { all: true }), "alt+, / shift+down");
});

// "ctrl-t" → "Ctrl+T", as docs/tui.md writes keys.
function docLabel(spec) {
  const k = parseKey(spec);
  const name = { up: "↑", down: "↓", left: "←", right: "→", "page-up": "PgUp", "page-down": "PgDn", esc: "Esc", tab: "Tab", space: "Space", home: "Home", end: "End", enter: "Enter" }[k.key] ?? (/^f\d+$/.test(k.key) ? k.key.toUpperCase() : k.key.length === 1 && /[a-z]/.test(k.key) && (k.ctrl || k.alt || k.shift) ? k.key.toUpperCase() : k.key);
  const mods = [k.ctrl && "Ctrl", k.alt && "Alt", k.shift && "Shift"].filter(Boolean);
  return mods.length ? `${mods.join("+")}+${name}` : /^[\x21-\x7e]$/.test(name) ? `\`${name}\`` : name;
}

test("docs/tui.md names every default key of every action ad has", () => {
  const docs = readFileSync(new URL("../../docs/tui.md", import.meta.url), "utf8");
  const keys = docs.slice(docs.indexOf("## Keys"), docs.indexOf("## Approvals"));
  const missing = [];
  for (const [ctx, actions] of Object.entries(DEFAULT_KEYMAP)) {
    for (const [action, specs] of Object.entries(actions)) {
      for (const spec of specs) if (spec !== "shift-?" && !keys.includes(docLabel(spec))) missing.push(`${ctx}.${action}: ${docLabel(spec)}`);
    }
  }
  assert.deepEqual(missing, [], "add these to the Keys section of docs/tui.md");
});
