#!/usr/bin/env node
// The release build of the memory product (MCP launch plan L3, Decision 24): one
// script that release-memory.yml's build job runs, and that runs the same locally
// (a dry run of the job). Into <out>:
//   dist/      what the release uploads, every file listed in SHA256SUMS:
//                <pkg>-<v>.tgz                        the npm package (npm pack)
//                <pkg>-<v>.cdx.json                   its SBOM (CycloneDX, from a scratch install of that tarball)
//                tools-list.json                      sha256 of tools/list per host × capture mode (checked against the golden)
//                <pkg>-claude-code-marketplace-<v>.zip        the plugin marketplace (exec-form hooks)
//                <pkg>-claude-code-marketplace-legacy-<v>.zip the same in shell form, for the old marketplace repo
//                <pkg>-product-repo-<v>.zip           the product repository's tree (marketplace + README)
//                <pkg>-agent-plugin-<v>.zip, <pkg>-cursor-<v>.zip, <pkg>-gemini-extension-<v>.zip
//                server.json                          the MCP Registry entry
//                SHA256SUMS
//   npm/       the package folder · hosts/ the host trees (product-repo/ among them)
//   hosts-legacy/ the shell-form marketplace · listing/ the rendered listing copy
// What setup writes for each host (hooks and command skills) rides in the npm package.
//   node runtime/scripts/release-memory-build.mjs --out <dir> [--no-sbom]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "../src/product.mjs";

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(RUNTIME, "..");
const GOLDEN = path.join(RUNTIME, "test", "fixtures", "tools-list.golden.json");
const isWin = process.platform === "win32";

/** Every file the release uploads in dist/, by name. */
export function artifactNames(v, p = PRODUCT.package) {
  return [
    `${p}-${v}.tgz`,
    `${p}-${v}.cdx.json`,
    "tools-list.json",
    `${p}-claude-code-marketplace-${v}.zip`,
    `${p}-claude-code-marketplace-legacy-${v}.zip`,
    `${p}-product-repo-${v}.zip`,
    `${p}-agent-plugin-${v}.zip`,
    `${p}-cursor-${v}.zip`,
    `${p}-gemini-extension-${v}.zip`,
    "server.json",
    "SHA256SUMS",
  ];
}

// npm is a .cmd shim on Windows, which needs a shell: quote each argument for cmd.exe.
const winQuote = (a) => {
  // cmd.exe expands %VAR% and !VAR! even inside quotes: refuse rather than guess.
  if (/[%!]/.test(a)) throw new Error(`can't pass ${a} to npm through cmd.exe (it holds % or !): pick another --out`);
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
};
const run = (cmd, args, opts = {}) => {
  const shell = isWin && /^(npm|npx)$/.test(cmd);
  return execFileSync(shell ? `${cmd} ${args.map(winQuote).join(" ")}` : cmd, shell ? [] : args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell, ...opts });
};
const zip = (cwd, name, dest) => run("zip", ["-qrX", dest, name], { cwd });

/**
 * The SBOM as the released package's own (D24): npm describes the scratch project it
 * ran in, so the package becomes metadata.component and the scratch root goes. Throws
 * when it isn't CycloneDX, doesn't name the package or a dependency, or holds a path.
 */
