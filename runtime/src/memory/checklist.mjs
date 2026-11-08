// The review checklist's model (L5 design decision 11): pure, no I/O. The driver
// (checklist-run.mjs) feeds it key names from keys.mjs and draws it with
// checklist-view.mjs; apply (checklist-apply.mjs) carries out its plan.
//
//   const s = createChecklist(rows, { pageSize, screen });
//   const s2 = press(s, "space");          // a new state; s is never changed
//   plan(s2)                                // what enter + y would apply
//
// Rows (checklist-rows.mjs builds them from L4b's reviewQueue and the store):
//   { key, kind, group, ids, text, source, status, flagged?, secret?, accepted?, units?, files? }
//   kind: note | repeat | file | removed | flagged | forget-requested | hidden | marked
// Two verbs per row: space = yes, x = no (what they mean depends on the row: VERBS).
// Movement keys never decide anything. `a` selects only unflagged rows of group 1 on the
// visible page (a second `a` adds group 2's); nothing else is ever bulk-selected.

export const GROUPS = Object.freeze([
  { id: "forget", title: "The agent asked to forget" },
  { id: "new", title: "New from your prompts" },
  { id: "agent", title: "Saved by the agent" },
  { id: "history", title: "From your history" },
  { id: "files", title: "From your instruction files" },
  { id: "gone", title: "No longer in your instruction files" },
  { id: "flagged", title: "Flagged for a closer look" },
  { id: "marked", title: "You asked to remove" },
  { id: "removed", title: "Removed (restore within 7 days)" },
]);
const ORDER = GROUPS.map((g) => g.id);

/** What space (yes) and x (no) do on each kind of row, as the focused row's second line says. */
export const VERBS = Object.freeze({
  note: { yes: "start using", no: "delete" },
  repeat: { yes: "start using", no: "delete" },
  file: { yes: "start using the chosen lines", no: "delete every line" },
  flagged: { yes: "start using (then y to confirm)", no: "delete" },
  "flagged-secret": { yes: null, no: "delete (it holds what looks like a secret)" },
  "forget-requested": { yes: "keep in use", no: "forget for good" },
  removed: { yes: "keep", no: "forget for good" },
  marked: { yes: "keep it", no: "delete" },
  hidden: { yes: "restore", no: "leave removed" },
});

// A row holding what looks like a secret can only be deleted, whatever its kind (L1).
const verbsOf = (row) => VERBS[row.secret ? "flagged-secret" : row.kind === "flagged" || row.flagged ? "flagged" : row.kind] ?? VERBS.note;

// Text from any writer, as one plain line: no control or format characters (M3).
const oneLine = (t) => String(t ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();

// Kinds `a` may select, and the groups it reaches (first press, second press).
const BULK_KINDS = new Set(["note"]);
const BULK_GROUPS = [["new"], ["new", "agent"]];

/**
 * A new checklist.
 * @param {object[]} rows
 * @param {{pageSize?:number}} [o]  pageSize: the lines a page may use (rows and group headers)
 */
export function createChecklist(rows, { pageSize = 10 } = {}) {
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  const forget = sorted.filter((r) => r.group === "forget");
  const s = {
    rows: Object.freeze(sorted.map((r) => Object.freeze({ ...r }))),
    choice: Object.freeze({}), // key → "yes" | "no"
    units: Object.freeze({}), // file row key → ids chosen (default: all)
    edits: Object.freeze({}), // key → edited text
    bulk: 0, // presses of `a` on the current page
    focus: 0, // index into visible()
    page: 0,
    pageSize: Math.max(2, pageSize),
    // The agent's forget requests start as a one-line banner, expanded with ↑ (decision 11).
    expanded: forget.length === 0,
    mode: "list", // list | confirm-flagged | units | edit | summary | quit | help | done | quit-done
    pending: null, // key awaiting the flagged confirm
    open: null, // the file row whose units are open
    unitFocus: 0,
    buffer: "", // the one-line editor's text
    message: null,
  };
  const vis = visible(s);
  const first = vis.findIndex((r) => r.group === "new");
  s.focus = first >= 0 ? first : 0;
  s.page = pageOf(s, s.focus);
  return Object.freeze(s);
}

/** The rows shown in the list (the forget group only once expanded). */
export function visible(s) {
  return s.rows.filter((r) => s.expanded || r.group !== "forget");
}

/**
 * Where each page starts (indexes into visible()): a page holds rows and a header line
 * for each group that starts on it, within pageSize lines.
 */
export function pageStarts(s) {
  const rows = visible(s);
  const starts = [0];
  let used = 0;
  let group = null;
  rows.forEach((r, i) => {
    const cost = 1 + (r.group !== group ? 1 : 0);
    if (used > 0 && used + cost > s.pageSize) {
      starts.push(i);
      used = 2; // the next page starts with this row's group header
    } else used += cost;
    group = r.group;
  });
  return starts;
}

/** The page a row index is on. */
export function pageOf(s, index) {
  const starts = pageStarts(s);
  let p = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= index) p = i;
  return p;
}

