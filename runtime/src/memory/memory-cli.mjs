// The memory verbs in a terminal (L5 design decisions 1, 10, 12), for both CLIs:
//   <pkg> remember <text…>        ad remember <text…>
//   <pkg> forget <ref>            ad forget <ref>
//   <pkg> restore <ref>           ad restore <ref>
//   <pkg> config review [strict|auto]   ad config review [strict|auto]
// Trust comes from the review token (review-service.mjs reviewToken: your own terminal,
// typed). Without it (the agent's shell, any non-TTY run) a remember is the agent's
// pending note, a forget can only hide the agent's notes or ask to forget an accepted one,
// and `config review auto` is refused. `config review strict` needs no token: it narrows trust.

import os from "node:os";
import path from "node:path";
import { PRODUCT } from "../product.mjs";

export const MEMORY_VERBS = Object.freeze(["remember", "forget", "restore", "config"]);

const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

async function askLine(q) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

/**
 * The review token for a CLI verb (remember, forget, config, and L8's learnings and
 * `report --purge`), or why not. token: an injected () => {token}|{refused} (tests).
 * → {token} | {refused}
 */
export async function cliToken({ token, ask = askLine, out = (l) => console.log(l) } = {}) {
  const svc = await import("./review-service.mjs");
  const r = await (token ?? (() => svc.reviewToken({ ask, out })))();
  return r?.token && svc.isReviewToken(r.token) ? { token: r.token, dialogProven: r.dialogProven === true } : { refused: r?.refused ?? "not your own terminal" };
}

/**
 * Run one memory verb. → exit code.
 * @param {string} verb  remember | forget | restore | config
 * @param {string[]} argv the words after the verb
 * @param {{out?:Function, cwd?:string, ask?:Function, handle?:object, token?:Function,
 *   command?:(verb:string)=>string, home?:string, now?:Date}} [o]
 *   token: () => Promise<{token}|{refused}> (default: reviewToken in this terminal);
 *   command: how a verb is printed (`ad <verb>` or the pinned npx form).
 */
