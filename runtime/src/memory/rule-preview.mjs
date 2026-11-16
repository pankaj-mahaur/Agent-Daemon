// The rule step's preview (MCP launch plan L7, design D18): what a proposed rule would have
// done on this project's Claude Code and Codex transcripts of the last 30 days. Offline,
// nothing stored; sources are filtered by date and project before any is read.
//
// Consent is asked once in the step and kept (memory_settings.history_preview "on"|"off");
// `config history-preview off` turns it off. With consent kept, the read starts in a worker
// when review starts; the step waits for it at most 1.5 s.

import { Worker } from "node:worker_threads";
import { getSetting, putSetting } from "./l5-tables.mjs";
import { isReviewToken } from "./review-service.mjs";
import { PREVIEW_DAYS } from "./rule-proposals.mjs";

export const CONSENT_KEY = "history_preview";
export const PREVIEW_WAIT_MS = 1500;

/** → "on" | "off" | null (never asked). */
export function previewConsent(handle) {
  try {
    const v = getSetting(handle, CONSENT_KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

/** Keep the user's answer. Turning it on reads the user's history: the review token; off needs none. */
export function setPreviewConsent(handle, value, { token = null, now } = {}) {
  if (!["on", "off"].includes(value)) throw new Error(`history preview: on or off, not ${value}`);
  if (value === "on" && !isReviewToken(token)) throw new Error("history preview: turning it on needs your own terminal");
  putSetting(handle, CONSENT_KEY, value, { now });
  return value;
}

const lean = (input) => {
  // What a rule matches on: the command, the patch, the target. Never the written content.
  const out = {};
  for (const k of ["command", "cmd", "patch", "file_path", "path", "notebook_path", "edits"]) if (input?.[k] !== undefined) out[k] = k === "edits" ? (Array.isArray(input.edits) ? input.edits.map(() => ({})) : undefined) : input[k];
  return out;
};

/**
 * This project's agent calls of the last `days` days. Synchronous (the worker runs it).
 * → {root, calls: {tool, input, os, cwd, ts}[]} ; root null when the folder isn't a project.
 */
export async function readPreviewCalls({ cwd, env = process.env, home, now = Date.now(), days = PREVIEW_DAYS } = {}) {
  const h = await import("../mistakes/history.mjs");
  const sources = h.listSources({ env, ...(home ? { home } : {}), cwd });
  if (!sources.root) return { root: null, calls: [] };
  const cutoff = now - days * 86_400_000;
  // By date before reading: a file last written before the window holds nothing in it.
  const recent = (files) => files.filter((f) => (f.mtimeMs ?? 0) >= cutoff);
  const filtered = { ...sources, claude: { ...sources.claude, files: recent(sources.claude.files) }, codex: { ...sources.codex, files: recent(sources.codex.files) } };
  const { calls } = h.readPrompts(filtered, { calls: true });
  return {
    root: sources.root,
    calls: calls.filter((c) => typeof c.ts === "number" && c.ts >= cutoff && c.ts <= now + 60_000).map((c) => ({ tool: c.tool, input: lean(c.input), os: c.os, cwd: c.cwd, ts: c.ts })),
  };
}

/**
 * Start the read in a worker. → {result: Promise<{root, calls}|null>, stop()}. Never throws;
 * a failed read resolves null (the step says the preview isn't ready).
 */
export function startPreviewRead(o = {}) {
  let worker = null;
  const result = new Promise((resolve) => {
    try {
      worker = new Worker(new URL("./rule-preview-worker.mjs", import.meta.url), { workerData: { cwd: o.cwd, env: o.env ?? process.env, home: o.home ?? null, now: o.now ?? Date.now() } });
      worker.unref();
      worker.once("message", (m) => resolve(m && Array.isArray(m.calls) ? m : null));
      worker.once("error", () => resolve(null));
      worker.once("exit", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
  return {
    result,
    stop: () => {
      try {
        worker?.terminate();
      } catch {
        // already gone
      }
    },
  };
}

/** Wait for a started read until `deadline` (ms since epoch). → the read, or null when not ready. */
export async function previewWithin(read, deadline, now = Date.now()) {
  if (!read) return null;
  const left = Math.max(0, deadline - now);
  let timer;
  const late = new Promise((resolve) => {
    // Not unref'd: the worker is, so this timer is what keeps the process alive for the wait
    // (with stdin closed, Node 22 would otherwise end the loop mid-await). Always cleared below.
    timer = setTimeout(() => resolve(null), left);
  });
  try {
    return await Promise.race([read.result, late]);
  } finally {
    clearTimeout(timer);
  }
}
