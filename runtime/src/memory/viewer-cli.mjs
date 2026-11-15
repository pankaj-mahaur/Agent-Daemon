// `<pkg> view` (MCP launch plan L8b): write the read-only HTML snapshot of your
// learnings, rules and weekly numbers to adRoot()/view.html and say where it is. No server,
// no browser started, no network. The store is opened read-only; the only file written is
// that one (overwritten each run; there is no --out).

import fs from "node:fs";
import path from "node:path";
import { PRODUCT } from "../product.mjs";

export const VIEW_FILE = "view.html";
export const viewPath = (root) => path.join(root, VIEW_FILE);

/**
 * @param {string[]} argv
 * @param {{cwd?: string, env?: object, out?: (l: string) => void, root?: string, command?: (verb: string) => string, now?: number}} [o]
 * @returns {Promise<number>}
 */
export async function viewMain(argv, { cwd = process.cwd(), env = process.env, out = (l) => console.log(l), root, command, now = Date.now() } = {}) {
  let all = false;
  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      out("view [--all-projects]   write a read-only HTML page of your learnings, rules and weekly numbers, and print where it is");
      return 0;
    }
    if (a === "--all-projects") all = true;
    else {
      out(`unknown option ${a}`);
      return 1;
    }
  }
  const { adRoot } = await import("../ad-root.mjs");
  const base = root ?? adRoot({ env });
  const cmd = command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const { readOnlyStore } = await import("./recall-doctor.mjs");
  const { renderViewer } = await import("./viewer-html.mjs");
  const store = await readOnlyStore(path.join(base, "episodic.db"));
  let html;
  try {
    let data = null;
    if (store) {
      const { gatherView } = await import("./viewer-data.mjs");
      const { hookProjectKeys } = await import("./scope.mjs");
      const { readRuleEvents } = await import("../hooks/rule-events.mjs");
      const { screenPrompt } = await import("./prompt-screen.mjs");
      const keys = all ? null : await hookProjectKeys(cwd);
      data = gatherView(store, { keys, ruleEvents: readRuleEvents({ root: base }), now, screen: (t) => screenPrompt(t, { userWords: false }) });
    }
    html = renderViewer(data, { generatedAt: new Date(now).toISOString(), command: cmd });
  } finally {
    store?.close();
  }
  const file = viewPath(base);
  const { writeFileAtomic } = await import("../atomic-write.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, html);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: the folder's own rights apply
  }
  out(`Wrote ${file}`);
  out("Open it in your browser. It is a read-only snapshot: it starts no server, loads nothing from the internet and changes nothing. Run this again to refresh it.");
  return 0;
}
