// The starter safety policy, offered once (MCP launch plan L7b; L7b design §8). Setup's last
// step and `review` (after the rule step) ask once: "Ask before four kinds of catastrophic
// commands? (y/N)". y turns it on with the review token; anything else is kept, and the
// question is never asked again (`safety on` stays). Never from the agent's shell or
// without a terminal (nothing is recorded then, so the user is asked in their own terminal).
//
//   memory_settings.safety_offered = {"at": ISO, "answer": "yes"|"no"|"on-already"}

import { getSetting, putSetting } from "./l5-tables.mjs";
import { PRODUCT } from "../product.mjs";

export const OFFER_KEY = "safety_offered";

/** The kept answer, or null when the policy was never offered. */
export function offerRecord(handle) {
  const v = getSetting(handle, OFFER_KEY);
  if (v === null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return { answer: String(v) };
  }
}

const record = (handle, answer, now) => putSetting(handle, OFFER_KEY, JSON.stringify({ at: now.toISOString(), answer }), { now });

/**
 * Ask once. → {asked:boolean, answer?:"yes"|"no"|"on-already", why?:string, code?:number}
 * @param {{handle:any, ask:(q:string)=>Promise<string>, out:(l:string)=>void, token?:string|null,
 *   getToken?:()=>Promise<{token?:string, refused?:string}|null>, root:string, env?:object,
 *   isTTY?:()=>boolean, version?:string|null, now?:Date, cmdName?:string|null,
 *   command?:(v:string)=>string}} o
 *   token: the run's review token (review); getToken: asks for it only after a yes (setup).
 */
export async function offerPolicyOnce(o) {
  const { handle, out } = o;
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const command = o.command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const now = o.now ?? new Date();
  if (offerRecord(handle)) return { asked: false, why: "offered before" };
  // S4: the agent's shell is never asked (and nothing is recorded: the user still is).
  if (env.AD_TOOL_SHELL === "1" || !isTTY()) return { asked: false, why: "not your own terminal" };
  const policy = await import("./starter-policy.mjs");
  if (policy.policyState(handle).state !== "off") {
    record(handle, "on-already", now);
    return { asked: false, answer: "on-already" };
  }
  out("");
  out("Starter safety policy (off by default), for every project. It asks before:");
  for (const f of policy.policyState(handle).families) out(`  ${f.text}`);
  out(`  ${policy.POLICY_COPY.limits}`);
  const a = String((await o.ask(`${policy.POLICY_COPY.offer} `)) ?? "").trim().toLowerCase();
  if (a !== "y" && a !== "yes") {
    record(handle, "no", now);
    out(`  Left off; you won't be asked again. Turn it on any time: \`${command("safety on")}\``);
    return { asked: true, answer: "no" };
  }
  let token = o.token ?? null;
  if (!token) {
    const t = await (o.getToken ?? (async () => (await import("./review-service.mjs")).reviewToken({ ask: o.ask, out })))();
    token = t?.token ?? null;
    if (!token) {
      // Not recorded: the yes didn't take, so it is asked again next time.
      out(`  Nothing changed: this needs your own terminal (${t?.refused ?? "not your own terminal"}). \`${command("safety on")}\` turns it on.`);
      return { asked: true, why: "no token" };
    }
  }
  const { turnPolicyOn } = await import("./safety-cli.mjs");
  const version = o.version !== undefined ? o.version : (await import("./own-version.mjs")).ownVersion?.() ?? null;
  const code = await turnPolicyOn({ handle, token, root: o.root, version, now, cmd: o.cmdName ?? null, out, command });
  // Kept only once it took (review M1): a yes that changed nothing is asked again.
  if (policy.policyState(handle).state === "off") return { asked: true, why: "not turned on", code };
  record(handle, "yes", now);
  return { asked: true, answer: "yes", code };
}

/**
 * review's hook (L7 P4 `afterRuleStep`): the offer with the run's token, asked through the
 * step's own input. → ({handle, token, out, input}) => Promise
 */
export function reviewOffer({ env = process.env, isTTY, cmdName = null, command, root } = {}) {
  return async ({ handle, token, out, input }) => {
    const r = root ?? (await import("../ad-root.mjs")).adRoot({ env });
    return offerPolicyOnce({ handle, token, out, ask: (q) => input.line(q), root: r, env, isTTY, cmdName, command });
  };
}

/** setup's last step: the offer, asking for the review token only after a yes. → result or null */
export async function setupOffer({ out, env = process.env, isTTY, cmdName = null, command, root, ask, handle } = {}) {
  const h = handle ?? (await (await import("./episodic.mjs")).db().catch(() => null));
  if (!h) return null;
  const q = ask ?? (async (text) => {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(text);
    } finally {
      rl.close();
    }
  });
  const r = root ?? (await import("../ad-root.mjs")).adRoot({ env });
  return offerPolicyOnce({ handle: h, out, ask: q, root: r, env, isTTY, cmdName, command });
}
