// The rule step at review (MCP launch plan L7, design D17–D18). After the checklist, in raw
// keys or the plain line mode (never in --accept-all), at most 3 offers:
//
//   #12 "use pnpm, not npm"
//     rule: npm install|i|ci|add  ·  asks in Claude Code, stops in Codex  ·  this project
//     last 30 days here: would have stopped 14 commands, e.g. npm install lodash · npm ci
//     r make it a rule · e edit · p all projects · b block instead of ask · n never · enter later
//
// Defaults: ask, this project. `p` and `b` toggle (all projects and block are explicit
// choices); `e` edits the pattern on one line (validated, the preview replayed); `n`
// records rule-declined; enter records rule-deferred. Adding a rule raises enforcement: the
// review token, no typed code. The caller rebuilds the snapshot afterwards (afterReview).

import readline from "node:readline";
import { addRule, recordRuleAnswer } from "./rules-service.mjs";
import { ruleOffers, patternText, parsePatternText, previewCounts, ruleSummary, PREVIEW_DAYS } from "./rule-proposals.mjs";
import { previewConsent, setPreviewConsent, previewWithin, startPreviewRead, PREVIEW_WAIT_MS } from "./rule-preview.mjs";
import { clean } from "./checklist-view.mjs";

export const STEP_COPY = Object.freeze({
  lead: "Command and file repeats are asked about or stopped where the host can; other corrections are recalled and counted.",
  limits: "File rules see edits made with the agent's file tools, not shell redirects; MCP tools and nested agents with their own settings aren't checked.",
  keys: "r make it a rule · e edit · p all projects · b block instead of ask · n never · enter later",
});

const where = (decision) => (decision === "deny" ? "stops in Claude Code and Codex" : "asks in Claude Code, stops in Codex");
const scopeWords = (scope) => (scope === "all" ? "all projects" : "this project");
const noun = (kind, n) => (kind === "write" ? `file write${n === 1 ? "" : "s"}` : `command${n === 1 ? "" : "s"}`);

/** Raw single keys and a pre-filled line, from a TTY stdin (the checklist has let go of it). */
export function rawInput(stdin, stdout) {
  return {
    key: () =>
      new Promise((resolve) => {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.once("data", (d) => {
          stdin.setRawMode?.(false);
          stdin.pause();
          const s = d.toString("utf8");
          resolve(s === "\r" || s === "\n" || s === "\r\n" ? "" : s === "\u0003" || s === "\u001b" ? "stop" : s.toLowerCase());
        });
      }),
    line: async (q, initial = "") => {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        const p = new Promise((resolve) => rl.question(q, resolve));
        if (initial) rl.write(initial);
        return await p;
      } finally {
        rl.close();
      }
    },
  };
}

/** The line mode's input: one answer per prompt (several letters are taken in order). */
export function plainInput(ask) {
  return {
    key: async () => String((await ask("  choice (r e p b n, enter for later): ")) ?? "").trim().toLowerCase(),
    line: async (q, initial = "") => String((await ask(`${q}${initial ? `(now: ${initial}) ` : ""}`)) ?? ""),
  };
}

/**
 * @param {{handle:any, token:object, keys:string[], projectId?:string|null, justAccepted?:number[],
 *   out:(l:string)=>void, input:{key:()=>Promise<string>, line:(q:string, initial?:string)=>Promise<string>},
 *   read?:{result:Promise<any>, stop:Function}|null, cwd?:string, env?:object, home?:string,
 *   startRead?:Function, now?:()=>number, offers?:object[]}} o
 * @returns {Promise<{added:number[], declined:number[], deferred:number[], offered:number, seconds:number}>}
 */
