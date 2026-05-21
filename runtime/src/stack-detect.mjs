// Stack detection for smart skill installation.
//
// Reads project markers (package.json, requirements.txt, Cargo.toml, go.mod,
// framework config files) and emits a Set of stack labels. Used by `ad init
// --skills-mode smart` to choose which skills are relevant.
//
// Pure-ish: only fs reads against the given cwd. No network, no env effects.
// Best-effort: every read is wrapped in try/catch — missing files are silent.
// Failure mode is "fewer detected stacks", never a thrown error.
//
// Public API:
//   detectStack(cwd) → { stacks: Set<string>, signals: object }
//
// The `signals` object records which marker files actually existed, so
// callers can display "detected: package.json (next), eleventy.config.js"
// to the user during `ad init`.

import fs from "node:fs/promises";
import path from "node:path";

/** Stack labels we emit. Keep alphabetised. */
export const KNOWN_STACKS = Object.freeze([
  "astro", "cypress", "django", "docker", "dotnet", "drizzle",
  "eleventy", "expo", "fastapi", "flask", "flutter", "go",
  "monorepo", "nest", "next", "node-cli", "playwright", "postgres",
  "prisma", "python", "rails", "react", "react-native", "rust",
  "supabase", "svelte", "tauri", "vite", "vue"
]);

/**
 * Detect project stacks from filesystem markers.
 *
 * @param {string} cwd - absolute path to project root
 * @returns {Promise<{ stacks: Set<string>, signals: Object<string, string|boolean> }>}
 */
export async function detectStack(cwd) {
  const stacks = new Set();
  const signals = {};

  // -- Node.js / JS / TS ecosystem -------------------------------------
  const pkg = await readJson(path.join(cwd, "package.json"));
  if (pkg) {
    signals["package.json"] = true;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    // Frameworks
    if (deps["next"])                  { stacks.add("next");    signals.next = true; }
    if (deps["@11ty/eleventy"])        { stacks.add("eleventy"); signals.eleventy = true; }
    if (deps["astro"])                 { stacks.add("astro");   signals.astro = true; }
    if (deps["vite"])                  { stacks.add("vite");    signals.vite = true; }
    if (deps["svelte"])                { stacks.add("svelte");  signals.svelte = true; }
    if (deps["vue"])                   { stacks.add("vue");     signals.vue = true; }
    if (deps["@nestjs/core"])          { stacks.add("nest");    signals.nest = true; }

    // React (broad — many frameworks include it)
    if (deps["react"] || deps["react-dom"]) { stacks.add("react"); signals.react = true; }

    // React Native / Expo
    if (deps["react-native"])          { stacks.add("react-native"); signals["react-native"] = true; }
    if (deps["expo"])                  { stacks.add("expo");    signals.expo = true; }

    // DB / ORM
    if (deps["prisma"] || deps["@prisma/client"])  { stacks.add("prisma");  signals.prisma = true; }
    if (deps["drizzle-orm"])           { stacks.add("drizzle"); signals.drizzle = true; }
    if (deps["@supabase/supabase-js"]) { stacks.add("supabase"); signals.supabase = true; }
    if (deps["pg"] || deps["postgres"]) { stacks.add("postgres"); signals.postgres = true; }

    // Testing / QA
    if (deps["@playwright/test"] || deps["playwright"]) { stacks.add("playwright"); signals.playwright = true; }
    if (deps["cypress"])               { stacks.add("cypress"); signals.cypress = true; }

    // Tauri (Rust + web frontend)
    if (deps["@tauri-apps/api"] || deps["@tauri-apps/cli"]) { stacks.add("tauri"); signals.tauri = true; }

    // Node CLI marker: has a "bin" field
    if (pkg.bin) { stacks.add("node-cli"); signals["node-cli"] = "bin field in package.json"; }

    // Monorepo: pnpm-workspaces or npm/yarn workspaces or turbo
    if (pkg.workspaces) { stacks.add("monorepo"); signals.workspaces = "package.json workspaces"; }
  }

  // pnpm workspace
  if (await exists(path.join(cwd, "pnpm-workspace.yaml"))) {
    stacks.add("monorepo"); signals["pnpm-workspace.yaml"] = true;
  }
  if (await exists(path.join(cwd, "turbo.json"))) {
    stacks.add("monorepo"); signals["turbo.json"] = true;
  }
  if (await exists(path.join(cwd, "lerna.json"))) {
    stacks.add("monorepo"); signals["lerna.json"] = true;
  }

  // -- Framework config files (corroborate or stand-alone) -------------
  for (const name of ["eleventy.config.js", "eleventy.config.cjs", "eleventy.config.mjs", ".eleventy.js"]) {
    if (await exists(path.join(cwd, name))) {
      stacks.add("eleventy"); signals[name] = true; break;
    }
  }
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (await exists(path.join(cwd, name))) {
      stacks.add("next"); signals[name] = true; break;
    }
  }
  for (const name of ["vite.config.js", "vite.config.ts", "vite.config.mjs"]) {
    if (await exists(path.join(cwd, name))) {
      stacks.add("vite"); signals[name] = true; break;
    }
  }
  for (const name of ["astro.config.js", "astro.config.mjs", "astro.config.ts"]) {
    if (await exists(path.join(cwd, name))) {
      stacks.add("astro"); signals[name] = true; break;
    }
  }
  // Expo / React Native bare projects: android/ + ios/ folders or app.config.*
  if ((await exists(path.join(cwd, "android"))) && (await exists(path.join(cwd, "ios")))) {
    stacks.add("react-native"); signals["android+ios"] = true;
  }
  for (const name of ["app.config.js", "app.config.ts", "app.json"]) {
    if (await exists(path.join(cwd, name))) {
      // app.json is also used by other tools — only count as Expo signal if "expo" key inside
      if (name === "app.json") {
        const appJson = await readJson(path.join(cwd, name));
        if (appJson && appJson.expo) { stacks.add("expo"); signals["app.json"] = "expo block"; }
      } else {
        stacks.add("expo"); signals[name] = true;
      }
    }
  }

  // -- Python ----------------------------------------------------------
  const requirements = await readText(path.join(cwd, "requirements.txt"));
  if (requirements) {
    stacks.add("python");
    signals["requirements.txt"] = true;
    if (/^\s*fastapi\b/im.test(requirements)) { stacks.add("fastapi"); signals.fastapi = true; }
    if (/^\s*flask\b/im.test(requirements))   { stacks.add("flask");   signals.flask = true; }
    if (/^\s*django\b/im.test(requirements))  { stacks.add("django");  signals.django = true; }
  }
  const pyproject = await readText(path.join(cwd, "pyproject.toml"));
  if (pyproject) {
    stacks.add("python");
    signals["pyproject.toml"] = true;
    if (/\bfastapi\b/i.test(pyproject))       { stacks.add("fastapi"); signals.fastapi = true; }
    if (/\bflask\b/i.test(pyproject))         { stacks.add("flask");   signals.flask = true; }
    if (/\bdjango\b/i.test(pyproject))        { stacks.add("django");  signals.django = true; }
  }
  // Django manage.py is a strong marker
  if (await exists(path.join(cwd, "manage.py"))) {
    stacks.add("django"); stacks.add("python"); signals["manage.py"] = true;
  }

  // -- Rust ------------------------------------------------------------
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    stacks.add("rust"); signals["Cargo.toml"] = true;
    // Tauri: detect via Cargo.toml deps if tauri config exists
    if (await exists(path.join(cwd, "src-tauri"))) {
      stacks.add("tauri"); signals["src-tauri"] = true;
    }
  }

  // -- Go --------------------------------------------------------------
  if (await exists(path.join(cwd, "go.mod"))) {
    stacks.add("go"); signals["go.mod"] = true;
  }

  // -- Flutter / Dart --------------------------------------------------
  if (await exists(path.join(cwd, "pubspec.yaml"))) {
    stacks.add("flutter"); signals["pubspec.yaml"] = true;
  }

  // -- .NET ------------------------------------------------------------
  // Any .csproj at the root or one-level under src/
  const rootEntries = await safeReaddir(cwd);
  if (rootEntries.some(n => n.endsWith(".csproj") || n.endsWith(".sln") || n.endsWith(".fsproj"))) {
    stacks.add("dotnet"); signals.dotnet = true;
  }

  // -- Ruby on Rails ---------------------------------------------------
  if (await exists(path.join(cwd, "Gemfile"))) {
    const gemfile = await readText(path.join(cwd, "Gemfile"));
    if (gemfile && /\brails\b/i.test(gemfile)) {
      stacks.add("rails"); signals.rails = true;
    }
  }

  // -- Docker ----------------------------------------------------------
  if (await exists(path.join(cwd, "Dockerfile")) ||
      await exists(path.join(cwd, "docker-compose.yml")) ||
      await exists(path.join(cwd, "docker-compose.yaml")) ||
      await exists(path.join(cwd, "compose.yaml"))) {
    stacks.add("docker"); signals.docker = true;
  }

  return { stacks, signals };
}

