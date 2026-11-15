// `safety on|off|status` (MCP launch plan L7b; L7b design §5): the starter safety policy.
//   status  no token: on / off / some, each family with its rule, paused, the store against
//           the rules file, and other guards that ask about the same commands (doctor's lines);
//   on      the review token (D3: your own terminal) and a guard copy that knows the policy;
//   off     the review token and the typed code (L7 design decision 16: it lowers enforcement).
// From the agent's shell (AD_TOOL_SHELL=1, no terminal, an agent ancestor) on and off refuse
// and name no command (S4). Copy: it asks before; it is a gate against accidents, not a sandbox.

import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { PRODUCT } from "../product.mjs";

const CODE_LETTERS = "acdefhjkmnprtvwxy"; // no look-alikes (b/6, g/9, i/l/1, o/0, q, s/5, u/v, z/2)

async function askLine(q) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

/** From the agent's shell? (the same signals as the review token's refusal, without ancestry). */
const agentShell = (env, isTTY) => env.AD_TOOL_SHELL === "1" || !isTTY();

/**
 * Can the hook that will run know the policy? (review H1) On the launcher's route the guard
 * copy runs tool.before: one older than the policy would read its rules as unknown. → null
 * when ready, else why not.
 */
export async function guardNotReady(root, { version = null } = {}) {
  const dists = await import("./launch/dists.mjs");
  if (!fs.existsSync(dists.launcherFile(root))) return null; // no launcher: the hook runs from this install
  const g = dists.readGuard(root);
  if (g.missing) return "there is no guard copy yet";
  if (!g.path) return "the guard copy's record can't be read";
  if (!fs.existsSync(path.join(g.path, "src", "rules", "policy.mjs"))) return `the guard copy (${g.version}) is older than the starter safety policy`;
  if (version && dists.cmpVersion(g.version, version) < 0) return `the guard copy (${g.version}) is older than this package (${version})`;
  return null;
}

function snapshotPolicyIds(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "guards.json"), "utf8"));
    return (raw?.global?.rules ?? []).filter((r) => r?.rule?.type === "policy").map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * → exit code.
 * @param {string[]} argv  [on|off|status]
 * @param {{out?:Function, ask?:Function, env?:object, isTTY?:Function, handle?:object, root?:string,
 *   token?:Function, command?:(v:string)=>string, now?:Date, version?:string|null,
 *   code?:()=>string, others?:Function}} [o]
 */
