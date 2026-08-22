// VX-03 dashboard, laid out as a pan/zoom canvas rather than a scroll.
//
// The system is not a workflow, it is a network: the Chief-of-Staff sits on the
// left and reads what every agent has done; each agent belongs to a section
// (Marketing, Sales, Executive); and traffic flows both ways along the lines
// that connect them. This page draws that shape, and the details for each node
// open in a side panel so the map stays intact.
//
// Interactions:
//   - drag empty space  → pan the canvas
//   - mouse wheel       → zoom, focused on the cursor
//   - space + drag      → also pans (accessibility fallback)
//   - click a node      → opens its detail panel on the right
//   - "Reset view"      → return to the default framing
//
// All state (approvals, reports, schedule overrides) lives in the backend; this
// page reads it every 60s and on demand, and posts changes through the same
// endpoints the old dashboard used.

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
  --bg:#0F1218; --bg-2:#141821; --surface:#1B1F2A; --surface-raised:#20242F;
  --border:#2A2F3B; --border-soft:#232832;
  --text:#EDEAE2; --text-dim:#9297A6; --text-faint:#5C6170;
  --gold:#B4915B; --gold-dim:#8A754F; --gold-glow:rgba(180,145,91,.35);
  --green:#6FA787; --green-glow:rgba(111,167,135,.35);
  --red:#C1666B; --amber:#C98A3E;
  --blue:#7597C4; --blue-glow:rgba(117,151,196,.4);
  --slate:#6B7280; --marketing:#B4915B; --sales:#7597C4; --executive:#6FA787;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;user-select:none}
button,input,textarea,select{font-family:inherit}
a{color:var(--blue);text-decoration:none}

/* ── Top bar ─────────────────────────────────────────────────── */
.topbar{
  position:fixed; top:0; left:0; right:0; z-index:10;
  display:flex; align-items:center; gap:16px;
  padding:12px 20px;
  background:linear-gradient(to bottom, rgba(15,18,24,.95), rgba(15,18,24,.75) 70%, transparent);
  backdrop-filter:blur(8px);
}
.brand{font-family:Georgia,'Fraunces',serif;font-size:16px;font-weight:600;letter-spacing:-.01em}
.brand .tag{color:var(--gold);margin-right:8px;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase}
.status-chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:11px;display:inline-flex;align-items:center;gap:6px}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--slate)}
.chip.good .dot{background:var(--green);box-shadow:0 0 6px var(--green-glow)}
.chip.warn .dot{background:var(--amber)}
.chip.bad .dot{background:var(--red)}
.chip .k{color:var(--text-faint);font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.chip .v{color:var(--text)}
.toolbar{margin-left:auto;display:flex;gap:6px;align-items:center}
.toolbtn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:5px;font-size:12px;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px}
.toolbtn:hover{border-color:var(--gold-dim);color:var(--gold)}
.zoom-indicator{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-faint);padding:0 6px;min-width:52px;text-align:center}

/* ── Canvas ─────────────────────────────────────────────────── */
.canvas-viewport{
  position:fixed; inset:0;
  overflow:hidden;
  cursor:grab;
  background:
    radial-gradient(ellipse at 20% 40%, rgba(180,145,91,.06), transparent 60%),
    radial-gradient(ellipse at 80% 60%, rgba(117,151,196,.04), transparent 60%),
    var(--bg);
}
.canvas-viewport.dragging{cursor:grabbing}
.canvas-inner{
  position:absolute;
  transform-origin:0 0;
  will-change:transform;
}
/* A subtle grid to give the pan/zoom real feedback. Rendered on the viewport
   itself so the grid does not scale — that is what real infinite canvases do. */
.canvas-viewport::before{
  content:'';
  position:absolute; inset:0;
  background-image:
    linear-gradient(to right, rgba(146,151,166,.04) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(146,151,166,.04) 1px, transparent 1px);
  background-size:48px 48px;
  background-position:0 0;
  pointer-events:none;
}

/* ── Sections ─────────────────────────────────────────────────── */
.section{
  position:absolute;
  background:rgba(28,32,41,.55);
  border:1px solid var(--border);
  border-radius:20px;
  padding:22px 24px 26px;
  min-width:340px;
  min-height:220px;
  backdrop-filter:blur(4px);
}
.section h2{
  font-family:Georgia,'Fraunces',serif; font-weight:600; font-size:18px;
  display:flex; align-items:center; gap:10px;
  margin-bottom:6px; letter-spacing:-.01em;
}
.section h2 .swatch{width:8px;height:8px;border-radius:50%;box-shadow:0 0 10px currentColor}
.section .sub{font-size:11.5px;color:var(--text-faint);margin-bottom:18px;font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}
.section.marketing h2, .section.marketing .swatch{color:var(--marketing)}
.section.sales h2, .section.sales .swatch{color:var(--sales)}
.section.executive h2, .section.executive .swatch{color:var(--executive)}
.section .agents{display:flex;flex-wrap:wrap;gap:16px 20px;align-items:flex-start}

