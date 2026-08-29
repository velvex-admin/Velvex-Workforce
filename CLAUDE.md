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
**Branch of record:** `claude/vx03-operations-layer-7rq5ya` — this is the branch
on the owner's machine, the one that gets tested and deployed. A Claude session
is assigned its own scratch branch name each time and pushes fail with 403
regardless (section 11), so that name never matters: what matters is that work
reaches `claude/vx03-operations-layer-7rq5ya` locally, by bundle. Note that
`origin` is far behind it and always will be, so never resolve a question about
"current state" by reading origin.
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
| Competitive Intelligence | **intelligence** | Sonnet 5 scan → Opus 5 | high | monthly |
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
| `0 8 1 * *` | 08:00 UTC on the 1st — **monthly**, where intelligence now runs |
| `0 8 * * 1` | 08:00 UTC Mondays — weekly, **intelligence only** if set back to weekly |
| `0 9 * * 1` | 09:00 UTC Mondays — weekly, **everything else** |

**The weekly cadence runs on two ticks, and that is not cosmetic.** A cron
invocation gets 15 minutes of wall clock for *everything it runs*, and `runDue()`
is a sequential loop. Competitive Intelligence measured **10m03s**, which left
Growth-Strategy under five minutes — and it would not have failed loudly, because
a killed agent leaves a `running` status row rather than an error. So
`runDue(cadence, ctx, filter)` takes a `BatchFilter`, and `scheduled()` routes
`0 8 * * 1` to `{ only: ["intelligence"] }` and `0 9 * * 1` to
`{ except: ["intelligence"] }`. Intelligence still goes first, so Growth-Strategy
reads the brief written for it an hour earlier. `test/weekly-split.test.ts`
asserts the two ticks are a **partition** of the weekly agents — drop one and it
silently never runs again, overlap and it runs twice and bills twice — and that
the cron strings in `wrangler.toml` still match the literals the handler matches
on, since nothing about that drift fails at build time.

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
trail of the last 12 lines. Each wrapped log flushes the board itself; it does
not just append to an array that gets written when the agent finishes. That was
the original shape and it made the trail live only for agents that finish in
seconds: Competitive Intelligence spends its entire run inside `propose()`, so
the board sat on "started" for ten minutes and a watcher could not tell that
apart from a hang. The flush is fire-and-forget because `ctx.log` is
synchronous, coalesced so a chatty agent does not buy a round trip per line, and
serialised because `writeStatus()` reads the whole status map and writes it
back — an older read landing after a newer write silently reverts it, which is
why the three terminal writes await `settleThoughts()` first. A running agent shows an amber pulsing ring and its
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
- **`src/core/business.ts` is copied from the site, and the site can be behind
  the product.** For months it carried `v0.1` and six "nodes" (Structural
  Architecture, Revenue Mechanics, Channel Dependency, Operational Capacity,
  Pressure Point Matrix, Continuity Risk) because that is what the homepage said.
  The engine had moved to **v1.0** and to VDL's **seven engines**, and
  `BUSINESS_CONTEXT` goes into the system prompt of every agent that writes
  anything — so the whole system was describing a superseded model of its own
  product in copy that reads fine and contradicts the page it links to. When the
  site changes, change this file, and check it against
  `intel.position` rather than against the site alone: the position statement is
  the thing that outranks both.

- **Site-Integrity can now put the site back on its own, and the dangerous half
  of that is the false positive.** Telling the owner their site is ruined is
  worth nothing at 3am, so `assessDamage()` decides deterministically and the
  agent restores `site.source.last_good` without waiting for approval. The rule
  is **damage, never difference**: a rewritten, retitled or restructured page is
  the owner changing their own site and must never be reverted — an agent that
  undid a redesign would destroy more than the failure it guards against. Damage
  is a page collapsed below `MIN_CREDIBLE_HTML` when the verified copy was a real
  page, a page that lost over half its body, a page that stopped being a complete
  HTML document, or a live page returning an error. HTTP status 0 is *our* network
  failing and is explicitly not damage. The restore writes `site.source` **before**
  deploying, or the next SEO run republishes what was just undone; it is capped at
  `MAX_RESTORES_PER_DAY` (2), because a restore that does not hold turns into an
  hourly deploy loop; and the restore point is promoted on **no critical
  findings**, not on a clean bill of health, since Netlify injects ~546 bytes into
  every served page and requiring zero findings would leave the net unarmed
  forever. `site_restore` is a distinct action type from `site_edit` precisely so
  the veto can keep refusing the second while allowing the first, and
  `observeOnly` now means "never writes anything NEW" rather than "never writes".

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

