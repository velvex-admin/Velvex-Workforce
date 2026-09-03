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
that — we own the strategist.

**Two routes to the page now exist and they are independent.** The partner queue
(`route: "linkedin-partner-queue"`) is the doc's integration point. Alongside it,
`src/connectors/linkedin-direct.ts` posts to the company page ourselves. The
strategist prefers direct whenever it is actually live and falls back to the
queue otherwise, so `/api/status` lists LinkedIn **twice** on purpose — a draft
handed to a queue is not a draft that reached LinkedIn, and one row would hide
that.

Direct posting is not a paste-a-secret job the way X was. It needs LinkedIn's
**Community Management API** product on a developer app, which LinkedIn reviews,
plus the page having that app's owner as an admin. `r_organization_social` from
the same review is what would give this system its **first audience signal
anywhere** — X's free tier 402s on every read, so nothing published by this
system has ever reported an impression back.

Two things the connector deliberately refuses rather than papers over: it will
not publish when handed `scheduledFor`, because the Posts API has no scheduling
field and posting now would put a post out hours early with nothing saying so;
and it will not invent a reference when LinkedIn returns 201 with no
`x-restli-id`, because a made-up ref reads for ever after as a successful publish
nobody can find, and a retry would post twice.

`escapeCommentary()` is the one part written against documentation rather than a
real response. An unescaped `(` is the usual cause of a 422 on ordinary prose;
`#` is deliberately left alone, since escaping it would publish a visible
backslash and kill the one hashtag the guide allows. **Verify it on the first
real post** — too wide and backslashes show, too narrow and a sentence 422s.

### Every LinkedIn post waits for the owner

`approveBeforePublish: true` on the LinkedIn spec turns publishing into a veto,
which is a deliberate departure from every other channel, where publishing a
draft the strategist wrote into an established slot is routine. The owner's
reasoning is the right one: the cost of one generic post on a company page is not
one bad post, it is every reader who now reads the page as automated, and the
agent getting better later does not remove the posts that taught them to scroll.

The half that is easy to leave out is what happens on a **rejection**.
`queueApproval` ignores a duplicate `dedupe_key` whatever its status, and a
publish proposal's key is stable for a given draft and slot — so a rejected draft
left available would be re-picked every tick, silently fail to re-queue, and the
channel would go quiet rather than write something else. `absorbDeclines()` reads
the agent's own rejected publishes at the start of a run and stamps `declinedOn`,
which is per channel for the same reason `publishedOn` is: a channel-neutral
draft turned down for LinkedIn may still be right for X. This is the third
instance of the same pattern, after `absorbRejections()` and `absorbVerdicts()` —
rejection has no hook anywhere in this system, by design.

### The page already had a voice, and the agent could not see it

`readChannelHistory` reads what **this system** published, which on a page it has
never posted to is nothing — so the model would be told "nothing published on
this channel yet" about a page with a year of posts on it, and would invent a
register from the guide alone. That is precisely how an agent arrives generic on
day one, which was the owner's stated fear.

`db/seeds/linkedin-voice.json` is the page as read from the public URL on
2026-08-30, and it carries **both halves**: three recent posts as the target, and
three older ones marked with why they are not. The contrast is the lesson — the
page's own trajectory dropped the calls to action and the comment-bait questions,
and continuing that is a clearer instruction than any adjective. It is used only
while `history.recentPosts` is empty; real history is richer and current, and a
frozen baseline sitting beside it would compete with it.

The page was readable with no authentication, incidentally, which is also how the
reaction counts were obtained. On 339 followers those run 0–7 per post and the
newest posts have had days against the oldest posts' month, so they are **not yet
a signal** and the `audienceLine` says so.

**Three conflicts between the page and the code, all settled by the owner:**
hashtags — the page stacks 4–6, the guide now allows at most one, and the owner
chose the guide; em dashes — the page uses them, `allowEmDash` stays `false`;
closing questions — banned, and the page had already stopped.

### Facebook is dormant

The owner has no Facebook page. The agent returns `[]` on every tick until
`FACEBOOK_ENABLED="true"`. Full logic and connector are already built.

---

## 7. Scheduling — three concepts people confuse

**Cron** (`wrangler.toml`) is the engine. Three schedules only:

| Cron | Fires |
|---|---|
| `0 * * * *` | hourly, on the hour — everything hourly **except** Site-Integrity |
| `30 * * * *` | hourly, half past — **Site-Integrity alone**, on its own subrequest budget |
| `0 7 * * *` | 07:00 UTC daily |
| `0 8 1 * *` | 08:00 UTC on the 1st — **monthly**, where intelligence now runs |
| `0 9 * * 1` | 09:00 UTC Mondays — weekly, **all of it**, unfiltered |

**The weekly cadence used to run on two ticks, and giving that up was forced.**
A cron invocation gets 15 minutes of wall clock for *everything it runs*, and
`runDue()` is a sequential loop. Competitive Intelligence measured **10m03s**,
which left Growth-Strategy under five minutes — and it would not have failed
loudly, because a killed agent leaves a `running` status row rather than an
error. So the weekly cadence was split across an 08:00 tick for intelligence and
an 09:00 tick for everything else.

That split cost a cron line, and **Workers Free allows five per account** (see
section 9). When Site-Integrity needed one, the 08:00 line was the one to give
up: it was filtered to the `intelligence` batch, intelligence has been monthly
since the cost measurement, so it fired every Monday and ran **nothing at all**.

The consequence is that **intelligence's monthly cadence is now load-bearing**,
not merely a cost choice. Override it back to weekly and it shares the 09:00 tick
with Growth-Strategy and the squeeze returns. `runDue()` logs a warning when that
happens rather than letting an agent be killed silently, and the weekly tick is
deliberately **unfiltered** — a filter there is how a weekly agent silently never
runs. `test/weekly-split.test.ts` asserts that, asserts intelligence still lands
somewhere if set back to weekly, and **counts the cron lines against the ceiling**,
which is the only cheap place a sixth is catchable before the API refuses it.

**The hourly cadence is split for the same reason, against the other limit.** An
invocation gets ~50 **subrequests** for everything it runs, as well as its fifteen
minutes. Site-Integrity runs last in the hourly loop and fetches every stored
page, so it is the agent that finds them spent — and it died that way on
consecutive hourly ticks on 2026-08-29 leaving no error at all, because the
failure report is itself a subrequest. `30 * * * *` gives it a fresh budget.
`BatchFilter` gained `onlyAgents` / `exceptAgents` for this: a batch is the wrong
unit here, since Site-Integrity shares `executive` with three agents that do not
need moving. `test/hourly-split.test.ts` asserts the two hourly ticks are a
**partition** — drop it from one without adding it to the other and auto-restore
silently stops being armed — and that the cron literals still match what the
handler matches on.

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
| `LINKEDIN_PARTNER_TOKEN` | partner queue — not yet supplied |
| `LINKEDIN_ORG_ID`, `LINKEDIN_ACCESS_TOKEN` | direct company-page posting — not yet supplied |
| `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` | not yet supplied |

