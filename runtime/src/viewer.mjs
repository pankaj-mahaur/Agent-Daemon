// Local memory viewer — a single self-contained HTML snapshot.
//
// claude-mem ships a React app behind an always-on worker on a fixed port.
// agent-daemon's equivalent is deliberately the opposite: zero dependencies,
// no server, no network. `ad viewer` reads the episodic SQLite store, renders
// one HTML file (inline CSS + a tiny vanilla-JS tab/filter), writes it, and
// optionally opens it in the OS default browser. A snapshot, not a live feed.
//
// Security: every value is HTML-escaped AND run through neutralizeText before
// it touches the document — the viewer must never execute content that a
// transcript managed to smuggle into memory. See the escaping helpers below.

import { db } from "./memory/episodic.mjs";
import { routeAdviceStats, stats } from "./memory/episodic.mjs";
import { neutralizeText } from "./digest/sanitize.mjs";

/**
 * Escape the five HTML-significant characters. Applied to EVERY value rendered
 * into the document. Combined with neutralizeText (control/invisible/marker
 * stripping), this is what makes injected memory inert in the viewer.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** neutralize (strip invisibles/markers) THEN HTML-escape — the safe-cell path. */
function cell(s, maxChars = 600) {
  return escapeHtml(neutralizeText(String(s == null ? "" : s), { maxChars }));
}

