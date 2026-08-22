# VX-03 — Velvex Internal Operations Layer

This file is loaded automatically at the start of every Claude Code session in
this repo. It is the project's memory. If you are a fresh session with no prior
context, read this first — it tells you what this system is, what has already
been decided, and which mistakes have already been made and fixed.

Keep it current. When a decision is made or a trap is discovered, write it here.

---

## 1. The business this serves

Velvex sells a **commercial architecture diagnostic**. It is positioned as an
institutional-grade, third-party diagnostic standard — not a consultancy, not
coaching, not an agency. Register matters: it is a *standard*, and the writing
should read like one.

- **Deliverable:** an Executive Ledger, delivered within 24 hours, plus a
  structured follow-up at 30, 90 and 180 days, with a money-back guarantee.
- **Price:** introductory **$149 for the first 10 clients only**, then the
  standing **$999** per engagement.
  - Both numbers live in `src/core/business.ts` as `introPriceUsd` /
    `introSeats` / `priceUsd`, and reach every writing agent through
    `BUSINESS_CONTEXT`.
  - Agents must never quote only one of the two. The approved phrasing states
    the intro rate, states that it is capped at the first 10 clients, and
    offers to confirm whether seats remain rather than committing either way.
- **Live site:** https://velvex-site.netlify.app/
  - `/faq` on that site is a **pricing page**, which is why it is in
    `PROTECTED_PAGE_PATTERNS` in `src/core/config.ts`. The SEO agent may not
    edit it unattended.

---

## 2. What VX-03 is

A single Cloudflare Worker running 13 agents against a Supabase database. No
framework, no agent library, no SDK for Supabase — plain `fetch` against
PostgREST, and a thin wrapper around the Anthropic Messages API.

**Repo:** `velvex-admin/Velvex-Workforce`
**Working branch:** `claude/vx03-operations-layer-7rq5ya`
**Live Worker:** `https://velvex-vx03.a99339744.workers.dev`
**Cloudflare account id:** `cb58bfa682b8997a987de0637c7a69bc`
**Supabase project ref:** `ttwudgdwusorwscegtnz`

The dashboard lives at `/x/<APP_PATH_SECRET>/`. There is **no authentication** —
access control is an unguessable URL, by explicit decision. The single choke
point for adding real auth later is `authorize()` in `src/index.ts`; nothing
else in the codebase decides who may call it.

---

## 3. Hard constraints (owner-stated, do not violate)

- **Only work in this repo.** Do not touch the `operations-pipeline` repo, its
  database, or any Phase 0 infrastructure. Separate project.
- **Do not touch the owner's other Cloudflare Workers.** This account hosts
  another workflow that is not ours.
- Outreach (Apollo, Clay) belongs to the Phase 0 pipeline. Do not build
  outreach agents here — it would create two systems with different memories of
  who has been contacted.

---

## 4. The autonomy model — the core idea

Every agent **proposes**; it never acts directly. A proposal is classified
before anything runs:

```
Agent proposes an action
        ↓
Autonomy boundary classifies it
        ↓
  routine?  → executes now, logged to `reports`
  new/risky? → queued to `pending_approvals`, waits for the owner
```

Evaluation order in `src/core/autonomy.ts` is deliberate:

1. **Approval rules run first and act as vetoes.** If any fires, the action is
   queued, full stop.
2. **Routine rules are allowances.** Only checked if no veto fired.
3. **Unmatched → queued.** Default deny.
4. **A judgement call that fails → queued.** Uncertainty escalates.

General vetoes apply to every agent: spend, irreversibility, a new channel,
pricing changes, and anything new-by-type.

No agent module calls a connector directly. That is what keeps the
routine/needs-approval line real rather than a comment.

---

## 5. The 13 agents

