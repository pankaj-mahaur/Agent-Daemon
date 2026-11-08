// The review checklist, run (L5 design decision 11). The one entry other code calls:
//
//   const r = await openChecklist({ handle, keys, token, stdin, stdout, filter, onApply });
//   // r: { ended: "applied" | "quit" | "empty" | "ctrl-c" | "error" | "signal", applied?, rows }
//
// The caller takes the review token first (review-service.mjs reviewToken, before the
// screen opens) and checks for a TTY; a plain or non-TTY run uses checklistText instead.
// filter(row) narrows the rows (L4b's install step: history and instruction files only).

import { GROUPS, createChecklist, press, plan, choiceCount, pageRows, repage } from "./checklist.mjs";
import { render, clean } from "./checklist-view.mjs";
import { checklistRows } from "./checklist-rows.mjs";
import { applyPlan } from "./checklist-apply.mjs";
import { runKeys, asText } from "./keys.mjs";
import { screenPrompt } from "./prompt-screen.mjs";
import { isReviewToken } from "./review-service.mjs";

/**
 * The lines a page may use (rows and group headers) on a terminal this many rows high:
 * the rest is the header, the banner, the focused row's second line, the page line, two
 * lines for a prompt or the summary, and the footer.
 */
export const pageSizeFor = (rows) => Math.max(3, (Number(rows) || 24) - 7);

/**
 * @param {{handle:object, keys:string[], token:object, stdin:object, stdout:object,
 *   rows?:object[], filter?:(row:object)=>boolean, header?:string|null, effect?:string|null,
 *   projectId?:string|null, slug?:string|null, memoryFile?:string|string[],
 *   projectMemory?:string|null, onApply?:(rows:object[])=>any, now?:()=>Date, escTimeout?:number}} o
 *   projectMemory: the project's memory file, where an accepted note's line is appended
 */
export async function openChecklist(o) {
  if (!isReviewToken(o.token)) throw new Error("the review checklist needs a review token (your own terminal)");
  const now = o.now ?? (() => new Date());
  const all = o.rows ?? checklistRows(o.handle, o.keys, { now: now().getTime() });
  const rows = typeof o.filter === "function" ? all.filter(o.filter) : all;
  if (!rows.length) return { ended: "empty", rows };
  const started = now().getTime();
  const out = o.stdout;
  let state = createChecklist(rows, { pageSize: pageSizeFor(out.rows) });
  // The rows actually drawn: only a removed note the user saw starts its 7 days (decision 12).
  const seen = new Set();
  const draw = () => {
    if (!["units", "help"].includes(state.mode)) for (const r of pageRows(state)) seen.add(r.key);
    const lines = render(state, { width: out.columns || 80, header: o.header ?? null, effect: o.effect ?? null });
    out.write(`\x1b[?25l\x1b[H\x1b[2J${lines.join("\r\n")}`);
  };
  // A resized terminal gets pages that fit it again.
  const onResize = () => {
    state = repage(state, pageSizeFor(out.rows));
    draw();
  };
  out.on?.("resize", onResize);
  out.write("\x1b[?1049h"); // the alternate screen: the user's scrollback is left as it was
  let result;
  try {
    draw();
    result = await runKeys({
      stdin: o.stdin,
      stdout: out,
      escTimeout: o.escTimeout,
      onKey: (key) => {
        state = press(state, state.mode === "edit" ? asText(key) : key, { screen: (t, so) => screenPrompt(t, so) });
        if (state.mode === "done" || state.mode === "quit-done") return true;
        draw();
        return false;
      },
    });
  } finally {
    out.removeListener?.("resize", onResize);
    out.write("\x1b[?1049l\x1b[?25h");
  }
  // Only the review (apply) starts a shown removed note's clock: a quit leaves it unseen.
  const shownHidden = rows.filter((r) => r.kind === "hidden" && r.statusAtNull && seen.has(r.key)).flatMap((r) => r.ids);
  if (result.ended !== "done" || state.mode !== "done") {
    return { ended: result.ended === "done" ? "quit" : result.ended, error: result.error, rows, choices: choiceCount(state) };
  }
  const applied = await applyPlan(o.handle, o.token, plan(state), {
    keys: o.keys,
    projectId: o.projectId ?? null,
    slug: o.slug ?? null,
    rows,
    shownHidden,
    memoryFile: o.memoryFile,
    projectMemory: o.projectMemory ?? null,
    seconds: Math.round((now().getTime() - started) / 1000),
    now: now(),
    onApply: o.onApply,
  });
  return { ended: "applied", applied, rows };
}

/**
 * The rows as plain text (review --list, a non-TTY run, TERM=dumb): numbered, one line
 * each, grouped as the checklist groups them.
 */
export function checklistText(rows) {
  const lines = [];
  let n = 0;
  for (const g of GROUPS) {
    const these = rows.filter((r) => r.group === g.id);
    if (!these.length) continue;
    lines.push(`${g.title}:`);
    for (const r of these) lines.push(`  ${++n}. #${r.ids[0]} ${clean(r.text)}${[r.source, r.status].filter(Boolean).length ? ` · ${[r.source, r.status].filter(Boolean).map(clean).join(" · ")}` : ""}`);
  }
  return lines;
}