/** Parse the JSON tags column into a clean string[] (best-effort). */
function parseTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.filter(t => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Gather everything the viewer renders, straight from the episodic store.
 * Returns { driver: false } when better-sqlite3 isn't installed so the caller
 * can render a graceful "unavailable" page (mirrors memory_stats behavior).
 * Each query is defensively wrapped — an older DB missing a table degrades to
 * an empty section rather than throwing.
 *
 * @returns {Promise<object>}
 */
export async function gatherViewerData() {
  const handle = await db();
  if (!handle) return { driver: false };

  const safeAll = (sql, params = []) => {
    try { return handle.all(sql, params); } catch { return []; }
  };

  const s = await stats().catch(() => ({ driver: true, counts: {}, retrieval: null, dbPath: handle.path }));

  const sessions = safeAll(
    `SELECT id, project_slug, started_at, ended_at, digest_status,
            user_turns, assistant_turns, tool_calls, edits
       FROM sessions ORDER BY started_at DESC LIMIT 50`
  );
  const learnings = safeAll(
    `SELECT id, category, text, confidence, project_slug, tags,
            observed_count, retrieval_count, created_at
       FROM learnings WHERE status = 'active'
      ORDER BY created_at DESC LIMIT 200`
  );
  const proposals = safeAll(
    `SELECT id, kind, title, status, created_at
       FROM proposals ORDER BY created_at DESC LIMIT 50`
  );
  let routes = { rows: [], totals: { advised: 0, followed: 0, diverged: 0, ignored: 0 }, constraintOverrides: 0 };
  try { routes = await routeAdviceStats({ days: 30 }); } catch { /* keep empty */ }

  return {
    driver: true,
    dbPath: s.dbPath || handle.path,
    counts: s.counts || {},
    retrieval: s.retrieval || null,
    sessions,
    learnings: learnings.map(l => ({ ...l, tagList: parseTags(l.tags) })),
    proposals,
    routes
  };
}

/**
 * Render the viewer HTML. Pure + deterministic given its input (generatedAt is
 * passed in, not read from the clock) so it's unit-testable. Returns a complete
 * standalone HTML document string.
 *
 * @param {object} data            - shape from gatherViewerData()
 * @param {string} generatedAt     - ISO timestamp to stamp into the header
 * @returns {string}
 */
export function buildViewerHtml(data, generatedAt) {
  const stamp = escapeHtml(generatedAt || "");
  if (!data || data.driver === false) {
    return wrapDoc(stamp, `<p class="empty">Episodic store unavailable — <code>better-sqlite3</code> is not installed.<br>Run <code>cd runtime &amp;&amp; npm install</code>, then re-run <code>ad viewer</code>.</p>`);
  }

  const countsRow = Object.entries(data.counts || {})
    .map(([t, n]) => `<span class="stat"><b>${escapeHtml(n)}</b> ${escapeHtml(t)}</span>`)
    .join("");
  const ret = data.retrieval
    ? `<span class="stat"><b>${escapeHtml(data.retrieval.events)}</b> retrievals/7d</span>` +
      `<span class="stat"><b>${escapeHtml(Math.round((data.retrieval.truncationRate || 0) * 100))}%</b> truncated</span>`
    : "";

  const tabs = [
    { id: "learnings", label: `Learnings (${(data.learnings || []).length})`, body: renderLearnings(data.learnings) },
    { id: "sessions", label: `Sessions (${(data.sessions || []).length})`, body: renderSessions(data.sessions) },
    { id: "proposals", label: `Proposals (${(data.proposals || []).length})`, body: renderProposals(data.proposals) },
    { id: "routing", label: "Routing", body: renderRoutes(data.routes) },
    { id: "telemetry", label: "Telemetry", body: renderTelemetry(data) }
  ];

  const tabButtons = tabs.map((t, i) =>
    `<button class="tabbtn${i === 0 ? " active" : ""}" data-tab="${t.id}">${escapeHtml(t.label)}</button>`
  ).join("");
  const tabPanels = tabs.map((t, i) =>
    `<section class="tab${i === 0 ? " active" : ""}" id="tab-${t.id}">${t.body}</section>`
  ).join("");

  const header = `
    <header>
      <h1>agent-daemon memory</h1>
      <div class="meta">${escapeHtml(data.dbPath || "")} · generated ${stamp}</div>
      <div class="stats">${countsRow}${ret}</div>
    </header>
    <div class="controls">
      <input id="filter" type="search" placeholder="Filter rows in the active tab…" autocomplete="off">
      <nav class="tabs">${tabButtons}</nav>
    </div>`;

  return wrapDoc(stamp, header + tabPanels + VIEWER_SCRIPT);
}

function renderLearnings(rows) {
  if (!rows || rows.length === 0) return emptyMsg("No learnings recorded yet.");
  const body = rows.map(l => {
    const tags = (l.tagList || []).map(t => `<span class="tag">${cell(t, 80)}</span>`).join(" ");
    return `<tr>
      <td class="num">${escapeHtml(l.id)}</td>
      <td><span class="cat cat-${escapeHtml(String(l.category || "").replace(/[^a-z]/gi, ""))}">${cell(l.category, 40)}</span></td>
      <td class="conf">${escapeHtml(Number(l.confidence).toFixed(2))}</td>
      <td>${cell(l.text)}<div class="tags">${tags}</div></td>
      <td class="num">${escapeHtml(l.observed_count ?? 1)}/${escapeHtml(l.retrieval_count ?? 0)}</td>
      <td class="dim">${cell(l.project_slug, 80) || "<i>global</i>"}</td>
    </tr>`;
  }).join("");
  return table(["id", "type", "conf", "learning", "seen/used", "project"], body);
}

function renderSessions(rows) {
  if (!rows || rows.length === 0) return emptyMsg("No sessions recorded yet.");
  const body = rows.map(s => `<tr>
      <td class="mono">${cell(String(s.id || "").slice(0, 8), 12)}</td>
      <td class="dim">${cell(s.project_slug, 80)}</td>
      <td>${cell(s.started_at, 40)}</td>
      <td><span class="status status-${escapeHtml(String(s.digest_status || "").replace(/[^a-z-]/gi, ""))}">${cell(s.digest_status, 40)}</span></td>
      <td class="num">${escapeHtml(s.user_turns)}/${escapeHtml(s.assistant_turns)}</td>
      <td class="num">${escapeHtml(s.tool_calls)}</td>
      <td class="num">${escapeHtml(s.edits)}</td>
    </tr>`).join("");
  return table(["session", "project", "started", "status", "u/a turns", "tools", "edits"], body);
}

function renderProposals(rows) {
  if (!rows || rows.length === 0) return emptyMsg("No proposals queued.");
  const body = rows.map(p => `<tr>
      <td class="num">${escapeHtml(p.id)}</td>
      <td>${cell(p.kind, 40)}</td>
      <td>${cell(p.title, 200)}</td>
      <td><span class="status status-${escapeHtml(String(p.status || "").replace(/[^a-z-]/gi, ""))}">${cell(p.status, 40)}</span></td>
      <td>${cell(p.created_at, 40)}</td>
    </tr>`).join("");
  return table(["id", "kind", "title", "status", "created"], body);
}

function renderRoutes(routes) {
  const rows = routes?.rows || [];
  if (rows.length === 0) return emptyMsg("No route-advice telemetry in the last 30 days.");
  const body = rows.map(r => `<tr>
      <td>${cell(r.skill, 60)}</td>
      <td class="num">${escapeHtml(r.advised)}</td>
      <td class="num">${escapeHtml(r.followed)}</td>
      <td class="num">${escapeHtml(r.diverged)}</td>
      <td class="num">${escapeHtml(r.ignored)}</td>
    </tr>`).join("");
  const t = routes.totals || {};
  const foot = `<p class="dim">Totals (30d): advised ${escapeHtml(t.advised || 0)}, followed ${escapeHtml(t.followed || 0)}, diverged ${escapeHtml(t.diverged || 0)}, ignored ${escapeHtml(t.ignored || 0)} · constraint overrides ${escapeHtml(routes.constraintOverrides || 0)}</p>`;
  return table(["skill", "advised", "followed", "diverged", "ignored"], body) + foot;
}

function renderTelemetry(data) {
  const c = data.counts || {};
  const lines = Object.entries(c).map(([t, n]) =>
    `<tr><td>${escapeHtml(t)}</td><td class="num">${escapeHtml(n)}</td></tr>`
  ).join("");
  const ret = data.retrieval
    ? `<p>Retrieval (7d): <b>${escapeHtml(data.retrieval.events)}</b> events · <b>${escapeHtml(Math.round((data.retrieval.truncationRate || 0) * 100))}%</b> truncated · avg <b>${escapeHtml(data.retrieval.avgInjectedBytes || 0)}</b> bytes injected</p>`
    : `<p class="dim">No retrieval events recorded yet.</p>`;
  return table(["table", "rows"], lines) + ret;
}

function table(headers, bodyRows) {
  const head = headers.map(h => `<th>${escapeHtml(h)}</th>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function emptyMsg(msg) {
  return `<p class="empty">${escapeHtml(msg)}</p>`;
}

function wrapDoc(stamp, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-daemon memory</title>
<style>${VIEWER_CSS}</style>
</head><body>${inner}</body></html>`;
}

const VIEWER_CSS = `
:root{--bg:#0f1115;--panel:#171a21;--line:#262b35;--fg:#e6e9ef;--dim:#8b93a3;--accent:#6ea8fe;--good:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 24px 8px}
h1{margin:0;font-size:18px;letter-spacing:.2px}
.meta{color:var(--dim);font-size:12px;margin-top:2px;word-break:break-all}
.stats{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 9px;font-size:12px;color:var(--dim)}
.stat b{color:var(--fg)}
.controls{position:sticky;top:0;background:var(--bg);padding:8px 24px;border-bottom:1px solid var(--line);z-index:2}
#filter{width:100%;max-width:420px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)}
.tabs{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.tabbtn{background:transparent;border:1px solid transparent;color:var(--dim);padding:5px 11px;border-radius:6px;cursor:pointer;font:inherit}
.tabbtn:hover{color:var(--fg)}
.tabbtn.active{background:var(--panel);border-color:var(--line);color:var(--fg)}
.tab{display:none;padding:12px 24px 40px}
.tab.active{display:block}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;position:sticky;top:96px;background:var(--bg)}
td.num,td.conf{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}
td.mono,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
td.dim,.dim{color:var(--dim)}
tr:hover td{background:#1b1f27}
.cat{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--line);white-space:nowrap}
.cat-correction{color:var(--bad)}.cat-gotcha{color:var(--warn)}.cat-pattern{color:var(--accent)}.cat-decision{color:var(--good)}
.status{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--line)}
.status-digested{color:var(--good)}.status-queued{color:var(--warn)}.status-error{color:var(--bad)}
.tags{margin-top:4px}
.tag{display:inline-block;font-size:10px;color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:0 5px;margin:2px 3px 0 0;font-family:ui-monospace,monospace}
.empty{color:var(--dim);padding:24px 0}
code{font-family:ui-monospace,monospace;background:var(--panel);padding:1px 5px;border-radius:4px}
`;

const VIEWER_SCRIPT = `<script>
(function(){
  var btns=document.querySelectorAll('.tabbtn');
  var tabs=document.querySelectorAll('.tab');
  var filter=document.getElementById('filter');
  function activeTab(){return document.querySelector('.tab.active');}
  function applyFilter(){
    var q=(filter.value||'').toLowerCase();
    var t=activeTab(); if(!t) return;
    t.querySelectorAll('tbody tr').forEach(function(tr){
      tr.style.display = !q || tr.textContent.toLowerCase().indexOf(q)>=0 ? '' : 'none';
    });
  }
  btns.forEach(function(b){b.addEventListener('click',function(){
    btns.forEach(function(x){x.classList.remove('active')});
    tabs.forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');
    var el=document.getElementById('tab-'+b.dataset.tab);
    if(el) el.classList.add('active');
    applyFilter();
  });});
  if(filter) filter.addEventListener('input',applyFilter);
})();
</script>`;
