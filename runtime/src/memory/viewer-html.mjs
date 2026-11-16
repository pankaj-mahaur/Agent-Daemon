// The page `<pkg> view` writes (MCP launch plan L8b): one self-contained HTML file, no
// server, no network, no link. Store values arrive already redacted and neutralized
// (viewer-data.mjs) and are escaped again here; they appear only as text, never inside
// an attribute (ids are numbers, labels come from fixed lists). The file has static CSS,
// one static script (tabs and a filter), and a CSP that allows nothing else.

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LABELS = new Set(["accepted", "forget-requested", "provisional", "pending", "flagged", "hidden", "archived", "rejected", "superseded"]);
const e = escapeHtml;
const n = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "0");
const count = (v) => (v === null || v === undefined ? "–" : n(v));

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="empty">${e(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const cmd = (text) => `<code>${e(text)}</code>`;

function learningsTab(rows, command) {
  const body = rows.map((r) => {
    const label = LABELS.has(r.label) ? r.label : "pending";
    const how = label === "pending" || label === "provisional" || label === "flagged" ? `accept: ${cmd(command("review"))}` : `forget: ${cmd(command(`learnings forget ${n(r.id)}`))}`;
    return `<tr><td class="num">${n(r.id)}</td><td><span class="status">${e(label)}</span></td><td>${e(r.text)}<div class="dim">${e(r.category)} · ${e(r.provenance)} · ${e(r.scope)}${r.rules.length ? ` · rule ${r.rules.map(n).join(", ")}` : ""}</div></td><td class="num">${n(r.recalled)}</td><td class="num">${n(r.repeated)}</td><td>${how}</td></tr>`;
  });
  return table(["#", "Status", "Learning", "Recalled", "Repeated", "Change it (run in your terminal)"], body, "No learnings yet.");
}

function rulesTab(rows, command) {
  const body = rows.map((r) => {
    const how = r.source === "policy" ? cmd(command("safety off")) : r.learning ? `forget its learning: ${cmd(command(`learnings forget ${n(r.learning)}`))}` : "its learning is gone";
    return `<tr><td class="num">${n(r.id)}</td><td>${r.decision === "deny" ? "stops" : "asks"} · ${r.kind === "write" ? "writes" : "commands"} · ${e(r.scope)}${r.source === "policy" ? " · starter policy" : ""}${r.orphaned ? " · orphaned" : ""}</td><td class="mono">${e(r.pattern)}<div class="dim">${e(r.reason)}</div></td><td class="num">${n(r.asked)}</td><td class="num">${n(r.stopped)}</td><td>${how}</td></tr>`;
  });
  return table(["#", "Rule", "Pattern", "Asked", "Stopped", "Remove it (run in your terminal)"], body, "No rules yet.");
}

function weeklyTab(rows) {
  const body = rows.map((w) => `<tr><td>${e(w.week)}<div class="dim">${e(w.from)} to ${e(w.to)}</div></td><td class="num">${n(w.captured)}</td><td class="num">${n(w.provisional)}</td><td class="num">${n(w.accepted)}</td><td class="num">${n(w.recalled)}</td><td class="num">${n(w.repeated)}</td><td class="num">${count(w.asked)}</td><td class="num">${count(w.stopped)}</td></tr>`);
  return table(["Week", "Captured", "Provisional", "Accepted", "Recalled", "Repeated", "Asked", "Stopped"], body, "No weekly numbers yet.");
}

/**
 * @param {{learnings: object[], rules: object[], weekly: object[], allProjects: boolean}|null} data  null: no store yet
 * @param {{generatedAt?: string, command?: (verb: string) => string, title?: string}} [o]
 */
export function renderViewer(data, { generatedAt = "", command = (v) => v, title = "agent-daemon memory" } = {}) {
  const tabs = data
    ? [
        { id: "learnings", label: `Learnings (${data.learnings.length})`, body: learningsTab(data.learnings, command) },
        { id: "rules", label: `Rules (${data.rules.length})`, body: rulesTab(data.rules, command) },
        { id: "weekly", label: "Weekly report", body: weeklyTab(data.weekly) },
      ]
    : [{ id: "learnings", label: "Learnings", body: '<p class="empty">No memory store yet: nothing has been saved on this computer.</p>' }];
  const buttons = tabs.map((t, i) => `<button class="tabbtn${i === 0 ? " active" : ""}" data-tab="${t.id}">${e(t.label)}</button>`).join("");
  const panels = tabs.map((t, i) => `<section class="tab${i === 0 ? " active" : ""}" id="tab-${t.id}">${t.body}</section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${CSS}</style>
</head><body>
<header><h1>${e(title)}</h1><div class="meta">${data?.allProjects ? "all projects" : "this project"} · read-only snapshot, generated ${e(generatedAt)} · nothing here changes anything: each row shows the command to run</div></header>
<div class="controls"><input id="filter" type="search" placeholder="Filter rows in this tab" autocomplete="off"><nav class="tabs">${buttons}</nav></div>
${panels}
${SCRIPT}
</body></html>
`;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1c1f26;--dim:#5b6472;--line:#d8dce3;--panel:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e9ef;--dim:#9aa3b2;--line:#262b35;--panel:#171a21}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{padding:20px 24px 8px}h1{margin:0;font-size:18px}.meta{color:var(--dim);font-size:12px;margin-top:2px}
.controls{padding:8px 24px;border-bottom:1px solid var(--line)}#filter{width:100%;max-width:420px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)}
.tabs{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}.tabbtn{background:transparent;border:1px solid transparent;color:var(--dim);padding:5px 11px;border-radius:6px;cursor:pointer;font:inherit}
.tabbtn.active{background:var(--panel);border-color:var(--line);color:var(--fg)}.tab{display:none;padding:12px 24px 40px}.tab.active{display:block}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-size:11px;text-transform:uppercase}td.num{text-align:right;color:var(--dim);white-space:nowrap}.mono{font-family:ui-monospace,monospace}.dim{color:var(--dim);font-size:12px}
.status{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--line)}.empty{color:var(--dim);padding:24px 0}code{font-family:ui-monospace,monospace;background:var(--panel);padding:1px 5px;border-radius:4px;word-break:break-all}`;

const SCRIPT = `<script>
(function(){var b=document.querySelectorAll('.tabbtn'),t=document.querySelectorAll('.tab'),f=document.getElementById('filter');
function apply(){var q=(f.value||'').toLowerCase(),a=document.querySelector('.tab.active');if(!a)return;
a.querySelectorAll('tbody tr').forEach(function(r){r.style.display=!q||r.textContent.toLowerCase().indexOf(q)>=0?'':'none'})}
b.forEach(function(x){x.addEventListener('click',function(){b.forEach(function(y){y.classList.remove('active')});t.forEach(function(y){y.classList.remove('active')});
x.classList.add('active');var el=document.getElementById('tab-'+x.dataset.tab);if(el)el.classList.add('active');apply()})});
f.addEventListener('input',apply)})();
</script>`;
