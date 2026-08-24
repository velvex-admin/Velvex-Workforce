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

A single Cloudflare Worker running 15 agents against a Supabase database. No
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

## 5. The 15 agents

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
| Site-Integrity | executive | *none* | — | hourly |
| Growth-Strategy | executive | Opus 5 | max | weekly |
| Competitive Intelligence | **intelligence** | Opus 5 | high → max | weekly |
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
- **Every wire on the dashboard was invisible, and had been from the start.**
  `.canvas-inner` holds only absolutely positioned children, so it collapsed to
  0x0, and the wires SVG inside it inherits that through `inset:0`. Every ECG
  line and every membership link was being written into the DOM correctly and
  then clipped away to nothing. It is invisible to a typecheck, and invisible to
  any test that only asserts the paths exist. `renderWires()` now measures the
  real extent of the rendered sections and nodes and sizes the canvas to it, and
  `test/dashboard-script.test.ts` asserts that it does. Related: wires are drawn
  to `dotCentre()`, not `nodeCentre()` — a `.node` is the dot plus its label,
  cadence and live thought, so its box centre sits well below the dot and lines
  drawn to it visibly miss.

- **The dashboard is a template literal, so its browser code is escaped twice.**
  A `\'` written inside that literal emits a bare `'` and closes the surrounding
  JavaScript string early; the page then dies on the first line the browser
  parses and the canvas is simply blank. It compiles, it typechecks, it ships.
  `test/dashboard-script.test.ts` parses the emitted script with `new Function`,
  which is what catches it. Write `\\'` when the browser needs `\'`.

- **A backtick inside a prompt template literal closes it.** The agent prompts
  are template literals, so a stray `` ` `` around a field name ends the string
  early and the file stops compiling. Cheaper than the dashboard version of this
  trap because `tsc` catches it, but it is the same mistake: write prompts in
  plain prose and quote field names with ordinary quotes.

- **Server tools and structured output are kept in separate calls.** Not a
  discovered trap so much as a refusal to discover one: the intelligence agent
  researches with web tools and no schema, then composes with a schema and no
  tools. Given `maxItems` once 400'd every strategist before the model ran, the
  combination is not worth testing in production.

- **A server-tool turn can stop with `stop_reason: "pause_turn"`.** HTTP 200, no
  error, no warning, and an answer that just stops partway. `complete()` in
  `src/lib/claude.ts` resumes it by re-sending with the paused assistant turn
  appended, up to 4 times, and sets `truncated` if it is still paused after
  that. Never append a "Continue" message: the API sees the trailing
  `server_tool_use` block and resumes on its own, and the word would become part
  of the conversation.

- **A failed web search returns an object where a successful one returns an
  array.** Both arrive as HTTP 200 inside a `web_search_tool_result` block.
  Anything reading `.content` has to check which it got; indexing the error
  object yields nothing and hides the failure.

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
Claude session fail with 403. **This is a plan limitation, not a
misconfiguration:** the owner is on Claude Pro, and write access to a repository
requires an organisation or enterprise subscription. Do not spend a session
retrying it, and do not send the owner to the GitHub App install page as though
it were fixable there. Confirmed dead ends, all returning 403 on write while
reads succeed: `git push`, `add_repo` with `access: "push"`, and the GitHub MCP
write tools (`create_branch` returns `Resource not accessible by integration`).

**The owner pushes from their own Chromebook terminal.** Getting the code there
is the real problem, and the cause was found on 2026-08-24: **ChromeOS and the
Linux container have separate filesystems.** A file downloaded in Chrome lands in
the ChromeOS "My files → Downloads", which the Linux container cannot see, so
`~/Downloads` inside Linux is a different and empty folder. That is the whole
explanation for years of "downloads never appear".

The fix, once, in the ChromeOS **Files** app: right-click **Downloads** →
**Share with Linux**. It then appears in the container at
`/mnt/chromeos/MyFiles/Downloads/`. Dragging a file into **Linux files** instead
copies it to `~/`. Either works; they are different paths, so say which one you
mean.

A verified transfer then looks like this, and note that Chrome may put the file
in a subfolder, so find it rather than assuming the path:

```
BUNDLE=$(find /mnt/chromeos/MyFiles/Downloads -name '*.bundle' -print -quit)
md5sum "$BUNDLE"                 # must match what the session reported
cd ~/Velvex-Workforce
git fetch "$BUNDLE" HEAD:<branch>
git checkout <branch> && npx tsc --noEmit && npx vitest run
git push -u origin <branch>
```

`git bundle` is the right artifact: it carries real commits with their history
and message, it verifies with `git bundle verify`, and a corrupted one fails
loudly instead of applying badly. Hand-transcribed base64 in chat **corrupts** —
do not try it.

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
npx vitest run            # 281 tests
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
    intel.ts            the brief document, its schema, and page diffing
  agents/
    registry.ts         the roster; runDue() honours schedule overrides
    marketing/          content, channel-agent (shared strategist factory),
                        x, linkedin, facebook, seo-site, analytics,
                        social-engagement
    sales/              lead-pipeline, objection-faq
    executive/          finance-watch, ops-health, site-integrity,
                        growth-strategy
    intelligence/       competitive-intel
    orchestration/      chief-of-staff (Coordinator + an agent)
  connectors/           facebook, x (OAuth 1.0a), linkedin (queue), site
  routes/               api.ts, integrations.ts
  ui/dashboard.ts       the canvas dashboard
db/migrations/          0001_orchestration_layer.sql
                        0002_intelligence_layer.sql
db/seeds/               intel-candidates.json (verified; proposed, not applied)
                        intel-position.md (draft; owner fills the blanks)
```