To check what the live Worker actually believes, call
`GET /x/<APP_PATH_SECRET>/api/status` and read `connectors[].missing`. That is
authoritative; the dashboard UI is not.

### Five cron triggers, per ACCOUNT, and a refusal that does not roll back

Workers Free allows **5 cron triggers per account** — not per Worker, not per
day. A sixth is refused by the API with `code: 10072`. Waiting does not help;
this is a plan ceiling, and Workers Paid raises it to 1,000 for $5/month.

The dangerous half is what happens on refusal. `wrangler deploy` uploads the
script **first** and sets triggers **second**, and it says so plainly:

```
Uploaded velvex-vx03 (9.61 sec)
✘ [ERROR] Trigger configuration ... was only partially updated
    - This account has reached the Workers Free limit of 5 cron triggers
  Successful trigger changes were not rolled back.
```

So **the new code goes live against the old cron table**. Any agent the code
moved onto a schedule that was never created simply stops running, and stops
silently: no error, no failed report, no `running` row, because nothing invoked
it at all. That is exactly how Site-Integrity was orphaned for eighteen hours on
2026-08-30 — the deployed code excluded it from `0 * * * *` and the `30 * * * *`
it had been moved to did not exist, so auto-restore was unarmed the whole time
and the only visible sign was `site.source.last_good` failing to advance.

**So adding a cron line means removing one, and a deploy is not done when the
upload succeeds.** Read past the trigger line for an error, then confirm the
agent you moved actually ran: `GET /api/state/runtime.agent_status` and check
`startedAt` on that agent against the tick it should have caught.

`test/weekly-split.test.ts` counts the lines in `wrangler.toml` against the
ceiling, which is the only place this is catchable before the API refuses it.

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

- **The error path must not need the resource that just ran out, and this was
  read as a hanging fetch for a whole session.** Site-Integrity died on
  consecutive hourly ticks on 2026-08-29 — 20:00 and 21:00 each logged one line
  and then produced nothing: no heartbeat, no findings, no restore-point
  promotion, no error. An earlier session read that signature as a `fetch()` with
  no timeout and gave it `AbortSignal.timeout(10_000)`, which was a real fix for a
  real bug and left this one untouched. The tells that it was not the fetch: the
  timeout **was** in the deployed bundle (pull the live script and grep it, do not
  trust a note); all five pages answer in under a second; and the heartbeat is a
  `setInterval`, so a missing beat at +120s means the isolate is **dead**, not
  slow. Run alone via `POST /api/run/site_integrity` it finishes in seconds and
  promotes the restore point — so the agent was never the problem, the tick was.
  Site-Integrity runs **last** on the hourly tick and is the heaviest thing in it,
  so it is the one that discovers the invocation's ~50 subrequests are spent. And
  the reason it left no evidence: both catch blocks in `runAgent` filed their
  failure report with a bare `await coordinator.receiveReport(...)`, which is
  itself a subrequest — so the report threw too, and *that* throw escaped
  `runAgent` past `stopBeat()` and the terminal `writeStatus()`, out of `runDue()`,
  killing the whole invocation and leaving a `running` row that nothing could
  correct. `reportSafely()` now swallows a reporting failure the way
  `writeStatus()` already swallows its own. **A restore point that stops advancing
  is the visible symptom of an invocation dying, not of the site being wrong.**

- **A report that cannot be written must never revise what the run actually did.**
  Found while testing the above. On the success path the report was inside the
  same `try` as `execute()`, so a throw there landed in the execute `catch`, which
  counted the *same* action as `failed` on top of the `executed` it had already
  been counted as — two increments for one action, and a failure report filed for
  work that had already happened externally. An agent reading that back sees
  something to retry, and retrying an external publish is exactly how the LinkedIn
  partner queue reached 131 copies of one post. By that line the tweet is sent;
  the bookkeeping does not get to disagree.

- **`readMemory` takes a list of keys, and reading three keys one at a time costs
  three subrequests.** `state.readMany()` exists for this. It matters only where
  the margin is thin, which is precisely where it was needed: the agent at the end
  of a tick is the one that finds the budget gone.

- **Two passes over one shelf, asking different questions, deadlocked the X
  agent for five days in total silence.** Nothing ever moves a draft off
  `status: "ready"` — `publishedOn` is the only record that it went out, and that
  is deliberate, because a channel-neutral draft published on X may still be due
  on LinkedIn. So availability is a **per-channel** question. The publish pass in
  `channel-agent.ts` asked it correctly (`!publishedOn.some(channel)`); the
  drafting gate counted `ready.length` and did not. A shelf holding three drafts
  already published on X therefore read as **full** to the drafting gate and
  **empty** to the publish pass, and the two answers lock: nothing left to send,
  no reason to draft, and the only thing that drains the shelf is publishing. X
  published nothing from 2026-08-25 to 2026-08-30 with no error anywhere, and it
  took the learning layer with it, since that lives inside the drafting path. One
  `available` list now feeds both passes. `test/draft-shelf.test.ts` drives the
  real `xAgent.propose` against the shelf as it actually was — and asserts the
  publish half too, so nobody ever makes the two agree by loosening the publish
  pass and republishing a post that has already gone out.

- **A join can only see what it was built to join to, and on day one that is
  nothing.** `applyVerdicts` matches a ruling to the episode the agent recorded
  when it proposed, which is right, and means the layer starts blind to every
  ruling made before it shipped. On X that was **nine real rulings — eight
  approvals and a rejection** — already in `pending_approvals` with the whole
  original action attached, while the agent sat waiting to accumulate five new
  ones. Twice blind, in fact: those keys predate the content hash `dedupeKey`
  appends, so a re-proposal of the identical idea would not have matched either.
  `backfillEpisodes()` reconstructs them from the stored row, which carries the
  title, the risk and the action type, so nothing is guessed. Two things it
  deliberately does not do: it does not select on the shape of the dedupe key
  (the action type is the same vocabulary the propose path filters on, so the two
  cannot drift), and it does not mark a reconstruction in `features` — a flag
  correlating perfectly with a historical batch that is 8:1 approved is exactly
  the spurious rule the layer exists to avoid.

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