export function packageSbom(sbom, { name, version, dependencies = {} }) {
  if (sbom?.bomFormat !== "CycloneDX") throw new Error("the SBOM isn't CycloneDX");
  const purl = `pkg:npm/${name}@${version}`;
  const own = (sbom.components ?? []).find((c) => c.purl === purl);
  if (!own) throw new Error(`the SBOM doesn't list ${name}@${version}`);
  const scratchRef = sbom.metadata?.component?.["bom-ref"];
  const out = {
    ...sbom,
    // Installed from the local tarball, npm points its distribution at that file: the
    // released package's is the registry's.
    metadata: {
      ...sbom.metadata,
      component: {
        ...own,
        type: "application",
        properties: (own.properties ?? []).filter((p) => p.name !== "cdx:npm:package:path"),
        externalReferences: [...(own.externalReferences ?? []).filter((r) => r.type !== "distribution"), { type: "distribution", url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` }],
      },
    },
    components: sbom.components.filter((c) => c !== own),
    dependencies: (sbom.dependencies ?? []).filter((d) => d.ref !== scratchRef),
  };
  for (const [dep, v] of Object.entries(dependencies)) {
    // The package pins exact versions (one supply chain per release): a range is refused as such.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`${name}'s dependency ${dep} is "${v}": pin an exact version`);
    if (!out.components.some((c) => c.purl === `pkg:npm/${dep}@${v}`)) throw new Error(`the SBOM doesn't list ${dep}@${v}`);
  }
  const text = JSON.stringify(out);
  if (/sbom-scratch|"file:|[A-Za-z]:\\\\|\/(?:home|Users|tmp|var\/folders|private\/var)\//.test(text)) throw new Error("the SBOM names the scratch project or a local path");
  return out;
}

export function sha256sums(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f !== "SHA256SUMS" && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")}  ${f}`)
    .join("\n") + "\n";
}

export async function releaseBuild({ out, sbom = true, golden = GOLDEN, log = console.log } = {}) {
  if (!out) throw new Error("--out <dir> is required");
  out = path.resolve(out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`refusing --out ${out}: pick an empty folder`);
  const v = JSON.parse(fs.readFileSync(path.join(REPO, "packages", PRODUCT.package, "package.json"), "utf8")).version;
  const p = PRODUCT.package;
  const dist = path.join(out, "dist");
  if (spawnSync("zip", ["-v"]).status !== 0) throw new Error("the release build needs `zip` on PATH (it is on GitHub's Ubuntu runners)");
  fs.mkdirSync(dist, { recursive: true });
  const node = (script, args) => run(process.execPath, [path.join(RUNTIME, "scripts", script), ...args], { stdio: ["ignore", "pipe", "inherit"] });

  log("· npm package");
  node("build-memory-package.mjs", ["--out", path.join(out, "npm")]);
  run("npm", ["pack", "--pack-destination", dist], { cwd: path.join(out, "npm") });
  const tgz = path.join(dist, `${p}-${v}.tgz`);
  if (!fs.existsSync(tgz)) throw new Error(`npm pack didn't write ${tgz}`);

  if (sbom) {
    log("· SBOM (a scratch install of the tarball)");
    const scratch = path.join(out, "sbom-scratch");
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: `${p}-sbom`, version: v, private: true }, null, 2) + "\n");
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tgz], { cwd: scratch });
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages", p, "package.json"), "utf8"));
    const raw = JSON.parse(run("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev"], { cwd: scratch, maxBuffer: 64 * 1024 * 1024 }));
    fs.writeFileSync(path.join(dist, `${p}-${v}.cdx.json`), JSON.stringify(packageSbom(raw, { name: p, version: v, dependencies: pkg.dependencies }), null, 2) + "\n");
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  log("· tools/list per host × capture mode (against the reviewed golden)");
  const { toolsList, compareLists } = await import("./tools-list.mjs");
  const reviewed = JSON.parse(fs.readFileSync(golden, "utf8"));
  const checked = async (label, server) => {
    const lists = await toolsList({ server });
    const diff = compareLists(lists, reviewed);
    if (diff.length) throw new Error(`${label}'s tools/list isn't the reviewed one:\n  ${diff.join("\n  ")}`);
    return lists;
  };
  const lists = await checked("the package", path.join(out, "npm", "dist", "src", "mcp", "memory-server.mjs"));
  fs.writeFileSync(path.join(dist, "tools-list.json"), JSON.stringify(lists, null, 2) + "\n");

  log("· host packages");
  const { build, NAME } = await import("./build-host-packages.mjs");
  const hosts = path.join(out, "hosts");
  build({ out: hosts });
  const legacy = path.join(out, "hosts-legacy");
  build({ out: legacy, targets: ["claude-code"], hookForm: "string" });
  // The plugin ships its own copy of the server: it lists the reviewed tools too.
  for (const [label, root] of [["the plugin", hosts], ["the legacy plugin", legacy]]) await checked(label, path.join(root, "claude-code", "plugins", NAME, "server", "server.mjs"));
  zip(hosts, "claude-code", path.join(dist, `${p}-claude-code-marketplace-${v}.zip`));
  zip(legacy, "claude-code", path.join(dist, `${p}-claude-code-marketplace-legacy-${v}.zip`));
  zip(hosts, "product-repo", path.join(dist, `${p}-product-repo-${v}.zip`));
  zip(path.join(hosts, "agent-plugin"), p, path.join(dist, `${p}-agent-plugin-${v}.zip`));
  zip(path.join(hosts, "cursor"), p, path.join(dist, `${p}-cursor-${v}.zip`));
  zip(hosts, "gemini", path.join(dist, `${p}-gemini-extension-${v}.zip`));
  fs.copyFileSync(path.join(hosts, "registry", "server.json"), path.join(dist, "server.json"));

  log("· listing copy");
  node("render-copy.mjs", ["--out", path.join(out, "listing")]);

  fs.writeFileSync(path.join(dist, "SHA256SUMS"), sha256sums(dist));
  const missing = artifactNames(v).filter((n) => (n.endsWith(".cdx.json") && !sbom ? false : !fs.existsSync(path.join(dist, n))));
  const extra = fs.readdirSync(dist).filter((n) => !artifactNames(v).includes(n));
  if (missing.length || extra.length) throw new Error(`dist/ isn't the release's list:${missing.length ? ` missing ${missing.join(", ")}` : ""}${extra.length ? ` unexpected ${extra.join(", ")}` : ""}`);
  return { version: v, dist, hosts, legacy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  try {
    const r = await releaseBuild({ out: arg("--out"), sbom: !process.argv.includes("--no-sbom") });
    process.stdout.write(fs.readFileSync(path.join(r.dist, "SHA256SUMS"), "utf8"));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${r.version}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