/** The rows of the current page. */
export function pageRows(s) {
  const starts = pageStarts(s);
  return visible(s).slice(starts[s.page] ?? 0, starts[s.page + 1] ?? undefined);
}

/** The checklist for a new page size (the terminal was resized): same choices and focus. */
export function repage(s, pageSize) {
  const next = Object.freeze({ ...s, pageSize: Math.max(2, pageSize) });
  return Object.freeze({ ...next, page: pageOf(next, next.focus), bulk: 0 });
}

export const focused = (s) => visible(s)[s.focus] ?? null;
const set = (s, patch) => Object.freeze({ ...s, ...patch });
const withChoice = (s, key, value) => {
  const choice = { ...s.choice };
  if (value) choice[key] = value;
  else delete choice[key];
  return Object.freeze(choice);
};
const move = (s, focus) => {
  const n = visible(s).length;
  const f = Math.max(0, Math.min(n - 1, focus));
  const page = pageOf(s, f);
  return set(s, { focus: f, page, bulk: page === s.page ? s.bulk : 0, message: null });
};

/** How many choices are made. */
export const choiceCount = (s) => Object.keys(s.choice).length;

/**
 * Apply one key. → a new state. Keys: up down pgup pgdn home end space x a e right left
 * enter esc q ? y n ctrl-c backspace, and {char:"…"} in the editor.
 * @param {object} s
 * @param {string|{char:string}} key
 * @param {{screen?:(text:string)=>{flags:string[]}}} [o]  re-screens an edit
 */
export function press(s, key, { screen } = {}) {
  if (s.mode === "done" || s.mode === "quit-done") return s;
  if (key === "ctrl-c") return set(s, { mode: "quit-done" });
  switch (s.mode) {
    case "help":
      return set(s, { mode: "list" });
    case "confirm-flagged":
      if (key === "y") return set(s, { mode: "list", pending: null, choice: withChoice(s, s.pending, "yes"), message: null });
      return set(s, { mode: "list", pending: null, message: "Not chosen." });
    case "summary":
      if (key === "y") return set(s, { mode: "done" });
      return set(s, { mode: "list", message: null });
    case "quit":
      if (key === "y") return set(s, { mode: "quit-done" });
      return set(s, { mode: "list", message: null });
    case "units":
      return pressUnits(s, key);
    case "edit":
      return pressEdit(s, key, screen);
    default:
      return pressList(s, key);
  }
}