export async function memoryVerbMain(verb, argv = [], o = {}) {
  const out = o.out ?? ((l) => console.log(l));
  const ask = o.ask ?? askLine;
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const command = o.command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const now = o.now ?? new Date();
  const ep = await import("./episodic.mjs");
  const handle = o.handle ?? (await ep.db().catch(() => null));
  if (!handle) {
    out(`${PRODUCT.displayName}: the memory store can't be opened (run ${command("doctor")}).`);
    return 1;
  }
  const getToken = () => cliToken({ token: o.token, ask, out });
  const { projectIdOf } = await import("./projects.mjs");
  // Every name of this folder: a linked folder's notes may be keyed by its logical path
  // (the host's cwd) while node runs in the physical one.
  const { folderPaths } = await import("./forget.mjs");
  const paths = folderPaths(cwd, { env: o.env ?? process.env });
  const keys = [...new Set(paths.map((p) => ep.projectSlug(p))), projectIdOf(cwd)].filter(Boolean);
  // A folder that shares its memory with another can't tell their notes apart (the slug
  // matches the other folder's rows): nothing changes there. Review mode is store-wide.
  if (verb !== "config") {
    const { slugCollides } = await import("./safety.mjs");
    if (paths.some((p) => slugCollides(handle, ep.projectSlug(p), p))) {
      out(`${PRODUCT.displayName}: Nothing changed: this folder shares its memory with another folder`);
      return 1;
    }
  }

  if (verb === "remember") {
    const text = argv.join(" ").trim();
    if (!text) {
      out(`usage: ${command("remember")} <what to remember>`);
      return 1;
    }
    const t = await getToken();
    const { captureCli } = await import("./capture-prompt.mjs");
    const { FLAG_PHRASES } = await import("./prompt-screen.mjs");
    const r = await captureCli(text, { handle, cwd, token: t.token ?? null, now });
    const ref = r.id ? `#${r.id}` : "";
    const lines = {
      accepted: `Remembered ${ref} "${clip(text)}": your agents use it from their next session.`,
      "accepted-before": `Already remembered (${ref}).`,
      pending: `Saved for review as ${ref} "${clip(text)}" (${t.refused}). Accept it with ${command("review")} in your own terminal.`,
      duplicate: `Already saved for review. Accept it with ${command("review")} in your own terminal.`,
      quarantined: `Saved for a closer look: ${ref} mentions ${FLAG_PHRASES[r.flags?.[0]] ?? "something to check"} · ${command("review")}`,
      "refused-secret": `Not saved: it contains what looks like a ${r.secretKind ?? "secret"}. Say it again without it.`,
      "too-long": `Not saved: the note is too long (up to 2000 characters).`,
      "no-project": "Not saved: this folder isn't a project ad knows yet.",
      hidden: `Not saved: ${ref} was removed in another project.`,
    };
    out(`${PRODUCT.displayName}: ${lines[r.status] ?? `Nothing saved (${r.status}).`}`);
    return ["accepted", "accepted-before", "pending", "duplicate", "quarantined"].includes(r.status) ? 0 : 1;
  }

  if (verb === "forget" || verb === "restore") {
    const F = await import("./forget.mjs");
    const ref = F.parseRef(argv.join(" "));
    if (!ref || (verb === "restore" && ref.last) || ref.last) {
      // `forget last` belongs to a prompt's session; the terminal names a number.
      out(`usage: ${command(verb)} <number> (the #number from review or a receipt)`);
      return 1;
    }
    const t = await getToken();
    const asker = F.askerOf({ cli: true, token: t.token ?? null });
    // L7 D2: the rules each learning has, before the forget (a forgotten learning's rule stays
    // until the user confirms its removal with the typed code).
    const R = t.token ? await import("./rule-removal.mjs") : null;
    const before = R ? R.ruleOwners(handle) : null;
    const words = { verb, product: PRODUCT.displayName, forget: command("forget"), restore: command("restore"), review: command("review"), terminalForget: (id) => command(`forget ${id}`) };
    let r;
    if (verb === "restore") r = F.restoreLearning(handle, { ref, asker, keys, token: t.token, now });
    else {
      const projectFile = await (await import("../digest/apply.mjs")).resolveProjectMemoryPath(cwd).catch(() => null);
      r = await F.forgetLearning(handle, {
        ref,
        asker,
        keys,
        token: t.token,
        now,
        memoryFile: [projectFile, path.join(o.home ?? os.homedir(), ".agent-daemon", "user.md")].filter(Boolean),
        // An accepted note goes for good only with its number typed back.
        confirm: async (row) => String(await ask(`#${row.id} "${clip(row.text)}" is in use. Type ${row.id} to forget it for good (anything else keeps it): `)).trim() === String(row.id),
      });
    }
    out(F.commandReceipt(r, words) ?? `${PRODUCT.displayName}: nothing changed.`);
    // L8: the words also left the capture files, except what was in use or tracked by git.
    if (r.scrub?.older) out(`Its ${r.scrub.older} older wording${r.scrub.older === 1 ? "" : "s"} went too.`);
    if (r.scrub?.left?.length) out(`${r.scrub.left.length} capture file${r.scrub.left.length === 1 ? " still holds" : "s still hold"} its words (in use, or tracked by git): ${r.scrub.left.join(", ")}`);
    if (asker === "agent" && ["refused-own", "removed-by-you"].includes(r.status)) out(`(not your own terminal: ${t.refused})`);
    if (R && t.token && verb === "forget" && r.status === "forgotten") {
      const left = R.rulesLeftBy(handle, before, [r.id ?? ref.id].filter((x) => x != null));
      const confirmed = await R.confirmRemovals({ rules: left, out, tty: o.tty, confirm: o.confirm, proven: t.dialogProven === true, command });
      try {
        const done = await (await import("./rules-finish.mjs")).afterReview(handle, t.token, { now, confirmed, ...(o.root ? { root: o.root } : {}) });
        if (done?.switch?.why) out(done.switch.why);
        for (const l of done?.switch?.codex ?? []) out(l.trim());
      } catch (e) {
        out(`The rules file wasn't rebuilt (${e?.message ?? e}); it keeps the rules it had until the next review.`);
      }
    }
    return ["hidden", "restored", "forgotten", "forget-requested", "marked"].includes(r.status) ? 0 : 1;
  }

  if (verb === "config" && argv[0] === "history-preview") {
    // L7 D18: the rule step's preview over this project's last 30 days of transcripts.
    const value = argv[1];
    const P = await import("./rule-preview.mjs");
    if (value && !["on", "off"].includes(value)) {
      out(`usage: ${command("config history-preview")} [on|off]`);
      return 1;
    }
    if (value === "off") P.setPreviewConsent(handle, "off", { now });
    else if (value === "on") {
      const t = await getToken();
      if (!t.token) {
        out(`${PRODUCT.displayName}: the history preview stays as it is: turning it on needs your own terminal (${t.refused}).`);
        return 2;
      }
      P.setPreviewConsent(handle, "on", { token: t.token, now });
    }
    const c = P.previewConsent(handle);
    out(c === "on"
      ? `The rule step's preview is on: review shows what a proposed rule would have done on this project's last 30 days of Claude Code and Codex history (read here, nothing stored). Turn off: ${command("config history-preview off")}`
      : `The rule step's preview is ${c === "off" ? "off" : "not set (review asks once)"}.`);
    return 0;
  }

  if (verb === "config" && argv[0] === "recall") {
    // Plan L6 (design decision 13): recall on or off for this project, the token both ways.
    const value = argv[1];
    const { recallMode } = await import("./recall-mode.mjs");
    const projectId = projectIdOf(cwd);
    if (value && !["on", "off"].includes(value)) {
      out(`usage: ${command("config recall")} [on|off]`);
      return 1;
    }
    if (value) {
      if (!projectId) {
        out(`${PRODUCT.displayName}: this folder isn't a project, so recall has no setting here.`);
        return 1;
      }
      const t = await getToken();
      if (!t.token) {
        out(`${PRODUCT.displayName}: recall stays as it is: changing it needs your own terminal (${t.refused}).`);
        return 2;
      }
      (await import("./review-service.mjs")).setRecallMode(handle, t.token, projectId, value, { now });
    }
    const mode = recallMode(handle, projectId);
    out(mode === "off"
      ? `Recall is off in this project: agents get none of your learnings. Rules still ask or stop; corrections are still saved. Turn on: ${command("config recall on")}`
      : `Recall is on in this project: agents get the learnings that fit each session and prompt. Turn off: ${command("config recall off")}`);
    return 0;
  }

  if (verb === "config") {
    const [what, value] = argv;
    if (what !== "review" || (value && !["strict", "auto"].includes(value))) {
      out(`usage: ${command("config review")} [strict|auto] · ${command("config recall")} [on|off]`);
      return 1;
    }
    const M = await import("./review-mode.mjs");
    if (value === "strict") {
      const { demoted } = M.setReviewStrict(handle, { now });
      out(`${PRODUCT.displayName}: Review-first is on${demoted ? `: ${demoted} learning${demoted === 1 ? "" : "s"} in use now wait${demoted === 1 ? "s" : ""} for review` : ""}.`);
    } else if (value === "auto") {
      const t = await getToken();
      if (!t.token) {
        out(`${PRODUCT.displayName}: review stays as it is: turning review-first off needs your own terminal (${t.refused}).`);
        return 2;
      }
      // Widening trust lowers enforcement: the typed code (L7 D16).
      if (M.reviewMode(handle) !== "auto") {
        const { confirmTypedCode } = await import("./typed-code.mjs");
        const c = await confirmTypedCode({ what: "Turn review-first off (corrections you type apply at once)", proven: t.dialogProven, tty: o.tty, code: o.code?.() });
        if (!c.ok) {
          out(`${PRODUCT.displayName}: review stays as it is: ${c.text}.`);
          return 1;
        }
      }
      (await import("./review-service.mjs")).setReviewAuto(handle, t.token, { now });
    }
    for (const l of M.describeModes(M.reviewMode(handle))) out(l);
    return 0;
  }
  out(`unknown memory verb ${verb}`);
  return 1;
}
