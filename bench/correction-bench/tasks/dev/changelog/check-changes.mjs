// Oracle for the changelog family: a change under src/ needs a new line in
// CHANGES.md's "## Unreleased" section. Reads {dir, changes} on stdin.
import fs from "node:fs";
import path from "node:path";

let raw = "";
for await (const c of process.stdin) raw += c;
const { dir, changes } = JSON.parse(raw);
const opportunity = changes.some((c) => c.path.startsWith("src/") && c.status !== "deleted");
let text = "";
try {
  text = fs.readFileSync(path.join(dir, "CHANGES.md"), "utf8").replace(/\r\n/g, "\n");
} catch {
  // no file: nothing was added to it
}
const lines = text.split("\n");
const start = lines.findIndex((l) => /^##\s+Unreleased\b/i.test(l));
const section = new Set();
if (start >= 0) for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (lines[i].trim()) section.add(lines[i]);
const added = changes.find((c) => c.path === "CHANGES.md")?.added ?? [];
const logged = added.some((l) => section.has(l));
process.stdout.write(JSON.stringify({ opportunity, violated: opportunity && !logged, detail: logged ? [] : ["no new line under ## Unreleased in CHANGES.md"] }));