| Agent | Batch | Model | Effort | Cadence |
|---|---|---|---|---|
| Content | marketing | Opus 5 | xhigh | daily |
| X Strategist | marketing | Opus 5 | xhigh | hourly |
| LinkedIn Strategist | marketing | Opus 5 | xhigh | hourly |
| Facebook Strategist | marketing | Opus 5 | xhigh | hourly *(dormant)* |
| SEO / Site | marketing | Sonnet 5 (+ Haiku 4.5 for alt text) | high | daily |
| Marketing Analytics | marketing | Sonnet 5 | medium | daily |
| Social Engagement | marketing | Haiku → Sonnet → Opus 5 | xhigh | hourly |
| Lead / Pipeline | sales | *none* | — | daily |
| Objection / FAQ | sales | Sonnet 5 | high | manual |
| Finance-Watch | executive | Sonnet 5 | medium | daily |
| Ops-Health | executive | *none* | — | hourly |
| Growth-Strategy | executive | Opus 5 | max | weekly |
| Chief-of-Staff | orchestration | Opus 5 | high | daily |

### Why the models differ

The owner was explicit: *"Not every agent with the best model is the right way,
as that would be an unnecessarily high cost."* Three tiers in
`src/core/models.ts`, resolved from `wrangler.toml` vars:

- **reasoning** (Opus 5) — writes public copy, or makes judgement calls with
  real consequences.
- **balanced** (Sonnet 5) — classification, summarisation, matching against an
  approved library.
- **fast** (Haiku 4.5) — cheap high-volume filtering, e.g. spam triage before
  an expensive judge call, and alt text.
- **null** — no model at all. Timing, threshold checks and stall arithmetic are
  deterministic and should not cost a token.

Rationale per agent is in `docs/MODEL-CHOICES.md`.

---

## 6. Channel strategists

Originally the architecture doc had channel agents doing only "timing and
publishing of already-approved content". **The owner widened this deliberately:**
each channel now owns its platform end to end.

Every run, a strategist:

1. Reads its **own** past posts from `reports` plus memory tagged for that channel.
2. Drafts one **platform-native** post — X and LinkedIn have different register
   guides in their respective files.
3. Proposes **0–3 growth ideas**, which *always* queue for approval by design.
4. Publishes a ready draft **only if a scheduled slot is due**.

Drafts carry `channelHint`, so a LinkedIn draft never publishes on X. The shared
Content Agent still exists for cross-channel copy and leaves `channelHint`
unset, meaning any channel may take it.

**Learning ≠ copying.** The prompt explicitly instructs the model to notice what
landed and what stalled, deliberately break the pattern when recent posts all
opened the same way, and rewrite any draft that could sit unnoticed inside the
recent list. The owner cares about this: creativity is the point.

### LinkedIn was originally an external build

The architecture doc had an outside company delivering it. The owner overrode
that — we own the strategist. Publishing still routes through the partner queue
(`route: "linkedin-partner-queue"`) because we hold no LinkedIn API credentials.
Switching to direct posting later means deleting that one option.

### Facebook is dormant

The owner has no Facebook page. The agent returns `[]` on every tick until
`FACEBOOK_ENABLED="true"`. Full logic and connector are already built.

---

## 7. Scheduling — three concepts people confuse

**Cron** (`wrangler.toml`) is the engine. Three schedules only:

| Cron | Fires |
|---|---|
| `0 * * * *` | hourly, on the hour |
| `0 7 * * *` | 07:00 UTC daily |
| `0 8 * * 1` | 08:00 UTC Mondays |

**Cadence** is per agent — which tick wakes it. This is what the hourly/daily/
weekly label on a dashboard node means.

**The weekly plan** (`src/core/schedule.ts`) decides when posts actually go out.
Three slots per week per channel, chosen by a PRNG seeded on
`(channel + ISO week)`:

- Deterministic **within** a week, so worker restarts and re-runs never reshuffle
  a week that is half-published.
- Different **between** weeks, so nothing lands on a repeating on-the-hour
  pattern that reads as automated. The owner asked for this specifically.
- Windows target English-speaking audiences: X and Facebook Mon–Fri 12:00–21:00
  UTC; LinkedIn Tue–Thu 13:00–21:00 UTC.

**So: a strategist wakes hourly but posts 3× a week.** Waking keeps the draft
shelf stocked (target 3 ready); the weekly plan gates publishing. "Run once" on
the dashboard fires one wake-up immediately but will *not* publish early — it
still checks whether a slot is genuinely due.