/* ── Nodes ─────────────────────────────────────────────────── */
.node{
  display:flex; flex-direction:column; align-items:center;
  gap:8px; cursor:pointer;
  transition:transform .15s ease;
  min-width:76px;
}
.node:hover{transform:translateY(-2px)}
.node .dot{
  width:48px; height:48px; border-radius:50%;
  background:var(--surface-raised);
  border:2px solid var(--border);
  display:grid; place-items:center;
  transition:.2s;
  font-family:ui-monospace,monospace; font-size:11px; color:var(--text-faint);
  position:relative;
}
.node:hover .dot{border-color:currentColor}
.node.marketing .dot{color:var(--marketing)}
.node.sales .dot{color:var(--sales)}
.node.executive .dot{color:var(--executive)}
.node.orchestration .dot{color:var(--gold)}

/* Pulsing rim for live/paused/inactive so the map reads at a glance. */
.node .dot::after{
  content:''; position:absolute; inset:-4px; border-radius:50%;
  border:1px solid currentColor; opacity:.25;
  animation:pulse 2.6s ease-in-out infinite;
}
.node.paused .dot{opacity:.5}
.node.paused .dot::after{animation:none;border-style:dashed;opacity:.35}
.node.mock .dot::after{border-style:dashed;opacity:.35;animation:none}
.node.selected .dot{border-color:currentColor;box-shadow:0 0 0 3px rgba(180,145,91,.15), 0 0 22px currentColor}

/* Working — an agent is mid-run right now. Amber pulse ring, and a small
   "cooking" tag that briefly names what phase it is in. */
.node.working .dot{border-color:var(--amber);box-shadow:0 0 22px rgba(201,138,62,.45)}
.node.working .dot::after{border-color:var(--amber);animation:pulse-fast 1.2s ease-in-out infinite;opacity:.6}
.node.failed-status .dot{border-color:var(--red)}
.node.failed-status .dot::after{border-color:var(--red);opacity:.5;animation:none}
.status-tag{
  position:absolute; top:-6px; left:50%; transform:translateX(-50%);
  font-family:ui-monospace,monospace; font-size:9px; text-transform:uppercase; letter-spacing:.08em;
  padding:2px 7px; border-radius:20px; white-space:nowrap;
  background:var(--surface); border:1px solid currentColor;
}
.status-tag.working{color:var(--amber)}
.status-tag.failed{color:var(--red)}
@keyframes pulse-fast{
  0%,100%{transform:scale(1);opacity:.6}
  50%{transform:scale(1.2);opacity:.15}
}

/* Live thought — what the agent is doing right now, shown under its label */
.node .thought{
  font-size:10px; color:var(--text-faint); font-style:italic;
  max-width:120px; text-align:center;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}

