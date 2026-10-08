// Protocol snapshot — the part of the codex app-server protocol Agent Daemon
// depends on, reduced to a small, stable, diffable JSON document.
//
// Built from `codex app-server generate-json-schema --out <dir>`. The full
// schema is ~40 files and changes cosmetically every release; the snapshot
// keeps only method lists plus the shape (required + property names, enum
// values, union tags) of the definitions we actually read or send. Upgrade
// CI regenerates it for a new Codex version and diffs: removals are
// breaking, additions are informational.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MISSING, resolveCodexCommand } from "./app-server.mjs";
import { codexEnv } from "./home.mjs";

// Definitions the engine sends or reads. Add a name here whenever engine
// code starts depending on a new request/response/notification shape.
export const TRACKED_DEFINITIONS = [
  "InitializeParams",
  "ClientInfo",
  "ThreadStartParams",
  "ThreadStartResponse",
  "ThreadResumeParams",
  "ThreadResumeResponse",
  "Thread",
  "TurnStartParams",
  "TurnStartResponse",
  "TurnInterruptParams",
  "TurnSteerParams",
  "TurnCompletedNotification",
  "TurnStartedNotification",
  "Turn",
  "TurnStatus",
  "TurnError",
  "UserInput",
  "ThreadItem",
  "FileUpdateChange",
  "AgentMessageDeltaNotification",
  "ItemStartedNotification",
  "ItemCompletedNotification",
  "ErrorNotification",
  "SandboxMode",
  "AskForApproval",
  "CommandExecutionApprovalDecision",
  "FileChangeApprovalDecision",
  "GetAccountResponse",
  "LoginAccountParams",
  "LoginAccountResponse",
  "ConfigBatchWriteParams",
  "ConfigValueWriteParams",
  "ConfigEdit",
  "MergeStrategy",
  "HooksListParams",
  "HookMetadata",
  "SkillsExtraRootsSetParams",
  "ThreadListParams",
  "ThreadListResponse",
];

// Every method ad sends (a test checks this list against the request("…")
// calls in src/). Their params types, and every type those reference, are
// tracked too, so the fake app-server can check ad's own requests against the
// pinned protocol (testkit/protocol-check.mjs), not only what Codex sends.
export const SENT_METHODS = [
  "account/login/cancel",
  "account/login/start",
  "account/logout",
  "account/rateLimits/read",
  "account/read",
  "account/usage/read",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/read",
  "config/value/write",
  "fuzzyFileSearch",
  "hooks/list",
  "initialize",
  "mcpServerStatus/list",
  "model/list",
  "review/start",
  "skills/extraRoots/set",
  "skills/list",
  "thread/archive",
  "thread/compact/start",
  "thread/delete",
  "thread/fork",
  "thread/goal/clear",
  "thread/goal/set",
  "thread/list",
  "thread/name/set",
  "thread/resume",
  "thread/revert",
  "thread/shellCommand",
  "thread/start",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
  "windowsSandbox/readiness",
  "windowsSandbox/setupStart",
];

const methodsOf = (schema) =>
  (schema.oneOf ?? schema.anyOf ?? [])
    .map((o) => o.properties?.method?.enum?.[0])
    .filter(Boolean)
    .sort();