Cadence can be overridden per agent from the dashboard
(`hourly`/`daily`/`weekly`/`paused`/`default`). Overrides persist in the memory
table under `control.agent_schedules` and take effect with no redeploy.

---

## 8. The dashboard

`src/ui/dashboard.ts` — one file, ~860 lines, served by the Worker. A pan/zoom
canvas, not a scrolling page, because the system is a network rather than a
workflow. The owner asked for this shape explicitly.

- Chief-of-Staff sits on the left with two sub-nodes: **Completed** and
  **Pending**. Animated ECG lines run from each section into it.
- Marketing / Sales / Executive sections on the right hold their agent dots.
- Click a node → side panel with rules, recent activity, Run once, cadence
  override buttons.
- Drag pans, wheel zooms, Escape closes the panel.

**Live thought trails:** the runner wraps `ctx.log` and writes a status board to
memory at `runtime.agent_status` — status, phase, latest thought, and a rolling
trail of the last 12 lines. A running agent shows an amber pulsing ring and its
phase; the panel shows a live spinner and the trail. When idle, the panel shows
the previous run's trail. The page polls every 3s while anything is running,
60s otherwise.

---

## 9. Deployment — and the trap that cost hours

**`wrangler.toml` is the source of truth for variables.** Every
`npx wrangler deploy` overwrites whatever the Cloudflare dashboard says.

> **Never set variables in the Cloudflare web dashboard.** They get silently
> stamped back on the next deploy. This exact loop wasted a long debugging
> session with `X_ENABLED`. Edit the file, deploy, commit.

Secrets are the opposite — they live only in `wrangler secret put` and never in
the file.

### Secret names (values are NOT stored in this repo)

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | all model calls |
| `SUPABASE_SERVICE_ROLE_KEY` | database access (bypasses RLS) |
| `APP_PATH_SECRET` | the unguessable dashboard path segment |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | X publishing — **all four are set** |
| `LINKEDIN_PARTNER_TOKEN` | not yet supplied |
| `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` | not yet supplied |

To check what the live Worker actually believes, call
`GET /x/<APP_PATH_SECRET>/api/status` and read `connectors[].missing`. That is
authoritative; the dashboard UI is not.

### Cloudflare Workers Builds is a red herring

If the Cloudflare dashboard shows a failing build complaining about
`npm install`, `allow-scripts`, or a **missing `index.js`** — ignore it. That is
Cloudflare's server-side builder trying to build the repo itself. It looks for a
plain JS entry point; our entry is `src/index.ts`, compiled by wrangler at
deploy time. It has never been the path that deploys this Worker and its
failures never touch the running Worker. The build configuration can be deleted
outright.

---

## 10. Traps already hit — do not rediscover these

- **Haiku 4.5 rejects `thinking` and `effort`.** Sending either returns 400.
  `buildRequest()` in `src/lib/claude.ts` is capability-aware and omits them per
  model. Check `MODEL_CAPABILITIES` before adding a parameter.
- **Structured-output schemas reject array length constraints.** `maxItems` on
  an array returns
  `output_config.format.schema: For 'array' type, property 'maxItems' is not supported`.
  This silently broke *every* channel strategist's drafting call — 400 before
  the model ran, so zero cost and zero output, surfacing only as a logged error.
  `test/schema-constraints.test.ts` walks the real exported schema objects and
  fails the build on `maxItems`, `minItems`, `uniqueItems`,
  `patternProperties`. Enforce array caps in the prompt and in code instead.
  **When you add a new structured-output schema anywhere, export it and add it
  to `SCHEMAS` in that test** — otherwise it is not covered.
- **The em-dash question.** The architecture doc bans them; the live site uses
  them. Implemented as `allowEmDash` in `src/core/voice.ts`, currently `false`
  per the doc. Flip the toggle, do not scatter exceptions.
