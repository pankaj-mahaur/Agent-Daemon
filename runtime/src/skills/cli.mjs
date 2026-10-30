// `ad skill propose|history|diff|undo|publish` (P5.7): the skill library's commands.
//
//   propose <name> --file <path> [--origin gepa-inline]   queue a v1 proposal (applies nothing)
//   history <name>                                        every version, with where it came from
//   diff <name> [--from a] [--to b] [--bundled]            between versions, or against this release
//   undo <name> [--to n]                                   an older version becomes current (guarded)
//   publish [<name>] [--host <id>] [--replace] [--dry-run] write accepted skills to the hosts (P5.7b);
//           --remove (with --host) stops publishing there and removes ad's unchanged copy
//
// Undo changes what every session loads, so it is the user's alone, like accepting
// in ad review (D49): refused in an agent's tool shell and without a terminal, then
// a typed confirmation; no --yes.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { renderSkillProposal, isSkillName, skillSha } from "./proposal.mjs";

const realTTY = () => Boolean(input.isTTY && output.isTTY);

/**
 * @param {string} sub
 * @param {{ name?: string, cwd?: string, file?: string, origin?: string, to?: string, from?: string,
 *           bundled?: boolean, yes?: boolean, env?: object, isTTY?: () => boolean,
 *           io?: { ask: (q: string) => Promise<string> }, out?: (l: string) => void, err?: (l: string) => void }} opts
 * @returns {Promise<number>} exit code
 */
export async function runSkillCommand(sub, opts = {}) {
  const out = opts.out ?? ((l) => console.log(l));
  const err = opts.err ?? ((l) => console.error(l));
  const cwd = opts.cwd ?? process.cwd();
  const name = opts.name;
  if (sub !== "publish" && !isSkillName(name)) {
    err(`ad skill ${sub}: a skill name is required (kebab-case)`);
    return 1;
  }
  const lib = await import("./library.mjs");
  switch (sub) {
    case "propose": {
      if (!opts.file) {
        err("ad skill propose: --file <path to the proposed SKILL.md> is required");
        return 1;
      }
      let body;
      try {
        body = await fs.readFile(path.resolve(cwd, opts.file), "utf8");
      } catch (e) {
        err(`ad skill propose: can't read ${opts.file} (${e.code ?? e.message})`);
        return 1;
      }
      const loaded = lib.loadedCopy(name, { cwd, bundled: await bundledIndex() });
      if (!loaded) {
        err(`ad skill propose: no skill named ${name} is installed or bundled`);
        return 1;
      }
      const current = await fs.readFile(path.join(loaded.dir, "SKILL.md"), "utf8");
      const origin = ["gepa", "gepa-inline", "digest"].includes(opts.origin) ? opts.origin : "gepa-inline";
      const { projectDataDir } = await import("../memory/project-dir.mjs");
      const dir = path.join(projectDataDir(cwd), "proposed");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString();
      const file = path.join(dir, `skill-${name}-${stamp.replace(/[:.]/g, "-")}.md`);
      const text = renderSkillProposal({ skill: name, base: skillSha(current), body, origin, created: stamp, why: `Proposed with \`ad skill propose\` from ${path.basename(opts.file)}.` });
      await fs.writeFile(file, text, { flag: "wx" });
      out(`Queued: ${file}`);
      out("Review it with: ad review (it shows the change; nothing is applied until you accept).");
      return 0;
    }
    case "history": {
      const rows = lib.skillHistory(name);
      if (!rows.length) {
        out(`${name} has no accepted versions yet.`);
        return 0;
      }
      for (const h of rows) {
        const what = h.action === "base" ? "the copy before the first accept" : h.action === "undo" ? `undo (the content of v${h.from})` : `accepted${h.origin ? ` (${h.origin}${h.run ? ` ${h.run}` : ""})` : ""}${h.proposal ? `, ${h.proposal}` : ""}`;
        out(`  v${h.version}  ${String(h.at).slice(0, 16).replace("T", " ")}  ${h.sha256.slice(0, 12)}  ${what}`);
      }
      return 0;
    }
    case "diff": {
      const d = await lib.skillDiff(name, { from: opts.from === undefined ? undefined : Number(opts.from), to: opts.to === undefined ? undefined : Number(opts.to), bundled: opts.bundled });
      if (d === null) {
        out(`${name} has no accepted versions yet.`);
        return 0;
      }
      out(d === "" ? "No differences." : lib.visible(d));
      return 0;
    }
    case "undo": {
      if (opts.yes) {
        err("ad skill undo: there is no --yes: undo always asks you to type the confirmation.");
        return 2;
      }
      const { reviewGuard } = await import("../review.mjs");
      const refused = reviewGuard({ env: opts.env ?? process.env, isTTY: opts.isTTY ?? realTTY });
      if (refused) {
        err(refused.replace(/^ad review: accepting notes/, "ad skill undo: changing a skill").replace(/^ad review/, "ad skill undo"));
        return 2;
      }
      const meta = lib.readMeta(name);
      if (!meta) {
        out(lib.LIBRARY_TEXTS.noLibrary(name));
        return 1;
      }
      const target = opts.to === undefined ? meta.version - 1 : Number(opts.to);
      if (target >= 1 && target <= meta.version) {
        const d = await lib.skillDiff(name, { from: meta.version, to: target });
        out(`${name}: v${meta.version} → the content of v${target}`);
        out(lib.visible(d || "No differences."));
      }
      const rl = opts.io ? null : readline.createInterface({ input, output });
      try {
        const ask = opts.io ? opts.io.ask : (q) => rl.question(q);
        if (String(await ask("Type undo to confirm: ")).trim() !== "undo") {
          out("Not confirmed: nothing changed.");
          return 1;
        }
      } finally {
        rl?.close();
      }
      const r = await lib.undoSkill(name, { to: opts.to, cwd });
      (r.ok ? out : err)(r.text);
      return r.ok ? 0 : 1;
    }
    case "publish": {
      const { publishCommand } = await import("./publish.mjs");
      return publishCommand({ ...opts, out, err });
    }
    default:
      return 1;
  }
}

async function bundledIndex() {
  try {
    const { buildSkillIndex } = await import("../skills-source.mjs");
    const { adPackageRoot } = await import("../ad-root.mjs");
    const root = process.env.AGENT_DAEMON_HOME ? path.resolve(process.env.AGENT_DAEMON_HOME) : path.resolve(adPackageRoot(), "..");
    return await buildSkillIndex(path.join(root, "skills"));
  } catch {
    return new Map();
  }
}