/* Panel: currently thinking and the thought trail */
.now-thinking{
  background:linear-gradient(135deg, rgba(201,138,62,.12), rgba(201,138,62,.03));
  border:1px solid rgba(201,138,62,.3);
  border-radius:8px; padding:12px 14px; margin-bottom:14px;
  display:flex; gap:12px; align-items:flex-start;
}
.now-thinking .spinner{
  width:14px; height:14px; border-radius:50%;
  border:2px solid rgba(201,138,62,.25); border-top-color:var(--amber);
  animation:spin 1s linear infinite; margin-top:3px; flex-shrink:0;
}
@keyframes spin{to{transform:rotate(360deg)}}
.now-thinking .text{color:var(--amber);font-size:13px}
.now-thinking .text b{display:block;font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.thought-trail{margin-top:8px;font-size:12px;color:var(--text-dim);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:ui-monospace,monospace;max-height:220px;overflow:auto}
.thought-trail div{padding:2px 0;border-bottom:1px dotted var(--border-soft)}
.thought-trail div:last-child{border-bottom:none}
.thought-trail .ts{color:var(--text-faint);font-size:10.5px;margin-right:8px}
.node .label{font-size:12px;color:var(--text);text-align:center;max-width:100px}
.node .cadence{font-family:ui-monospace,monospace;font-size:9.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em}
.node.paused .cadence{color:var(--amber)}
.badge-count{
  position:absolute; top:-4px; right:-4px;
  background:var(--red); color:#fff; font-size:10px; font-family:ui-monospace,monospace;
  min-width:18px; height:18px; padding:0 5px;
  border-radius:9px; display:grid; place-items:center;
  border:2px solid var(--bg);
}

/* The Chief-of-Staff, drawn larger and with its two sub-nodes. */
.node.chief .dot{width:76px;height:76px;background:radial-gradient(circle at 30% 30%, rgba(180,145,91,.35), rgba(180,145,91,.05));border-color:var(--gold);color:var(--gold);box-shadow:0 0 30px var(--gold-glow)}
.node.chief .label{font-family:Georgia,serif;font-size:14px;font-weight:600}
.node.sub .dot{width:34px;height:34px}
.node.sub .label{font-size:11px;color:var(--text-dim)}

@keyframes pulse{
  0%,100%{transform:scale(1);opacity:.25}
  50%{transform:scale(1.15);opacity:.05}
}

/* ── Connective SVG (behind nodes) ─────────────────────────────── */
.wires{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:0}
.wires path{fill:none;stroke:var(--border);stroke-width:1.2}
.wires .ecg{stroke:var(--gold);stroke-width:1.4;opacity:.85;filter:drop-shadow(0 0 4px var(--gold-glow))}
.wires .ecg-pulse{
  stroke-dasharray:8 320;
  stroke-dashoffset:0;
  animation:ecg 4s linear infinite;
}
@keyframes ecg{to{stroke-dashoffset:-328}}
.wires .link{stroke:var(--border);opacity:.6}
.wires .link.marketing{stroke:var(--marketing)}
.wires .link.sales{stroke:var(--sales)}
.wires .link.executive{stroke:var(--executive)}

/* ── Side panel (agent detail) ─────────────────────────────── */
.panel{
  position:fixed; top:0; right:0; bottom:0; width:min(520px, 100%);
  background:var(--bg-2); border-left:1px solid var(--border);
  transform:translateX(100%); transition:transform .28s cubic-bezier(.2,.7,.2,1);
  overflow-y:auto; z-index:20;
  padding:24px 26px 40px;
  box-shadow:-20px 0 60px rgba(0,0,0,.4);
}
.panel.open{transform:translateX(0)}
.panel .close{position:absolute;top:14px;right:16px;background:transparent;border:none;color:var(--text-faint);font-size:22px;cursor:pointer;padding:4px 8px;border-radius:5px}
.panel .close:hover{color:var(--text);background:var(--surface)}
.panel h2{font-family:Georgia,serif;font-size:22px;font-weight:600;margin-bottom:4px;letter-spacing:-.01em}
.panel .meta{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:18px}
.panel .lede{color:var(--text-dim);margin-bottom:22px;font-size:14px}
.panel h3{font-size:12px;font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--gold);margin:20px 0 8px}
.panel .rulebox{background:var(--surface);border-radius:8px;border:1px solid var(--border);padding:10px 14px;margin-bottom:6px;font-size:13px;color:var(--text-dim)}
.panel .rulebox.routine{border-left:2px solid var(--green)}
.panel .rulebox.approval{border-left:2px solid var(--amber)}
.panel .rulebox .rid{font-family:ui-monospace,monospace;font-size:10px;color:var(--text-faint);display:block;margin-bottom:2px}
.panel .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.panel .actions button{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:5px;font-size:12.5px;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px}
.panel .actions button:hover{border-color:var(--gold-dim);color:var(--gold)}
.panel .actions button.primary{border-color:var(--green);color:var(--green)}
.panel .actions button.primary:hover{background:rgba(111,167,135,.08)}
.panel .actions button.danger{border-color:var(--red);color:var(--red)}
.panel .actions button.danger:hover{background:rgba(193,102,107,.08)}
.panel .actions button:disabled{opacity:.5;cursor:default}
.panel .actions button.selected{background:var(--gold);color:var(--bg);border-color:var(--gold)}
.panel .cadence-hint{font-size:12px;color:var(--text-faint);margin:8px 0 4px}
.panel table.activity{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}
.panel table.activity th{text-align:left;font-family:ui-monospace,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:6px 8px;border-bottom:1px solid var(--border);font-weight:500}
.panel table.activity td{padding:8px;border-bottom:1px solid var(--border-soft);color:var(--text-dim);vertical-align:top}
.panel table.activity tr:last-child td{border-bottom:none}
.panel .empty{color:var(--text-faint);font-size:12.5px;padding:12px 0;font-style:italic}
.badge{display:inline-flex;align-items:center;gap:5px;font-family:ui-monospace,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:20px;border:1px solid}
.badge.green{color:var(--green);border-color:rgba(111,167,135,.4)}
.badge.blue{color:var(--blue);border-color:rgba(117,151,196,.4)}
.badge.amber{color:var(--amber);border-color:rgba(201,138,62,.4)}
.badge.red{color:var(--red);border-color:rgba(193,102,107,.4)}
.badge.slate{color:var(--slate);border-color:rgba(107,114,128,.4)}

/* Approval cards */
.approval{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;border-left:3px solid var(--amber)}
.approval.risk-high{border-left-color:var(--red)}
.approval.risk-medium{border-left-color:var(--amber)}
.approval.risk-low{border-left-color:var(--slate)}
/* A failure escalated by Chief-of-Staff is not a request for permission, it is
   news that something broke. Styled identically to a routine proposal it reads
   as one more item to wave through, which is how a two-day X publishing outage
   sat unnoticed between six growth ideas. */
.approval.problem{border-left-color:var(--red);border-left-width:5px;background:rgba(193,102,107,.06);border-color:rgba(193,102,107,.35)}
.approval.problem h4{color:var(--red)}
.approval .flag{display:inline-block;background:var(--red);color:#fff;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:3px;margin-bottom:7px}
.panel .meta .probcount{color:var(--red);font-weight:600}
.approval h4{font-size:14px;font-weight:600;margin-bottom:4px}
.approval .amt{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.approval .reason{font-size:12.5px;color:var(--text-dim);margin-bottom:8px}
.approval .body{background:var(--bg);border-radius:5px;padding:8px 10px;font-size:12.5px;color:var(--text-dim);max-height:200px;overflow:auto;white-space:pre-wrap;margin-bottom:10px}
.approval .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.approval input[type=text]{flex:1;min-width:120px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:5px;font-size:12px}
.approval button.approve{background:transparent;border:1px solid rgba(111,167,135,.5);color:var(--green);padding:6px 12px;border-radius:5px;font-size:12px;cursor:pointer}
.approval button.approve:hover{background:rgba(111,167,135,.08)}
.approval button.reject{background:transparent;border:1px solid rgba(193,102,107,.5);color:var(--red);padding:6px 12px;border-radius:5px;font-size:12px;cursor:pointer}
.approval button.reject:hover{background:rgba(193,102,107,.08)}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--green);color:var(--text);padding:10px 18px;border-radius:6px;font-size:13px;opacity:0;transition:.2s;pointer-events:none;z-index:30}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.error{border-left-color:var(--red)}

