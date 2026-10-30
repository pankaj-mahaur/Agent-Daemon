// The tool name map (P6.1 §4): the engine's tools — plain functions, a namespace's
// functions, custom (freeform) tools — as flat Chat function names, and back. Rebuilt from
// each request's own tools, so it holds no state between requests.
//
//   buildToolMap(tools, { strict }) → {
//     chatTools                      the Chat `tools` array
//     flat(kind, name, namespace)    the flat name of an engine tool (null when unknown)
//     resolve(flatName)              { kind: "function" | "custom", name, namespace? } | null
//   }
// Flat name: "<namespace>__<name>" (or the name), characters outside [A-Za-z0-9_-] → "_",
// at most 64; a collision or a longer name gets "_" + 6 base32 characters of the original's
// SHA-256. A name the model returns that isn't in the map is never guessed.

import { createHash } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const MAX = 64;

function hash6(s) {
  const h = createHash("sha256").update(s).digest();
  let out = "";
  for (let i = 0; i < 6; i++) out += B32[h[i] & 31];
  return out;
}

const keyOf = (kind, name, namespace) => `${kind}\u0000${namespace ?? ""}\u0000${name}`;

/** A refusal the request handler turns into an HTTP 400 naming the field. */
export const refusal = (param, message) => Object.assign(new Error(message), { code: "TRANSLATE_REFUSED", param });

export function customToolDescription(t) {
  const fmt = t.format;
  const parts = [t.description ?? ""];
  if (fmt?.type === "grammar") parts.push(`The input is free text (not JSON) in this ${fmt.syntax ?? ""} grammar:\n${fmt.definition ?? ""}`);
  else if (fmt?.type === "text") parts.push("The input is free text.");
  parts.push('Call this tool with {"input": "<the text>"}.');
  return parts.filter(Boolean).join("\n\n");
}

export function buildToolMap(tools = [], { strict = false } = {}) {
  const entries = []; // { kind, name, namespace, def }
  for (const [i, t] of (tools ?? []).entries()) {
    if (t?.type === "function") entries.push({ kind: "function", name: t.name, def: t });
    else if (t?.type === "namespace") {
      for (const [j, c] of (t.tools ?? []).entries()) {
        if (c?.type !== "function") throw refusal(`tools[${i}].tools[${j}]`, `ad can't pass a "${c?.type}" tool to this provider.`);
        // The namespace's own description says what its tools are for: kept on each.
        const def = t.description ? { ...c, description: `${t.description}\n\n${c.description ?? ""}`.trim() } : c;
        entries.push({ kind: "function", name: c.name, namespace: t.name, def });
      }
    } else if (t?.type === "custom") entries.push({ kind: "custom", name: t.name, def: t });
    // The engine's default cached search (external_web_access false) runs only on OpenAI's
    // own servers: a Chat provider could never have used it, so it is left out. Live search
    // the user turned on is refused, so they know it isn't there.
    else if (t?.type === "web_search" && t.external_web_access === false) continue;
    else throw refusal(`tools[${i}]`, t?.type === "web_search" ? "ad can't pass web search to this provider. Turn it off for this chat, or pick another model." : `ad can't pass the "${t?.type}" tool to this provider.`);
  }
  const byFlat = new Map();
  const byKey = new Map();
  for (const e of entries) {
    const original = e.namespace ? `${e.namespace}__${e.name}` : e.name;
    let flat = String(original).replace(/[^A-Za-z0-9_-]/g, "_");
    if (flat.length > MAX || byFlat.has(flat) || flat !== original) {
      // A changed, long or colliding name: suffixed with its own hash so it never meets
      // another tool's (a.b and a_b stay apart whatever the order).
      if (flat !== original || flat.length > MAX || byFlat.has(flat)) flat = `${flat.slice(0, MAX - 7)}_${hash6(keyOf(e.kind, e.name, e.namespace))}`;
    }
    for (let n = 2; byFlat.has(flat); n++) flat = `${flat.slice(0, MAX - 7)}_${hash6(`${keyOf(e.kind, e.name, e.namespace)}#${n}`)}`;
    byFlat.set(flat, e);
    byKey.set(keyOf(e.kind, e.name, e.namespace), flat);
  }
  const chatTools = [...byFlat].map(([flat, e]) => {
    if (e.kind === "custom") {
      return { type: "function", function: { name: flat, description: customToolDescription(e.def), parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } } };
    }
    const fn = { name: flat, description: e.def.description ?? "", parameters: e.def.parameters ?? { type: "object", properties: {} } };
    if (strict && e.def.strict) fn.strict = true;
    return { type: "function", function: fn };
  });
  return {
    chatTools,
    flat: (kind, name, namespace) => byKey.get(keyOf(kind, name, namespace)) ?? null,
    resolve(flatName) {
      const e = byFlat.get(flatName);
      return e ? { kind: e.kind, name: e.name, ...(e.namespace ? { namespace: e.namespace } : {}) } : null;
    },
  };
}