- **`/faq` is a pricing page.** Protected from unattended SEO edits.
- **X free tier posts but does not read.** `POST /2/tweets` is included; the
  read endpoints Social Engagement needs (`/2/users/me`, `/2/users/:id/mentions`)
  return `402 credits-depleted` until a paid tier is active. That is a billing
  state, not a fault. `gather()` in `social-engagement.ts` treats 401/402/403
  as "skip this channel and carry on" and records an observation so the state
  is visible; every other status still fails loudly. Read access is roughly
  $200/month, so it is a volume decision, not a setup step.

---

## 10a. The site, and why we hold its source

The site is a Netlify **file deploy** — no repo, no build command — so the SEO
agent publishes through Netlify's digest deploy: a manifest of every path with
its SHA1, then upload whatever Netlify does not already hold. A file missing
from the manifest is deleted, so the manifest always carries every file.

**The source of truth is ours, not Netlify's.** The obvious design — read the
page from Netlify, edit, put it back — does not work:

- Netlify's file endpoints return metadata, not content, under every Accept
  header tried (`application/vnd.bitballoon.v1.raw`, `text/plain`, none), on
  both the site and deploy routes.
- The served page differs from the stored digest by ~10 bytes, cause not
  visible from outside. Editing a page we cannot read byte-exactly is how a
  live site quietly rots over repeated deploys.

So `site.source` in the memory table holds path → content, seeded from the
folder that gets dragged into Netlify. The agent edits that, deploys the whole
set, writes it back. Nothing is read back from Netlify, so nothing can drift.

Seed it with `scripts/seed-site-source.mjs <folder> <worker-base>`, and re-run
that whenever the site is edited by hand, or the agent's copy falls behind.

`applyEdit()` refuses more readily than it writes: the page must be in the
source, `before` must be non-empty and match exactly once (zero means stale,
more than one means ambiguous), the result must differ, and an edit that would
cut a page below half its size is rejected as a rewrite rather than a fix. A
refused edit is still recorded — it says the page moved under us, which is
worth knowing.

**The empty-anchor failure — do not reintroduce it.** `applyEdit()` originally
read `edit.before ? current.replace(...) : edit.after`. The SEO agent expresses
"this page needs a meta description and has none" as `before: ""`, so that
ternary replaced the entire file with the description. A 22kB page went live as
134 bytes. Two things caused it: the writer had a whole-file-replacement branch
that no edit in this path ever legitimately needs, and nothing translated the
agent's semantic finding into a textual substitution.

`src/core/site-edits.ts` is that translation — `metaDescriptionEdit()` anchors
on `</title>` when no description exists, `altTextEdit()` anchors on the whole
`<img>` tag — and both return null rather than guess when no unambiguous anchor
exists. The tests that passed before the incident used a hand-written non-empty
anchor, so they exercised the mechanism as imagined rather than the input the
agent actually produces. When testing an agent's output path, construct the
input the agent really emits.

## 11. Getting code onto the owner's machine

The Claude GitHub App has **read-only** access to this repo, so pushes from a
Claude session fail with 403. The owner pushes from their own Chromebook
terminal. File downloads to that machine have repeatedly failed to appear on the
Linux filesystem, and hand-transcribed base64 in chat **corrupts** — do not try
it.

**The reliable route** (verified byte-perfect with md5):

1. From the session, POST the payload into the Supabase `memory` table under a
   `transfer.*` key, with the base64 in `detail.value`.
2. The owner pulls it through their own Worker:
   ```
   curl -s "<worker>/x/<APP_PATH_SECRET>/api/state/transfer.<key>" \
     | python3 -c "import sys,json,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)['value']))" \
     > /tmp/x.tar.gz
   md5sum /tmp/x.tar.gz     # verify before extracting
   ```
3. `tar xzf`, test, commit, push, deploy.
4. **Delete the transfer row afterward.**

Outbound HTTPS from the session works — Supabase and the Worker are both
reachable.

---

## 12. Working on this repo

```bash
npx tsc --noEmit          # typecheck
npx vitest run            # 94 tests
npx wrangler deploy       # deploy (also: verify vars in the output)
```

