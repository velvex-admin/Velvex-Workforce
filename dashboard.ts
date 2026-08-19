// The dashboard. One page, served by the Worker, desktop-first as the doc asks.
// Styled to match the VX-03 architecture document so this does not look like a
// different product from the thing that specified it.

export function dashboardHtml(basePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>VX-03 — Internal Operations</title>
<style>
:root{
  --bg:#14171F; --surface:#1C2029; --surface-raised:#20242E; --border:#2A2F3B;
  --text:#EDEAE2; --text-dim:#9297A6; --text-faint:#5C6170;
  --gold:#B4915B; --gold-dim:#8A754F; --green:#6FA787; --red:#C1666B;
  --amber:#C98A3E; --slate:#6B7280; --blue:#7597C4;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1100px;margin:0 auto;padding:40px 32px 120px}
header{margin-bottom:28px}
.tag{font-family:ui-monospace,'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--gold);margin-bottom:8px}
h1{font-family:Georgia,'Fraunces',serif;font-weight:600;font-size:30px;letter-spacing:-.01em}
h2{font-family:Georgia,'Fraunces',serif;font-weight:600;font-size:20px;margin:0 0 12px;display:flex;align-items:baseline;gap:10px}
h2 .count{font-family:ui-monospace,monospace;font-size:12px;color:var(--text-faint)}
section{margin-top:40px}
p.lede{color:var(--text-dim);max-width:70ch}
.strip{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.chip{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:9px 14px;font-size:12.5px;display:flex;flex-direction:column;gap:2px;min-width:130px}
.chip .k{font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.chip .v{color:var(--text)}
.chip.bad{border-color:var(--red)} .chip.bad .v{color:var(--red)}
.chip.warn{border-color:var(--amber)} .chip.warn .v{color:var(--amber)}
.chip.good{border-color:rgba(111,167,135,.45)} .chip.good .v{color:var(--green)}
.card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:8px;padding:18px 20px;margin-bottom:14px}
.card.risk-high{border-left-color:var(--red)}
.card.risk-medium{border-left-color:var(--amber)}
.card.risk-low{border-left-color:var(--slate)}
.card h3{font-size:14.5px;font-weight:600;margin-bottom:6px}
.meta{font-family:ui-monospace,monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);margin-bottom:8px}
.reason{font-size:13px;color:var(--text-dim);margin-bottom:10px}
.body{font-size:13.5px;color:var(--text-dim);white-space:pre-wrap;background:var(--surface-raised);border-radius:6px;padding:12px 14px;margin-bottom:12px;max-height:280px;overflow:auto}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{font-family:inherit;font-size:12.5px;padding:7px 14px;border-radius:5px;border:1px solid var(--border);background:var(--surface-raised);color:var(--text);cursor:pointer;transition:.15s}
button:hover{border-color:var(--gold-dim)}
button.approve{border-color:rgba(111,167,135,.5);color:var(--green)}
button.approve:hover{background:rgba(111,167,135,.1)}
button.reject{border-color:rgba(193,102,107,.5);color:var(--red)}
button.reject:hover{background:rgba(193,102,107,.1)}
button:disabled{opacity:.5;cursor:default}
input[type=text]{flex:1;min-width:180px;font-family:inherit;font-size:12.5px;padding:7px 10px;border-radius:5px;border:1px solid var(--border);background:var(--bg);color:var(--text)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-family:ui-monospace,monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:10px 12px;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid var(--border);color:var(--text-dim);vertical-align:top}
td.strong{color:var(--text)}
tr:last-child td{border-bottom:none}
.tablewrap{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.badge{display:inline-flex;align-items:center;gap:5px;font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:2px 8px 2px 6px;border-radius:20px;border:1px solid;white-space:nowrap}
.badge::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}
.badge.green{color:var(--green);border-color:rgba(111,167,135,.4)}
.badge.red{color:var(--red);border-color:rgba(193,102,107,.4)}
.badge.amber{color:var(--amber);border-color:rgba(201,138,62,.4)}
.badge.slate{color:var(--slate);border-color:rgba(107,114,128,.4)}
.badge.blue{color:var(--blue);border-color:rgba(117,151,196,.4)}
.empty{color:var(--text-faint);font-size:13.5px;padding:16px 0}
.rules{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
@media(max-width:720px){.rules{grid-template-columns:1fr}}
.rule{background:var(--surface-raised);border-radius:6px;padding:7px 11px;font-size:12px;color:var(--text-dim)}
.rule .rk{font-family:ui-monospace,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:2px}
.rule.routine .rk{color:var(--green)} .rule.approval .rk{color:var(--amber)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--border);font-size:12px;color:var(--text-faint)}
code{font-family:ui-monospace,monospace;font-size:12px;color:var(--gold)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="tag">Internal — Velvex — Not client facing</div>
    <h1>VX-03 Internal Operations</h1>
    <p class="lede">Marketing, sales management and executive agents, coordinated by a Chief-of-Staff. Routine work runs and gets logged. Anything new lands here for you.</p>
    <div class="strip" id="status"></div>
  </header>

  <section>
    <h2>Waiting on you <span class="count" id="approvals-count"></span></h2>
    <div class="toolbar">
      <button onclick="runTick('hourly')">Run hourly agents</button>
      <button onclick="runTick('daily')">Run daily agents</button>
      <button onclick="runTick('weekly')">Run weekly agents</button>
      <button onclick="load()">Refresh</button>
    </div>
    <div id="approvals"></div>
  </section>

  <section>
    <h2>Recent activity <span class="count" id="reports-count"></span></h2>
    <div class="tablewrap"><table>
      <thead><tr><th>When</th><th>Agent</th><th>What</th><th>Outcome</th></tr></thead>
      <tbody id="reports"></tbody>
    </table></div>
  </section>

  <section>
    <h2>Channels</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Channel</th><th>Status</th><th>Waiting on</th><th>Note</th></tr></thead>
      <tbody id="connectors"></tbody>
    </table></div>
  </section>

  <section>
    <h2>Roster <span class="count" id="roster-count"></span></h2>
    <div id="roster"></div>
  </section>

  <footer>
    VX-03 — served behind an unguessable URL, no authentication yet. Model: <code id="model"></code>.
    Voice profile: <code id="voice"></code>.
  </footer>
</div>

<script>
const BASE = ${JSON.stringify(basePath)};
const api = (path, init) => fetch(BASE + '/api' + path, init).then(r => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins/60) + 'h ago';
  return Math.round(mins/1440) + 'd ago';
};

async function load() {
  const [status, approvals, reports] = await Promise.all([
    api('/status'), api('/approvals?status=pending'), api('/reports?limit=40')
  ]);

  document.getElementById('model').textContent =
    Object.entries(status.modelTiers).map(([tier, id]) => tier + ' ' + id).join(' &middot; ')
      .replace(/&middot;/g, '·');
  document.getElementById('voice').textContent = status.voiceProfile;

  const chips = [];
  const r = status.readiness;
  chips.push(['Ready', r.ready ? 'yes' : 'no', r.ready ? 'good' : 'bad']);
  chips.push(['Database', status.database.ok ? 'connected' : 'not reachable', status.database.ok ? 'good' : 'bad']);
  for (const [key, value] of Object.entries(r.detail)) {
    if (!key.startsWith('ANTHROPIC') && !key.startsWith('SUPABASE') && !key.startsWith('APP_')) continue;
    chips.push([key.replace(/_/g,' ').toLowerCase(), value.status, value.status === 'live' ? 'good' : 'bad']);
  }
  chips.push(['Pending', approvals.approvals.length, approvals.approvals.length ? 'warn' : 'good']);
  document.getElementById('status').innerHTML = chips.map(([k,v,c]) =>
    '<div class="chip ' + c + '"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>').join('');

  document.getElementById('approvals-count').textContent = approvals.approvals.length + ' queued';
  document.getElementById('approvals').innerHTML = approvals.approvals.length === 0
    ? '<div class="empty">Nothing waiting. Routine work runs without asking.</div>'
    : approvals.approvals.map(renderApproval).join('');

  document.getElementById('reports-count').textContent = reports.reports.length + ' entries';
  document.getElementById('reports').innerHTML = reports.reports.length === 0
    ? '<tr><td colspan="4" class="empty">No activity logged yet.</td></tr>'
    : reports.reports.map(row =>
      '<tr><td>' + esc(ago(row.created_at)) + '</td><td class="strong">' + esc(row.agent_id) + '</td>' +
      '<td>' + esc(row.summary) + (row.error ? '<br><span style="color:var(--red)">' + esc(row.error) + '</span>' : '') + '</td>' +
      '<td>' + outcomeBadge(row.outcome) + '</td></tr>').join('');

  document.getElementById('connectors').innerHTML = status.connectors.map(c =>
    '<tr><td class="strong">' + esc(c.channel) + '</td>' +
    '<td>' + (c.active ? '<span class="badge green">live</span>' : '<span class="badge amber">inactive</span>') + '</td>' +
    '<td>' + (c.missing.length ? '<code>' + c.missing.map(esc).join('</code> <code>') + '</code>' : '&mdash;') + '</td>' +
    '<td>' + esc(c.note) + '</td></tr>').join('');

  document.getElementById('roster-count').textContent = status.agents.length + ' agents';
  document.getElementById('roster').innerHTML = status.agents.map(a =>
    '<div class="card risk-low"><h3>' + esc(a.name) +
    (a.externalBuild ? ' <span class="badge blue">external build</span>' : '') +
    (a.observeOnly ? ' <span class="badge slate">observes only</span>' : '') + '</h3>' +
    '<div class="meta">' + esc(a.batch) + ' &middot; ' + esc(a.cadence) + ' &middot; ' +
    (a.model ? esc(a.model) + ' &middot; effort ' + esc(a.effort) : 'no model calls') + '</div>' +
    '<div class="reason">' + esc(a.description) + '</div>' +
    '<div class="rules">' +
      '<div class="rule routine"><span class="rk">Routine</span>' +
        (a.routine.map(x => esc(x.describe)).join('<br>') || 'nothing runs unattended') + '</div>' +
      '<div class="rule approval"><span class="rk">Needs approval</span>' +
        (a.needsApproval.map(x => esc(x.describe)).join('<br>') || 'general boundary only') + '</div>' +
    '</div>' +
    (a.externalBuild ? '' : '<div class="actions" style="margin-top:10px"><button onclick="runAgent(\\'' + a.id + '\\')">Run now</button></div>') +
    '</div>').join('');
}

function outcomeBadge(outcome) {
  const map = { executed:'green', observed:'blue', no_op:'slate', failed:'red', blocked_inactive:'amber' };
  return '<span class="badge ' + (map[outcome] || 'slate') + '">' + esc(outcome) + '</span>';
}

function renderApproval(a) {
  const action = a.action || {};
  const body = action.payload && (action.payload.text || action.payload.reply || action.payload.analysis || action.payload.after || action.payload.answer || action.payload.briefing);
  return '<div class="card risk-' + esc(a.risk) + '">' +
    '<h3>' + esc(a.title) + '</h3>' +
    '<div class="meta">' + esc(a.agent_id) + ' &middot; ' + esc(action.type || '') + ' &middot; rule ' + esc(a.trigger_rule) + ' &middot; ' + ago(a.created_at) + '</div>' +
    '<div class="reason">' + esc(a.trigger_reason || a.rationale) + '</div>' +
    (body ? '<div class="body">' + esc(body) + '</div>' : '') +
    '<div class="actions">' +
      '<input type="text" id="note-' + a.id + '" placeholder="note (optional)">' +
      '<button class="approve" onclick="decide(\\'' + a.id + '\\',\\'approve\\')">Approve</button>' +
      '<button class="reject" onclick="decide(\\'' + a.id + '\\',\\'reject\\')">Reject</button>' +
    '</div></div>';
}

async function decide(id, decision) {
  const note = (document.getElementById('note-' + id) || {}).value || '';
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    await api('/approvals/' + id + '/' + decision, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    });
  } finally {
    document.querySelectorAll('button').forEach(b => b.disabled = false);
    load();
  }
}

async function runTick(cadence) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await api('/run?cadence=' + cadence, { method: 'POST' }); }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); load(); }
}

async function runAgent(id) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await api('/run/' + id, { method: 'POST' }); }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); load(); }
}

load();
setInterval(load, 120000);
</script>
</body>
</html>`;
}