### Database

Four tables: `reports` (audit trail), `memory` (continuity + typed state),
`pending_approvals` (the queue), and `intel_briefs` (the intelligence library,
added in migration 0002). RLS is on with no policies — the Worker uses the
service role key, which bypasses it; anon keys get nothing.

The architecture doc says three tables and no more. `intel_briefs` departs from
that deliberately, and the reason is worth keeping: every agent's run pulls
`memory` rows into its prompt by salience, so a full multi-page brief stored
there would be read, and paid for, by every other agent on every tick. A brief
is a document to be retrieved on purpose, not context to be broadcast. What goes
in `memory` is a one-line pointer at `intel.latest_brief`.

---

## 12b. The intelligence layer

The Competitive Intelligence and Category Positioning Agent is the only agent
whose subject is outside this system. Every other agent reasons over data we
already hold. This one reads the category and asks one question of it: which
position is nobody holding, and could Velvex hold it credibly.

It is observe-only and permanently so. It cannot publish, cannot edit the site,
cannot contact anyone. It writes documents and it makes a case.

### Before it can run: migration 0002

`db/migrations/0002_intelligence_layer.sql` must be applied, once, before the
agent is any use. It does two things: creates `intel_briefs`, and **drops** the
`agent_batch` CHECK constraints on `reports` and `pending_approvals` so a new
batch never needs a migration again. The vocabulary lives in
`src/core/types.ts`; duplicating it in the schema only ever produced a
constraint violation on the day somebody forgot to migrate.

```
DATABASE_URL='postgresql://...' npm run db:apply
```
or paste the file into the Supabase SQL editor.

Until it is applied the agent checks, logs `0002_intelligence_layer.sql`, and
returns without doing anything, so a missing migration costs nothing rather than
failing halfway through two Opus passes. `/api/status` reports
`intelligence.migrationApplied`, and the Library node on the dashboard says
"migration 0002" in amber rather than showing an empty shelf.

### Nothing is watched until the owner says so

The owner's read is that nothing in this market matches Velvex: scoring tools
return a number, Velvex returns a structural reading, and those are different
products. That is correct, and it decides the design. A watchlist assembled from
guesses about who competes would be a list of non-competitors, watched forever,
producing diffs nobody cares about.

So the agent **proposes** and the owner **rules**:

```
discovery finds a candidate
        ↓
queued as its own approval, with evidence and a suggested kind
        ↓
  accepted → joins intel.watchlist, fetched and diffed every run from then on
  rejected → suppressed for 180 days, however often it is rediscovered
```

`REJECTION_COOLDOWN_DAYS` is 180 and the expiry is deliberate: "not a
competitor" is a statement about now, not about always. The clock is dated from
**when the owner decided**, not from when the agent noticed, so a rejection made
two months ago has two months less to run rather than restarting.

Rejecting an approval does not run the agent, so a rejection would leave no
trace and the same candidate would come back next Monday. `absorbRejections()`
reads the agent's own rejected proposals at the start of each run and records
the verdicts itself. That is why there is no reject hook on the runner:
rejection stays free of side effects everywhere else in the system, which is
worth more than the week of delay.

`candidateIsOpen()` blocks three cases: already watched, already accepted, still
in cooldown. It matches on a normalised URL as well as on the name, because
discovery re-finds the same page every week and describes it differently each
time.

**The shipped batch.** `db/seeds/intel-candidates.json` is ten researched,
verified candidates, compiled into the Worker and proposed **four per run**,
highest signal first. They are not a watchlist: nothing there is fetched until
it is accepted. Order matters, because the batch drains a few a week: the one
real competitor is first, then the pages where category language hardens, then
buyer vocabulary.

### How one run works

Four stages, and the order matters:

