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
  /* Intelligence is the one section that reads the world outside this system,
     and it is the only one with a store of its own. Cyan sets it apart from
     the three operating colours rather than joining them. */
  --intel:#4FC3D9; --intel-dim:#3A93A6; --intel-glow:rgba(79,195,217,.4);
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
.section.intelligence h2, .section.intelligence .swatch{color:var(--intel)}
.section.intelligence{border-color:rgba(79,195,217,.28)}
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
.node.intelligence .dot{color:var(--intel)}
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

/* ── The library ───────────────────────────────────────────────
   Drawn as a store rather than as a circle, because it is not an agent. The
   Competitive Intelligence agent is the only thing that writes into it, and
   the cyan line between the two is the only place on this canvas where a node
   feeds something other than the Chief-of-Staff. */
.node.library .dot{
  width:104px; height:66px; border-radius:14px;
  background:linear-gradient(160deg, rgba(79,195,217,.16), rgba(79,195,217,.02));
  border:1.5px solid var(--intel); color:var(--intel);
  box-shadow:0 0 26px var(--intel-glow);
  flex-direction:column; gap:1px;
}
.node.library .dot::after{border-radius:16px;border-color:var(--intel);opacity:.2}
.node.library .dot .n{font-family:Georgia,serif;font-size:22px;font-weight:600;line-height:1.1;color:var(--intel)}
.node.library .dot .u{font-family:ui-monospace,monospace;font-size:8.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--text-faint)}
.node.library .label{color:var(--intel);font-size:12.5px}
.node.library .cadence{color:var(--text-faint)}
.node.library.empty-store .dot{border-style:dashed;box-shadow:none;opacity:.75}
.node.library.blocked .dot{border-color:var(--amber);color:var(--amber);box-shadow:0 0 22px rgba(201,138,62,.3)}
.node.library.blocked .dot .n{color:var(--amber);font-size:13px;font-family:ui-monospace,monospace}

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
.wires .link.intelligence{stroke:var(--intel)}

/* The feed from the agent into its library. Same ECG idea as the section
   lines, in cyan, with a node at each end: one where the work is produced and
   one where it lands. The far node pulses because that end is what fills. */
.wires .ecg.intel{stroke:var(--intel);stroke-width:1.6;opacity:.9;filter:drop-shadow(0 0 5px var(--intel-glow))}
.wires .ecg.intel.ecg-pulse{stroke-width:2.4;opacity:1}
.wires .ecg-node{fill:var(--intel);transform-box:fill-box;transform-origin:center;filter:drop-shadow(0 0 6px var(--intel-glow))}
.wires .ecg-node.pulsing{animation:ecg-node 2.4s ease-in-out infinite}
@keyframes ecg-node{
  0%,100%{transform:scale(1);opacity:1}
  50%{transform:scale(1.7);opacity:.45}
}

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
.badge.cyan{color:var(--intel);border-color:rgba(79,195,217,.45)}