- **The composing pass runs at effort `high`, and that was measured.** At `max`
  it took **5m32s and $0.64 on its own**, which put a $1.25-capped run at $1.39
  and left no room in a 15-minute cron window for anything else. The full run at
  `max` was 10m03s: 4s watchlist, 4m00s research, 23s discovery, 5m32s compose.
  Raise it again only against a new measurement.

- **A Worker has a subrequest budget per invocation, and the status board can
  eat it.** `writeStatus()` reads the whole map before writing it back, so every
  status update costs **two** subrequests. Bracketing a run with three of those
  is nothing; doing it on every log line and every heartbeat is not. A ten-minute
  intelligence run spent roughly forty subrequests on the trail alone and died on
  `Too many subrequests by single Worker invocation` **one second after
  composing its brief** — the brief was filed and the four candidates and the top
  move it was about to queue were lost. Trail writes now reuse the map the run
  already holds (one subrequest, not two), are throttled by `TRAIL_MIN_GAP_MS`,
  and `HEARTBEAT_MS` is 120s. Only the three bracketing writes still read, so
  anything else that touched the map is merged before the run signs off. The
  first test written for this passed on the broken code, because fifty log lines
  in a tight loop coalesce anyway: the real cost is spread over minutes, so the
  test drives ten simulated minutes on fake timers and asserts on **reads**.

- **`spendCapUsd` bounds when a request may start, not what a run totals.**
  `assertWithinBudget()` runs before each request, so a run sitting at $0.75
  under a $1.25 cap will happily start a call that costs $0.64 and finish at
  $1.39. That is the measured number, not a hypothetical. The overshoot is
  bounded by the price of one maximal call, which is why `maxTokens` on the
  expensive passes is part of the ceiling rather than separate from it. Do not
  describe the cap as a hard limit.

- **`writeStatus()` swallows its own errors, so a lost terminal write is a
  permanent lie, and only another run can clear it.** Swallowing is correct — a
  status write must never take an agent's real work down with it — but the cost
  showed up in production: `finance_watch` claimed to be running for three days,
  and `marketing_analytics` sat `running` beside a Chief-of-Staff row from the
  **same runId** that had finished, which proves the agent completed and only its
  ending went missing. The agent that owns a row is not running, so it can never
  correct itself. `reconcileStale()` therefore sweeps the board on every fresh
  read, closing any `running` row whose runId differs from the current run and
  whose last sign of life is older than `IMPOSSIBLE_RUN_MS` (30 min). That bound
  is the platform's, not a guess: a cron invocation is capped at 15 minutes, so
  nothing older can still be alive. Related: `startedAt` used to be `ctx.now`,
  which is fixed for a whole tick, so every agent in a tick reported the same
  start time and "how long has this been running" was unreadable.

- **A killed Worker cannot write its own ending, so a status row lies.** A run
  terminated mid-flight leaves `runtime.agent_status` reading `running` forever,
  and the dashboard pulsed an amber "thinking" ring on Competitive Intelligence
  for half an hour after it had been dead for twenty-nine of them. The runner now
  writes `heartbeatAt` about once a minute while an agent works (`HEARTBEAT_MS`
  in `src/core/agent.ts`, cleared the moment the run leaves propose/execute), and
  the dashboard treats a `running` row with no sign of life for four minutes as
  **stalled**: dashed grey dot, "no signal", no spinner, and it stops counting
  toward `anyRunning()` so one dead row cannot hold the page on the 3s poll. Rows
  written before heartbeats existed fall back to their last thought, then to
  `startedAt`.

- **Sections are absolutely positioned but their heights are whatever fits.**
  Those two facts disagree the moment a section holds more than its authored box
  allowed: Marketing renders **391px** tall against an authored `h: 300`, so the
  Sales box, painted at a fixed `y: 380`, covered the last row — Social
  Engagement's cadence label was behind it. `elementFromPoint` at the label's
  centre returned `section sales`. `restackSections()` now places each section
  under the measured bottom of the one before it, so adding an agent can never
  hide a label again; the authored `y` only sets the first section's origin and
  the order. It runs before `renderWires()` so the lines land on the moved nodes,
  and the Library node travels with the Intelligence section. Verified in a real
  Chromium, because neither a typecheck nor a substring test can see a covered
  element.

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

