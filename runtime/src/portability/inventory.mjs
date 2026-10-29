// What ad keeps, for moving it to another machine (P7.1b): every file under ad's state root (G,
// adRoot()) and a project's .agent-daemon (P) belongs to exactly one class, and each class says
// whether an export takes it by default.
//
//   CLASSES: [{ id, where: "global"|"project", match: RegExp (on the "/"-joined relative path),
//              default: "in"|"opt"|"out"|"never", restore, note }]
//   classify(relPath, where) → the class, or null (a path no class names: a test catches it)
//   classOf(id) → the class
//
// in: taken by default · opt: only with --include <class> · out: left behind (machine-local) ·
// never: refused even when asked (secrets, engine homes, other tools' files). Which rows and
// files of a class belong to the selected projects is the exporter's job (P7.2).

import { legacyHomeName } from "../engine/attribution.mjs";

const C = (id, where, match, def, restore, note = "") => ({ id, where, match, default: def, restore, note });

export const CLASSES = Object.freeze([
  // never first: a secret-looking path is never taken, whatever else it would match.
  C("secrets", "global", /^(secrets(\/|$)|auth\.json$|.*\/auth\.json$)/, "never", "regenerated on the target", "keys and tokens never travel"),
  // The engine's rollouts before its folders: the rest of an engine folder is never taken.
  C("engine-rollouts", "global", /^(engine|a\/[^/]+)\/sessions\//, "opt", "imports/<id>/engine-sessions/ (view-only)"),
  C("engine-homes", "global", new RegExp(`^(engine|${legacyHomeName}|a/[^/]+)(/|$)`), "never", "regenerated on the target", "engine folders hold sign-ins"),
  C("machine-state", "global", /^(migrate\.json|agy-consent\.json|siwc\/host\.json|imports|exports)(\/|$)/, "never", "regenerated on the target"),
  C("memory-db", "global", /^episodic\.db$/, "in", "rebuilt row by row (P7.3)", "a snapshot; -wal and -shm never"),
  C("memory-db-sidecar", "global", /^episodic\.db-(wal|shm|journal)$/, "out", "—"),
  C("profile", "global", /^(user\.md|config\.json|notes\.json)$/, "in", "place / conflict"),
  C("tui-prefs", "global", /^tui\/prefs\.json$/, "in", "place"),
  C("tui-state", "global", /^tui\/state\.json$/, "in", "state merged by key"),
  C("tui-history", "global", /^tui\/history\.jsonl$/, "opt", "append"),
  C("accounts", "global", /^accounts\/registry\.json$/, "in", "merge by id", "credentials removed, needs-sign-in"),
  C("projects", "global", /^projects\.json$/, "in", "merge"),
  C("ledger", "global", /^sessions\//, "in", "place"),
  C("route-policy", "global", /^fallback\.json$/, "in", "place"),
  C("delegations", "global", /^delegations\//, "in", "place"),
  C("handoffs-global", "global", /^handoffs\//, "in", "under the target's slug"),
  C("watch", "global", /^watch\.json$/, "in", "place / conflict"),
  C("route-maps", "global", /^(route-map|routing-map)\.json$/, "in", "place / conflict"),
  C("schedules", "global", /^schedules\.json$/, "in", "merged, imported disabled"),
  C("review", "global", /^(proposed|applied)\//, "in", "place (renamed on clash), re-enters review"),
  C("project-data", "global", /^projects\/[^/]+\//, "in", "screened, placed under the target's projectDataDir"),
  C("pending", "global", /^pending_messages[^/]*\.jsonl?$/, "in", "append"),
  C("skill-log", "global", /^skill-author-log\.jsonl$/, "in", "append"),
  C("skill-manifest", "global", /^skill-manifest\.json$/, "in", "a reinstall list shown with its sources"),
  C("skill-library", "global", /^skills\//, "in", "place; published host folders re-linked by ad init", "current/, versions/, meta.json"),
  C("quota-cache", "global", /^(quota|catalog|spend)\//, "out", "—", "re-read from the providers"),
  C("machine-local", "global", /^(locks|running-agents|logs|schedule-logs|schedule-locks|audit|telemetry|teams|worktrees|loops|skill-traces|checkpoints)(\/|$)|^(STOP|viewer\.html|.*\.flag)$/, "out", "—"),
  C("tui-cache", "global", /^tui\/(?!prefs\.json$|state\.json$|history\.jsonl$)/, "out", "—", "the terminal UI's own caches"),
  C("project-journals", "project", /^(sessions\.jsonl|learning-journal(\.archive)?\.jsonl|.*\.draining-[^/]*\.jsonl)$/, "opt", "append, dedup by line hash", "raw capture"),
  C("project-machine-local", "project", /^(logs|loops|telemetry|skill-traces)(\/|$)|^(STOP|.*\.flag)$/, "out", "—"),
  C("project-memory", "project", /^(memory|archive|handoffs|proposed|applied)(\/|$)|^(config\.json|route-map\.json|skill-author-log\.jsonl|project\.json|activeContext\.md)$/, "in", "screened, then place / conflict"),
  C("session-logs", "project", /^session-logs\//, "opt", "place"),
]);

/** The class of a path relative to ad's state root ("global") or a project's .agent-daemon ("project"). */
export function classify(relPath, where = "global") {
  const p = String(relPath).replace(/\\/g, "/").replace(/^\.?\/+/, "");
  return CLASSES.find((c) => c.where === where && c.match.test(p)) ?? null;
}

export const classOf = (id) => CLASSES.find((c) => c.id === id) ?? null;

/** The classes --include can name: the opt ones (never ones are refused). */
export const OPTIONAL_CLASSES = Object.freeze(CLASSES.filter((c) => c.default === "opt").map((c) => c.id));
