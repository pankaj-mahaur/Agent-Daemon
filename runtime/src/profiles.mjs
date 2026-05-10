// Resolve install profiles defined in runtime/profiles/profiles.json.
// Resolves `extends`, `hooks_add`, `skills_add` into a flat plan.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROFILES_PATH = path.resolve(path.dirname(__filename), "..", "profiles", "profiles.json");

let _cache = null;

async function loadManifest() {
  if (_cache) return _cache;
  _cache = JSON.parse(await readFile(PROFILES_PATH, "utf8"));
  return _cache;
}

export async function listProfiles() {
  const m = await loadManifest();
  return { default: m.default, names: Object.keys(m.profiles) };
}

export async function resolveProfile(name) {
  const m = await loadManifest();
  const wantedName = name || m.default;
  const raw = m.profiles[wantedName];
  if (!raw) {
    const known = Object.keys(m.profiles).join(", ");
    throw new Error(`unknown profile "${wantedName}". Known: ${known}`);
  }

  // Walk the extends chain (one level deep is plenty).
  const chain = [];
  let cur = raw;
  let curName = wantedName;
  while (cur) {
    chain.unshift({ name: curName, def: cur });
    if (cur.extends) {
      curName = cur.extends;
      cur = m.profiles[cur.extends];
    } else cur = null;
  }

  const hooks = [];
  const skills = [];
  let features = {};
  let description = "";
  for (const { def } of chain) {
    if (def.description) description = def.description;
    if (def.hooks) hooks.splice(0, hooks.length, ...def.hooks);
    if (def.hooks_add) for (const h of def.hooks_add) if (!hooks.includes(h)) hooks.push(h);
    if (def.skills) skills.splice(0, skills.length, ...def.skills);
    if (def.skills_add) for (const s of def.skills_add) if (!skills.includes(s)) skills.push(s);
    if (def.features) features = { ...features, ...def.features };
  }

  // Hydrate hook definitions.
  const resolvedHooks = hooks.map((h) => {
    const d = m.hookDefinitions[h];
    if (!d) throw new Error(`profile "${wantedName}" references undefined hook "${h}"`);
    return { id: h, ...d };
  });

  return {
    name: wantedName,
    description,
    hooks: resolvedHooks,
    skills,
    features,
  };
}