- **A `fetch()` with no signal is not a slow call, it is a call that may never
  return.** `fetchServed()` in Site-Integrity reaches the live site for every
  stored path, sequentially, hourly, and had no timeout. One page that never
  answers stopped the whole integrity check — and stopped it in the worst way,
  because the agent that hangs is the one that would have reported the problem:
  a `running` status row, no findings filed, and no restore point promoted,
  since promotion happens after that loop returns. Auto-restore therefore stops
  arming without anything anywhere saying so. Seen on 2026-08-29: the 20:00 run
  logged "5 stored paths, 0 problem(s)" at 20:00:56 and produced nothing for the
  next half hour while `site.source.last_good` stayed frozen at its 15:17 copy.
  Every outbound `fetch` in an agent needs `AbortSignal.timeout(...)`; the one
  here is 10s per page. The test asserts on **which URLs were asked for**, not
  on which findings came back — the latter cannot tell "carried on" apart from
  "stopped at the first failure".

  **There was a second one, found on 2026-09-03 before it could bite.**
  `ops-health.ts` fetched `OPS_PIPELINE_STATUS_URL` with no signal at all, and
  that URL belongs to a system this project deliberately does not control — the
  worst kind to wait on forever. It had never hung only because the endpoint had
  never existed; connecting it is what would have armed it. Now 10s, with the
  timeout named in the report rather than folded into a generic failure.
  `test/ops-health.test.ts` asserts a signal is **passed**, since a stub always
  answers instantly and no assertion about the findings can tell a bounded call
  from an unbounded one. Worth grepping for the rest: `x.ts`, `facebook.ts` and
  `netlify.ts` still have none, and they are connectors rather than agents, so
  they run inside an agent's budget rather than owning one.

- **A queue with no idempotency, fed by an hourly agent, fills up.** The
  LinkedIn partner queue reached 132 items, 131 of them the same post, and the
  partner would have published every copy. One early return caused it: handing
  a draft to the queue *is* this channel's publish step, but the "partner not
  wired up yet" branch returned before stamping the draft as handed over and
  before consuming the schedule slot that asked for it — and the third guard,
  the minimum gap between posts, counts only `executed` reports, which that
  branch does not produce. Three guards, all skipped by the same return. Both
  branches now do identical bookkeeping and differ only in the outcome they
  report. `enqueueForPartner` is idempotent on a `sourceKey` as well, and
  `POST /api/linkedin/queue/compact` collapses repeats already stored.
  The lesson generalises: **when one branch of a publish path returns early,
  check what bookkeeping the other branch was doing.**

- **A digest deploy publishes the whole source, not the page you edited.**
  `applyEdit()` guards the substitution it is handed. It cannot guard the pages
  it is not editing, and every one of them goes live with it — which is how the
  two stubs left in `site.source` after the empty-anchor incident would have
  reached the real site on the next sound edit to any page.
  `netlifySiteWriter.write()` now runs `criticalFindings()` over the whole map
  twice, before the edit and after it, and refuses to deploy either way. This is
  the complement to auto-restore, not a duplicate: restore repairs damage that
  was published, this refuses to publish it. Note that Site-Integrity's own
  restore calls `deploySite()` directly rather than going through `write()`, so
  putting a verified copy back is never blocked by the gate — which is right,
  because a restore fires precisely when the source is damaged.

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

- **The dashboard called three agents failed and none of them was.** Reported by
  the owner on 2026-09-03: "most of the agents say that they failed". The
  `reports` table held exactly three failures in the preceding six days —
  growth_strategy on `max_tokens 4000`, seo_site on `max_tokens 400`, and
  competitive_intel hitting its $1.25 cap by design — and the first two were
  already fixed in code and deployed. Not one red dot matched a live fault.

  Two separate causes, and the second is the one that hides:

  `reconcileStale()` closed a lost row as **`failed`**, in the same function
  whose own comment records the proof that the run had *completed* — a
  Chief-of-Staff row from the same runId sitting finished beside it. A lost
  terminal write is a fact about the status write, not about the work, so the
  status is now **`unknown`** and says the reports are the record of what the
  run did. Then: a **paused** agent never runs again, so it can never replace
  its own row — `finance_watch` wore a red dot from 26 August onward for a run
  nobody had any evidence went wrong. The node now suppresses `failed` when the
  agent is paused (the cadence line already says "paused", so nothing is
  hidden), and a genuine failure carries its **age** — "failed 4d ago" and
  "failed" are different sentences, and only the first lets you tell a live fire
  from a fixed bug waiting on next Monday's tick.

  `test/dashboard-status.test.ts` executes the real `nodeCard` against the board
  rows that were actually on the live system, rather than asserting a substring
  appears somewhere in the page — a substring test passes happily on this bug.
  All three assertions were verified to fail on the unfixed code.

  The general rule: **what the dashboard calls wrong and what is actually wrong
  have to be the same list.** A board that cries wolf teaches its owner to stop
  reading red, which costs more than having no board.


- **A requirement can be a missing FEED, not a missing credential, and three
  agents were sitting in that state with no way to say so.** `finance_watch`,
  `lead_pipeline` and Ops-Health's Phase 0 half are all fully built and fully
  configured. What they lack is data: a snapshot pushed to `finance.snapshot`,
  `sales.pipeline`, `ops.pipeline_status`. Every tick they ran, found nothing,
  filed an honest "no pipeline data to track" observation, and looked on the
  board exactly like an agent working fine — until one of them also carried a
  stale `failed` row from a lost terminal write, at which point it looked like
  an agent on fire. Neither reading was true.

  `AgentRequirement.feed` names the memory key. `check(env)` deliberately
  **cannot** see the database — it runs before `propose()` for every agent on
  every tick, and a read there is the subrequest budget that has already killed
  two agents in this system — so a feed is resolved only where it is displayed:
  `resolveRequirements()` collects every declared key across the whole roster
  and reads them in **one** call, from `/api/status`, on a request somebody
  made. `check` is now optional, and a feed requirement is never `blocking`,
  because the agent running is what files the "no data" report that makes the
  gap visible in the first place.

  Two judgements worth keeping. A snapshot that arrives carrying **zero
  prospects** counts as connected, not missing: "nothing is wired up" and
  "wired up, nothing in it yet" are different sentences and only the first is a
  setup step. And a **failed read falls back to the environment-only answer**
  rather than painting "needs setup" across fifteen agents — a database briefly
  unreachable is not the same fact as an agent nobody connected, and a board
  that confuses the two is back to crying wolf.

