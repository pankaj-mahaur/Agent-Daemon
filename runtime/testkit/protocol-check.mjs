// Checks a message against the pinned protocol snapshot (plan Part 7): the
// fake app-server must only send what the real Codex could. Required fields,
// enum values, union tags and basic types, through every type the snapshot
// tracks; anything untracked is accepted as is.
//
//   checkMessage({method, params}, {kind: "notification" | "request"}) → [problem…]

import { readFileSync } from "node:fs";

const SNAPSHOT = JSON.parse(readFileSync(new URL("../src/engine/codex/protocol-snapshot.json", import.meta.url), "utf8"));
const DEFS = SNAPSHOT.definitions;

function checkLabel(value, label, where, out) {
  const alts = label.split("|").map((s) => s.trim());
  if (value === null || value === undefined) {
    if (!alts.includes("null") && !alts.includes("any")) out.push(`${where}: null where ${label} is expected`);
    return;
  }
  const errsPer = alts.filter((a) => a !== "null").map((alt) => {
    const e = [];
    checkOne(value, alt, where, e);
    return e;
  });
  if (errsPer.length && errsPer.every((e) => e.length)) out.push(...errsPer[0]);
}

function checkOne(value, label, where, out) {
  if (label === "any" || label.startsWith("{")) return;
  const arr = /^array<(.+)>$/.exec(label);
  if (arr) {
    if (!Array.isArray(value)) return void out.push(`${where}: expected an array`);
    value.forEach((v, i) => checkLabel(v, arr[1], `${where}[${i}]`, out));
    return;
  }
  const en = /^enum\((.*)\)$/.exec(label);
  if (en) {
    if (!en[1].split("|").includes(String(value))) out.push(`${where}: ${JSON.stringify(value)} is not one of ${en[1]}`);
    return;
  }
  if (label === "string") return void (typeof value !== "string" && out.push(`${where}: expected a string`));
  if (label === "integer" || label === "number") return void (typeof value !== "number" && out.push(`${where}: expected a number`));
  if (label === "boolean") return void (typeof value !== "boolean" && out.push(`${where}: expected a boolean`));
  if (label === "object" || label === "array") return;
  const def = DEFS[label];
  if (def) checkDef(value, def, `${where}<${label}>`, out);
}

function checkDef(value, def, where, out) {
  if (def.enum) {
    if (!def.enum.includes(value)) out.push(`${where}: ${JSON.stringify(value)} is not one of ${def.enum.join("|")}`);
    return;
  }
  if (def.union) {
    // Tags: a "type" value, "key=value" for another discriminator, a single key, or a bare enum value.
    const matches = (v) => {
      if (typeof value === "string") return v.tag === value || v.tag.split("|").includes(value);
      if (!value || typeof value !== "object") return false;
      const kv = /^(\w+)=(.*)$/.exec(v.tag);
      if (kv) return String(value[kv[1]]) === kv[2];
      return v.tag === value.type || (value.type === undefined && v.tag in value);
    };
    const variant = def.union.find(matches);
    if (!variant) return void out.push(`${where}: unknown variant ${JSON.stringify(value?.type ?? value)}`);
    if (variant.types) checkProps(value, { required: [], props: variant.props ?? [], types: variant.types }, where, out);
    return;
  }
  if (def.props) checkProps(value, def, where, out);
}

function checkProps(value, def, where, out) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void out.push(`${where}: expected an object`);
  for (const r of def.required ?? []) if (!(r in value)) out.push(`${where}: missing required ${r}`);
  for (const [k, v] of Object.entries(value)) {
    const label = def.types?.[k];
    if (label) checkLabel(v, label, `${where}.${k}`, out);
  }
}

export function checkMessage({ method, params }, { kind = "notification" } = {}) {
  const table = kind === "request" ? SNAPSHOT.params.serverRequests : SNAPSHOT.params.serverNotifications;
  const methods = kind === "request" ? SNAPSHOT.methods.serverRequests : SNAPSHOT.methods.serverNotifications;
  if (!methods.includes(method)) return [`${method}: not a ${kind} the pinned Codex sends`];
  const type = table[method];
  if (!type || !DEFS[type]) return [];
  const out = [];
  checkDef(params ?? {}, DEFS[type], method, out);
  return out;
}