export async function ruleStep(o) {
  const clock = o.now ?? (() => Date.now());
  const started = clock();
  const res = { added: [], declined: [], deferred: [], offered: 0, seconds: 0 };
  const offers = o.offers ?? ruleOffers(o.handle, { keys: o.keys, justAccepted: o.justAccepted ?? [], now: new Date(started) });
  if (!offers.length) return res;
  const out = o.out;
  out("");
  out(`Rules: ${STEP_COPY.lead}`);
  out(`  ${STEP_COPY.limits}`);

  // The preview's consent: asked once here and kept (D18).
  let read = o.read ?? null;
  let consent = previewConsent(o.handle);
  if (consent === null) {
    const a = String((await o.input.line(`  Show what each rule would have done on this project's last ${PREVIEW_DAYS} days of Claude Code and Codex history? It's read here and nothing is stored. (y/n) `)) ?? "").trim().toLowerCase();
    consent = a === "y" || a === "yes" ? "on" : "off";
    try {
      setPreviewConsent(o.handle, consent, { token: o.token, now: new Date(clock()) });
    } catch {
      // kept for this run only
    }
  }
  if (consent === "on" && !read) read = (o.startRead ?? startPreviewRead)({ cwd: o.cwd, env: o.env, home: o.home });
  const deadline = started + PREVIEW_WAIT_MS;
  let history; // undefined: not waited for yet; null: not ready
  const previewLine = async (kind, pattern) => {
    if (consent !== "on") return null;
    if (history === undefined) history = await previewWithin(read, deadline, clock());
    if (!history) return `  last ${PREVIEW_DAYS} days here: still reading your history (shown at the next review)`;
    const p = previewCounts(pattern, history.calls, { rootOf: () => history.root });
    if (!p.count) return `  last ${PREVIEW_DAYS} days here: it would have stopped nothing`;
    return `  last ${PREVIEW_DAYS} days here: would have stopped ${p.count} ${noun(kind, p.count)}${p.examples.length ? `, e.g. ${p.examples.map(clean).join(" · ")}` : ""}`;
  };

  try {
    for (const offer of offers) {
      res.offered++;
      let kind = offer.kind;
      let pattern = offer.pattern;
      let scope = "project";
      let decision = "ask";
      const show = async () => {
        out(`  rule: ${patternText(kind, pattern)}  ·  ${where(decision)}  ·  ${scopeWords(scope)}`);
        const pl = await previewLine(kind, pattern);
        if (pl) out(pl);
        out(`  ${STEP_COPY.keys}`);
      };
      out("");
      out(`#${offer.learningId} "${clean(offer.text)}"`);
      await show();
      let done = false;
      while (!done) {
        const answer = await o.input.key();
        if (answer === "stop" || answer === "q") return res;
        const letters = answer === "" ? [""] : [...answer];
        for (const k of letters) {
          if (k === "p") {
            scope = scope === "all" ? "project" : "all";
            out(`  ${scope === "all" ? "all projects: it applies in every folder" : "this project only"}`);
          } else if (k === "b") {
            decision = decision === "deny" ? "ask" : "deny";
            out(`  ${decision === "deny" ? "blocks instead of asking" : "asks"}`);
          } else if (k === "e") {
            const typed = await o.input.line("  pattern: ", patternText(kind, pattern));
            const parsed = parsePatternText(typed);
            if (parsed.error) out(`  not changed: ${parsed.error}`);
            else {
              kind = parsed.kind;
              pattern = parsed.pattern;
              history = history === null ? undefined : history; // a late read may be ready now
              await show();
            }
          } else if (k === "r") {
            const projectId = offer.projectId ?? o.projectId ?? null;
            try {
              const id = addRule(o.handle, o.token, { learningId: offer.learningId, projectId, scope, kind, decision, pattern, reason: offer.text, now: new Date(clock()) });
              res.added.push(id);
              out(`  rule ${id} ${ruleSummary(kind, pattern, decision)} (${scopeWords(scope)}).`);
            } catch (e) {
              out(`  not added: ${String(e?.message ?? e).replace(/^rules: /, "")}`);
            }
            done = true;
            break;
          } else if (k === "n") {
            if (answerOf(o, offer, "declined", clock)) res.declined.push(offer.learningId);
            out("  no rule; offered again only if the correction repeats.");
            done = true;
            break;
          } else if (k === "") {
            if (answerOf(o, offer, "deferred", clock)) res.deferred.push(offer.learningId);
            out("  later.");
            done = true;
            break;
          }
        }
      }
    }
    if (res.added.length) out("Claude Code asks you; in bypass or don't-ask mode, and in Codex, these calls are stopped with the reason. While rules exist, Claude Code also asks when the check itself can't run (from your next session).");
    return res;
  } finally {
    res.seconds = Math.round((clock() - started) / 100) / 10;
    if (o.read == null) read?.stop?.();
  }
}

function answerOf(o, offer, answer, clock) {
  try {
    recordRuleAnswer(o.handle, o.token, { learningId: offer.learningId, projectId: offer.projectId ?? o.projectId ?? null, answer, now: new Date(clock()) });
    return true;
  } catch (e) {
    o.out(`  not recorded: ${String(e?.message ?? e).replace(/^rules: /, "")}`);
    return false;
  }
}

/**
 * The `reviewed` event records the step's seconds and the whole review's (D17). The
 * checklist's event comes first; with nothing waiting, the step records its own.
 */
export function noteStepSeconds(handle, { projectId = null, slug = null, step, total, hadChecklist, now = new Date() } = {}) {
  try {
    if (hadChecklist) {
      const ev = handle.get("SELECT id, detail FROM events WHERE kind = 'reviewed' ORDER BY id DESC LIMIT 1");
      if (!ev) return;
      let d = {};
      try {
        d = JSON.parse(ev.detail ?? "{}") ?? {};
      } catch {
        d = {};
      }
      handle.run("UPDATE events SET detail = ? WHERE id = ?", [JSON.stringify({ ...d, ruleStepSeconds: step, totalSeconds: total }), ev.id]);
      return;
    }
    handle.run("INSERT INTO events (at, kind, project_id, actor, detail) VALUES (?, 'reviewed', ?, 'review', ?)", [now.toISOString(), projectId, JSON.stringify({ slug, rows: 0, choices: {}, ruleStepSeconds: step, totalSeconds: total })]);
  } catch {
    // an older store without events: nothing to note
  }
}