.help{position:fixed;bottom:14px;right:14px;font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-faint);z-index:5;background:rgba(15,18,24,.7);padding:8px 12px;border-radius:6px;border:1px solid var(--border-soft)}
.help kbd{background:var(--surface);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-family:inherit;color:var(--text-dim)}
</style>
</head>
<body>

<div class="topbar">
  <div class="brand"><span class="tag">Internal</span>VX-03</div>
  <div class="status-chips" id="status-chips"></div>
  <div class="toolbar">
    <button class="toolbtn" onclick="runTick('hourly')" title="Fire every hourly agent now">Run hourly</button>
    <button class="toolbtn" onclick="runTick('daily')" title="Fire every daily agent now">Run daily</button>
    <button class="toolbtn" onclick="loadAll()" title="Refresh dashboard">↻</button>
    <button class="toolbtn" onclick="resetView()" title="Reset zoom and center">Reset view</button>
    <span class="zoom-indicator" id="zoom-indicator">100%</span>
  </div>
</div>

<div class="canvas-viewport" id="viewport">
  <div class="canvas-inner" id="canvas">
    <svg class="wires" id="wires"></svg>
    <div id="nodes"></div>
  </div>
</div>

<aside class="panel" id="panel">
  <button class="close" onclick="closePanel()" title="Close">×</button>
  <div id="panel-body"></div>
</aside>

<div class="help">
  <kbd>drag</kbd> pan  ·  <kbd>wheel</kbd> zoom  ·  <kbd>click</kbd> a node to open it
</div>

<div class="toast" id="toast"></div>

