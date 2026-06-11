// UserPromptSubmit hook — capability route advice.
//
// For "substantial" or "high-risk" prompts, injects a brief additionalContext
// hint telling Claude which installed skill, MCP, or native agent matches best.
// For "simple" prompts (greetings, trivial reads, quick questions) it returns
// {} — no advice, no overhead.
//
// Design constraints (from FUTURE-CLAUDE-SKILL-ROUTING-HARDENING-PLAN.md):
//   - Deterministic, no LLM call, no API key.
//   - Never blocks the prompt.
//   - Respects explicit "do not use skills" / "use only Read/Grep" overrides.
//   - Does NOT suppress native-agent use for prompts that explicitly request agents.
//   - Fails safe — any exception → passthrough().

import os from "node:os";
import { readStdinJson, passthrough, advise } from "./io.mjs";
import { recordRouteAdvice } from "../memory/episodic.mjs";
import { loadRouteMaps, compileEntryRegex } from "../route-map.mjs";

// ── Explicit constraint patterns ─────────────────────────────────────────────
// When the user says these things, we suppress forced-skill advice.
const CAPABILITY_CONSTRAINT_RE =
  /\b(do\s*not|don'?t|no)\s+use\s+(skills?|tools?|mcp|plugins?)\b|use\s+only\s+Read[\/,]?\s*Grep\b/i;

// Explicit sub-agent / parallel delegation — allow native agents, skip routing.
const EXPLICIT_AGENT_RE =
  /\b(sub-?agent|spawn\s+agent|parallel\s+worker|deploy\s+(two|2|multiple)\s+agent|run\s+(two|2|multiple)\s+agent|background\s+agent)\b/i;

// ── Simple prompt signals — no advice needed ─────────────────────────────────
const SIMPLE_PATTERNS = [
  /^\s*(hey|hi|hello|sup|yo|ok|okay|thanks|thank you|done|got it|sounds good|lgtm|sure|yes|no|👍|🙏)\s*[.!?]?\s*$/i,
  /^(what is|what's|who is|who's|when did|where is|how do I|how does)\b.{0,80}[?]?\s*$/i,
];

// ── Builtin routing map: [intent-regex, recommended-skill, description] ──────
// Curated, highest-priority tier — first match wins, checked BEFORE the
// compiled per-install route maps (see ../route-map.mjs).
const BUILTIN_ROUTING_MAP = [
  // Session close
  {
    re: /\b(bye|session\s*khatam|done\s+for\s+today|end\s+session|close\s+session|wrapping\s+up|session\s+done|ending\s+this\s+session|aaj\s+ka\s+kaam|ho\s+gaya\s+kaam|chalo\s+bye|i'?m\s+done)\b/i,
    skill: "session-close",
    tier: "substantial",
    note: "session-close skill runs session log + digest + handoff without an API key",
  },
  // Security audit
  {
    re: /\b(security\s+audit|security\s+review|vulnerability\s+check|csp\s+review|auth\s+(check|audit)|pen\s*test|owasp)\b/i,
    skill: "security-audit",
    fallback: "review-slice",
    tier: "high-risk",
    note: "security-audit (or review-slice) applies a 9-class bug checklist",
  },
  // General audit / review
  {
    re: /\b(audit|review\s+this|review\s+the|check\s+karo|deeply\s+dekho|iska\s+review|is\s+page\s+ko|seo\s+(of|audit|check)|ux\s+(review|audit))\b/i,
    skill: "review-slice",
    tier: "substantial",
    note: "review-slice applies a 9-class bug checklist grouped by root cause + severity",
  },
  // Debug / error
  {
    re: /\b(broken|bug|error|crash|toot\s+gaya|kaam\s+nahi|why\s+is\s+(this|it)\s+fail|exception|stack\s+trace|not\s+working|isn'?t\s+working)\b/i,
    skill: "debug-triage",
    tier: "substantial",
    note: "debug-triage applies strict triage order: services → data → cache → request → code",
  },
  // Implement / build / add feature
  {
    re: /\b(implement|add\s+feature|build\s+a|create\s+a|wire\s+up|banao|naya\s+banao|feature\s+add|is\s+feature\s+ko)\b/i,
    skill: "implement-feature",
    tier: "substantial",
    note: "implement-feature searches for existing utilities before writing new code",
  },
];

// ── Task size classifier ──────────────────────────────────────────────────────

function classifyPrompt(prompt, compiledEntries = []) {
  if (SIMPLE_PATTERNS.some(re => re.test(prompt))) return "simple";
  // Short prompt with no specialized keyword → probably simple. A compiled
  // trigger match counts as specialized too.
  if (prompt.trim().length < 40 &&
      !BUILTIN_ROUTING_MAP.some(r => r.re.test(prompt)) &&
      !compiledEntries.some(e => compileEntryRegex(e).test(prompt))) {
    return "simple";
  }
  return "substantial";
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function capabilityRouteAdvice() {
  try {
    const input = await readStdinJson();
    const prompt = String(input.prompt || "");
    const cwd = String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const sessionId = String(input.session_id || "");

    if (!prompt) { passthrough(); return 0; }

    // Respect explicit capability constraints.
    if (CAPABILITY_CONSTRAINT_RE.test(prompt)) {
      await tryRecordRoute({ sessionId, cwd, prompt, taskSize: "override", recommendedCapability: null, explicit_constraint: true });
      passthrough();
      return 0;
    }

    // Don't suppress native agents for explicit delegation requests.
    const explicitAgent = EXPLICIT_AGENT_RE.test(prompt);

    // Compiled per-install maps (project shadows global). Failure here →
    // builtin-only routing; the fail-safe contract holds.
    let compiledEntries = [];
    try {
      compiledEntries = await loadRouteMaps({ cwd, home: os.homedir() });
    } catch { /* builtin only */ }

    const taskSize = classifyPrompt(prompt, compiledEntries);

    if (taskSize === "simple" && !explicitAgent) {
      passthrough();
      return 0;
    }

    // Find the first matching route: curated builtins first, then compiled.
    let match = null;
    let promptIntent = null;
    let recommendationSource = null;
    for (const route of BUILTIN_ROUTING_MAP) {
      if (route.re.test(prompt)) {
        match = route;
        promptIntent = `builtin:${route.skill}`;
        recommendationSource = "builtin-map";
        break;
      }
    }
    if (!match) {
      const builtinSkills = new Set(BUILTIN_ROUTING_MAP.map(r => r.skill));
      for (const entry of compiledEntries) {
        if (builtinSkills.has(entry.skill)) continue;  // builtin already vetted it
        const m = prompt.match(compileEntryRegex(entry));
        if (m) {
          match = { skill: entry.skill, tier: entry.tier || "substantial", note: entry.note || `${entry.skill} matches this request` };
          promptIntent = m[0].toLowerCase();
          recommendationSource = "compiled-map";
          break;
        }
      }
    }

    if (!match) {
      // Substantial but no specific route match — no skill advice, still passes.
      passthrough();
      return 0;
    }

    // If explicit sub-agent request, mention the skill as optional context but
    // don't instruct Claude to invoke it first.
    const skillName = match.skill;
    let context;
    if (explicitAgent) {
      context = `[agent-daemon] Native agent execution detected. Note: the installed \`${skillName}\` skill may provide useful supporting context if the task applies.`;
    } else {
      const fallbackNote = match.fallback
        ? ` (use \`${match.fallback}\` if \`${skillName}\` is not installed)`
        : "";
      context = `[agent-daemon] This is a ${match.tier} request. Relevant installed skill: \`${skillName}\`${fallbackNote}. Invoke it before starting work. Reason: ${match.note}.`;
    }

    await tryRecordRoute({
      sessionId, cwd, prompt, taskSize: match.tier,
      recommendedCapability: skillName,
      promptIntent,
      recommendationSource,
      explicit_agent: explicitAgent,
      explicit_constraint: false,
    });

    advise(context);
    return 0;
  } catch (err) {
    // Fail-safe: never crash the session.
    if (process.env.AGENT_DAEMON_DEBUG === "1") {
      process.stderr.write(`capability-route-advice error: ${err.stack || err.message}\n`);
    }
    passthrough();
    return 0;
  }
}

async function tryRecordRoute(event) {
  try {
    await recordRouteAdvice(event);
  } catch {
    // Telemetry is non-critical.
  }
}