- **An agent run is not a web request, and there were three wrong answers before
  the right one.** `POST /api/run/:agentId` originally ran the agent and then
  responded. The intelligence agent fetches a dozen pages and makes three model
  calls, so it comfortably passes Cloudflare's ~100 second edge timeout: the
  caller got **524 A Timeout Occurred** while the Worker carried on running and
  carried on billing.

  The obvious fix — hand the work to `execCtx.waitUntil()` and return **202** —
  is wrong, and wrong in a way that looks right. **`waitUntil()` extends a
  Worker for at most thirty seconds past the response.** Every other agent here
  finishes in under ten, so they all passed. Competitive Intelligence was killed
  half a minute in, mid research call, and left a status board reading
  "Competitive Intelligence started" that is indistinguishable from an agent
  still thinking. It sat like that for twenty minutes while we watched it.

  What actually has room, from Cloudflare's limits table: a **cron trigger gets
  15 minutes** of wall clock, and an **HTTP-triggered Worker has no duration
  limit at all while it is streaming a response body to a connected client**.
  So the run now lives inside its own response. `runStream()` in
  `src/routes/api.ts` wraps the work in a `ReadableStream`, every `ctx.log` line
  is written to the caller as it happens, and a **heartbeat every 15 seconds**
  covers the quiet stretches — a research pass thinks for minutes without
  logging, and a connection carrying nothing is exactly what the edge cuts. The
  trade is that the run belongs to the connection: hang up and it dies. That is
  why the dashboard's `followRun()` holds the reader open rather than firing and
  forgetting, and why letting go of it kills the agent mid-run.

- **Resuming a paused server-tool turn re-sends everything, at full price.**
  This cost real money before it was found: a research pass paused, and each
  resume re-sent the whole accumulated conversation including every search
  result and every fetched page. Four resumes over roughly 60k tokens of
  accumulated context bills around 600k input tokens, which is over three
  dollars on Opus for a single call. The fix is `cache_control: {type:
  "ephemeral"}` on any request carrying web tools, so re-sent prefixes bill at a
  tenth. `test/spend-ceiling.test.ts` does that arithmetic against the real
  pricing table so the number cannot quietly drift.

- **A long model call must be streamed, or the edge kills it at ~100 seconds.**
  This is the outbound twin of the 524 above and it is a separate bug from it.
  `api.anthropic.com` sits behind Cloudflare too, so a non-streaming request —
  which holds one connection open carrying nothing until the whole answer is
  ready — is cut with **524 after the model has done the work and billed for
  it**. The intelligence agent's research pass, at effort `high` with
  server-side search and a 32000 token budget, passes that limit routinely; the
  recorded failure reads `Claude call failed on claude-opus-5: 524 error code:
  524`. Backgrounding the run with `waitUntil()` does not help, because the leg
  that dies is the outbound one. `complete()` now sends every request through
  `messages.stream(...).finalMessage()`, which returns the identical `Message`
  and keeps bytes moving so nothing idles out. The current API guidance is to
  stream any request with long input, long output or a high `max_tokens` for
  exactly this reason. `test/spend-ceiling.test.ts` stubs `messages.create` as a
  throw, so reintroducing the non-streaming form fails four tests — a typecheck
  would not notice, since both forms take the same parameters.

- **`max_tokens` includes thinking on this generation, and running out of it
  truncates structured output mid-JSON.** The parse then fails with "expected
  JSON matching the schema", which blames the model and hides the cause, and the
  tokens are billed either way. `complete()` now checks for
  `stop_reason: "max_tokens"` and says what actually happened. A call at effort
  `max` needs a budget sized for the thinking AND the answer: the intelligence
  agent's passes use 32000, not 12000.

- **A budget sized for the answer is spent before the answer starts, and this
  hit five agents, not one.** Thinking is billed inside `max_tokens`, so the SEO
  agent asking Sonnet 5 at effort `high` for a 160-character meta description
  with `max_tokens: 400` failed outright the first time it had real work. The
  same shape was in objection-faq (600), finance-watch (700), analytics (800)
  and social-engagement (600 at effort **xhigh**, which had produced nothing for
  six days). `SHORT_ANSWER_MAX_TOKENS` in `src/core/models.ts` is the shared
  budget for a short answer from a thinking model; `max_tokens` is a ceiling
  rather than a spend, so raising it costs nothing unless the tokens are
  generated. `test/token-budgets.test.ts` scans the real sources and fails on
  any budget under 1500, resolving named constants as well as literals — the
  first version only checked literals and passed happily on the bug it was
  written for. A small budget is exempt only where the model does no thinking,
  by name, and the test asserts alt text really is on the fast tier.