1. **Watchlist fetch and diff. No model.** Every accepted source is fetched,
   reduced to visible text, and compared against the snapshot stored at
   `intel.source_snapshots`. This is the only first-hand evidence in a brief:
   "their language moved" is a comparison against what the page actually said
   last week, not the model's impression of it. The diff is set-based on
   sentences, so a page that reorders its sections has not changed; script and
   style bodies are dropped, so a changed analytics snippet is not a competitor
   changing their message.
2. **Research pass.** Opus 5 at effort `high`, **with** the web tools and **no**
   output schema. It searches, reads pages, and returns notes plus the list of
   URLs it actually retrieved.
3. **Discovery and triage.** Opus 5 at effort `medium`, **with** a schema and
   **no** tools. It does two things the expensive pass should not be paid for:
   proposes candidates, and decides whether the week was material at all.
4. **Composing pass.** Opus 5 at effort `max`, **with** the schema and **no**
   tools. Only reached if the week was material.

**A quiet week writes no brief.** If nothing on the watchlist moved, no
candidate is pending, and triage says the category did not shift, the run stops
after stage 3 and files one observation carrying the triage's own sentence. A
brief every week regardless of what happened is how a library stops meaning
anything, and the expensive pass is never paid for on a week with nothing in it.

With web research off and nothing watched, **no model runs at all**: the pending
candidates are put to the owner directly, because deciding them is what unblocks
the agent.

Keeping 2 and 4 apart is deliberate. Structured output and server-side tools are
not built to interact and this repo has already lost an agent's entire output to
a schema the API rejected before the model ran. A composing call that cannot
search cannot quietly fill an evidence gap with a search it forgets to cite. And
the expensive half can be re-run without paying for the research again.

### The evidence standard

Every finding in a brief is tagged `observed`, `inferred` or `assumption`. That
is the same standard Velvex applies to a client Ledger, turned on Velvex's own
intelligence, and it is a required field in `BRIEF_SCHEMA` rather than an
optional flourish. The prompts are emphatic that a company, price or claim that
is not in the retrieved notes does not go in the brief: a fabricated competitor
would put a real decision in front of the owner based on nothing.

### What reaches the approvals queue

Candidates, and exactly one move per brief.

Each candidate is its own decision, capped at four a run for the same reason a
brief carries one move: a queue arriving with ten maybes is a queue nobody
finishes.

Beyond candidates, exactly one thing per brief. A brief can carry four positioning gaps and four
differentiation signals; all eight arriving in the queue every week would bury
it, and a queue nobody finishes reading is how a two-day X publishing outage sat
unnoticed between six growth ideas once already. `topMove()` picks the single
highest-value move — a gap outranks a reinforcement, and observed outranks
inferred — and the rest stay in the document. The brief itself is routine and
files without asking. Watchlist movement is one routine observation.

An approved move is written to `memory` at salience 9 under `positioning.<date>`,
which is how it reaches the writing agents' context. Nothing publishes it.

### The loop back: what the owner tells it

The agent reads the open web, and the open web is stale about a young company.
Left alone it will find that a framework was unvalidated, that a price was
different, that a claim had not been made yet, and report those as observed
facts, because on the page it read they are. A brief that tells the owner
something false about their own business has spent their attention to do it.

Two mechanisms fix that, and together they are the second half of the agent.

**`intel.position`** is the owner's standing statement of what is true about
Velvex now, and it **outranks anything the agent reads about Velvex on the web**.
Not "weigh this too": where the two conflict, the page is stale and the brief
says so. `positionContext()` in `src/core/intel.ts` is what frames it that way,
and both prompts repeat it. With nothing on file the agent is told to treat
everything it finds about Velvex as unverified rather than repeating it back.

```
PUT /x/<APP_PATH_SECRET>/api/intel/position
{ "standing": "The Vela framework was validated against completed engagements in June 2026. ..." }
```

A PUT replaces the prose and **keeps** the answered questions; they are a record
of a conversation, not draft text.

**One question per brief.** `openQuestion` is the single thing the agent could
not establish from outside that the owner could settle in a few sentences. It is
nullable on purpose: a cycle with nothing worth asking asks nothing, because a
question asked to fill the field teaches the owner to skip the field.

Answering closes the loop:

```
POST /x/<APP_PATH_SECRET>/api/intel/answer
{ "briefDate": "2026-08-24", "answer": "..." }
```

Three things happen, in this order:

1. The answer is appended to `intel.position` **first**. If the next step fails,
   what the owner said is still kept: losing it to a model error would be the
   worst outcome and the easy one to get wrong.
2. `assessAnswer()` runs one Opus call at effort `medium` and says what the
   answer changes, including whether the brief was wrong.
3. That assessment is **queued**, not executed. The owner approves it (it becomes
   a positioning note at salience 9, which is how it reaches the writing agents)
   or rejects it. Nothing publishes either way.

On the dashboard this is the amber card at the top of a brief, with the answer
box, and "Show what it knows" under the Library panel's position section.