export async function safetyMain(argv = [], o = {}) {
  const out = o.out ?? ((l) => console.log(l));
  const ask = o.ask ?? askLine;
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const command = o.command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const name = PRODUCT.displayName;
  const sub = argv[0] ?? "status";
  if (!["on", "off", "status"].includes(sub) || argv.length > 1) {
    out(`usage: ${command("safety [on|status]")}`);
    return 1;
  }
  const policy = await import("./starter-policy.mjs");
  const { adRoot } = await import("../ad-root.mjs");
  const root = o.root ?? adRoot({ env });
  const fromAgent = agentShell(env, isTTY);

  if (sub !== "status" && fromAgent) {
    // S4: no command here; the decision is the user's, in their own terminal.
    out(`${name}: the starter safety policy is turned ${sub} by the user, in their own terminal. Nothing changed.`);
    return 1;
  }
  const ep = await import("./episodic.mjs");
  const handle = o.handle ?? (await ep.db().catch(() => null));
  if (!handle) {
    out(`${name}: the memory store can't be opened (run ${command("doctor")}).`);
    return 1;
  }

  if (sub === "status") {
    const s = policy.policyState(handle);
    const enforced = snapshotPolicyIds(root);
    out(`${name} starter safety policy: ${s.state === "some" ? "partly on" : s.state} (off by default; it asks before these commands where the host can ask, and stops them where it can't).`);
    for (const f of s.families) out(`  ${f.rule !== null ? `rule ${f.rule}` : "off"}  asks before ${f.text}`);
    if (s.paused) out(`  every rule is paused${s.paused.until ? ` until ${s.paused.until}` : " until resumed"}`);
    const inStore = s.families.filter((f) => f.rule !== null).map((f) => f.rule);
    if (enforced.some((id) => !inStore.includes(id))) out("  off in your store, but the rules file still asks until it is rebuilt" + (fromAgent ? " (the user can settle this in their own terminal)." : ` (\`${command("review")}\`).`));
    else if (inStore.some((id) => !enforced.includes(id))) out("  on in your store; the rules file catches up at the next session start.");
    out(`  ${policy.POLICY_COPY.limits}`);
    out("  The Read tool on Claude Code is asked about once ad's hook entry covers Read (from the release that adds it).");
    const others = await (o.others ?? (async () => (await import("./policy-coexist.mjs")).coexistLines({ env, home: env.HOME || env.USERPROFILE || undefined })))();
    for (const l of others ?? []) out(`  ${l}`);
    if (!fromAgent) out(s.state === "off" ? `  Turn it on: \`${command("safety on")}\`` : `  Turn it off: \`${command("safety off")}\``);
    return 0;
  }

  const svc = await import("./review-service.mjs");
  const t = await (o.token ?? (() => svc.reviewToken({ ask, out })))();
  if (!t?.token || !svc.isReviewToken(t.token)) {
    out(`${name}: nothing changed: this needs your own terminal (${t?.refused ?? "not your own terminal"}).`);
    return 1;
  }
  const now = o.now ?? new Date();
  const cmd = o.cmdName ?? null;

  if (sub === "on") {
    if (policy.policyState(handle).state === "on") {
      out(`${name}: the starter safety policy is already on.`);
      return 0;
    }
    const version = o.version !== undefined ? o.version : (await import("./own-version.mjs")).ownVersion?.() ?? null;
    const notReady = await guardNotReady(root, { version });
    if (notReady) {
      out(`${name}: nothing changed: ${notReady}. Update it first: \`${command("repair")}\`, then \`${command("safety on")}\`.`);
      return 1;
    }
    let r;
    try {
      r = await policy.setPolicy(handle, t.token, true, { root, now, cmd });
    } catch (e) {
      if (policy.policyState(handle).state === "off") {
        out(`${name}: nothing changed: ${e?.message ?? e}`);
        return 1;
      }
      out(`${name}: the policy is on in your store, but the rules file couldn't be rebuilt (${e?.message ?? e}); it starts asking once \`${command("review")}\` rebuilds it.`);
      return 1;
    }
    out(`${name} starter safety policy: on (${r.added.length} rule${r.added.length === 1 ? "" : "s"} added). It asks before:`);
    for (const f of policy.policyState(handle).families) out(`  ${f.text} (rule ${f.rule})`);
    out("  Claude Code asks you; in bypass or don't-ask mode, and in Codex (which can't ask), these calls are stopped with the reason.");
    out("  While rules exist, Claude Code also asks when the check itself can't run (from your next session).");
    out(`  ${policy.POLICY_COPY.limits}`);
    out(`  Turn it off: \`${command("safety off")}\` · one call: \`${command("rules allow-once <rule>")}\``);
    return 0;
  }

  // off: lowers enforcement → the typed code (L7 design decision 16).
  const s = policy.policyState(handle);
  const n = s.families.filter((f) => f.rule !== null).length;
  if (!n) {
    out(`${name}: the starter safety policy is already off.`);
    return 0;
  }
  const code = (o.code ?? (() => Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("")))();
  const typed = String((await ask(`Turn off the starter safety policy (${n} rule${n === 1 ? "" : "s"}) — type ${code}: `)) ?? "").trim().toLowerCase();
  if (typed !== code) {
    out(`${name}: nothing changed (the code didn't match).`);
    return 1;
  }
  try {
    const r = await policy.setPolicy(handle, t.token, false, { root, now, cmd });
    out(`${name} starter safety policy: off (${r.removed.length} rule${r.removed.length === 1 ? "" : "s"} removed). Turn it on again: \`${command("safety on")}\``);
    return 0;
  } catch (e) {
    out(`${name}: the policy is off in your store, but the rules file couldn't be rebuilt (${e?.message ?? e}); it still asks until \`${command("review")}\` rebuilds it.`);
    return 1;
  }
}
