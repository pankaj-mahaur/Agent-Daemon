// A scripted model for the CI smoke (`run.mjs --mock`): it proves the plumbing,
// never a result. It plays a forgetful agent:
//   a task turn       writes the family's VIOLATING example, unless the request
//                     already carries the lesson (the family's marker appears in
//                     what the model was given besides the task), then the COMPLIANT one
//   a tool result     "done"
//   anything else     "Understood." (the correction turn)
// The marker is a word only the lesson brings into the request: the fixture's
// README and the task never name it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime");
const { ev, lastUserText, roleTexts, startMockResponses, writeMockCodexHome } = await import(pathToFileURL(path.join(RUNTIME, "testkit", "mock-responses.mjs")).href);

export const MARKERS = { logger: "logInfo", dates: "fmtDate", ids: "newId", money: "Money.cents", http: "request(", timers: "wait(", settings: "settings.get", "error-envelope": "fail(", imports: "#app/", generated: "schema/api.yml", changelog: "CHANGES.md", "test-layout": ".spec.js" };

/** An apply_patch for {path: text}: files the fixture has are replaced whole, new ones added. */
export function patchFor(files, fixtureDir) {
  const parts = ["*** Begin Patch"];
  for (const [rel, text] of Object.entries(files)) {
    const body = text.replace(/\n$/, "").split("\n");
    const old = path.join(fixtureDir, ...rel.split("/"));
    if (fs.existsSync(old)) {
      parts.push(`*** Update File: ${rel}`, "@@", ...fs.readFileSync(old, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((l) => `-${l}`), ...body.map((l) => `+${l}`));
    } else parts.push(`*** Add File: ${rel}`, ...body.map((l) => `+${l}`));
  }
  parts.push("*** End Patch");
  return parts.join("\n");
}

/** @param {Array<{family, dir}>} split  @param {string} benchDir */
export function benchScript(split, benchDir) {
  const tasks = new Map();
  for (const { family } of split) for (const s of family.sessions) tasks.set(s.task, family);
  let call = 0;
  return (body) => {
    const input = Array.isArray(body?.input) ? body.input : [];
    if (input.at(-1)?.type === "function_call_output") return [ev.created(), ev.message("done"), ev.completed()];
    const task = lastUserText(body);
    const family = [...tasks.entries()].find(([t]) => task.includes(t))?.[1];
    if (!family) return [ev.created(), ev.message("Understood."), ev.completed()];
    const given = [...roleTexts(body, "developer"), ...roleTexts(body, "user"), ...roleTexts(body, "system")].join("\n").replace(task, "");
    const marker = MARKERS[family.id];
    const files = marker && given.includes(marker) ? family.examples.compliant : family.examples.violating;
    const fixtureDir = path.join(benchDir, "repos", family.sessions[0].fixture);
    const cmd = `apply_patch <<'EOF'\n${patchFor(files, fixtureDir)}\nEOF\n`;
    return [ev.created(), ev.functionCall(`call-bench-${++call}`, "exec_command", { cmd }), ev.completed()];
  };
}

/** Start the mock; → { url, configToml, requests, close }. */
export async function startBenchModel(split, benchDir, tmpDir) {
  const mock = await startMockResponses({ script: benchScript(split, benchDir) });
  const home = writeMockCodexHome(path.join(tmpDir, "mock-config"), { url: mock.url });
  const configToml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  return { url: mock.url, configToml, requests: mock.requests, close: () => mock.close() };
}