Note the memory key: `positioning.<date>.<kind>`. A brief's top move and an
answer assessment are both recommendations and can both be approved on the same
day; memory keys are unique, so a date alone would let one silently overwrite
the other.

### The library

`intel_briefs`, one row per cycle, keyed on `brief_date` so a re-run revises that
day's brief instead of filing a near-duplicate beside it. The whole structured
document is stored in `document`, so a brief read a year from now is the brief
that was written rather than a reconstruction.

| Route | What it gives you |
|---|---|
| `GET /api/intel/briefs` | the index (no documents, so the list stays cheap) |
| `GET /api/intel/briefs/:handle` | one brief, whole |
| `GET /api/intel/briefs/:handle/markdown` | the same brief as a `.md` download |
| `GET /api/intel/briefs/:handle/page` | the same brief as a standalone page |
| `GET|PUT /api/intel/watchlist` | what is watched, validated on write |
| `GET /api/intel/candidates` | what has been ruled on, and cooldown remaining |

`:handle` is the brief's uuid or the date it covers. On the dashboard the
Library is the cyan node to the right of the Intelligence section, fed by an
animated cyan ECG line from the agent, and it is the one line on the canvas that
runs away from the Chief-of-Staff rather than into it.

### The watchlist, once things are on it

```
PUT /x/<APP_PATH_SECRET>/api/intel/watchlist
{ "sources": [
    { "id": "rival-home", "label": "Rival — homepage",
      "url": "https://rival.example/", "kind": "competitor" }
] }
```

That endpoint still exists for direct control, and the validator rejects with a
list of problems rather than storing something that would fail weekly inside an
agent run. But the normal path is not this: it is accepting a candidate, which
writes the same entry and records the verdict in one step. Twelve sources are
fetched per run.

`kind` is one of `competitor`, `category`, `adjacent_tooling`, `buyer_language`,
and the kinds are not a formality. You do not watch a company because it matches
you today. You watch it because it is where a match would first appear, and the
first sign is always the language moving before the product does. A scoring tool
that starts saying "dependency" and "load bearing" has told you something a year
before it could deliver it.

Every URL in the shipped batch was fetched with the agent's own User-Agent and
run through its own `extractText()` before being added. That check matters more
than it sounds: three obvious candidates were rejected because they refuse us.
SCOREMAX (`getscoremax.com`) and SCORE.org both return 403, and Hello Alice's
Business Health Score returns 429. A source that cannot be fetched is worse than
no source, because it reports "unreachable" every week forever and teaches you
to stop reading the column. They are in `_rejected` with the reason so nobody
re-adds them without checking.

`test/intel-candidate-seed.test.ts` validates the file as data, but deliberately
does **not** check that the URLs still resolve: that is a network fact which
changes without anyone touching this repo, and a suite that goes red because a
competitor had an outage is a suite people stop believing.

The closest thing to a real competitor found so far is **Lumena Global's
Operational Readiness Assessment**, and it is worth knowing why it is close and
why it is not the same product. It makes the identical rhetorical move ("Strategy
tells you where to go. An operational readiness assessment tells you whether the
current version of your business can get there"), but its seven pillars are
operating-model and org design rather than commercial architecture, it runs two
to four weeks against Velvex's 24 hours, and it publishes no price. Watch it for
movement on any of those three.

### Seeding the position statement

`db/seeds/intel-position.md` is the draft to send to `intel.position`. The half
drawn from `src/core/business.ts` and `src/core/config.ts` is filled in; the half
only the owner can answer is left blank on purpose and **must stay that way until
they answer it**. A guessed entry there does not stay a guess: `intel.position`
outranks the public record, so a wrong line in it is worse than an empty file.

The agent works with an empty watchlist as long as `INTEL_WEB_RESEARCH_ENABLED`
is true; it just has no week-on-week comparison until something is accepted.

### Web research is a spend switch, not a credential

`INTEL_WEB_RESEARCH_ENABLED` in `wrangler.toml`, currently `"true"`. Web search
runs server side on the model call, so there is nothing to set up. Searches bill
at $10 per 1,000 on top of the tokens their results consume, and the agent caps
itself at 8 searches and 5 fetches per weekly run: a few cents a month. Off, it
works from the watchlist alone and says so in the brief's limitations.

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
- ~~**Competitive intelligence**~~ — this was the deferred one, and it is now
  built. See section 12b. The condition for building it was "until
  Growth-Strategy actually raises a question it would answer", and the way that
  condition is honoured is that the two run on the same Monday tick, with
  intelligence first, and Growth-Strategy reads the newest brief's headline and
  gaps as part of its own context.

The only ones with a clear case, if volume justifies them later: an **Intake
Auditor** (validates Tally submissions before they reach the owner) and a
**Distribution / Ledger Delivery** agent (worth it past ~4 clients/month).