- **Nothing was counting money between requests.** `AgentDefinition.spendCapUsd`
  is a per-run ceiling the runner applies before `propose()` and lifts on the
  way out, and `Claude` checks it before every request including every
  continuation. Checking only at the start of a run would not have stopped
  anything, because the spend happens between requests. Competitive Intelligence
  is capped at $1.25; hitting it is reported as a failure like any other, so it
  reaches the approvals queue rather than the logs.

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

- **A big `memory` row is not a big prompt, and the panic over that wastes a
  session.** `readMemory({ minSalience: 6 })` is called by Chief-of-Staff
  (`chief-of-staff.ts:166`) and Growth-Strategy (`growth-strategy.ts:70`), it
  selects `*`, and rows sort `salience.desc, updated_at.desc` — so a freshly
  written 277KB blob at salience 7 does sort straight to the top. What it does
  **not** do is reach the model: `writeJson()` in `src/core/state.ts` puts the
  payload in `detail` and a one-line summary in `content`, and both prompt
  builders render `row.content` only:

  ```ts
  const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n");
  ```

  So the prompt gets `- transfer.full: state pushed to transfer.full`. The cost
  of an oversized row is bytes over the wire into the Worker on those two runs,
  not tokens. Before declaring a token leak, check which field the prompt reads.
  This one was called live and was wrong.

- **Section 11's transfer path is the only way code leaves a session, so treat a
  failed transfer as an incident.** The full write-up is in section 11. The short
  version, because it is the expensive one: a failed bundle fetch does not stop
  the `git checkout` and `wrangler deploy` that follow it in the same paste, and
  origin is months behind because push is 403. Check the **test count** and the
  **number of cron lines wrangler prints**, not just the md5.


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

**A failed transfer does not stop the commands after it, and the next one is a
deploy.** This is the transfer trap, and it is worse than losing the bundle. The
usual paste is a straight-line sequence: fetch, md5, `git fetch`, `git checkout`,
test, `wrangler deploy`. When the fetch fails, `>` has already created an empty
file, so `git fetch` errors on it — and then `git checkout <branch>` succeeds,
putting the tree at **origin's** state, which is whatever the last successful push
left there. Push has been 403 since the start, so origin is *months* behind. The
tests then pass, because an old tree has an old suite and a smaller number is not
an error, and `wrangler deploy` ships it. That is how nineteen commits came off
the live Worker in one paste while every line looked like it worked.

Two tells, and neither is the md5:

- The **test count**. It is the cheapest version check in this repo. 175 is the
  pre-session tree; the current number is in section 12. A count that dropped is
  a reverted checkout, not a passing suite.
- The **cron lines wrangler prints on deploy**. Five is current; three is the old
  `wrangler.toml`. Those come from the file being deployed, so they describe what
  actually went live rather than what you meant to send.

So gate the destructive half on the md5 rather than trusting the eye, and never
put `git checkout` and `wrangler deploy` in the same unconditional paste as a
`curl`:

```
[ "$(md5sum < /tmp/x.bundle | cut -d' ' -f1)" = "<expected>" ] \
  && echo "BUNDLE OK" || echo "STOP — do not continue"
```

Recovery is not the scattered per-fix branches from earlier transfers: bundle the
whole gap in one artifact (`git bundle create x.bundle <origin-sha>..HEAD`), fetch
it to `FETCH_HEAD` and `git merge --ff-only`, which also avoids git refusing to
fetch into the branch that is currently checked out.

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
npx vitest run            # 384 tests
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

### The cheap pass comes first, and that is the whole cost argument

Four stages became five, and the new one is stage 0.

The original order was research (dollars) then triage (pennies), which meant the
question *was this cycle worth a brief* was answered **after** the money was
spent. Skipping at that point saved the composing pass and nothing else. Two
measured runs settled it:

| | Run 1 | Run 2 |
|---|---|---|
| Research | 4m00s, $0.6601 | 6m02s, **$1.1838** |
| Carried questions | 0 | 6 |
| Outcome | brief filed, approvals lost to a subrequest failure | **refused the composing pass, no brief, $1.3132** |