function pressList(s, key) {
  const vis = visible(s);
  const row = vis[s.focus] ?? null;
  switch (key) {
    case "up":
    case "k":
      // ↑ on the first row opens the agent's forget requests (decision 11's banner): they go
      // in above it, and focus lands on the nearest of them.
      if (!s.expanded && s.focus === 0 && s.rows.some((r) => r.group === "forget")) {
        const count = s.rows.filter((r) => r.group === "forget").length;
        return move(set(s, { expanded: true }), count - 1);
      }
      return move(s, s.focus - 1);
    case "down":
    case "j":
      return move(s, s.focus + 1);
    case "pgup":
      return move(s, s.page > 0 ? pageStarts(s)[s.page - 1] : 0);
    case "pgdn":
      return move(s, pageStarts(s)[s.page + 1] ?? visible(s).length - 1);
    case "home":
      return move(s, 0);
    case "end":
      return move(s, vis.length - 1);
    case "space":
      return row ? yes(s, row) : s;
    case "x":
      if (!row) return s;
      return set(s, { choice: withChoice(s, row.key, s.choice[row.key] === "no" ? null : "no"), message: null });
    case "a":
      return bulk(s);
    case "e":
      if (!row || !["note", "repeat"].includes(row.kind)) return set(s, { message: "Only a waiting note can be edited." });
      if (row.flagged || row.secret) return set(s, { message: "A flagged note can't be edited here: space then y to use it, x to delete it." });
      return set(s, { mode: "edit", buffer: s.edits[row.key] ?? oneLine(row.text), message: null });
    case "right":
      if (row?.kind !== "file") return s;
      return set(s, { mode: "units", open: row.key, unitFocus: 0, message: null });
    case "enter":
      if (!choiceCount(s)) return set(s, { message: "Nothing chosen yet: space to use, x to delete." });
      return set(s, { mode: "summary", message: null });
    case "q":
    case "esc":
      return choiceCount(s) ? set(s, { mode: "quit" }) : set(s, { mode: "quit-done" });
    case "?":
      return set(s, { mode: "help" });
    default:
      return s;
  }
}

function yes(s, row) {
  if (s.choice[row.key] === "yes") return set(s, { choice: withChoice(s, row.key, null), message: null });
  const v = verbsOf(row);
  if (!v.yes) return set(s, { message: "This one holds what looks like a secret: it can only be deleted (x)." });
  if (row.kind === "flagged" || row.flagged) return set(s, { mode: "confirm-flagged", pending: row.key, message: null });
  return set(s, { choice: withChoice(s, row.key, "yes"), message: null });
}

// `a`: unflagged note rows of group 1 on this page; again: group 2's too. Never anything else.
function bulk(s) {
  const level = Math.min(s.bulk, BULK_GROUPS.length - 1);
  const groups = BULK_GROUPS[level];
  let choice = { ...s.choice };
  let n = 0;
  for (const r of pageRows(s)) {
    if (!groups.includes(r.group) || !BULK_KINDS.has(r.kind) || r.flagged || r.secret || r.accepted) continue;
    if (choice[r.key] !== "yes") n++;
    choice[r.key] = "yes";
  }
  const msg = n ? `Chose ${n} on this page${level === 0 ? " · a again adds the agent's" : ""}.` : level === 0 && pageRows(s).some((r) => r.group === "agent") ? "Nothing new from your prompts here · a again adds the agent's." : "Nothing here can be chosen in bulk.";
  return set(s, { choice: Object.freeze(choice), bulk: s.bulk + 1, message: msg });
}

function pressUnits(s, key) {
  const row = s.rows.find((r) => r.key === s.open);
  const units = row?.units ?? [];
  const chosen = new Set(s.units[s.open] ?? units.map((u) => u.id));
  switch (key) {
    case "up":
    case "k":
      return set(s, { unitFocus: Math.max(0, s.unitFocus - 1) });
    case "down":
    case "j":
      return set(s, { unitFocus: Math.min(units.length - 1, s.unitFocus + 1) });
    case "space": {
      const u = units[s.unitFocus];
      if (!u) return s;
      if (chosen.has(u.id)) chosen.delete(u.id);
      else chosen.add(u.id);
      const map = { ...s.units, [s.open]: Object.freeze([...chosen]) };
      // Choosing lines chooses the file; none chosen un-chooses it.
      return set(s, { units: Object.freeze(map), choice: withChoice(s, s.open, chosen.size ? "yes" : null) });
    }
    case "left":
    case "esc":
    case "enter":
    case "q":
      return set(s, { mode: "list", open: null });
    default:
      return s;
  }
}

