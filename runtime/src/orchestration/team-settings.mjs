// `ad team set <team> fallback on|off` (P4.7): whether a team's workers may continue on the next
// model in the user's fallback order. Granting or changing it is refused from the agent's own
// shell (exit 2); a worker spawned from there still uses what the user granted here.

import { setTeamFallback } from "./team.mjs";

export const TEAM_SET_USAGE = "Usage: ad team set <team> fallback on|off";
const GUARD = "Fallback settings can't be changed from the agent's own shell. Run it in your terminal.";

export async function cmdTeamSet(args, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const [team, key, value] = args;
  if (!team || key !== "fallback" || !["on", "off"].includes(value)) {
    err.write(`${TEAM_SET_USAGE}\n`);
    return 1;
  }
  if (env.AD_TOOL_SHELL === "1") {
    err.write(`${GUARD}\n`);
    return 2;
  }
  try {
    await setTeamFallback(team, value === "on");
  } catch (e) {
    err.write(`ad team set: ${e.message}\n`);
    return 1;
  }
  out.write(`${team}: fallback ${value}\n`);
  return 0;
}