// method → the name of its params type, for what Codex sends us. Their
// shapes are tracked too, so the fake server's messages can be checked
// against the pinned protocol (testkit/protocol-check.mjs).
const paramsOf = (schema) =>
  Object.fromEntries(
    (schema.oneOf ?? schema.anyOf ?? [])
      .map((o) => [o.properties?.method?.enum?.[0], typeLabel(o.properties?.params)])
      .filter(([m, t]) => m && t && t !== "any" && /^[A-Z]\w*$/.test(t))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

// A stable name for a union variant that survives field additions:
// discriminator value → single-key object name → title → $ref → enum value.
function variantTag(v) {
  const props = v.properties ?? {};
  if (props.type?.enum?.length === 1) return props.type.enum[0];
  for (const [key, p] of Object.entries(props)) if (p?.enum?.length === 1) return `${key}=${p.enum[0]}`;
  const keys = Object.keys(props);
  if (keys.length === 1 && v.required?.includes(keys[0])) return keys[0];
  return v.title ?? v.$ref?.split("/").pop() ?? (v.enum?.length ? v.enum.join("|") : v.type ?? "variant");
}

// Reduce one JSON-schema definition to its contract-relevant shape.
export function shapeOf(def) {
  if (!def) return null;
  const variants = def.oneOf ?? def.anyOf;
  if (variants) {
    const seen = new Map();
    return {
      union: variants
        .map((v) => {
          let tag = variantTag(v);
          const n = (seen.get(tag) ?? 0) + 1;
          seen.set(tag, n);
          if (n > 1) tag = `${tag}#${n}`;
          const props = v.properties ? Object.keys(v.properties).sort() : undefined;
          if (!props) return { tag };
          // Variant fields carry their types too: a field changing type inside a
          // variant (ThreadItem.command string → array) breaks readers.
          return { tag, props, types: Object.fromEntries(props.map((k) => [k, typeLabel(v.properties[k])])) };
        })
        .sort((a, b) => String(a.tag).localeCompare(String(b.tag))),
    };
  }
  if (def.enum) return { enum: [...def.enum].sort() };
  if (def.properties) {
    const props = Object.keys(def.properties).sort();
    return {
      required: [...(def.required ?? [])].sort(),
      props,
      types: Object.fromEntries(props.map((k) => [k, typeLabel(def.properties[k])])),
    };
  }
  return { type: def.type ?? null };
}

// A short, stable label for a property's type: "string", "string|null",
// a definition name, "A|null" for an optional reference, "array<T>".
export function typeLabel(p, depth = 0) {
  if (!p || p === true) return "any";
  if (p.$ref) return p.$ref.split("/").pop();
  if (p.allOf?.length === 1) return typeLabel(p.allOf[0], depth);
  const variants = p.anyOf ?? p.oneOf;
  if (variants) return [...new Set(variants.map((v) => typeLabel(v, depth)))].sort().join("|");
  // Inline enums keep their values; inline objects their fields (two levels),
  // so a renamed inner key or a dropped enum value shows up in the diff.
  if (p.enum) return `enum(${[...p.enum].map(String).sort().join("|")})`;
  if (p.properties && depth < 2) {
    const keys = Object.keys(p.properties).sort();
    return `{${keys.map((k) => `${k}:${typeLabel(p.properties[k], depth + 1)}`).join(",")}}`;
  }
  const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
  if (!types.length) return "any";
  return types
    .map((t) => (t === "array" ? `array<${typeLabel(p.items, depth)}>` : t))
    .sort()
    .join("|");
}

// The v2 bundle holds most definitions; a few (approval decisions) only
// exist inside their own per-message files. Merge everything, bundle first.
function collectDefinitions(schemaDir, read) {
  const defs = { ...(read("codex_app_server_protocol.v2.schemas.json").definitions ?? {}) };
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".json")).sort()) {
    const schema = read(file);
    for (const [name, def] of Object.entries(schema.definitions ?? {})) defs[name] ??= def;
    defs[file.replace(/\.json$/, "")] ??= schema;
  }
  return defs;
}

// The definitions reachable from `roots` through $refs (the roots included).
function referenced(roots, defs) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string") visit(node.$ref.split("/").pop());
    for (const v of Object.values(node)) walk(v);
  };
  const visit = (name) => {
    if (seen.has(name) || !defs[name]) return;
    seen.add(name);
    walk(defs[name]);
  };
  roots.forEach(visit);
  return seen;
}

export function buildSnapshot(schemaDir, codexVersion) {
  const read = (f) => JSON.parse(readFileSync(join(schemaDir, f), "utf8"));
  const defs = collectDefinitions(schemaDir, read);
  const params = {
    clientRequests: Object.fromEntries(Object.entries(paramsOf(read("ClientRequest.json"))).filter(([m]) => SENT_METHODS.includes(m))),
    serverNotifications: paramsOf(read("ServerNotification.json")),
    serverRequests: paramsOf(read("ServerRequest.json")),
  };
  const names = new Set([
    ...TRACKED_DEFINITIONS,
    ...Object.values(params.serverNotifications),
    ...Object.values(params.serverRequests),
    ...referenced(Object.values(params.clientRequests), defs),
  ]);
  const definitions = {};
  for (const name of [...names].sort((a, b) => TRACKED_DEFINITIONS.indexOf(a) - TRACKED_DEFINITIONS.indexOf(b) || a.localeCompare(b))) if (defs[name]) definitions[name] = shapeOf(defs[name]);
  return {
    codexVersion,
    methods: {
      clientRequests: methodsOf(read("ClientRequest.json")),
      clientNotifications: methodsOf(read("ClientNotification.json")),
      serverRequests: methodsOf(read("ServerRequest.json")),
      serverNotifications: methodsOf(read("ServerNotification.json")),
    },
    params,
    definitions,
  };
}