So the **scan** runs first: Sonnet 5 at effort `low`, three searches, a schema
and no deep reading. It answers one question — has anything moved since the last
brief that would change what it said — and on a quiet cycle the run ends there,
in cents, having never started the research pass. `SCAN_SYSTEM` carries the
definition of what counts: a price, packaging, turnaround or guarantee that
changed; a new entrant selling a diagnostic that *ends*; category language
hardening; buyer vocabulary moving; anything that dates the last brief's central
claim; a watched source that changed. Explicitly not: blog posts, rebrands,
funding with no product change, general AI news.

**A new way out of a run has to persist what the run already paid for.** The
scan gate added a third exit and it returned without writing
`intel.source_snapshots`, so four pages were fetched, reduced to text, and
discarded — and every source would have reported `first_seen` again the next
cycle, meaning the week-on-week diff, the only first-hand evidence a brief
carries, would silently never have worked. The two older exits both wrote
snapshots; nothing made the third one. `test/agent-rules.test.ts` now stubs
`globalThis.fetch` and asserts the snapshot write happens on a quiet cycle.

**The settled list de-duplicates on a normalised prefix, not the whole string.**
On the second real run the same fact about the same company was stored twice,
once as "credited toward delivery" and once as "credited toward the delivery
engagement". The model rephrases a finding every cycle, so exact-string matching
lets one fact occupy the list several times — the additive-memory problem the
list exists to prevent. `settledKey()` lowercases, strips to letters and digits
and compares the first 48 characters. The scan prompt also forbids entries about
the agent's own configuration: two of the first seven said "No watchlist is
configured", which was true when written and false a run later, and it is read
back to the scan as fact every cycle.

**A scan that cannot fetch is a scan that assumes.** `web_fetch` will only
retrieve a URL already present in the conversation. The first scan was handed the
last brief's *headline*, which names companies in prose, so every fetch call
failed, it verified one provider of five from search snippets alone, and still
reported "nothing moved" — honestly noting in its own words that four checks
could not be completed. A false "nothing moved" is the one failure this gate must
not have, because it looks exactly like the gate working. `recheckUrls()` now
hands the scan real URLs, capped at `MAX_RECHECK_URLS` (10), and the fetch budget
is 4 rather than 2.

The second half of that lesson cost another run. Given the URLs, the scan spent
all four fetches on the **watchlist** pages and hit `server tool use limit
exceeded` before reaching the four providers that actually needed a look. The
watchlist is fetched by the run itself, with no model and no budget, and
`describeChanges()` hands the scan each page's state plus the exact sentences
that appeared or vanished — so offering those pages as fetch targets buys a worse
copy of something already in the prompt and spends the budget needed for
everything else. `recheckUrls()` therefore **excludes** anything already watched,
leaving the right list: pages the last brief relied on that nobody is watching
yet. The prompt also states the fetch budget as a number, because "a small fetch
budget" is not something a model can count against.

**Memory has to subtract, or it costs more every cycle.** Carrying every open
question forward is what took research from $0.66 to $1.18 in one cycle, and it
grows on its own because each brief adds more. Two bounds now: at most
`MAX_CARRIED_QUESTIONS` (3) open threads are carried, and the scan maintains
`intel.settled` — things checked and found unchanged, capped at `MAX_SETTLED`
(12), de-duplicated case-insensitively — which the next scan is told to skip.
Each cycle should have *less* to look at, not more.

**A run stopped for budget still hands over the cheap half.** The composing pass
is the one that gets refused, and when it is, `BudgetExceededError` is caught and
the candidates discovery already produced are returned with an observation
explaining why there is no brief. Losing them was the actual failure in run 2:
full price, nothing delivered, and candidates are not part of a brief anyway —
they are a list of sources to rule on, and ruling on them is what unblocks the
agent.

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

## 12a. RIGHT NOW — the open threads (keep this section current; delete a thread once it is closed)

Everything else in this file is durable. This section is not: it is the state of
the unfinished work, as of **2026-08-29**. Facts here about live settings go
stale — a note in a document is not a setting. Verify against
`GET /api/schedules`, `GET /api/status` and `GET /api/memory` before acting on
anything below.

### Live schedule overrides, 2026-08-29

