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
      return JSON.parse(raw);
    } catch {
      // try next
    }
  }

  throw new Error(`template "${name}" not found. Searched:\n  ${candidates.join("\n  ")}`);
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