Both must pass before deploying. The tests encode real decisions — an autonomy
rule change that breaks `test/autonomy.test.ts` is a behaviour change, not a
test problem.

### File map

```
src/
  index.ts              Worker entry; authorize() is THE auth choke point
  env.ts                env typing + readiness()
  core/
    types.ts            ProposedAction and the shared vocabulary
    models.ts           three model tiers + per-model capabilities
    business.ts         what Velvex is; pricing; BUSINESS_CONTEXT
    voice.ts            voice profile + mechanical AI-tell detection
    config.ts           content pillars, FAQ library, protected pages
    autonomy.ts         evaluate(): vetoes → routines → default deny
    agent.ts            AgentDefinition + the run loop + status board
    schedule.ts         weekly jittered posting plan
    state.ts            typed views over the memory table
  agents/
    registry.ts         the roster; runDue() honours schedule overrides
    marketing/          content, channel-agent (shared strategist factory),
                        x, linkedin, facebook, seo-site, analytics,
                        social-engagement
    sales/              lead-pipeline, objection-faq
    executive/          finance-watch, ops-health, growth-strategy
    orchestration/      chief-of-staff (Coordinator + an agent)
  connectors/           facebook, x (OAuth 1.0a), linkedin (queue), site
  routes/               api.ts, integrations.ts
  ui/dashboard.ts       the canvas dashboard
db/migrations/          0001_orchestration_layer.sql
```

### Database

Three tables: `reports` (audit trail), `memory` (continuity + typed state),
`pending_approvals` (the queue). RLS is on with no policies — the Worker uses
the service role key, which bypasses it; anon keys get nothing.

---

## 12a. RIGHT NOW — the open thread (delete this section once done)

Everything else in this file is durable. This section is not: it is the state of
one unfinished piece of work, and should be removed when it is finished.

**The SEO agent is PAUSED.** It is set to `paused` in `control.agent_schedules`,
so no cron tick wakes it. That was deliberate: it published a whole-page
replacement over `/proof-of-concept.html` on its first real run — see the
empty-anchor failure in section 10a — and the pause stopped the daily tick from
repeating it. **Do not resume it on a schedule until the run below has been
done once, manually, and checked.**

The site was restored from backup and verified byte-identical. It is healthy.
A copy of the good source is in the memory table under `site.source.backup`,
separate from the live `site.source`.

**The owner's decision:** run the SEO agent once, by hand, with Claude watching
and ready to restore. Not back on cron. That is the right instinct and it should
be respected — the failure above is exactly why.

What that run should look like:

1. Confirm the fix is deployed. `src/core/site-edits.ts` must exist and
   `applyEdit()` in `src/connectors/netlify.ts` must refuse an empty `before`.
2. Snapshot the current source first, the way it was done last time: read
   `/api/state/site.source`, keep it, and write it to `site.source.backup`.
3. Trigger one run: `POST /api/run/seo_site`.
4. Immediately fetch every page and check byte sizes against the snapshot. A
   page that shrank is the failure recurring — restore at once.
5. Only if all pages are intact, consider whether it goes back on a cadence.

Two proposals are already queued for `/faq.html` — a meta description and an
internal link. That page is the pricing page and is protected, so they will
never auto-apply. One of them quotes "$999" without the $149 intro rate, which
is the phrasing problem described in section 1. Read them before approving.

## 13. Deliberately not built

The owner reviewed a list of candidate agents and declined most. Do not
re-propose these without being asked:

- **Referral / partnership outreach** — belongs to Apollo/Clay in Phase 0.
  Building it here creates two systems with conflicting contact histories.
- **Case-note extractor** — duplicates the Content Agent's pillars.
- **Voice-note ingester** — that is a webhook into `/api/state/<key>`, not an
  agent. No autonomy boundary, no proposals, nothing to supervise.
- **Competitive intelligence** — deferred until Growth-Strategy actually raises
  a question it would answer.

The only ones with a clear case, if volume justifies them later: an **Intake
Auditor** (validates Tally submissions before they reach the owner) and a
**Distribution / Ledger Delivery** agent (worth it past ~4 clients/month).
