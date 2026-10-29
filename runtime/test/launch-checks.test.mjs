// P8.4a: the launch's policy checks. The security page, the privacy page, the licence on every
// package, no analytics in ad's code, and no network code in the memory package.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-launch-checks-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function filesUnder(dir, re) {
  const out = [];
  const go = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") go(p);
      } else if (re.test(e.name)) out.push(p);
    }
  };
  go(dir);
  return out;
}

test("SECURITY.md has a supported-versions table, a reporting section and the memory scope rule", () => {
  const s = read("SECURITY.md");
  assert.match(s, /^## Supported versions$/m);
  assert.match(s, /^\| Version \| Supported \|$/m);
  assert.match(s, /^## Reporting a vulnerability$/m);
  assert.match(s, /another project/i, "the memory scope rule");
});

test("docs/privacy.md answers the questions a directory asks", () => {
  const p = read("docs/privacy.md");
  for (const h of ["What is stored, and where", "What the installer writes", "Network", "Telemetry", "Deleting everything", "Contact"]) assert.match(p, new RegExp(`^## ${h}$`, "m"), h);
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "terms.md")));
});

test("the licence: MIT in LICENSE and in every package.json", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  const pkgs = [path.join(ROOT, "runtime", "package.json"), ...filesUnder(path.join(ROOT, "packages"), /^package\.json$/)];
  assert.ok(pkgs.length >= 2);
  for (const f of pkgs) assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).license, "MIT", f);
});

const ANALYTICS = /segment\.io|posthog|sentry\.io|mixpanel|amplitude|google-analytics|googletagmanager/i;
test("no analytics in ad's code", () => {
  const files = [...filesUnder(path.join(ROOT, "runtime", "src"), /\.(mjs|js|json)$/), ...filesUnder(path.join(ROOT, "packages"), /\.(mjs|js|json)$/)];
  assert.ok(files.length > 100);
  const hits = files.filter((f) => ANALYTICS.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

// What the built memory package may never contain: a way to reach the network.
export const NETWORK = /from\s+["']node:(https?|net|dgram|tls|http2)["']|import\(\s*["']node:(https?|net|dgram|tls|http2)["']|require\(\s*["'](node:)?(https?|net|dgram|tls|http2)["']|\bfetch\s*\(|\bWebSocket\b/;
export const networkHits = (dir) => filesUnder(dir, /\.(mjs|js|cjs)$/).filter((f) => NETWORK.test(fs.readFileSync(f, "utf8")));

test("no network in the memory package: its built dist/ reaches no socket, no http, no fetch", async () => {
  const { build } = await import("../scripts/build-memory-package.mjs");
  const out = path.join(TMP, "pkg");
  build({ out });
  const dist = path.join(out, "dist");
  assert.ok(filesUnder(dist, /\.mjs$/).length > 5, "the package was built");
  assert.deepEqual(networkHits(dist).map((f) => path.relative(dist, f)), []);
  // The check itself: a fetch( in a copy is caught.
  fs.writeFileSync(path.join(dist, "planted.mjs"), "export const x = () => fetch('https://example.invalid');\n");
  assert.deepEqual(networkHits(dist).map((f) => path.basename(f)), ["planted.mjs"]);
});
