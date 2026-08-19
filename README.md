# VX-03 — Velvex Internal Operations Layer

The agents that run the business itself: marketing, sales management and
executive functions, coordinated by a Chief-of-Staff. Private, single user,
desktop, behind an unguessable URL.

Built from `velvex-vx03-architecture.html` in this repository. Separate from the
client-facing operations pipeline: no shared database, no shared credentials,
nothing from Phase 0 touched.

**To get it running: [DEPLOY.md](DEPLOY.md).**

## How it works

The whole system is one idea, applied thirteen times:

```
agent proposes an action
        |
   autonomy boundary classifies it
        |
   routine? ---- yes ---> execute ---> Chief-of-Staff ---> reports table
        |
        no
        |
   pending_approvals ---> you decide ---> execute exactly what you reviewed
```

No agent calls a connector directly. It returns a `ProposedAction`, and the
boundary in `src/core/autonomy.ts` decides what happens to it. That is what
makes "routine vs needs approval" enforceable rather than a comment:

1. **Approval rules are vetoes.** If one fires, the action is queued whatever
   else matched.
2. **Routine rules are allowances.** An action is routine because a rule says
   so, never by default.
3. **Anything unmatched is queued.** "Anything new needs approval" only means
   something if the unknown case lands on the approval side.
4. **Judgement failures resolve toward asking you.** If a rule cannot be
   evaluated, the action is queued, not taken.

## The roster

| Batch | Agent | Model | Routine | Needs approval |
|---|---|---|---|---|
| Marketing | Content | Opus 5 | Drafting inside established pillars, formats and voice | A new content pillar or campaign direction |
| Marketing | LinkedIn *(external build)* | none | Timing and publishing approved content | New campaign type or paid promotion |
| Marketing | Facebook *(connector inactive)* | none | Timing and publishing approved content | New campaign type or paid promotion |
| Marketing | X / Twitter *(connector inactive)* | none | Timing and publishing approved content | New campaign type or paid promotion |
| Marketing | SEO / Site *(write access)* | Sonnet 5 | Meta, alt text, internal links, on-page copy, structural SEO | Pricing pages, legal pages, full restructures |
| Marketing | Marketing Analytics *(observes only)* | Sonnet 5 | All of it | N/A |
| Marketing | Social Engagement | Opus 5 | Replies to praise and simple factual questions | Any reply to criticism, insults or public complaints |
| Sales | Lead / Pipeline | none | Tracking, flagging stalls, reporting | Any direct client-facing action |
| Sales | Objection / FAQ | Sonnet 5 | Known questions in already-approved language | New or ambiguous question types |
| Executive | Finance-Watch *(observes only)* | Sonnet 5 | Monitoring and reporting | Recommending a pricing change or pausing spend |
| Executive | Ops-Health *(observes only)* | none | Monitoring and reporting | Any infrastructure change |
| Executive | Growth-Strategy | Opus 5 | Nothing: advisory only | Everything it proposes, by definition |
| Orchestration | Chief-of-Staff | Opus 5 | Logging activity, keeping memory | Acting on another agent's behalf |

Models are chosen per agent, not globally: reasoning tier where copy is public or
a wrong judgement is expensive, balanced tier for bounded reading and writing,
fast tier for the spam filter and alt text, and no model at all for the five
agents whose work is arithmetic, a clock, or somebody else's build. Every call
records its cost. See [docs/MODEL-CHOICES.md](docs/MODEL-CHOICES.md).

## Layout

```
src/
  index.ts              Worker entry, the access choke point, cron
  env.ts                config, secrets, readiness
  core/
    types.ts            ProposedAction and the shared vocabulary
    models.ts           the three model tiers and what each one can do
    business.ts         what Velvex is, taken from the live site
    autonomy.ts         the boundary: the general rule, as code
    agent.ts            propose -> classify -> execute or queue -> report
    config.ts           the already-approved scope: pillars, pages, states, FAQ
    voice.ts            the voice profile and its mechanical checks
    state.ts            typed views over the memory table
  agents/               one module per agent, rules included
  connectors/           facebook, x (both inactive), linkedin integration point, site
  lib/                  Claude (three model tiers), Supabase, the judge
  routes/               dashboard API, LinkedIn partner endpoints
  ui/                   the dashboard
db/migrations/          reports, memory, pending_approvals
docs/                   model choices, open items
test/                   73 tests over the rules, the runner, the voice, connectors, models
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the three required secrets
npm run dev                      # http://localhost:8787/x/<APP_PATH_SECRET>/
npm test
npm run typecheck
```

## Status

| Piece | State |
|---|---|
| Application, hosting config, dashboard | Built |
| Supabase schema | Written; run it once, see DEPLOY.md step 1 |
| All 13 agents with rules as executable logic | Built |
| Facebook, X connectors | Full logic and publishing code built, **inactive until API keys are set** |
| LinkedIn | Integration point built, **agent is an external build** |
| Site write access | Edits written in full and queued, **no site platform named in the doc** — see docs/OPEN-ITEMS.md |
| Authentication | None, by design. Unguessable URL only. Where it goes later is marked in `src/index.ts`. |
