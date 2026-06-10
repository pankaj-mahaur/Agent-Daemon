// Template loader — reads team templates from the project's teams/templates/ dir.
//
// Templates are JSON files defining roles, communication flows, and default
// task structures for common multi-agent patterns.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Bump when the template JSON shape changes in a non-backwards-compatible
 * way. v1 templates auto-migrate in-memory (no disk write) on load — see
 * migrateV1ToV2 below. CURRENT_SCHEMA_VERSION is the shape this loader
 * expects after migration.
 */
export const CURRENT_SCHEMA_VERSION = 2;

// One-warning-per-name tracking — avoids spamming stderr if loadTemplate
// is called repeatedly for the same template in a single process.
const loadedWarnings = new Set();

/**
 * @typedef {Object} RoleDef
 * @property {string} name
 * @property {boolean} [is_leader]
 * @property {string} instructions
 * @property {string[]} [skills]
 *
 * @typedef {Object} TaskTemplate
 * @property {string} title
 * @property {string} [owner]          - role name (resolved to agent name at spawn)
 * @property {string[]} [blocked_by]   - other task titles
 *
 * @typedef {Object} TeamTemplate
 * @property {string} name
 * @property {string} description
 * @property {RoleDef[]} roles
 * @property {string[]} flows
 * @property {TaskTemplate[]} [tasks]  - default task decomposition
 */

/**
 * Load a template by name. Searches:
 *   1. {PROJECT_ROOT}/teams/templates/{name}.json
 *   2. ~/.agent-daemon/teams/templates/{name}.json (user overrides)
 *
 * @param {string} name
 * @returns {Promise<TeamTemplate>}
 */
export async function loadTemplate(name) {
  const candidates = [
    path.join(PROJECT_ROOT, "teams", "templates", `${name}.json`),
    path.join(homeDir(), ".agent-daemon", "teams", "templates", `${name}.json`)
  ];

  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw);

      // Schema-version handling — migrate v1 in-memory, never write to disk
      const version = parsed.schema_version ?? 1;
      if (version < CURRENT_SCHEMA_VERSION) {
        if (!loadedWarnings.has(name)) {
          process.stderr.write(
            `agent-daemon: template "${name}" uses schema v${version} — auto-migrated to v${CURRENT_SCHEMA_VERSION}. ` +
            `Add "schema_version": ${CURRENT_SCHEMA_VERSION} to silence.\n`
          );
          loadedWarnings.add(name);
        }
        return migrateV1ToV2(parsed);
      }

      return parsed;
    } catch {
      // try next
    }
  }

  throw new Error(`template "${name}" not found. Searched:\n  ${candidates.join("\n  ")}`);
}

/**
 * Migrate a v1 template to v2 in-memory. Pure function — no disk writes.
 *
 * v1 → v2 changes:
 *   - Adds `schema_version: 2`
 *   - Defaults each role.max_retries to 2 if missing
 *   - Stores legacy `tasks[].blocked_by` titles as `tasks[].blocked_by_titles`
 *     too, so future task-ID resolution can prefer titles when ambiguous.
 *
 * @param {object} v1Template
 * @returns {object} v2 template (new object — input not mutated)
 */
export function migrateV1ToV2(v1Template) {
  const v2 = {
    ...v1Template,
    schema_version: 2,
    roles: (v1Template.roles || []).map(r => ({
      ...r,
      max_retries: r.max_retries ?? 2
    })),
    tasks: (v1Template.tasks || []).map(t => ({
      ...t,
      blocked_by_titles: t.blocked_by ? [...t.blocked_by] : []
    }))
  };
  return v2;
}

/**
 * Reset the per-process warning tracker. Test helper.
 */
export function _resetLoadedWarnings() {
  loadedWarnings.clear();
}

/**
 * List all available templates.
 *
 * @returns {Promise<{name: string, description: string, source: string}[]>}
 */
export async function listTemplates() {
  const sources = [
    { dir: path.join(PROJECT_ROOT, "teams", "templates"), source: "built-in" },
    { dir: path.join(homeDir(), ".agent-daemon", "teams", "templates"), source: "user" }
  ];

  const seen = new Set();
  const templates = [];

  for (const { dir, source } of sources) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const name = e.replace(/\.json$/, "");
      if (seen.has(name)) continue;
      seen.add(name);

      try {
        const raw = await fs.readFile(path.join(dir, e), "utf8");
        const tmpl = JSON.parse(raw);
        templates.push({ name, description: tmpl.description || "", source });
      } catch {
        // skip invalid
      }
    }
  }

  return templates;
}

/**
 * Find the leader role in a template.
 */
export function findLeader(template) {
  return template.roles.find(r => r.is_leader);
}

/**
 * Get non-leader (worker) roles.
 */
export function getWorkerRoles(template) {
  return template.roles.filter(r => !r.is_leader);
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}