/**
 * Pretty-print detected stacks for the user during `ad init`.
 *
 * @param {Set<string>} stacks
 * @returns {string} comma-separated, sorted
 */
export function formatStacks(stacks) {
  return [...stacks].sort().join(", ") || "(none detected)";
}

/**
 * Resolve detected stacks → { global: string[], project: string[] } skill lists.
 * Reads `stack-skill-map.json` (relative to PROJECT_ROOT/runtime/profiles/).
 *
 * @param {Set<string>} stacks - detected stacks (from detectStack())
 * @param {object} map - the parsed stack-skill-map.json
 * @returns {{ global: string[], project: string[], excluded: string[] }}
 */
export function resolveSkillsForStacks(stacks, map) {
  const globalSet  = new Set(map.always || []);
  const projectSet = new Set();
  const excludeSet = new Set();

  for (const stack of stacks) {
    const entry = (map.stacks || {})[stack];
    if (!entry) continue;
    for (const s of (entry.global  || [])) globalSet.add(s);
    for (const s of (entry.project || [])) projectSet.add(s);
    for (const s of (entry.exclude || [])) excludeSet.add(s);
  }

  // Combos: alphabetically-sorted key like "react+fastapi" if both present
  for (const [comboKey, comboSkills] of Object.entries(map.combos || {})) {
    const parts = comboKey.split("+");
    if (parts.every(p => stacks.has(p))) {
      for (const s of comboSkills) globalSet.add(s);
    }
  }

  // Apply excludes (excludes win over includes)
  for (const ex of excludeSet) {
    globalSet.delete(ex);
    projectSet.delete(ex);
  }

  return {
    global:   [...globalSet].sort(),
    project:  [...projectSet].sort(),
    excluded: [...excludeSet].sort()
  };
}

/**
 * Load and parse the stack-skill-map.json file. Best-effort — returns a
 * minimal-but-valid map on read failure so caller doesn't need to guard.
 *
 * @param {string} mapPath - absolute path to stack-skill-map.json
 * @returns {Promise<object>}
 */
export async function loadStackSkillMap(mapPath) {
  try {
    const txt = await fs.readFile(mapPath, "utf8");
    return JSON.parse(txt);
  } catch {
    return { always: [], stacks: {}, combos: {} };
  }
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readText(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

async function readJson(p) {
  const txt = await readText(p);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

async function safeReaddir(p) {
  try { return await fs.readdir(p); } catch { return []; }
}