| Agent | Override | Why |
|---|---|---|
| `seo_site` | **paused** | Correct. See the thread below — it has never completed a run. |
| `finance_watch` | **paused** | Set 2026-08-27. Reason not recorded. Ask before clearing. |
| `competitive_intel` | **paused** | Set 2026-08-27, and it **overrides the monthly cadence**. |
| `site_integrity` | *(cleared 2026-08-29)* | Back on its built-in hourly, so auto-restore can arm. |
| `x` | hourly | |
| `chief_of_staff` | daily | |
| `social_engagement` | weekly | |

A `paused` override excludes an agent from **every** tick (`registry.ts:73`), so
it beats the cadence in the agent definition. Competitive Intelligence was
rebuilt to run monthly at a $4.50 cap, and while that pause stands it will never
run at all. Clearing it is a spend decision and belongs to the owner.

### Thread 1 — the SEO agent has still never completed a run

The manual run described below **was attempted on 2026-08-29 at 11:20 and it
failed**:

```
Ran out of output budget on claude-sonnet-5 (max_tokens 400).
```

That is the budget bug in section 10, and the fix (`SHORT_ANSWER_MAX_TOKENS`)
deployed at ~15:00 the same day — *after* that run. So the agent has never once
reached the point of proposing an edit on corrected code, and the original
concern is untouched: on its one real run before the pause it published a
whole-page replacement over `/proof-of-concept.html` (the empty-anchor failure in
section 10a). It stays paused until a watched manual run has been done once.

The site itself is healthy and was verified byte-identical after restore. A copy
of the good source is at `site.source.backup`, separate from live `site.source`.

What that run should look like:

1. Confirm `src/core/site-edits.ts` exists in the deployed build and
   `applyEdit()` in `src/connectors/netlify.ts` refuses an empty `before`.
2. Snapshot first: read `/api/state/site.source` and keep it.
3. `POST /api/run/seo_site` — and hold the connection. The run belongs to it.
4. Immediately fetch every page and compare byte sizes against the snapshot. A
   page that shrank is the failure recurring — restore at once.
5. Only if every page is intact, consider a cadence.

Site-Integrity is now armed (thread 2), so a catastrophic shrink would be caught
within the hour even if nobody is watching. That is a safety net, not a licence
to run it unattended.

### Thread 2 — auto-restore is live and armed (verify, do not assume)

Deployed 2026-08-29 and confirmed working in production on a manual run:

```
site_integrity: 5 stored paths, 0 problem(s) in the source itself
site_integrity: restore point updated (5 files)
site_integrity: source and live site both intact
```

`site.source.last_good` holds 5 files — `/index.html` 26,454 bytes,
`/proof-of-concept.html` 22,022, `/faq.html` 8,221, `/styles.css` 30,191,
`/site.js` 5,011. The mechanism is documented in section 10; the thing worth
re-checking is that `last_good` is still being promoted and has not gone stale,
since promotion is gated on no critical findings.

That same run also produced the first production proof of `reconcileStale()`:
`closed 3 stale status row(s) left by a run that never ended`.

### Thread 3 — the LinkedIn partner queue is filling with one post

`linkedin.outbound_queue` holds **130 items, all status `queued`, and only two
distinct texts — one of them repeated 129 times**, from 2026-08-21 through
2026-08-29T15:00. It grows by one on most hourly ticks and nothing drains it,
because `LINKEDIN_INTEGRATION_ENABLED` is `false` and there is no
`LINKEDIN_PARTNER_TOKEN`, which is also why every hourly report reads
`publish_post … blocked_inactive`.

`enqueueForPartner()` in `src/connectors/linkedin.ts` unshifts unconditionally
with a fresh `crypto.randomUUID()` and slices to 200. There is no dedupe on
content and no drain, so the cap is the only bound: it will reach 200 and then
churn, and the row is already 156KB. Callers are `channel-agent.ts:555` and
`:571` and `social-engagement.ts:346`.

Not yet diagnosed: why the same approved draft is re-queued each tick rather than
being recognised as already queued. Fix the re-queue, not the symptom — raising
the cap or clearing the row leaves it refilling. Note that the queue is the
*intended* publishing route for LinkedIn (section 6), so it must keep working
once a partner token exists.

### Thread 4 — leftovers

- Historical site snapshots are still in `memory` and are the owner's to keep or
  drop: `site.source.pre-pricing-fix` (102KB) and `site.source.wrecked-20260822`
  (47KB, a copy of the broken site kept as evidence).
- `transfer.*` rows from code transfers are cleared to `""` after use. There is
  no DELETE route on `/api/state`, so overwriting is how they get emptied.


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
