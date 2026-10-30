// What a run does: the conditions, and the episodes in a seeded, interleaved order.
//
// An episode = one family × condition × model × seed, in a fresh temp home.
// The seed picks the correction phrasing, the same one for every condition and
// model, so conditions are compared on the same words.

import crypto from "node:crypto";
import { rng } from "./stats.mjs";

/**
 * What each condition turns on. The driver applies these and prints its exact
 * settings (keys, values) into every result file.
 */
export const CONDITIONS = {
  off: { adHooks: false, adTools: false, hostMemory: false, rulesFile: false, about: "no ad memory, the host's own memory off" },
  native: { adHooks: false, adTools: false, hostMemory: true, rulesFile: false, about: "the host's own memory on, ad off" },
  "static-rules": { adHooks: false, adTools: false, hostMemory: false, rulesFile: true, about: "each correction appended verbatim to the project's rules file" },
  "on-hooks": { adHooks: true, adTools: true, hostMemory: false, rulesFile: false, about: "ad memory with hooks (and its memory tools)" },
  "on-tools": { adHooks: false, adTools: true, hostMemory: false, rulesFile: false, about: "ad's memory tools only, no hooks" },
};

const seedOf = (...parts) => crypto.createHash("sha256").update(parts.join("\0")).digest().readUInt32LE(0);

/** The phrasing a seed picks for a family (independent of condition and model). */
export function pickPhrasing(phrasings, familyId, seed) {
  if (!phrasings.length) throw new Error(`family ${familyId} has no phrasings`);
  return phrasings[Math.floor(rng(seedOf("phrasing", familyId, seed))() * phrasings.length)];
}

/**
 * @param {Array<{family, dir, phrasings}>} split  from loadSplit
 * @param {{conditions: string[], models: string[], seeds: number[], runSeed?: number}} o
 */
export function buildPlan(split, { conditions, models, seeds, runSeed = 1 }) {
  for (const c of conditions) if (!CONDITIONS[c]) throw new Error(`unknown condition "${c}" (known: ${Object.keys(CONDITIONS).join(", ")})`);
  const episodes = [];
  for (const { family, dir, phrasings } of split)
    for (const seed of seeds) {
      const phrasing = pickPhrasing(phrasings, family.id, seed);
      for (const model of models)
        for (const condition of conditions) episodes.push({ id: `${family.id}.${condition}.${model}.s${seed}`, familyId: family.id, familyDir: dir, condition, model, seed, phrasing });
    }
  // Interleave: a seeded shuffle, so no condition runs only at quiet hours or on one provider day.
  const rand = rng(runSeed);
  for (let i = episodes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [episodes[i], episodes[j]] = [episodes[j], episodes[i]];
  }
  return episodes;
}
