// Analyse one or more result folders (runner/run.mjs --out).
//
//   node analysis/analyze.mjs <results dir>… [--json] [--out report.md]
//        [--resamples 10000] [--seed 20261019] [--holm-m <n>] [--allow-mock]
//        [--power 20,40,60 --min-effect 0.10]
//
// Prints the Markdown report (conditions, H1, H4 with CIs and sensitivities).
// --holm-m: the pre-registered number of confirmatory tests (default 2 per host and model).
// --power: a simulation-based power check for H1 and H4 (both of H4's comparisons
// must succeed) at a smallest effect stated before looking (--min-effect, in
// violation-rate points) and at 0.05 ÷ the number of tests (Holm's worst case).
// Results from --mock runs are refused unless --allow-mock: they prove plumbing,
// never a result.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { analyze, pairUnits, renderMarkdown } from "../lib/analysis.mjs";
import { powerAt } from "../lib/stats.mjs";

export function readResults(dirs, { allowMock = false } = {}) {
  const records = [];
  for (const d of dirs) {
    const run = JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf8"));
    if (run.mock && !allowMock) throw new Error(`${d} is a --mock run: it proves plumbing, never a result (pass --allow-mock to look anyway)`);
    for (const line of fs.readFileSync(path.join(d, "episodes.jsonl"), "utf8").split("\n")) if (line.trim()) records.push(JSON.parse(line));
  }
  return records;
}

const fmt = (ps) => (ps ? ps.map((p) => `${p.families} families → ${(100 * p.power).toFixed(0)}%`).join(", ") : "no pairs");

export function main(argv = process.argv.slice(2)) {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
      resamples: { type: "string", default: "10000" },
      seed: { type: "string", default: "20261019" },
      power: { type: "string" },
      "min-effect": { type: "string" },
      "holm-m": { type: "string" },
      "allow-mock": { type: "boolean", default: false },
    },
  });
  if (!positionals.length) throw new Error("usage: node analysis/analyze.mjs <results dir>… [--json] [--out report.md] [--power 20,40,60 --min-effect 0.10]");
  const records = readResults(positionals, { allowMock: a["allow-mock"] });
  const holmM = a["holm-m"] ? Number(a["holm-m"]) : null;
  const groups = analyze(records, { resamples: Number(a.resamples), seed: Number(a.seed), holmM });
  let power = null;
  if (a.power) {
    const delta = Number(a["min-effect"]);
    if (!(delta > 0)) throw new Error("--power needs --min-effect: the smallest drop in the violation rate worth finding (e.g. 0.10), stated before looking");
    const sizes = a.power.split(",").map(Number);
    const alpha = 0.05 / (holmM ?? groups.length * 2);
    power = { delta, alpha };
    for (const g of groups) {
      const rs = records.filter((r) => r.driver === g.driver && r.model === g.model);
      const h1 = [pairUnits(rs, "off", "on-hooks")];
      const h4 = [pairUnits(rs, "native", "on-hooks"), pairUnits(rs, "static-rules", "on-hooks")];
      g.power = {
        H1: h1.every((u) => u.length) ? powerAt(h1, { delta, sizes, alpha }) : null,
        H4: h4.every((u) => u.length) ? powerAt(h4, { delta, sizes, alpha }) : null,
      };
    }
  }
  let text = a.json ? JSON.stringify({ groups, power }, null, 2) : renderMarkdown(groups);
  if (!a.json && power) {
    text += `\n## Power (the pilot's families resampled; smallest effect ${(100 * power.delta).toFixed(0)} points; α = ${power.alpha.toFixed(4)})\n\n`;
    text += groups.map((g) => `- ${g.driver} · ${g.model}: H1 ${fmt(g.power.H1)}; H4 ${fmt(g.power.H4)}`).join("\n") + "\n";
  }
  if (a.out) fs.writeFileSync(a.out, text + "\n");
  else process.stdout.write(text + "\n");
  return groups;
}

const same = (x, y) => (process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y);
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