function pressEdit(s, key, screen) {
  const row = focused(s);
  if (key === "esc") return set(s, { mode: "list", buffer: "", message: "Edit dropped." });
  if (key === "enter") {
    const text = oneLine(s.buffer);
    if (!text) return set(s, { mode: "list", buffer: "", message: "An empty note isn't saved: x deletes it." });
    // Unchanged: a plain yes (the note keeps where it came from).
    if (text === oneLine(row.text)) {
      const edits = { ...s.edits };
      delete edits[row.key];
      return set(s, { mode: "list", buffer: "", edits: Object.freeze(edits), choice: withChoice(s, row.key, "yes"), message: null });
    }
    // The edit is screened like any capture, by the row's own words rule: a flagged edit
    // isn't taken (decision 11).
    const flags = screen ? screen(text, { userWords: row.group === "new" }).flags ?? [] : [];
    if (flags.length) return set(s, { mode: "list", buffer: "", message: `Edit not taken: it mentions ${flags[0]}.` });
    const edits = { ...s.edits, [row.key]: text };
    return set(s, { mode: "list", buffer: "", edits: Object.freeze(edits), choice: withChoice(s, row.key, "yes"), message: null });
  }
  if (key === "backspace") return set(s, { buffer: [...s.buffer].slice(0, -1).join("") });
  if (key && typeof key === "object" && typeof key.char === "string") return set(s, { buffer: (s.buffer + key.char).slice(0, 2000) });
  if (key === "space") return set(s, { buffer: (s.buffer + " ").slice(0, 2000) });
  return s;
}

/**
 * What enter + y applies. Each decision once, by row:
 *   accept   [{ids, text?, flagged, provisional, kind, source}]   (file rows: the chosen lines)
 *   delete   [{ids, text}]       hard delete (with L4b's rejection record and the tombstone)
 *   forget   [ids]               an accepted note for good
 *   keep     [ids]               a forget request answered "keep in use"
 *   restore  [ids]               a removed note back to waiting
 *   unmark   [ids]               "You asked to remove", kept
 */
export function plan(s) {
  const out = { accept: [], delete: [], forget: [], keep: [], restore: [], unmark: [] };
  for (const r of s.rows) {
    const c = s.choice[r.key];
    if (!c) continue;
    if (r.kind === "forget-requested" || r.kind === "removed") {
      if (c === "yes" && r.kind === "forget-requested") out.keep.push(...r.ids);
      if (c === "no") out.forget.push(...r.ids);
    } else if (r.kind === "hidden") {
      if (c === "yes") out.restore.push(...r.ids);
    } else if (r.kind === "marked") {
      if (c === "yes") out.unmark.push(...r.ids);
      else out.delete.push({ ids: r.ids, text: r.text });
    } else if (c === "yes") {
      if (r.secret) continue;
      const ids = r.kind === "file" ? [...(s.units[r.key] ?? r.ids)] : r.ids;
      if (!ids.length) continue;
      out.accept.push({ key: r.key, ids, kind: r.kind, text: s.edits[r.key] ?? null, flagged: Boolean(r.flagged || r.kind === "flagged"), provisional: Boolean(r.provisional), fromPrompt: r.group === "new", source: r.source });
    } else {
      out.delete.push({ ids: r.kind === "file" ? r.ids : r.ids, text: r.text, units: r.units ?? null });
    }
  }
  return out;
}

/** The summary line shown before y (decision 11). */
export function summaryLine(p) {
  const parts = [];
  const accepted = p.accept.reduce((n, a) => n + a.ids.length, 0);
  if (accepted) {
    const mine = p.accept.filter((a) => a.fromPrompt).reduce((n, a) => n + a.ids.length, 0);
    const files = p.accept.filter((a) => a.kind === "file").reduce((n, a) => n + a.ids.length, 0);
    const history = p.accept.filter((a) => a.kind === "repeat").reduce((n, a) => n + a.ids.length, 0);
    const agent = accepted - mine - files - history;
    const from = [mine && `${mine} from your prompts`, history && `${history} from your history`, files && `${files} from instruction files`, agent && `${agent} the agent wrote`].filter(Boolean);
    parts.push(`Accept ${accepted}${from.length ? `: ${from.join(", ")}` : ""}`);
  }
  const deleted = p.delete.reduce((n, d) => n + d.ids.length, 0);
  if (deleted) parts.push(`Delete ${deleted} for good`);
  if (p.forget.length) parts.push(`Forget ${p.forget.length} for good`);
  if (p.keep.length) parts.push(`Keep ${p.keep.length} in use`);
  if (p.restore.length) parts.push(`Restore ${p.restore.length}`);
  if (p.unmark.length) parts.push(`Keep ${p.unmark.length} you asked to remove`);
  return `${parts.join(" · ")} · y/n`;
}