/* ── Library panel ─────────────────────────────────────────── */
.panel h3.intel{color:var(--intel)}
.brief-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--intel);border-radius:8px;padding:13px 15px;margin-bottom:9px;cursor:pointer;transition:.15s}
.brief-card:hover{border-color:var(--intel-dim);border-left-color:var(--intel);transform:translateX(2px)}
.brief-card h4{font-size:13.5px;font-weight:600;margin-bottom:3px}
.brief-card .amt{font-family:ui-monospace,monospace;font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.brief-card .reason{font-size:12.5px;color:var(--text-dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.brief-body{font-size:13.5px}
.brief-body .headline{border-left:2px solid var(--intel);padding-left:14px;color:var(--text);margin-bottom:18px;font-size:14.5px}
.brief-body article{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:9px}
.brief-body article.gap{border-left:3px solid var(--intel)}
.brief-body article h5{font-size:13.5px;font-weight:600;margin-bottom:5px;display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.brief-body p{margin-bottom:6px;color:var(--text-dim)}
.brief-body p:last-child{margin-bottom:0}
.brief-body p b{color:var(--text-faint);font-weight:600}
.std{font-family:ui-monospace,monospace;font-size:8.5px;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:20px;border:1px solid}
.std.observed{color:var(--green);border-color:rgba(111,167,135,.45)}
.std.inferred{color:var(--blue);border-color:rgba(117,151,196,.45)}
.std.assumption{color:var(--amber);border-color:rgba(201,138,62,.45)}
.sigtag{font-family:ui-monospace,monospace;font-size:8.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.sigtag.high{color:var(--red)}
.sigtag.medium{color:var(--amber)}
.panel .actions button.intel{border-color:var(--intel-dim);color:var(--intel)}
.panel .actions button.intel:hover{background:rgba(79,195,217,.08);border-color:var(--intel)}
.panel a.dl{background:var(--surface);border:1px solid var(--intel-dim);color:var(--intel);padding:8px 14px;border-radius:5px;font-size:12.5px;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.panel a.dl:hover{background:rgba(79,195,217,.08);border-color:var(--intel)}
.blocked-note{background:linear-gradient(135deg,rgba(201,138,62,.12),rgba(201,138,62,.03));border:1px solid rgba(201,138,62,.3);border-radius:8px;padding:12px 14px;margin-bottom:14px;color:var(--amber);font-size:13px}
.blocked-note b{display:block;font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.blocked-note code{background:var(--bg);padding:1px 5px;border-radius:3px;font-size:11.5px;color:var(--text-dim)}
.ask-card{background:linear-gradient(135deg,rgba(201,138,62,.13),rgba(201,138,62,.03));border:1px solid rgba(201,138,62,.35);border-left:3px solid var(--amber);border-radius:9px;padding:14px 16px;margin-bottom:12px}
.ask-card h4{font-size:14px;font-weight:600;color:var(--amber);margin-bottom:7px}
.ask-card p{font-size:12.5px;color:var(--text-dim);margin-bottom:6px}
.ask-card p b{color:var(--text-faint);font-weight:600}
.ask-card textarea{width:100%;min-height:92px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:9px 11px;border-radius:6px;font-size:13px;line-height:1.55;resize:vertical;margin:8px 0 8px}
.ask-card textarea:focus{outline:none;border-color:var(--amber)}
.answered{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--green);border-radius:8px;padding:12px 14px;margin-bottom:9px;font-size:12.5px}
.answered .q{color:var(--text-faint);margin-bottom:5px}
.answered .a{color:var(--text-dim)}
.verdict{background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:9px 12px;margin-bottom:6px;font-size:12.5px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.verdict.accepted{border-left:3px solid var(--green)}
.verdict.rejected{border-left:3px solid var(--slate);opacity:.8}
.verdict .nm{color:var(--text);flex:1;min-width:140px}
.verdict .when{font-family:ui-monospace,monospace;font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em}
.src-list{font-size:12.5px;color:var(--text-dim);padding-left:20px}
.src-list li{margin-bottom:4px;word-break:break-word}

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
let BRIEFS = [];

// ── Pan / zoom ──────────────────────────────────────────────────
// Framing. The canvas grew a fourth section and a store off to the right when
// Intelligence was added, so the default zoom pulls back far enough that the
// whole shape is visible on an ordinary laptop without panning for it. A map
// you have to hunt around to read is not doing its job.
const DEFAULT_VIEW = { x: 30, y: 40, scale: 0.72 };
const view = { ...DEFAULT_VIEW };
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

function resetView() { Object.assign(view, DEFAULT_VIEW); applyTransform(); }
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
  marketing:    { x: 460, y: 40,  w: 640, h: 300, label: 'Marketing', batch: 'marketing' },
  sales:        { x: 460, y: 380, w: 640, h: 180, label: 'Sales', batch: 'sales_management' },
  executive:    { x: 460, y: 600, w: 640, h: 260, label: 'Executive', batch: 'executive' },
  intelligence: { x: 460, y: 900, w: 640, h: 190, label: 'Intelligence', batch: 'intelligence' },
};
const COS_POS = { x: 200, y: 420 };
const SUB_COMPLETED = { x: 120, y: 570 };
const SUB_PENDING   = { x: 280, y: 570 };
// The library sits to the RIGHT of its section, away from the Chief-of-Staff.
// Everything else on this canvas flows leftward into coordination; this one
// line flows the other way, into a store. The layout says so before the labels
// do.
const LIBRARY_POS = { x: 1290, y: 985 };

// Compute where an element's centre lands in canvas space, for drawing wires.
function nodeCentre(el) {
  const n = el.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  return {
    x: ((n.left + n.width/2) - c.left) / view.scale,
    y: ((n.top + n.height/2) - c.top) / view.scale,
  };
}

// ── Rendering ──────────────────────────────────────────────────
/**
 * The centre of a node's DOT, not of the whole node.
 *
 * A .node is the dot plus its label, cadence and live thought stacked beneath
 * it, so the box's centre sits well below the dot. Wires drawn to that point
 * visibly miss the thing they are connecting, and the taller the node's text
 * the further out they land.
 */
function dotCentre(el) {
  return nodeCentre(el.querySelector('.dot') || el);
}

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
  const intel = STATUS.intelligence || {};
  chips.push([
    'library',
    intel.migrationApplied ? (BRIEFS.length + ' brief' + (BRIEFS.length === 1 ? '' : 's')) : 'migration 0002',
    intel.migrationApplied ? (BRIEFS.length ? 'good' : 'warn') : 'bad',
  ]);
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

  // The library
  parts.push(libraryHtml());

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
      else if (kind === 'library') openLibrary();
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

/**
 * The store the Competitive Intelligence agent writes into. Three states, and
 * they are visually different on purpose: blocked means the table it writes to
 * does not exist yet, which is a setup step rather than an empty shelf, and
 * showing those two the same way would hide a thing that needs doing.
 */
function libraryHtml() {
  const intel = STATUS.intelligence || {};
  const blocked = intel.migrationApplied === false;
  const count = BRIEFS.length;
  const cls = 'node library intelligence'
    + (blocked ? ' blocked' : '')
    + (!blocked && count === 0 ? ' empty-store' : '');
  const face = blocked
    ? '<span class="n">migration</span><span class="u">0002 not applied</span>'
    : \`<span class="n">\${count}</span><span class="u">brief\${count === 1 ? '' : 's'}</span>\`;
  const sub = blocked
    ? 'needs setup'
    : count === 0 ? 'nothing filed yet' : ('newest ' + esc(BRIEFS[0].brief_date));
  return \`<div class="\${cls}" data-kind="library"
    title="Every competitive intelligence brief, stored and readable"
    style="position:absolute;left:\${LIBRARY_POS.x - 52}px;top:\${LIBRARY_POS.y - 48}px">
    <div class="dot">\${face}</div>
    <div class="label">Intelligence Library</div>
    <div class="cadence">\${sub}</div>
  </div>\`;
}

// ── Wires ──────────────────────────────────────────────────────
// The visual metaphor: an animated ECG line runs from each section into COS.
// Extra thin static lines fan out from COS to every agent, so you see the
// membership. The two sub-nodes hang off COS with short connectors.
/**
 * How much room the drawing actually needs, in canvas coordinates.
 *
 * This has to be measured rather than assumed. Everything on this canvas is
 * absolutely positioned, so .canvas-inner collapses to zero width and height,
 * and the wires SVG inside it inherits that through inset:0. The paths were
 * being written correctly and then clipped to a 0x0 box: every ECG line in the
 * page was in the DOM and invisible. Reading the real extent of the rendered
 * sections and nodes keeps this correct when the layout moves, which an
 * assumed constant would not.
 */
function canvasExtent() {
  const c = canvas.getBoundingClientRect();
  let w = 0, h = 0;
  document.querySelectorAll('.section, .node').forEach(el => {
    const r = el.getBoundingClientRect();
    w = Math.max(w, (r.right - c.left) / view.scale);
    h = Math.max(h, (r.bottom - c.top) / view.scale);
  });
  return { w: Math.ceil(w) + 90, h: Math.ceil(h) + 90 };
}

function renderWires() {
  const wires = document.getElementById('wires');
  const cosEl = document.querySelector('[data-kind="chief"]');
  if (!cosEl) return;
  const cos = dotCentre(cosEl);
  const { w, h } = canvasExtent();
  // The canvas is given the size too, so the SVG's inset:0 resolves to it.
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  wires.setAttribute('width', w);
  wires.setAttribute('height', h);
  wires.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
  wires.style.width = w + 'px'; wires.style.height = h + 'px';

  const parts = [];
  // Static agent-membership links (faint) — one per agent, coloured by batch
  document.querySelectorAll('.node[data-kind="agent"]').forEach(n => {
    const c = dotCentre(n);
    const batch = n.className.split(/\\s+/).find(x => ['marketing','sales','executive','intelligence'].includes(x));
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

  // The intelligence feed: agent -> library.
  //
  // Every other line on this canvas ends at the Chief-of-Staff. This one runs
  // the other way, from the one agent that produces documents into the one
  // place that stores them, so it is drawn differently: cyan, thicker, with a
  // node at each end. The ECG spike sits mid-line as it does on the section
  // wires, and the dash animation runs a pulse along it from the agent to the
  // store, in that direction, because that is the direction the work moves.
  const intelEl = document.querySelector('.node[data-id="competitive_intel"]');
  const libEl = document.querySelector('[data-kind="library"]');
  if (intelEl && libEl) {
    const c = dotCentre(intelEl);
    const b = dotCentre(libEl);
    // Both ends clear their node. Drawn from the agent's centre the start node
    // would sit under the agent's own dot and never be seen, which is half the
    // point of having a node at each end.
    const a = { x: c.x + 32, y: c.y };
    const end = { x: b.x - 58, y: b.y };
    const mid = (a.x + end.x) / 2;
    const feed = \`M\${a.x},\${a.y}
      L\${mid - 52},\${a.y}
      L\${mid - 34},\${a.y - 14}
      L\${mid - 20},\${a.y + 24}
      L\${mid - 4},\${a.y - 30}
      L\${mid + 12},\${a.y}
      L\${mid + 52},\${a.y}
      Q\${end.x - 4},\${a.y} \${end.x},\${end.y}\`;
    parts.push(\`<path class="ecg intel" d="\${feed}"/>\`);
    parts.push(\`<path class="ecg intel ecg-pulse" d="\${feed}"/>\`);
    // A node at each end. The far one pulses: that is the end that fills up.
    parts.push(\`<circle class="ecg-node" cx="\${a.x}" cy="\${a.y}" r="5.5"/>\`);
    parts.push(\`<circle class="ecg-node pulsing" cx="\${end.x}" cy="\${end.y}" r="5.5"/>\`);
  }

  // Sub-node links
  const compEl = document.querySelector('[data-kind="sub-completed"]');
  const pendEl = document.querySelector('[data-kind="sub-pending"]');
  if (compEl && pendEl) {
    const comp = dotCentre(compEl);
    const pend = dotCentre(pendEl);
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


// ── The intelligence library ────────────────────────────────────
// A brief is a document, not a log line, so this reads like one: the headline
// first, then the findings, each carrying the evidence standard it was written
// under. The two buttons at the top are the point of the whole feature — the
// owner asked to be able to save and read these, so every brief leaves as a
// file or as its own page.

function handleOf(brief) {
  return (brief && brief.briefDate) || '';
}

/**
 * Answering closes the loop. The answer is stored as permanent context first,
 * then the agent reads it and says what it changes, and that assessment lands
 * in the approvals queue where it can be taken or rejected. Nothing about it
 * publishes.
 */
async function sendAnswer(briefDate) {
  const box = document.getElementById('answer-box');
  const out = document.getElementById('answer-status');
  const answer = (box && box.value || '').trim();
  if (!answer) { if (out) out.textContent = 'Write something first.'; return; }

  disableAll(true);
  if (out) out.textContent = 'Recording, then reading it...';
  try {
    const r = await api('/intel/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefDate, answer }),
    });
    if (r.error && !r.recorded) {
      toast('Error: ' + r.error, 'error');
      if (out) out.textContent = '';
      return;
    }
    if (r.recorded && !r.assessed) {
      toast('Answer saved. Reading it failed, so nothing was queued.', 'error');
    } else {
      toast('Answer saved. The assessment is waiting on you.');
    }
    await loadAll();
    openLibrary();
  } finally { disableAll(false); }
}

function stdTag(standard) {
  return '<span class="std ' + esc(standard) + '">' + esc(standard) + '</span>';
}

function briefSection(heading, body) {
  return '<h3 class="intel">' + esc(heading) + '</h3>' + (body || '<div class="empty">Nothing this cycle.</div>');
}

function renderBriefBody(brief) {
  const list = (rows, fn) => rows && rows.length ? rows.map(fn).join('') : '';

  const language = list(brief.categoryLanguage, item =>
    '<article><h5>' + esc(item.term) + stdTag(item.standard) + '</h5>' +
    '<p>' + esc(item.movement) + '</p>' +
    '<p><b>Evidence.</b> ' + esc(item.evidence) + '</p></article>');

  const moves = list(brief.competitorMoves, item =>
    '<article><h5>' + esc(item.who) + stdTag(item.standard) +
    '<span class="sigtag ' + esc(item.significance) + '">' + esc(item.significance) + '</span></h5>' +
    '<p>' + esc(item.change) + '</p>' +
    '<p><b>Evidence.</b> ' + esc(item.evidence) + '</p></article>');

  const gaps = list(brief.positioningGaps, item =>
    '<article class="gap"><h5>' + esc(item.gap) + stdTag(item.standard) + '</h5>' +
    '<p><b>Why it is open.</b> ' + esc(item.whyOpen) + '</p>' +
    '<p><b>Why Velvex fits.</b> ' + esc(item.velvexFit) + '</p>' +
    '<p><b>What it would take.</b> ' + esc(item.whatItWouldTake) + '</p></article>');

  const differentiation = list(brief.differentiationToReinforce, item =>
    '<article><h5>' + esc(item.claim) + stdTag(item.standard) + '</h5>' +
    '<p><b>Under pressure from.</b> ' + esc(item.pressure) + '</p>' +
    '<p><b>Reinforce by.</b> ' + esc(item.reinforcement) + '</p></article>');

  const watchNext = brief.watchNext && brief.watchNext.length
    ? '<ul class="src-list">' + brief.watchNext.map(line => '<li>' + esc(line) + '</li>').join('') + '</ul>'
    : '';

  const sources = brief.sources && brief.sources.length
    ? '<ol class="src-list">' + brief.sources.map(src =>
        '<li><a href="' + esc(src.url) + '" target="_blank" rel="noreferrer noopener">' +
        esc(src.title || src.url) + '</a>' + (src.usedFor ? ' — ' + esc(src.usedFor) : '') + '</li>').join('') + '</ol>'
    : '';

  // The question the brief is asking, with the box to answer it. This is the
  // half of the loop that makes the agent's reading correctable: the outside
  // world is stale about a young company, and this is where that gets fixed.
  const q = brief.openQuestion;
  const ask = q
    ? '<div class="ask-card">' +
        '<h4>' + esc(q.question) + '</h4>' +
        '<p><b>Why it cannot be answered from outside.</b> ' + esc(q.whyItCannotBeAnswered) + '</p>' +
        '<p><b>What your answer would change.</b> ' + esc(q.whatItWouldChange) + '</p>' +
        '<textarea id="answer-box" placeholder="A few sentences is enough. What you write here becomes permanent context: every future brief reads it, and the agent will not ask this again."></textarea>' +
        '<div class="actions">' +
          '<button class="primary" onclick="sendAnswer(\\'' + esc(handleOf(brief)) + '\\')">Answer it</button>' +
          '<span id="answer-status" class="cadence-hint" style="margin:0"></span>' +
        '</div>' +
      '</div>'
    : '<div class="empty">Nothing this cycle needed asking.</div>';

  const meta = brief.meta || {};
  return '<div class="brief-body">' +
    '<p class="headline">' + esc(brief.headline) + '</p>' +
    '<h3 class="intel">The question this brief is asking you</h3>' + ask +
    briefSection('Category language', language) +
    briefSection('Competitor and adjacent moves', moves) +
    briefSection('Positioning gaps Velvex could occupy', gaps) +
    briefSection('Differentiation to reinforce', differentiation) +
    briefSection('Watch next cycle', watchNext) +
    briefSection('Limitations', brief.limitations ? '<p style="color:var(--text-dim);font-size:13.5px">' + esc(brief.limitations) + '</p>' : '') +
    briefSection('Sources', sources) +
    '<h3 class="intel">Provenance</h3>' +
    '<div class="rulebox">' +
      esc(meta.sourcesChanged || 0) + ' of ' + esc(meta.sourcesWatched || 0) + ' watched sources changed · ' +
      'web research ' + (meta.webResearch ? 'on, ' + esc(meta.searchesUsed || 0) + ' searches' : 'off') + ' · ' +
      esc(meta.model || 'unknown') + ' · $' + Number(meta.costUsd || 0).toFixed(4) +
    '</div>' +
  '</div>';
}

/** The migration is a setup step, so it gets said plainly rather than implied. */
function migrationNote() {
  return '<div class="blocked-note"><b>The library has no table yet</b>' +
    'Apply <code>db/migrations/0002_intelligence_layer.sql</code> to the Supabase project, ' +
    'then run the agent. Until then it stops before doing any research, so nothing is being spent.</div>';
}

async function openLibrary() {
  SELECTED = null;
  renderAll();
  const intel = STATUS.intelligence || {};
  const blocked = intel.migrationApplied === false;

  const cards = BRIEFS.map(row =>
    '<div class="brief-card" onclick="openBrief(\\'' + esc(row.brief_date) + '\\')">' +
      '<h4>' + esc(row.title) + '</h4>' +
      '<div class="amt">' + esc(row.brief_date) + ' · ' + esc(row.gap_count || 0) + ' gap' +
        ((row.gap_count || 0) === 1 ? '' : 's') + ' · ' + esc(row.move_count || 0) + ' move' +
        ((row.move_count || 0) === 1 ? '' : 's') + ' · ' + esc(row.source_count || 0) + ' source' +
        ((row.source_count || 0) === 1 ? '' : 's') + ' · $' + Number(row.cost_usd || 0).toFixed(4) + '</div>' +
      '<div class="reason">' + esc(row.headline) + '</div>' +
    '</div>').join('');

  openPanel(
    '<h2>Intelligence Library</h2>' +
    '<div class="meta">' + BRIEFS.length + ' brief' + (BRIEFS.length === 1 ? '' : 's') + ' stored · ' +
      esc(intel.watchedSources || 0) + ' watched source' + ((intel.watchedSources || 0) === 1 ? '' : 's') + ' · ' +
      'web research ' + (intel.webResearch ? 'on' : 'off') + '</div>' +
    (blocked ? migrationNote() : '') +
    '<p class="lede">Everything the Competitive Intelligence agent has written, kept whole. ' +
      'A brief is stored exactly as it was composed, so one read a year from now is the brief that was ' +
      'written rather than a reconstruction of it. Open one to read it, or take it out as a file.</p>' +
    (BRIEFS.length
      ? '<h3 class="intel">Briefs, newest first</h3>' + cards
      : '<div class="empty">' + (blocked
          ? 'Nothing can be filed until the migration is applied.'
          : 'Nothing filed yet. The agent runs weekly, or use Run once on its node.') + '</div>') +
    '<h3 class="intel">Where Velvex stands</h3>' +
    '<p class="cadence-hint">What you have told the agent is true about Velvex right now. It ' +
      'outranks anything the agent reads about you on the open web, which is how a brief avoids ' +
      'reporting a stale fact about your own business back to you. Every question you answer is ' +
      'added here permanently. PUT to <code>/api/intel/position</code> to edit the standing text.</p>' +
    '<div class="actions"><button class="intel" onclick="showPosition()">Show what it knows</button></div>' +
    '<div id="position-out"></div>' +
    '<h3 class="intel">What it may watch</h3>' +
    '<p class="cadence-hint">Nothing is fetched until you have accepted it. Each week the agent ' +
      'proposes what it found, a few at a time, and every one is a separate decision in the ' +
      'queue. Accept and it gets fetched and compared against itself every run. Reject and it ' +
      'will not be proposed again for 180 days, however often it is rediscovered. A market ' +
      'moves, so a rejection expires rather than being permanent.</p>' +
    '<div class="actions"><button class="intel" onclick="showVerdicts()">Show what you have ruled on</button></div>' +
    '<div id="verdicts-out"></div>' +
    '<h3 class="intel">Currently watched</h3>' +
    '<p class="cadence-hint">The pages the agent fetches directly each cycle and compares against ' +
      'what they said last time. That comparison is the only first-hand evidence in a brief, so the ' +
      'list is worth keeping current. PUT to <code>/api/intel/watchlist</code> to change it.</p>' +
    '<div class="actions"><button class="intel" onclick="showWatchlist()">Show watchlist</button></div>' +
    '<div id="watchlist-out"></div>'
  );
}

async function showVerdicts() {
  const out = document.getElementById('verdicts-out');
  if (!out) return;
  out.innerHTML = '<div class="empty">Loading...</div>';
  const r = await api('/intel/candidates');
  const rows = r.candidates || [];
  if (!rows.length) {
    out.innerHTML = '<div class="empty">Nothing ruled on yet. The agent will start proposing ' +
      'candidates on its next run, and they arrive in the approvals queue.</div>';
    return;
  }
  out.innerHTML = rows.map(v => {
    const left = v.cooldownDaysLeft > 0
      ? v.cooldownDaysLeft + 'd left'
      : (v.verdict === 'rejected' ? 'can be proposed again' : 'watching');
    return '<div class="verdict ' + esc(v.verdict) + '">' +
      '<span class="nm">' + esc(v.name) + '</span>' +
      '<span class="badge ' + (v.verdict === 'accepted' ? 'green' : 'slate') + '">' + esc(v.verdict) + '</span>' +
      '<span class="when">' + esc(left) + '</span>' +
    '</div>';
  }).join('');
}

async function showPosition() {
  const out = document.getElementById('position-out');
  if (!out) return;
  out.innerHTML = '<div class="empty">Loading...</div>';
  const r = await api('/intel/position');
  const p = r.position || { standing: '', answers: [] };
  const answers = (p.answers || []).slice().reverse();

  out.innerHTML =
    (p.standing
      ? '<div class="rulebox" style="white-space:pre-wrap">' + esc(p.standing) + '</div>'
      : '<div class="empty">No standing statement yet. Until there is one, the agent treats ' +
        'everything it finds about Velvex as unverified and says so, rather than repeating it ' +
        'back to you as a finding.</div>') +
    (answers.length
      ? '<h3 class="intel">Questions you have answered</h3>' + answers.map(a =>
          '<div class="answered"><div class="q">' + esc(a.askedOn) + ' &middot; ' + esc(a.question) + '</div>' +
          '<div class="a">' + esc(a.answer) + '</div></div>').join('')
      : '');
}

async function showWatchlist() {
  const out = document.getElementById('watchlist-out');
  if (!out) return;
  out.innerHTML = '<div class="empty">Loading...</div>';
  const r = await api('/intel/watchlist');
  const sources = (r.watchlist && r.watchlist.sources) || [];
  out.innerHTML = sources.length
    ? '<table class="activity"><thead><tr><th>Source</th><th>Kind</th></tr></thead><tbody>' +
      sources.map(src =>
        '<tr><td><a href="' + esc(src.url) + '" target="_blank" rel="noreferrer noopener">' +
        esc(src.label) + '</a></td><td>' + esc(src.kind) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="empty">No sources watched yet. The agent still researches the category if ' +
      'web research is on, but nothing is being compared week to week.</div>';
}

async function openBrief(handle) {
  openPanel('<h2>Loading brief</h2><div class="empty">Fetching ' + esc(handle) + '...</div>');

  // Fetched every time rather than cached. A brief is revised in place by a
  // same-day re-run, and a reader showing the superseded version of a document
  // is worse than one extra request.
  const r = await api('/intel/briefs/' + encodeURIComponent(handle));
  if (r.error || !r.brief) {
    openPanel('<h2>Brief unavailable</h2><div class="empty">' + esc(r.error || 'Not found') + '</div>');
    return;
  }
  const row = r.brief;
  const brief = row.document || {};
  const base = BASE + '/api/intel/briefs/' + encodeURIComponent(handle);

  openPanel(
    '<h2>' + esc(brief.title || row.title) + '</h2>' +
    '<div class="meta">competitive intelligence · ' + esc(row.brief_date) + ' · ' +
      esc(row.gap_count || 0) + ' positioning gap' + ((row.gap_count || 0) === 1 ? '' : 's') + '</div>' +
    '<div class="actions">' +
      '<a class="dl" href="' + base + '/markdown">Download Markdown</a>' +
      '<a class="dl" href="' + base + '/page" target="_blank" rel="noreferrer">Open as a page</a>' +
      '<button onclick="openLibrary()">Back to the library</button>' +
    '</div>' +
    renderBriefBody(brief)
  );
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
  const [status, approvals, reports, schedules, runtime, briefs] = await Promise.all([
    api('/status'),
    api('/approvals?status=pending'),
    api('/reports?limit=100'),
    api('/schedules'),
    api('/runtime'),
    api('/intel/briefs?limit=60'),
  ]);
  STATUS = status || {};
  AGENTS = status.agents || [];
  APPROVALS = approvals.approvals || [];
  REPORTS = reports.reports || [];
  SCHEDULES = schedules.schedules || {};
  RUNTIME = runtime.runtime || {};
  BRIEFS = briefs.briefs || [];
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
