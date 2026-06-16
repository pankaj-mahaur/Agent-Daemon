// Tests for the local memory viewer (viewer.mjs).
//
// buildViewerHtml is pure (generatedAt passed in) so it's directly testable.
// The load-bearing property is SECURITY: memory text comes from transcripts,
// so an injected <script> (or a forged </private>) must be escaped, never
// rendered live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildViewerHtml, escapeHtml } from "../src/viewer.mjs";

test("escapeHtml escapes the five significant characters", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("buildViewerHtml renders a graceful page when the driver is unavailable", () => {
  const html = buildViewerHtml({ driver: false }, "2026-06-16T00:00:00.000Z");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /unavailable/i);
  assert.match(html, /better-sqlite3/);
});

test("buildViewerHtml produces a complete document with the expected tabs", () => {
  const html = buildViewerHtml(sampleData(), "2026-06-16T00:00:00.000Z");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  for (const tab of ["Learnings", "Sessions", "Proposals", "Routing", "Telemetry"]) {
    assert.match(html, new RegExp(tab));
  }
  // real data is rendered
  assert.match(html, /clean learning text/);
  assert.match(html, /2026-06-16T00:00:00\.000Z/);  // generated stamp
});

test("buildViewerHtml ESCAPES an injected <script> payload (no live execution)", () => {
  const data = sampleData();
  data.learnings.push({
    id: 99, category: "pattern", confidence: 0.5, project_slug: "p",
    text: `<script>alert('xss')</script>`, tagList: ["</private>", `<img src=x onerror=alert(1)>`],
    observed_count: 1, retrieval_count: 0, created_at: "2026-06-16"
  });
  const html = buildViewerHtml(data, "2026-06-16T00:00:00.000Z");
  // The raw executable tag must NOT appear...
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /<\/private>/);  // forged closing marker escaped too
  // ...but its escaped form must (proves it was rendered-as-text, not dropped).
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;\/private&gt;/);
});

function sampleData() {
  return {
    driver: true,
    dbPath: "/home/u/.agent-daemon/episodic.db",
    counts: { sessions: 3, learnings: 5, proposals: 1 },
    retrieval: { events: 10, truncationRate: 0.2, avgInjectedBytes: 1234 },
    sessions: [
      { id: "abcd1234 effff", project_slug: "p", started_at: "2026-06-15T10:00:00Z", ended_at: "2026-06-15T10:20:00Z", digest_status: "digested", user_turns: 4, assistant_turns: 5, tool_calls: 12, edits: 3 }
    ],
    learnings: [
      { id: 1, category: "gotcha", confidence: 0.7, project_slug: "p", text: "clean learning text", tagList: ["src/a.ts"], observed_count: 2, retrieval_count: 1, created_at: "2026-06-15" }
    ],
    proposals: [
      { id: 1, kind: "skill-edit", title: "tweak debug-triage", status: "queued", created_at: "2026-06-15" }
    ],
    routes: { rows: [{ skill: "debug-triage", advised: 3, followed: 2, diverged: 1, ignored: 0 }], totals: { advised: 3, followed: 2, diverged: 1, ignored: 0 }, constraintOverrides: 0 }
  };
}
