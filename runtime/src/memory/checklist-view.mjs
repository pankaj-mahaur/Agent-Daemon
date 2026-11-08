// The review checklist drawn as lines (L5 design decision 11). Pure: state in, lines out.
// One line per row — focus marker, [x] / [-] / [ ], #id, the text cut to fit, a source and
// a status word — and a second line under the focused row saying what space and x do.

import { GROUPS, VERBS, focused, pageRows, pageStarts, visible, plan, summaryLine } from "./checklist.mjs";

export const FOOTER = "space use · x delete · e edit · a all new · enter apply · ? help";
export const HELP = [
  "↑/↓ or j/k move · pgup/pgdn page · movement never decides anything",
  "space  yes: start using · keep · restore            x  no: delete · forget for good",
  "a      choose the new ones from your prompts on this page (again: the agent's too)",
  "e      edit the focused note (screened again; the edit is what gets saved)",
  "→      open an instruction file's lines · enter  summary, then y applies · q quit",
  "--plain gives a numbered line mode with the same choices.",
];

// Text from any writer is neutralised: no control or format characters (an escape code
// could redraw the screen), one line.
export const clean = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => (n <= 1 ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const title = (id) => GROUPS.find((g) => g.id === id)?.title ?? id;

function verbsLine(row) {
  const key = row.secret ? "flagged-secret" : row.kind === "flagged" || row.flagged ? "flagged" : row.kind;
  const v = VERBS[key] ?? VERBS.note;
  return [v.yes ? `space: ${v.yes}` : null, `x: ${v.no}`].filter(Boolean).join(" · ");
}

/**
 * @param {object} s  the checklist state
 * @param {{width?:number, header?:string|null, effect?:string|null}} [o]
 *   header: "This folder: app · also waiting: api (3)"; effect: what accepting does
 *   ("if accepted: recalled in your agents' next sessions").
 * @returns {string[]}
 */
export function render(s, { width = 80, header = null, effect = null } = {}) {
  const w = Math.max(20, width);
  const lines = [];
  lines.push(cut(clean(`Review${header ? ` · ${header}` : ""}`), w));
  const forget = s.rows.filter((r) => r.group === "forget");
  if (forget.length && !s.expanded) {
    const first = forget[0];
    lines.push(cut(`${forget.length} decision${forget.length === 1 ? "" : "s"} owed: the agent asked to forget #${first.ids[0]}${forget.length > 1 ? ` and ${forget.length - 1} more` : ""} · ↑ to see`, w));
  }
  if (!visible(s).length) {
    lines.push("", "Nothing waits for review here.");
    lines.push(FOOTER);
    return lines;
  }

  if (s.mode === "help") return [...lines, "", ...HELP.map((l) => cut(l, w)), "", "any key: back"];
  if (s.mode === "units") return [...lines, ...renderUnits(s, w)];

  const rows = pageRows(s);
  const start = pageStarts(s)[s.page] ?? 0;
  const vis = visible(s);
  let group = null;
  rows.forEach((r, i) => {
    if (r.group !== group) {
      group = r.group;
      lines.push(cut(`── ${title(group)}`, w));
    }
    const at = start + i === s.focus;
    const c = s.choice[r.key];
    const box = c === "yes" ? "[x]" : c === "no" ? "[-]" : "[ ]";
    const tail = [r.source, r.status].filter(Boolean).map(clean).join(" · ");
    const shown = clean(s.edits[r.key] ?? r.text);
    const lead = `${at ? ">" : " "} ${box} #${r.ids[0]}${r.ids.length > 1 ? `+${r.ids.length - 1}` : ""} `;
    const room = w - lead.length - (tail ? tail.length + 3 : 0);
    lines.push(cut(`${lead}${cut(shown, Math.max(8, room))}${tail ? ` · ${tail}` : ""}`, w));
    if (at) {
      const extra = [verbsLine(r)];
      if (r.flagPhrase) extra.push(`flagged: mentions ${clean(r.flagPhrase)}`);
      if (r.kind === "file") extra.push(`→ open its ${r.ids.length} line${r.ids.length === 1 ? "" : "s"}`);
      if (effect && !r.accepted && !["hidden", "marked"].includes(r.kind)) extra.push(effect);
      if (r.rule) extra.push(clean(r.rule));
      lines.push(cut(`    ${extra.join(" · ")}`, w));
    }
  });
  const pages = pageStarts(s).length;
  if (pages > 1) lines.push(`page ${s.page + 1} of ${pages} · pgup/pgdn`);

  if (s.mode === "edit") lines.push(cut(`edit: ${clean(s.buffer)}▏ (enter keeps it · esc drops it)`, w));
  else if (s.mode === "confirm-flagged") lines.push(cut("This one was flagged for a closer look. Start using it anyway? y/n", w));
  else if (s.mode === "summary") lines.push(cut(summaryLine(plan(s)), w), "agents use these from your next session");
  else if (s.mode === "quit") lines.push(`Quit without saving ${Object.keys(s.choice).length} choice${Object.keys(s.choice).length === 1 ? "" : "s"}? y/n`);
  else if (s.message) lines.push(cut(clean(s.message), w));
  lines.push(cut(FOOTER, w));
  return lines;
}

function renderUnits(s, w) {
  const row = s.rows.find((r) => r.key === s.open);
  const units = row?.units ?? [];
  const chosen = new Set(s.units[s.open] ?? units.map((u) => u.id));
  const lines = [cut(`── ${clean(row?.text ?? "")}`, w)];
  units.forEach((u, i) => lines.push(cut(`${i === s.unitFocus ? ">" : " "} [${chosen.has(u.id) ? "x" : " "}] #${u.id} ${clean(u.text)}`, w)));
  lines.push(cut("space: use this line or not · ← back", w));
  return lines;
}

/** The focused row (for tests and the driver). */
export { focused };