- **A site rewrite can change the shape of every internal link at once, and the
  inventory matches links by string.** The old build linked `faq.html`; the
  build deployed on 2026-09-03 links `/faq`. The source is keyed `/faq.html`
  either way, so a membership test against the normalised href matches nothing
  the moment the source is re-seeded from the new folder — and **every page
  becomes an orphan**, on a site whose navigation links all three of them, in
  view, on every page. The SEO agent would then propose an internal-links fix a
  day for a problem the owner can see is not there, which is how an agent
  teaches its owner to stop reading its findings.

  This is the second time this exact mismatch has bitten; the first is recorded
  in the header of `src/core/site-inventory.ts`, when the inventory was fetched
  from the live site instead of derived from the source. `resolveToPage()` now
  tries the href, then `+ ".html"`, then `/index.html` under it. Caught before
  the re-seed rather than after, which is the only reason it costs nothing.

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
  pre-session tree, 424 the tree before the learning layer, 457 before the shelf
  deadlock was found, 478 before the LinkedIn page work, 560 before the status
  board stopped calling things failures, 564 before Ops-Health was wired up, 573 before the needs-setup state; the current number is in section 12. A count that dropped is a reverted checkout, not a passing suite.
- The **cron lines wrangler prints on deploy** — but read WHICH, not how many.
  It is five now and it was five before the hourly split, so the count no longer
  separates those two trees. `30 * * * *` present and `0 8 * * 1` absent is the
  current table; three lines is the original `wrangler.toml`. These come from the
  file being deployed, so they describe what actually went live.
  **And check for an error after the trigger line**, because a refused cron
  update does not roll back the upload — see section 9.

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
npx vitest run            # 584 tests
npx wrangler deploy       # deploy (also: verify vars in the output)
```

Both must pass before deploying. The tests encode real decisions — an autonomy
rule change that breaks `test/autonomy.test.ts` is a behaviour change, not a
test problem.

`.github/workflows/ci.yml` now runs both on every push and pull request. Before
it existed the only check reporting on the PR was Cloudflare's Workers Builds —
the red herring in section 9, failing on every push since 2026-08-20 — so a red
tick meant nothing and a green one was unavailable. CI does **not** deploy:
`wrangler.toml` is the source of truth for variables, and a job holding deploy
credentials would be a second thing that can stamp them.

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
    learning.ts         episodes, lessons, and the forgetting rules (pure)
    spend.ts            the measured spend ledger and what it implies for a balance
    learning-store.ts   reading/writing a learning record, forming lessons, and
                        back-filling rulings made before the layer existed
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
  connectors/           facebook, x (OAuth 1.0a), linkedin (idempotent queue),
                        linkedin-direct (company page; dormant until approved),
                        site, netlify (deploy gated on whole-source integrity)
  routes/               api.ts, integrations.ts
  ui/dashboard.ts       the canvas dashboard
scripts/                seed-site-source.mjs, seed-site-inventory.mjs,
                        apply-migrations.mjs,
                        post-deploy-check.mjs (what to run after deploying)
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

## 12c. The learning layer

Every agent proposes; the owner rules; and until now nothing read the ruling
back. This is the layer that does, and it is live on **one agent** — the X
Strategist. The factory is shared, so turning it on for LinkedIn or Facebook is
the `learning: true` flag in their spec and nothing else.

### It now runs on two channels, and LinkedIn has the better signal

X learns from growth-idea rulings, because that is the only thing on that channel
the owner decides. LinkedIn is gated (`approveBeforePublish`), so **every post
produces a verdict on the copy itself** — denser and more directly useful to the
next draft than any ruling about an idea for copy.

`learnsFrom(spec)` is what expresses that, and it keys off the approval gate
rather than the channel name, so turning the gate on for a third channel starts
collecting its post rulings with no further change. On an ungated channel a
publish still must NOT be recorded: it classifies routine and executes with
nobody deciding anything, so the episode would never resolve and would push real
evidence out of the 40-slot ring.

A connector failure is excluded without needing a special case: the
Chief-of-Staff files a problem escalation with `action.type: "observation"`,
which matches no entry in the map. The owner clearing a 429 is not a judgement
about the writing.

`buildFeatures()` is shared by the live path and the back-fill, so a lesson
formed over a mix of the two generalises over one feature set rather than two. A
key the payload does not carry is **omitted** rather than written as "unknown":
a constant across a whole batch is not a comparable, it is a spurious feature.
Growth ideas therefore contribute `risk`, posts contribute `pillar` and `format`.

**`HAS_AUDIENCE_DATA` stays `false` on both.** That is the half that must not
move until `r_organization_social` is actually returning numbers.

### The cut: which agents get it, and why it is not "operational vs not"

Memory compounds only where the world answers back. A procedural layer on an
agent that acts and hears nothing accumulates confident rules with nothing
validating them, which is worse than no layer at all. So the question is which
agents have a **real feedback signal**, and the answer is less obvious than it
looks:

| Signal | Where it comes from | Who has it today |
|---|---|---|
| Owner verdict | `pending_approvals.status` | **every agent that queues** |
| Execution outcome | `reports.outcome` / `error` | every agent that acts |
| Audience response | `fetchMetrics()` | **nobody** |

**X sees no engagement, and this is the fact the design turns on.** `fetchMetrics()`
calls `/2/users/me` and `/2/users/:id/tweets`; both are read endpoints and both
return 402 on the free tier, so no post this system has ever published has
reported an impression back. The agent that most obviously "needs" learning is
the one with no audience signal at all. Read access is roughly $200/month and is
a purchase decision, not a design one — and even bought, `fetchMetrics()`
aggregates a window rather than attributing to a post, so per-post retrieval
keyed on the `external_ref` every published report already stores is a second
piece of work behind it.

So the layer X actually gets is built on the owner's rulings. That signal is
free, already collected, low-latency, and attributable to a specific proposal —
and the precedent for reading it back is in this repo already: `absorbRejections()`
does exactly this for the intelligence agent's candidates. This generalises it,
and reads approvals as well as rejections, because a rejection alone says what
not to do and nothing about what to do instead.

**SEO is the interesting case and the answer is "one layer, not three".** It gets
no outcome feedback — no rank, no click-through — so a semantic layer there would
be exactly the failure above. But it has a sharp *execution* signal: `applyEdit()`
refuses with a specific recorded reason, and "anchor matched zero times" versus
"matched more than once" is a procedural lesson validated by the next run for
free. Not built yet; noted here so the case is not re-argued from scratch.

**Deterministic agents must not learn.** `ops_health`, `site_integrity` and
`lead_pipeline` run no model because timing and threshold arithmetic are not
judgement calls. A smoke alarm that develops opinions about when not to go off is
strictly worse than one that does not. The `null` model tier and "no learning
layer" are the same decision.

### Three layers, and only two have anything true in them

- **Episodic** — already existed. It is `reports`. What was missing was not a
  store but a *join*: a proposal against what the owner decided about it. That is
  `episodes`, a bounded ring of at most `MAX_EPISODES` (40), keyed on the
  proposal's dedupe key.
- **Procedural** — the genuinely new one. A `Lesson` carries a claim, its basis,
  a support count, a contradiction count and a last-confirmed date.
- **Semantic** — the slot is built and **deliberately empty**. For a channel,
  semantic means audience truth, and the audience is silent. `learningContext()`
  states that absence to the model in words, because a model handed past posts
  and asked what worked will find a pattern — that is what it is for — and with
  no engagement signal the pattern is about nothing. `HAS_AUDIENCE_DATA` in
  `channel-agent.ts` is the single switch that changes when metrics exist.

### The retrieval contract, and why it is arithmetic rather than a convention

Section 12b's lesson: memory is read into other agents' prompts, so a document
stored there is paid for by agents that never asked for it. The broadcast surface
is **exactly two readers** — Growth-Strategy (`minSalience: 6`, limit 30) and
Chief-of-Staff (`minSalience: 6`, limit 25), both untagged. Everything else
already retrieves narrowly; the channel strategists query `tags: [channel]`.

So a learning record is written at **salience 4** with `tags: ["lesson", agentId]`.
`minSalience: 6` becomes `salience=gte.6` in PostgREST, so a row at 4 *cannot*
match it, whatever anyone later forgets. `test/learning-retrieval.test.ts` asserts
**both halves** — that we write below the floor, and that those two readers still
read at it. One half alone is not the invariant: assert only the write and
somebody raises a lesson's salience "so the Chief-of-Staff can see it too";
assert only the readers and somebody drops Growth-Strategy to 3. Both were
verified to fail on the broken code before being kept.

### Forgetting is the part that is hard

An additive memory costs more every cycle and grows more confident while it does
it. That is measured, not theoretical: carrying every open question forward took
the intelligence agent's research pass from $0.66 to $1.18 in one cycle. So:

- a lesson supported no more often than it is contradicted is dropped — a coin
  flip quoted as guidance reads as established and costs the space a real lesson
  would use;
- a lesson unconfirmed for `LESSON_STALE_DAYS` (45) is dropped, because a true
  claim is re-derived from the next batch for free while a false one nothing
  contradicts would sit in the prompt forever;
- `lessonId()` compares a normalised 48-character prefix, not the whole string,
  for the reason `settledKey()` does: the model rephrases the same claim every
  cycle and exact matching lets one belief occupy several slots.

### What it costs, and where it runs

Three subrequests and at most one model call, and **only on runs that were going
to call a model anyway**. The strategist wakes hourly but drafts only when its
shelf is short, so the learning block sits inside the drafting path — which is
also exactly when the lessons get used. On a tick whose subrequest budget is
tight enough to kill the last agent in it (see the trap below), that placement is
the difference between a layer that pays for itself and one that breaks its
neighbours.

The formation call is **Sonnet at effort `low`**, not Opus: it reads a small table
of decisions and says what they have in common, which is classification against
evidence in hand. It fires only once `FORM_AFTER_VERDICTS` (5) rulings have piled
up — the same "answer whether this is worth paying for before paying" argument as
the intelligence layer's stage-0 scan.

`failed` is **not** a rejection. The owner said yes and the machinery broke; that
is a fact about the connector. Counting it as a rejection would teach the agent
to stop proposing things that were approved.

The placement has a second consequence nobody wanted, and it is worth stating
plainly because the fix for it lives somewhere else entirely: **a strategist that
cannot draft cannot learn.** That is defensible on its own terms — lessons are
only *used* when drafting, so a run that skips drafting has no use for them — but
it means anything that jams the drafting gate silently jams the learning layer
too, and that is exactly what happened on X between 2026-08-25 and 2026-08-30.
See the shelf-deadlock trap in section 10. If the layer ever looks like it is not
running, check whether the agent is drafting at all before looking at the layer.

### Starting from the rulings that already exist

`applyVerdicts` joins a ruling onto the episode the agent recorded when it made
the proposal, so on the day the layer ships it can see **nothing**: the record is
empty, and every ruling the owner has ever made joins to nothing. On X that was
nine growth ideas already ruled on, eight approved and one rejected, sitting in
`pending_approvals` with the whole original action still attached.

`absorbVerdicts()` therefore takes an optional `BackfillSpec` and reconstructs
those into resolved episodes. The stored row carries the proposal's title, its
risk and its type, so the reconstruction has the same fields the live path
records and nothing is invented. It is idempotent — a key already in the ring is
never added twice, and an episode the agent logged itself is never overwritten by
a reconstruction of it.

The two restraints in it matter more than the mechanism:

- It selects on **`action.type`**, not on the shape of the dedupe key. The
  historical X keys look like `x:growth:x:<title>` with no trailing content hash,
  because they predate the hash `dedupeKey` now appends — so a key-shape match
  would be matching a format that has already changed once. The action type is
  the same vocabulary the propose path filters on, which is why `LEARNS_FROM` in
  `channel-agent.ts` is shared between the two.
- It does **not** flag a reconstruction in `features`. A feature that correlates
  perfectly with a historical batch running 8:1 approved is precisely the
  spurious rule this layer exists to avoid; the model generalises over features,
  and the `at` timestamp already says when it happened.

An escalated `publish_post` is excluded for the same reason: the owner clearing a
connector failure is not a judgement about an idea.

---

## 12a. RIGHT NOW — the open threads (keep this section current; delete a thread once it is closed)

Everything else in this file is durable. This section is not: it is the state of
the unfinished work, as of **2026-09-03, 00:45 UTC**. Facts here about live
settings go stale — a note in a document is not a setting. Verify against
`GET /api/schedules`, `GET /api/status` and `GET /api/memory` before acting on
anything below.

### CLOSED — X was deadlocked, and the learning layer has now run

Found while checking whether the learning layer had executed. It had not, and
could not have: X had published nothing since 2026-08-25, and the drafting gate
the layer lives behind was permanently shut.

The three x drafts on the shelf each carried a `publishedOn` entry for x and
still read `status: "ready"`, because nothing ever changes that. The shelf
counted as full to the drafting pass and empty to the publish pass. See the trap
in section 10 for the mechanism.

**Deployed and verified 2026-08-30**, version `a8c2aa66`. Two runs against the
live Worker:

| Run | What happened |
|---|---|
| 1 | `recovered 9 earlier ruling(s) from the queue` → `forming lessons from 9 ruling(s)` → `2 lesson(s) held`. Drafted; 4 proposed, 1 executed, 3 queued, 0 failed, $0.072 |
| 2 | **published** tweet `2094029247236976696` — first since 2026-08-25 — then drafted a replacement |

`learning.x` now holds 12 episodes (9 back-filled, 3 awaiting a ruling),
`pendingVerdicts` back to 0, and two lessons:

- *Approve quote-post or reply-based structural commentary on public diligence,
  allocator commentary, or disclosed filings without pitching* — support 4,
  contradict 0.
- *Approve structural/mechanism-focused content on x that uses
  observed/inference/assumption tagging or per-category failure mechanics* —
  support 6, contradict 1.

The lessons were visibly in use on the same run that formed them: one of the
three queued growth ideas is filing-sourced quote-posting, which is lesson one
applied.

**One thing to watch rather than fix.** Eight of the nine back-filled rulings are
approvals, so the first lessons are formed on evidence that is nearly all yes and
say little about what gets rejected. That balances as more rulings land; it is
not a fault in the layer, and `demote()` will drop either claim if the
contradictions catch up with the support.

### CLOSED — the :30 cron is live and Site-Integrity is running

Deployed with the five-line table. Verified 2026-09-03 00:38 UTC from
`runtime.agent_status`: `site_integrity` last started **2026-09-03T00:30** and
`x` at **00:00**, so both hourly ticks are firing and the partition holds.

### BLOCKED, and recorded in the system — LinkedIn needs a registered company

Confirmed 2026-08-31: LinkedIn's Community Management API requires a **legal name
and a registered company**, which does not exist yet. There is no self-serve
alternative — "Share on LinkedIn" grants `w_member_social`, which posts to a
personal profile, not to a company page. So direct posting is not weeks away, it
is a business step away.

This is no longer a note in a document. It is `requires` on the LinkedIn agent
(section 12d), so `/api/status` reports it and the dashboard panel shows the
steps under "What this needs to be operational". Nobody has to remember it.

**What still works, which is most of it:** the agent drafts in the page's own
voice, every post waits for approval, and it learns from each ruling. Approved
posts collect in the partner queue and can be published by hand from there.

Known and recorded in the requirement itself: `LINKEDIN_ORG_ID` is **127634091**
(read from the page's public HTML), the developer app exists and is verified,
and its client id/secret are NOT what the Worker needs — they are used once, by
the owner, in the OAuth exchange that mints the access token.

### CLOSED — the red dots were the board, not the agents

Reported 2026-09-03: "most of the agents say that they failed". Measured the
same hour: **three** failure reports in the preceding six days, all already
fixed in code (growth_strategy `max_tokens 4000`, seo_site `max_tokens 400`) or
working as designed (competitive_intel's $1.25 cap). Nothing was failing.

Two causes, both fixed — `reconcileStale()` labelling a lost ending as `failed`,
and a paused agent being unable to ever clear its own row. Full write-up as a
trap in section 10. After the fix the only red dot left is `growth_strategy`,
and it is telling the truth: it failed on 30 August on `max_tokens 4000`, that
is fixed in the deployed tree, and it is **weekly**, so its next turn is Monday
07 September 09:00 UTC. `POST /api/run/growth_strategy` clears it sooner at the
price of one Opus run.

### OPEN — the site was redeployed by hand and `site.source` is behind it

Measured 2026-09-03 against the live site. **The owner deployed a new build and
our stored copy is now the old one.** Both halves of that drifted:

| | `site.source` (ours) | live |
|---|---|---|
| `/index.html` | 26,614 bytes | ~26,948 |
| meta description on the home page | **present** | **absent** |
| internal links | `faq.html` | `/faq` |
| `/faq.html` | 8,396 | ~8,832 |
| `/proof-of-concept.html` | 22,184 | ~23,186 |

So the new build **dropped the two meta descriptions the SEO agent inserted on
29 August**, and the nav was rewritten extensionless. The navigation itself is
intact — a first pass here read `href="..."` only and missed `href='/faq'` in
single quotes, and briefly concluded the nav had been deleted. It has not.

**The hazard is the deploy path, not the drift.** A digest deploy publishes the
whole source map, not the page being edited (section 10). So the next time the
SEO agent makes any edit at all, it deploys our five stored files and the
owner's new build is gone. Nothing has fired yet only because the agent has had
nothing to do.

Site-Integrity will not auto-restore over this — the rule is damage, never
difference, and a few hundred bytes is a difference — but it is promoting a
**stale copy** as `site.source.last_good` on every clean pass, so the safety net
currently restores to a site that has already been replaced.

**The fix is the owner's, and it is one command:**

```
node scripts/seed-site-source.mjs <the folder they dragged into Netlify> <worker-base>
```

Re-seed first, then let the agent run. The extensionless-link fix in
`site-inventory.ts` (section 10) has to be deployed **before** the re-seed, or
the new hrefs make all three pages read as orphans.

### OPEN — the SEO agent has run out of things it knows how to look for

The owner's read is right and the cause is structural: `findIssues()` in
`seo-site.ts` looks for exactly **three** things — a missing or wrong-length
meta description, a missing alt attribute, and a page nothing links to. On a
five-file site those were fixed on 29 August, so every run since has correctly
found nothing.

Their proposed fix — give it the memory bank the X agent has — is the one thing
that will not work, and section 12c already argues why: that layer learns from
**owner rulings**, and SEO's edits classify routine and auto-apply, so nobody
ever rules on anything. There is no signal to learn from. Section 12c's own
conclusion for this agent is that its real feedback is `applyEdit()`'s refusal
reasons, which is a *procedural* layer, not a semantic one.

**And none of it addresses what the owner actually asked for**, which is being
findable. Measured on the live site the same day:

- `robots.txt` — **404**
- `sitemap.xml` — **404**
- no `<meta name="description">` on the home page
- no canonical, no JSON-LD, no Organization or Service structured data
- `<title>Velvex — System Evaluation</title>` on a name that collides with
  several existing companies
- the `<h1>` is the slogan, carrying no term anybody searches

Meta descriptions and alt text do not get a site indexed; they change how a
result reads once it already ranks. The gap between "the SEO agent has nothing
to do" and "I search Velvex and my site does not come up" is entirely made of
the list above, and every item on it is deterministic — no model needed.

Building it means letting the agent **create files** (`/sitemap.xml`,
`/robots.txt`), which `applyEdit()` deliberately cannot do: it edits pages that
exist, and its refusal to invent one is the guard that stopped the empty-anchor
incident from being worse. So it needs a new action kind with its own autonomy
line, and that is the owner's decision rather than a fix to slip in. Proposed
and awaiting their word.

### Six agents are paused, and two of those pauses cost real function

Read live from `GET /api/schedules`, 2026-09-03 00:38 UTC. Overrides are the
owner's and **must not be cleared on their behalf** — but what each one costs
belongs on the record:

| Agent | Paused | What the pause costs |
|---|---|---|
| `facebook` | 2026-08-31 | Nothing. There is no page, and it is `blocking` anyway. |
| `social_engagement` | 2026-08-31 | Little. X read returns 402 on the free tier, so it has almost nothing to read. |
| `linkedin` | 2026-08-31 | **Drafting, approval and learning — all of which work.** Only *delivery* is blocked on the company registration. Paused, the page's voice baseline is never used and no ruling is ever learned from, which is the layer the owner asked to switch on. |
| `ops_health` | 2026-08-31 | **The watchdog.** Its missing Phase 0 status URL is non-blocking; it watches this system's own agents regardless, and that half was working — 81 `observed` reports in the window. Paused, nothing watches the agents. |
| `finance_watch` | 2026-08-27 | Unknown. Reason never recorded. |
| `marketing_analytics` | 2026-08-30 | Unknown. Reason never recorded. |

The four set on 2026-08-31 carry `builtInCadence`, so `staleOverrides()` can
report them if the code's cadence later diverges. The two older ones cannot, and
somebody has to say whether they are still wanted.

`x` (hourly) and `chief_of_staff` (daily) also carry overrides; both match the
cadence in code, so they change nothing.

### CLOSED — the SEO agent has completed a run

Both earlier diagnoses were right and neither was the whole story. The
empty-anchor bug was real and was fixed. The reason the agent still never
completed a run afterwards was the budget bug: `propose()` makes its first model
call inside the finding loop, so `Ran out of output budget on claude-sonnet-5
(max_tokens 400)` took the entire run with it — `proposed 0, failed 1`, every
time. The budget fix deployed at ~15:00; the pause is what stopped it proving so.

The watched run was done at **17:41 UTC on 2026-08-29**, against a snapshot held
in hand: **3 proposed, 2 executed, 1 queued, 0 failed.**

| Page | Before | After | |
|---|---|---|---|
| `/index.html` | 26,454 | 26,614 | meta description inserted |
| `/proof-of-concept.html` | 22,022 | 22,184 | meta description inserted |
| `/faq.html` | 8,221 | 8,221 | queued for approval — protected pricing page |
| `/styles.css`, `/site.js` | — | unchanged | |

Both pages **grew** by the length of the inserted tag. That is what an anchored
insertion looks like, and it is exactly what the incident did not do. Both were
then confirmed correct on the live site. The pause is cleared and the agent is
back on `daily`.

Two proposals now sit in the queue for `/faq.html` — a meta description and an
internal link. It is the pricing page, so they will never auto-apply. **One
quotes "$999" without the $149 intro rate**, which is the phrasing problem in
section 1. Read them before approving.

### CLOSED — auto-restore is live, armed and verified

Verified again at 17:38 UTC: `site.source.last_good` held all five paths at
their pre-run sizes, saved 15:17 UTC, and `site.restores` is unset, so no
automatic restore has ever had to fire.

One thing to expect rather than worry about: that restore point is now behind
the two meta descriptions. Site-Integrity promotes a new one on its next clean
hourly pass, which is how the mechanism is meant to work.

### CLOSED — the LinkedIn partner queue

Measured 17:39 UTC: 132 items, two distinct texts, one repeated 131 times. It
kept growing until the deploy — the compaction at 20:32 UTC removed **133
repeats and kept 2**, one of each distinct post, which is the intended
behaviour: a repeat is dropped, a genuine post is not.

The question the earlier note left open — *why the same approved draft is
re-queued each tick rather than being recognised as already queued* — was
answered, and it was not the connector. It was one early return in
`channel-agent.ts`. See the trap in section 10 for the mechanism. Both ends are
fixed and deployed. The queue is now idempotent on a `sourceKey`, and
`readQueueHealed` collapses repeats on any read, so this cannot silently rebuild.

Worth knowing for next time: the queue is stored as `detail.items` while
`/api/state/<key>` writes `detail.value`, so it could **not** be repaired
through the state route — doing so would have read back as an empty queue and
taken the real posts with it. It needed the deploy.

### CLOSED — the hourly tick no longer kills its last agent

The fetch timeout was a real fix for a real bug and **was not this bug**. What
actually happened on 2026-08-29 is recorded as a trap in section 10: an
invocation gets ~50 subrequests for everything it runs, Site-Integrity is last in
the hourly loop and the heaviest thing in it, and both catch blocks in `runAgent`
filed their failure report with an unguarded `receiveReport` — itself a
subrequest — so the report threw, that throw escaped `runAgent` past
`stopBeat()` and the terminal `writeStatus()`, and the whole invocation died
leaving a `running` row nothing could correct.

Both halves are now done and deployed:

- `reportSafely()` guards all three report calls, and `state.readMany()` collapses
  site_integrity's two known-good reads into one. That makes the failure
  **visible** and shaves the margin.
- `30 * * * *` gives it its own invocation and therefore its own budget, which
  **raises the ceiling**. `BatchFilter` gained `onlyAgents`/`exceptAgents`
  because a batch is the wrong unit: site_integrity shares `executive` with three
  agents that did not need moving.

The two hourly ticks are a partition, asserted against the real roster in
`test/hourly-split.test.ts`, because dropping the agent from one tick without
adding it to the other would silently stop arming auto-restore — and that
failure looks like nothing at all.

**Expect six cron lines on deploy now, not five.** That is the version tell in
section 11 and it changed with this.

**One loose end, unchanged:** `/faq.html` in `site.source` is 8,396 bytes, up
from 8,221 at 15:17 on 2026-08-29. Something edited the protected pricing page in
that window and the 21:10 promotion baked it into the restore point. Worth
reading before it is trusted.

### Thread 4 — leftovers

- `finance_watch` and `marketing_analytics` both last ended with "this run
  stopped reporting and never recorded an ending. Closed by a later run."
  `reconcileStale()` was doing its job and then **mislabelling the result as a
  failure**; that half is fixed (section 10). What lost the terminal write in
  the first place is still not known, and both agents are paused, so neither can
  produce a fresh row to study. The stored rows still read `failed` — nothing
  rewrites history — but the dashboard no longer renders them red, because both
  agents are paused. `finance_watch` now also carries a **needs-setup** badge
  naming the snapshot it is waiting for, which outranks both in the node tag, so
  un-pausing it will not put a red dot back.
- Historical site snapshots are still in `memory` and are the owner's to keep or
  drop: `site.source.pre-pricing-fix` (102KB) and `site.source.wrecked-20260822`
  (47KB, a copy of the broken site kept as evidence). `site.source.backup` was
  written 17:38 as the pre-run snapshot; `site.source.last_good` is the one the
  restore mechanism actually reads, and is the one to trust.
- `transfer.*` rows from code transfers are cleared to `""` after use. There is
  no DELETE route on `/api/state`, so overwriting is how they get emptied.
- `APP_PATH_SECRET` was shared into a Claude session transcript on 2026-08-29.
  Rotating it is cheap: `wrangler secret put APP_PATH_SECRET`, then the
  dashboard URL changes.


## 12d. Requirements: what an agent needs, and where that is written down

Several agents are waiting on things the owner cannot simply supply. LinkedIn
will not grant the Community Management API without a **registered legal
entity**. X's read endpoints need a paid tier (~$200/month). There is no
Facebook page. None of those is a bug and none will resolve on its own.

The failure mode this prevents is not technical. An agent blocked on the outside
world used to present as `failed` on the dashboard, and a red dot that means
"LinkedIn wants a registered company" teaches you to stop reading red dots.

So `AgentDefinition.requires` is a list of `AgentRequirement`, each carrying what
is missing, whether it is `blocking`, the **steps that would end the wait**, and
a note. `check(env)` is deterministic and cheap — environment only, no database,
no model — and runs before `propose()` on every tick.

Three states, and they are different:

| | means |
|---|---|
| **failed** | it ran and something went wrong |
| **paused** | somebody chose to stop it |
| **blocked** | it is waiting on the outside world, expectedly, and something specific would end that |
| **needs setup** | it is fully built and configured, and has nothing to work on |

The fourth was added on 2026-09-03 at the owner's request, and the sentence
that earned it is theirs: *"that does not mean we should keep it at failed and
paused at the same time; rather, something like NEEDS SET-UP for me to keep in
mind that it needs something to work on, not something to fix."* The distinction
is which list the agent belongs on — one you work through, or one you worry
about. `finance_watch` had been on the wrong one since 27 August.

`blocking: true` holds the agent back entirely: it does not run, cannot spend a
token, and writes `blockedBy` to the status board. `blocking: false` means the
agent still runs and is merely degraded — which is the right setting for three of
the four, because they do most of their job without the missing piece.

**Where it shows.** `/api/status` returns `requirements` per agent, computed from
the agent rather than from its last run — per-run would vanish the moment a
degraded agent had a clean tick, which is exactly when the reminder is easiest to
lose. The dashboard panel renders **"What this needs to be operational"** with
the numbered steps, amber for degraded and red-bordered for blocking, and the dot
gets a dashed amber ring rather than a red one.

### What is on the list today

| Agent | Blocking | Waiting on |
|---|---|---|
| `linkedin` | no | A registered legal entity, before LinkedIn will grant the Community Management API. Drafting, approval and learning all work without it; only delivery of an approved post is blocked, and those wait in the partner queue. |
| `facebook` | **yes** | There is no Facebook page. Full strategist and connector are built. |
| `social_engagement` | no | Read access on any channel. X returns 402 on the free tier; LinkedIn comments need `r_organization_social` from the same review above. |
| `ops_health` | no | A read-only status URL from the Phase 0 pipeline. It watches this system's own agents regardless, which is the half that matters. |
| `finance_watch` | no | Revenue, cost and client figures pushed to `finance.snapshot`. The guardrail arithmetic and its thresholds are already written; it has nothing to divide. |
| `lead_pipeline` | no | A prospect snapshot pushed to `sales.pipeline`. Same shape: the agent is finished, the feed is the missing half. |

`X_READ_ENABLED` was added to the environment for the day the paid tier is
bought. It is a purchase, not a setup step, so it needs a switch.

---

## 12e. What this actually costs, measured

Every run already computed `result.costUsd` — `runAgent` snapshots the Claude
client's spend either side of the run, so it is real rather than modelled — and
then **threw it away**. `usage` was null on every report row, nothing persisted
a total, and "what am I spending" could only be answered by arithmetic over
assumptions.

`src/core/spend.ts` keeps a ledger in `memory` at `spend.ledger`: one entry per
day, per-agent split, capped at `MAX_SPEND_DAYS` (60). `runDue` folds each tick
into it **only when the tick spent something** — most hourly ticks make no model
call at all, and buying two subrequests an hour to store a zero is exactly the
budget this system has already lost an agent to.

`GET /api/spend?balance=12` returns the summary: today, last 7, last 30, daily
average, monthly projection, which agents are responsible, and — given a balance
— the date it runs out. The balance is a query parameter and deliberately not
stored: it lives in the Anthropic console and anything cached here is wrong
within a day.

**The daily average divides by days OBSERVED, not days that spent.** A quiet day
is a real day, and dividing by only the expensive ones flatters the average —
the wrong direction to be wrong when the output is "your credit lasts N days".
The first test written for this passed on either formula, because its fixture
spent on every day; `test/spend-ledger.test.ts` now includes a quiet-day case
that tells them apart.

**First measurement, three days on file (2026-08-31 to 09-02):** $0.3125 total,
a $0.104 daily average, a $3.13 monthly projection, and 27 December against a $12
balance. Top spenders: `x` $0.172, `competitive_intel` $0.076, `chief_of_staff`
$0.065. Note the shape of it — five model-calling runs in three days — because
six of the fifteen agents were paused for all of it. The projection is of a
system running at less than half strength, and it will rise when they come back.

**Sonnet 5 was priced wrong here for weeks.** `MODEL_CAPABILITIES` carried
$3/$15 — Sonnet 4.6's rates — against Sonnet 5's actual $2/$10, overstating every
Sonnet cost by 50%. That is not cosmetic: `spendCapUsd` is enforced against these
numbers, so a run could be stopped for a bill it never ran up. Current rates:
Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5 per MTok.

**`max_tokens` is a ceiling, not a spend.** Raising it costs nothing unless the
tokens are generated. A call that dies on `max_tokens` still bills for what it
produced before truncating, so raising a limit that was too low converts a
wasted spend into a useful one rather than adding cost.

---

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
