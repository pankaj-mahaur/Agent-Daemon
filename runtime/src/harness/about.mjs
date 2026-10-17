// `ad about`: what ad runs on. The engine's name, license and process name are
// shown here on purpose (design D4, an attribution place). Never starts the engine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aboutLines } from "../engine/attribution.mjs";
import { engineHome, engineVersion } from "../engine/index.mjs";

export function cmdAbout(opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  let home = null;
  try {
    const s = engineHome.state({ env, root: opts.root });
    home = s.state === "two-folders" ? null : s.path;
  } catch {
    home = null; // a conflict or a stray setting: ad doctor explains
  }
  const installed = engineVersion.installed(env, { run: opts.run });
  const lines = [
    `Agent Daemon ${pkg.version} (${pkg.license ?? "see LICENSE"})`,
    ...aboutLines({ engineVersion: installed.version ?? undefined, pinnedVersion: engineVersion.pinned(), homePath: home ?? "(see ad doctor)", settingsPath: home ? join(home, "config.toml") : "(see ad doctor)" }),
    `tested engine versions: ${(engineVersion.compat().tested ?? []).join(", ")}`,
    `notices: THIRD_PARTY_NOTICES.md (in ad's source folder)`,
  ];
  out.write(`${lines.join("\n")}\n`);
  return 0;
}