// Run a codex binary's schema generator into a temp dir and snapshot it.
// Defaults to the PINNED binary (empty env: AD_CODEX_BIN is ignored), since
// the snapshot is labelled with the pinned version.
export function generateSnapshot({ command = resolveCodexCommand({}), codexVersion } = {}) {
  if (!command.cmd) throw new Error(CODEX_MISSING);
  const dir = mkdtempSync(join(tmpdir(), "ad-codex-schema-"));
  // Its own throwaway CODEX_HOME too: Codex's default is the user's ~/.codex.
  const home = mkdtempSync(join(tmpdir(), "ad-codex-schema-home-"));
  try {
    execFileSync(command.cmd, [...command.prefix, "app-server", "generate-json-schema", "--out", dir], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: codexEnv({ home }),
    });
    return buildSnapshot(dir, codexVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

// A field that changed type breaks whoever reads or sends it; one that only
// became nullable is worth knowing but isn't breaking for a reader that copes.
function typeChanges(where, ta = {}, tb = {}, breaking, info) {
  for (const [prop, a] of Object.entries(ta ?? {})) {
    const b = tb?.[prop];
    if (b === undefined || b === a) continue;
    const parts = (t) => new Set(t.split("|"));
    const pa = parts(a);
    const pb = parts(b);
    const added = [...pb].filter((x) => !pa.has(x));
    const removed = [...pa].filter((x) => !pb.has(x));
    if (!removed.length && added.length === 1 && added[0] === "null") info.push(`${where}.${prop}: now nullable (${a} -> ${b})`);
    else breaking.push(`${where}.${prop}: type ${a} -> ${b}`);
  }
}

const setDiff = (a = [], b = []) => ({
  removed: a.filter((x) => !b.includes(x)),
  added: b.filter((x) => !a.includes(x)),
});

// → { breaking: string[], info: string[] }. A removed method, definition,
// field, enum value or union variant is breaking; a newly REQUIRED field on
// something we send is breaking too.
export function diffSnapshots(oldSnap, newSnap) {
  const breaking = [];
  const info = [];
  for (const group of Object.keys({ ...oldSnap.methods, ...newSnap.methods })) {
    const d = setDiff(oldSnap.methods[group], newSnap.methods[group]);
    d.removed.forEach((m) => breaking.push(`${group}: removed ${m}`));
    d.added.forEach((m) => info.push(`${group}: added ${m}`));
  }
  for (const name of Object.keys({ ...oldSnap.definitions, ...newSnap.definitions })) {
    const a = oldSnap.definitions[name];
    const b = newSnap.definitions[name];
    if (a && !b) { breaking.push(`${name}: definition removed`); continue; }
    if (!a && b) { info.push(`${name}: definition added`); continue; }
    if (!a && !b) continue;
    for (const key of ["props", "enum"]) {
      const d = setDiff(a[key], b[key]);
      d.removed.forEach((x) => breaking.push(`${name}.${key}: removed ${x}`));
      d.added.forEach((x) => info.push(`${name}.${key}: added ${x}`));
    }
    // A field that changed type breaks whoever reads or sends it.
    typeChanges(name, a.types, b.types, breaking, info);
    const req = setDiff(a.required, b.required);
    req.added.forEach((x) => breaking.push(`${name}: ${x} is now required`));
    req.removed.forEach((x) => info.push(`${name}: ${x} is no longer required`));
    if (a.union || b.union) {
      const tags = (s) => (s.union ?? []).map((v) => String(v.tag));
      const d = setDiff(tags(a), tags(b));
      d.removed.forEach((t) => breaking.push(`${name}: variant ${t} removed`));
      d.added.forEach((t) => info.push(`${name}: variant ${t} added`));
      for (const va of a.union ?? []) {
        const vb = (b.union ?? []).find((v) => String(v.tag) === String(va.tag));
        if (!vb) continue;
        typeChanges(`${name}[${va.tag}]`, va.types, vb.types, breaking, info);
        const pd = setDiff(va.props, vb.props);
        pd.removed.forEach((p) => breaking.push(`${name}[${va.tag}]: removed ${p}`));
        pd.added.forEach((p) => info.push(`${name}[${va.tag}]: added ${p}`));
      }
    }
  }
  return { breaking, info };
}

export function diffToMarkdown({ breaking, info }, fromVersion, toVersion) {
  const lines = [`## Codex app-server protocol: ${fromVersion} → ${toVersion}`, ""];
  if (!breaking.length && !info.length) lines.push("No changes to the tracked protocol surface.");
  if (breaking.length) lines.push(`### ⚠️ Breaking (${breaking.length})`, ...breaking.map((x) => `- ${x}`), "");
  if (info.length) lines.push(`### Added / relaxed (${info.length})`, ...info.map((x) => `- ${x}`), "");
  return lines.join("\n");
}