<script>
const BASE = ${JSON.stringify(basePath)};
const api = (path, init) => fetch(BASE + '/api' + path, init).then(async r => {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = (iso) => {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins/60) + 'h ago';
  return Math.round(mins/1440) + 'd ago';
};

// ── Global state ────────────────────────────────────────────────
let AGENTS = [], REPORTS = [], APPROVALS = [], STATUS = {}, SCHEDULES = {}, RUNTIME = {}, SELECTED = null;

// ── Pan / zoom ──────────────────────────────────────────────────
const view = { x: 40, y: 60, scale: 0.9 };
const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');
const zoomIndicator = document.getElementById('zoom-indicator');

function applyTransform() {
  canvas.style.transform = \`translate(\${view.x}px, \${view.y}px) scale(\${view.scale})\`;
  zoomIndicator.textContent = Math.round(view.scale * 100) + '%';
}

let dragging = false, dragStart = null;
viewport.addEventListener('mousedown', (e) => {
  // ignore drags that started on a node — those are clicks
  if (e.target.closest('.node')) return;
  dragging = true;
  dragStart = { x: e.clientX - view.x, y: e.clientY - view.y };
  viewport.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  view.x = e.clientX - dragStart.x;
  view.y = e.clientY - dragStart.y;
  applyTransform();
});
window.addEventListener('mouseup', () => {
  dragging = false;
  viewport.classList.remove('dragging');
});
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  // point under cursor in world coords
  const wx = (mx - view.x) / view.scale, wy = (my - view.y) / view.scale;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  view.scale = Math.max(0.25, Math.min(3, view.scale * delta));
  // keep that point under the cursor after zoom
  view.x = mx - wx * view.scale;
  view.y = my - wy * view.scale;
  applyTransform();
}, { passive: false });

function resetView() { view.x = 40; view.y = 60; view.scale = 0.9; applyTransform(); }
applyTransform();

// Touch support (basic pan + pinch)
let touchState = null;
viewport.addEventListener('touchstart', (e) => {
  if (e.target.closest('.node')) return;
  if (e.touches.length === 1) {
    touchState = { type: 'pan', x: e.touches[0].clientX - view.x, y: e.touches[0].clientY - view.y };
  } else if (e.touches.length === 2) {
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    touchState = { type: 'pinch', startDist: dist, startScale: view.scale };
  }
}, { passive: true });
viewport.addEventListener('touchmove', (e) => {
  if (!touchState) return;
  if (touchState.type === 'pan' && e.touches.length === 1) {
    view.x = e.touches[0].clientX - touchState.x;
    view.y = e.touches[0].clientY - touchState.y;
    applyTransform();
  } else if (touchState.type === 'pinch' && e.touches.length === 2) {
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    view.scale = Math.max(0.25, Math.min(3, touchState.startScale * (dist / touchState.startDist)));
    applyTransform();
  }
}, { passive: true });
viewport.addEventListener('touchend', () => { touchState = null; }, { passive: true });

// ── Layout ──────────────────────────────────────────────────────
// Coordinates are in the canvas's own space, no zoom applied.
// The section key names the layout box; the batch field is the value agents
// actually declare. They are not the same word for Sales: the agents say
// "sales_management" while the box is keyed "sales", so matching on the key
// alone silently rendered "no agents in this batch" over Lead/Pipeline and
// Objection/FAQ. Both are named here so they cannot drift apart again.
const SECTION_LAYOUT = {
  marketing: { x: 460, y: 40,  w: 640, h: 300, label: 'Marketing', batch: 'marketing' },
  sales:     { x: 460, y: 380, w: 640, h: 180, label: 'Sales', batch: 'sales_management' },
  executive: { x: 460, y: 600, w: 640, h: 260, label: 'Executive', batch: 'executive' },
};
const COS_POS = { x: 200, y: 420 };
const SUB_COMPLETED = { x: 120, y: 570 };
const SUB_PENDING   = { x: 280, y: 570 };

// Compute where each node's dot centre lands in canvas space, for drawing wires.
function nodeCentre(el) {
  const n = el.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  return {
    x: ((n.left + n.width/2) - c.left) / view.scale,
    y: ((n.top + n.height/2) - c.top) / view.scale,
  };
}

// ── Rendering ──────────────────────────────────────────────────
function renderAll() {
  renderChips();
  renderNodes();
  renderWires(); // after nodes have positions
}

function renderChips() {
  const chips = [];
  const r = STATUS.readiness || { ready: false, detail: {} };
  chips.push(['ready', r.ready ? 'yes' : 'no', r.ready ? 'good' : 'bad']);
  chips.push(['db', STATUS.database && STATUS.database.ok ? 'connected' : 'down', STATUS.database && STATUS.database.ok ? 'good' : 'bad']);
  chips.push(['pending', APPROVALS.length, APPROVALS.length ? 'warn' : 'good']);
  const activeConn = (STATUS.connectors || []).filter(c => c.active).map(c => c.channel);
  chips.push(['live channels', activeConn.join(', ') || 'none', activeConn.length ? 'good' : 'warn']);
  document.getElementById('status-chips').innerHTML = chips.map(([k, v, c]) =>
    '<span class="chip ' + c + '"><span class="dot"></span><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></span>'
  ).join('');
}

function renderNodes() {
  const nodes = document.getElementById('nodes');
  const parts = [];

  // Sections
  for (const [key, sec] of Object.entries(SECTION_LAYOUT)) {
    parts.push(\`<div class="section \${key}" style="left:\${sec.x}px;top:\${sec.y}px;width:\${sec.w}px;min-height:\${sec.h}px">
      <h2><span class="swatch"></span>\${esc(sec.label)}</h2>
      <div class="sub">\${countBatch(sec.batch)} agents · \${activeInBatch(sec.batch)} live</div>
      <div class="agents" id="agents-\${key}"></div>
    </div>\`);
  }

  // Chief-of-Staff
  const cos = AGENTS.find(a => a.id === 'chief_of_staff') || { id: 'chief_of_staff', name: 'Chief-of-Staff', batch: 'orchestration', cadence: 'daily' };
  parts.push(nodeHtml(cos, COS_POS.x, COS_POS.y, 'orchestration chief'));

  // Two sub-nodes
  parts.push(subNodeHtml('completed', 'Completed', SUB_COMPLETED.x, SUB_COMPLETED.y, REPORTS.filter(r => r.outcome === 'executed').length));
  parts.push(subNodeHtml('pending',   'Pending',   SUB_PENDING.x,   SUB_PENDING.y,   APPROVALS.length, APPROVALS.length ? 'red' : ''));

  nodes.innerHTML = parts.join('');

  // Now inject agent dots into their section containers
  for (const [key, sec] of Object.entries(SECTION_LAYOUT)) {
    const container = document.getElementById('agents-' + key);
    const agents = AGENTS.filter(a => a.batch === sec.batch);
    // Fill in placeholder positions if the batch is empty
    if (!agents.length) {
      container.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;font-style:italic">no agents in this batch</div>';
      continue;
    }
    container.innerHTML = agents.map(a => nodeCard(a)).join('');
  }

  // Wire click handlers (delegation would work too; this is explicit)
  document.querySelectorAll('.node').forEach(n => {
    n.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = n.dataset.kind;
      if (kind === 'agent' || kind === 'chief') openAgent(n.dataset.id);
      else if (kind === 'sub-completed') openCompleted();
      else if (kind === 'sub-pending') openPending();
    });
  });

  // The nodes rely on layout for wire coordinates; wait a frame.
  requestAnimationFrame(renderWires);
}

function countBatch(b) { return AGENTS.filter(a => a.batch === b).length; }
function activeInBatch(b) {
  return AGENTS.filter(a => a.batch === b).filter(a => {
    const s = SCHEDULES[a.id];
    if (s && s.cadence === 'paused') return false;
    return true;
  }).length;
}

function nodeCard(a) {
  const schedule = SCHEDULES[a.id];
  const paused = schedule && schedule.cadence === 'paused';
  const effectiveCadence = schedule ? schedule.cadence : a.cadence;
  const isMock = a.externalBuild || (a.model === null && (a.id === 'ops_health'));
  const rt = RUNTIME[a.id];
  const isWorking = rt && rt.status === 'running';
  const isFailed = rt && rt.status === 'failed';
  const cls = 'node ' + a.batch +
    (paused ? ' paused' : '') +
    (isMock ? ' mock' : '') +
    (SELECTED === a.id ? ' selected' : '') +
    (isWorking ? ' working' : '') +
    (isFailed ? ' failed-status' : '');
  const initials = initialsOf(a.name);
  const statusTag = isWorking
    ? '<div class="status-tag working">' + esc(rt.phase || 'working') + '</div>'
    : isFailed
      ? '<div class="status-tag failed">failed</div>'
      : '';
  const thought = isWorking && rt.latestThought
    ? '<div class="thought" title="' + esc(rt.latestThought) + '">' + esc(rt.latestThought) + '</div>'
    : '';
  return \`<div class="\${cls}" data-kind="agent" data-id="\${esc(a.id)}" title="\${esc(a.description)}">
    <div class="dot">\${statusTag}\${esc(initials)}</div>
    <div class="label">\${esc(a.name)}</div>
    <div class="cadence">\${paused ? 'paused' : esc(effectiveCadence)}</div>
    \${thought}
  </div>\`;
}

function initialsOf(name) {
  const parts = String(name).split(/\\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function nodeHtml(a, x, y, extraCls) {
  return \`<div class="node \${extraCls || 'orchestration'} \${SELECTED === a.id ? 'selected' : ''}"
    data-kind="chief" data-id="\${esc(a.id)}"
    style="position:absolute;left:\${x - 45}px;top:\${y - 55}px">
    <div class="dot">\${esc(initialsOf(a.name))}</div>
    <div class="label">\${esc(a.name)}</div>
    <div class="cadence">\${esc(a.cadence)}</div>
  </div>\`;
}

function subNodeHtml(kind, label, x, y, count, badgeClass) {
  const badge = count > 0 ? \`<span class="badge-count">\${count}</span>\` : '';
  return \`<div class="node sub orchestration" data-kind="sub-\${kind}"
    style="position:absolute;left:\${x - 34}px;top:\${y - 40}px">
    <div class="dot">\${badge}</div>
    <div class="label">\${esc(label)}</div>
  </div>\`;
}

// ── Wires ──────────────────────────────────────────────────────
// The visual metaphor: an animated ECG line runs from each section into COS.
// Extra thin static lines fan out from COS to every agent, so you see the
// membership. The two sub-nodes hang off COS with short connectors.
function renderWires() {
  const wires = document.getElementById('wires');
  const cosEl = document.querySelector('[data-kind="chief"]');
  if (!cosEl) return;
  const cos = nodeCentre(cosEl);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  wires.setAttribute('width', w);
  wires.setAttribute('height', h);
  wires.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
  wires.style.width = w + 'px'; wires.style.height = h + 'px';

  const parts = [];
  // Static agent-membership links (faint) — one per agent, coloured by batch
  document.querySelectorAll('.node[data-kind="agent"]').forEach(n => {
    const c = nodeCentre(n);
    const batch = n.className.split(/\\s+/).find(x => ['marketing','sales','executive'].includes(x));
    parts.push(\`<path class="link \${batch || ''}" d="M\${cos.x},\${cos.y} C\${(cos.x+c.x)/2},\${cos.y} \${(cos.x+c.x)/2},\${c.y} \${c.x},\${c.y}"/>\`);
  });

  // ECG pulse from each section header point to COS
  for (const [key, sec] of Object.entries(SECTION_LAYOUT)) {
    const anchor = { x: sec.x + 14, y: sec.y + 34 }; // near the section's swatch
    const midx = (cos.x + anchor.x) / 2;
    // Small ECG spike near the middle to sell the metaphor
    const spike = \`M\${cos.x},\${cos.y}
      L\${midx - 30},\${cos.y}
      L\${midx - 15},\${cos.y - 8}
      L\${midx - 6},\${cos.y + 14}
      L\${midx + 4},\${cos.y - 16}
      L\${midx + 14},\${cos.y}
      L\${midx + 40},\${cos.y}
      Q\${anchor.x - 40},\${cos.y} \${anchor.x},\${anchor.y}\`;
    parts.push(\`<path class="ecg" d="\${spike}"/>\`);
    parts.push(\`<path class="ecg ecg-pulse" d="\${spike}"/>\`);
  }

  // Sub-node links
  const compEl = document.querySelector('[data-kind="sub-completed"]');
  const pendEl = document.querySelector('[data-kind="sub-pending"]');
  if (compEl && pendEl) {
    const comp = nodeCentre(compEl);
    const pend = nodeCentre(pendEl);
    parts.push(\`<path class="link" d="M\${cos.x},\${cos.y + 34} Q\${cos.x - 30},\${cos.y + 70} \${comp.x},\${comp.y - 20}"/>\`);
    parts.push(\`<path class="link" d="M\${cos.x},\${cos.y + 34} Q\${cos.x + 30},\${cos.y + 70} \${pend.x},\${pend.y - 20}"/>\`);
  }

  wires.innerHTML = parts.join('');
}

// Redraw wires when the window resizes (positions don't change, but SVG size does)
window.addEventListener('resize', renderWires);

// ── Side panel ──────────────────────────────────────────────────
function openPanel(html) {
  document.getElementById('panel-body').innerHTML = html;
  document.getElementById('panel').classList.add('open');
}
function closePanel() {
  document.getElementById('panel').classList.remove('open');
  SELECTED = null;
  renderAll();
}

async function openAgent(id) {
  SELECTED = id;
  renderAll();
  const agent = AGENTS.find(a => a.id === id);
  if (!agent) return;
  const activity = REPORTS.filter(r => r.agent_id === id).slice(0, 12);
  const schedule = SCHEDULES[id];
  const effCadence = schedule ? schedule.cadence : agent.cadence;
  const rt = RUNTIME[id];

  const cadenceOptions = ['hourly', 'daily', 'weekly', 'paused'];
  const cadenceButtons = cadenceOptions.map(c =>
    \`<button onclick="setSchedule('\${id}', '\${c}')" \${effCadence === c ? 'class="selected"' : ''}>\${c}</button>\`
  ).join('');

  const nowThinking = rt && rt.status === 'running'
    ? \`<div class="now-thinking">
         <div class="spinner"></div>
         <div class="text"><b>currently \${esc(rt.phase || 'working')}</b>\${esc(rt.latestThought || '')}</div>
       </div>\`
    : rt && rt.status === 'failed'
      ? \`<div class="now-thinking" style="border-color:rgba(193,102,107,.3);background:linear-gradient(135deg,rgba(193,102,107,.12),rgba(193,102,107,.03))">
           <div style="width:14px;height:14px;border-radius:50%;background:var(--red);opacity:.6;margin-top:3px;flex-shrink:0"></div>
           <div class="text" style="color:var(--red)"><b>last run failed</b>\${esc(rt.error || rt.latestThought || 'no detail')}</div>
         </div>\`
      : '';

  const thoughtTrail = rt && rt.thoughts && rt.thoughts.length
    ? \`<h3>Thought trail (\${rt.status === 'running' ? 'live' : 'last run'})</h3>
       <div class="thought-trail">\${rt.thoughts.slice().reverse().map(t =>
         \`<div><span class="ts">\${esc(new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>\${esc(t.text)}</div>\`
       ).join('')}</div>
       \${rt.endedAt ? \`<div style="font-size:11px;color:var(--text-faint);margin-top:6px">ended \${esc(ago(rt.endedAt))}</div>\` : ''}\`
    : '';

  openPanel(\`
    <h2>\${esc(agent.name)}</h2>
    <div class="meta">\${esc(agent.batch)} · \${agent.model ? esc(agent.model) + ' · effort ' + esc(agent.effort) : 'no model calls'} · currently \${esc(effCadence)}</div>
    \${nowThinking}
    <p class="lede">\${esc(agent.description)}</p>
    \${thoughtTrail}

    <h3>Run now</h3>
    <div class="actions">
      <button class="primary" onclick="runAgent('\${id}')">▶ Run once</button>
    </div>

    <h3>Recurring cadence</h3>
    <p class="cadence-hint">Native cadence in code: <code>\${esc(agent.cadence)}</code>. Choose an override, or "default" to fall back.</p>
    <div class="actions">
      \${cadenceButtons}
      <button onclick="setSchedule('\${id}', 'default')" \${!schedule ? 'class="selected"' : ''}>default</button>
    </div>
    \${schedule && schedule.cadence === 'paused' ? '<p class="cadence-hint" style="color:var(--amber)">This agent is paused: it will not fire on any cron tick.</p>' : ''}

    <h3>Routine (runs without asking)</h3>
    \${agent.routine.length ? agent.routine.map(r =>
      \`<div class="rulebox routine"><span class="rid">\${esc(r.id)}</span>\${esc(r.describe)}</div>\`
    ).join('') : '<div class="empty">Nothing runs unattended for this agent.</div>'}

    <h3>Needs approval</h3>
    \${agent.needsApproval.length ? agent.needsApproval.map(r =>
      \`<div class="rulebox approval"><span class="rid">\${esc(r.id)}</span>\${esc(r.describe)}</div>\`
    ).join('') : '<div class="empty">Only the general boundary applies.</div>'}

    <h3>Recent activity</h3>
    \${activity.length ? \`<table class="activity"><thead><tr><th>When</th><th>Action</th><th>Outcome</th></tr></thead><tbody>\${
      activity.map(row => \`<tr><td>\${esc(ago(row.created_at))}</td><td>\${esc(row.summary)}</td><td>\${outcomeBadge(row.outcome)}</td></tr>\`).join('')
    }</tbody></table>\` : '<div class="empty">No activity logged for this agent yet.</div>'}
  \`);
}

function outcomeBadge(o) {
  const m = { executed: 'green', observed: 'blue', no_op: 'slate', failed: 'red', blocked_inactive: 'amber' };
  return \`<span class="badge \${m[o] || 'slate'}">\${esc(o || 'unknown')}</span>\`;
}

function openCompleted() {
  const rows = REPORTS.filter(r => r.outcome === 'executed').slice(0, 40);
  openPanel(\`
    <h2>Completed work</h2>
    <div class="meta">last \${rows.length} executed actions, most recent first</div>
    <p class="lede">Everything an agent has actually done — published, replied, updated, applied. Read-only observations and no-ops are in the agent panels.</p>
    \${rows.length ? \`<table class="activity"><thead><tr><th>When</th><th>Agent</th><th>Action</th></tr></thead><tbody>\${
      rows.map(r => \`<tr><td>\${esc(ago(r.created_at))}</td><td>\${esc(r.agent_id)}</td><td>\${esc(r.summary)}</td></tr>\`).join('')
    }</tbody></table>\` : '<div class="empty">Nothing executed yet.</div>'}
  \`);
}

function openPending() {
  // Problems first, then newest. A broken agent outranks a growth idea however
  // long the idea has been waiting.
  const ordered = APPROVALS.slice().sort((x, y) => (isProblem(y) ? 1 : 0) - (isProblem(x) ? 1 : 0));
  const problems = APPROVALS.filter(isProblem).length;
  openPanel(\`
    <h2>Waiting on you</h2>
    <div class="meta">\${APPROVALS.length} queued\${problems ? \` &middot; <span class="probcount">\${problems} problem\${problems > 1 ? 's' : ''}</span>\` : ''}</div>
    <p class="lede">Everything an agent proposed that its rules said "queue this, don't just do it". Approve to let the agent run the action as-is; reject with an optional note the agent will read next tick. Items flagged as a problem are failures an agent already hit: nothing runs when you acknowledge one, it just stops being shown as outstanding.</p>
    \${ordered.length ? ordered.map(renderApproval).join('') : '<div class="empty">Nothing waiting. Routine work runs without asking.</div>'}
  \`);
}

/**
 * Chief-of-Staff queues every failed action under this one rule. Those entries
 * are not permission requests: approving one executes nothing, it only marks
 * the problem as seen. The buttons say so, rather than offering "Approve" for
 * something there is nothing to approve.
 */
function isProblem(a) {
  return a.trigger_rule === 'chief_of_staff.problem_escalation'
    || !!(a.action && a.action.payload && a.action.payload.problem);
}

function renderApproval(a) {
  const action = a.action || {};
  const body = action.payload && (action.payload.text || action.payload.reply || action.payload.analysis || action.payload.after || action.payload.answer || action.payload.briefing);
  const problem = isProblem(a);
  return \`<div class="approval risk-\${esc(a.risk)}\${problem ? ' problem' : ''}">
    \${problem ? '<div class="flag">Problem &middot; needs attention</div>' : ''}
    <h4>\${esc(a.title)}</h4>
    <div class="amt">\${esc(a.agent_id)} · \${esc(action.type || '')} · rule \${esc(a.trigger_rule)} · \${esc(ago(a.created_at))}</div>
    <div class="reason">\${esc(a.trigger_reason || a.rationale)}</div>
    \${body ? \`<div class="body">\${esc(body)}</div>\` : ''}
    <div class="actions">
      <input type="text" id="note-\${esc(a.id)}" placeholder="optional note">
      <button class="approve" onclick="decide('\${esc(a.id)}','approve')">\${problem ? 'Acknowledge' : 'Approve'}</button>
      <button class="reject" onclick="decide('\${esc(a.id)}','reject')">\${problem ? 'Dismiss' : 'Reject'}</button>
    </div>
  </div>\`;
}

// ── Actions ────────────────────────────────────────────────────
async function decide(id, decision) {
  disableAll(true);
  try {
    const r = await api('/approvals/' + id + '/' + decision, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: (document.getElementById('note-' + id) || {}).value || '' }),
    });
    toast(r.error ? ('Error: ' + r.error) : (decision === 'approve' ? 'Approved and executed' : 'Rejected'), r.error ? 'error' : '');
    await loadAll();
    openPending();
  } finally { disableAll(false); }
}

async function runAgent(id) {
  disableAll(true);
  try {
    const r = await api('/run/' + id, { method: 'POST' });
    toast(r.error ? ('Error: ' + r.error) : 'Fired ' + id, r.error ? 'error' : '');
    await loadAll();
    openAgent(id);
  } finally { disableAll(false); }
}

async function runTick(cadence) {
  disableAll(true);
  try {
    const r = await api('/run?cadence=' + cadence, { method: 'POST' });
    toast(r.error ? ('Error: ' + r.error) : (\`Fired \${cadence} agents\`), r.error ? 'error' : '');
    await loadAll();
  } finally { disableAll(false); }
}

async function setSchedule(id, cadence) {
  disableAll(true);
  try {
    const r = await api('/schedules/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cadence }),
    });
    if (r.schedules) SCHEDULES = r.schedules;
    toast(cadence === 'default' ? \`\${id} reset to default cadence\` : \`\${id} → \${cadence}\`);
    renderAll();
    openAgent(id);
  } finally { disableAll(false); }
}

function disableAll(state) {
  document.querySelectorAll('button').forEach(b => b.disabled = state);
}

function toast(msg, cls = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + cls;
  setTimeout(() => t.className = 'toast ' + cls, 2600);
}

// ── Data loading ────────────────────────────────────────────────
async function loadAll() {
  const [status, approvals, reports, schedules, runtime] = await Promise.all([
    api('/status'),
    api('/approvals?status=pending'),
    api('/reports?limit=100'),
    api('/schedules'),
    api('/runtime'),
  ]);
  STATUS = status || {};
  AGENTS = status.agents || [];
  APPROVALS = approvals.approvals || [];
  REPORTS = reports.reports || [];
  SCHEDULES = schedules.schedules || {};
  RUNTIME = runtime.runtime || {};
  renderAll();
  // If any agent is currently running, keep the panel it's open on in sync.
  if (SELECTED && document.getElementById('panel').classList.contains('open')) {
    openAgent(SELECTED);
  }
}

/** Poll faster while anything is running, slower when nothing is. */
function anyRunning() { return Object.values(RUNTIME).some(r => r && r.status === 'running'); }
async function tick() {
  await loadAll();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, anyRunning() ? 3000 : 60000);
}
let pollTimer = null;

// Close panel on Escape
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

tick();
</script>
</body>
</html>`;
}
