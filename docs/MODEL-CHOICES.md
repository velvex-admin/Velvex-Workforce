# Model choices

Not every agent needs the strongest model. Running all thirteen on Opus 5 would
be paying reasoning-tier prices to divide two numbers and to describe a JPEG.

Three tiers, and a fourth answer that turns out to matter most: no model at all.

| Tier | Model | Price in / out per MTok | What belongs here |
|---|---|---|---|
| Reasoning | `claude-opus-5` | $5 / $25 | Public writing in the Velvex voice, and judgement that is expensive to get wrong |
| Balanced | `claude-sonnet-5` | $3 / $15 | Competent reading and writing inside tight, well-specified bounds |
| Fast | `claude-haiku-4-5` | $1 / $5 | Mechanical, high-volume, low-stakes work |
| None | — | — | Arithmetic, clocks, threshold checks, and an external build |

Tier ids live in `src/core/models.ts` and can be overridden per deployment with
`MODEL_REASONING`, `MODEL_BALANCED` and `MODEL_FAST` in `wrangler.toml`, so a
whole tier can move without touching code.

## Per agent

| Agent | Model | Effort | Why this one |
|---|---|---|---|
| Content | Opus 5 | `xhigh` | Writes public copy in a specific institutional voice. Two drafts a day, and the most visible thing the system produces when it is wrong. Cheap to do properly. |
| Social Engagement | Opus 5 | `xhigh` | Public replies carrying a judgement about what they are replying to. The register has to be right in front of an audience that includes prospects. |
| Growth-Strategy | Opus 5 | `max` | Weekly, and its entire output is a judgement read across marketing and sales together. Four calls a month is the cheapest place in the system to buy depth. |
| Competitive Intelligence | Opus 5 | `high` researching, `max` composing | Weekly, and the only agent whose subject is outside this system. Two passes on purpose: the research pass carries the web tools and no schema, the composing pass carries the schema and no tools. Effort is split because gathering benefits less from depth than deciding what the gathering means. A wrong read here is expensive in a way that does not show up for months, and a fabricated competitor would put a decision in front of the owner based on nothing. |
| Chief-of-Staff | Opus 5 | `high` | Decides what reaches you and what stays in the log. Filtering badly is worse than not filtering. |
| SEO / Site | Sonnet 5 | `high` | A meta description has a length, a subject and a page to match. Bounded work with a clear target, and every protected-page edit is queued for you anyway. |
| Marketing Analytics | Sonnet 5 | `medium` | The aggregation is deterministic. Only the four-sentence read needs a model, and you are the only reader. |
| Objection / FAQ | Sonnet 5 | `high` | Matching a question to an approved answer, and drafting a candidate when none fits. Every new answer is reviewed by you before it is used, so the reasoning tier would be paying twice for the same safety. |
| Finance-Watch | Sonnet 5 | `medium` | The guardrail is arithmetic and runs before any model is called. The model writes three sentences about the ratio. |
| Facebook, X | none | — | Deciding whether a slot is due and picking the oldest unpublished draft is a clock and a list. The copy already came through the content agent. |
| Lead / Pipeline | none | — | A stall is a subtraction against a threshold. Paying a model to restate arithmetic would buy nothing and add a failure mode. |
| Ops-Health | none | — | Error rate against a threshold, stuck cases against a count, hourly. Exactly where a needless call adds up. |
| LinkedIn | none | — | External build. Somebody else's model cost. |

Two shared calls sit below their agents:

| Call | Model | Why |
|---|---|---|
| The judge (`categorize`) | Sonnet 5 | Short, single-question classification. Safety here comes from the confidence floor, not from model depth. |
| Spam triage | Haiku 4.5 | Runs on every inbound message before anything expensive does. It can only ever say "definitely spam" at 90% confidence; unsure answers and failures fall through to the real judge, so the saving costs nothing in safety. |

## Capability differences, which are errors and not degradations

Haiku 4.5 predates adaptive thinking and the `effort` parameter. Sending either
returns a 400, not a worse answer. `buildRequest()` in `src/lib/claude.ts` is the
one place that knows this, and `test/models.test.ts` holds it to it:

- current-generation models get `thinking: {type: "adaptive"}` and `output_config.effort`
- Haiku gets neither, and still gets its JSON schema
- an unrecognised model id is treated as current generation, which is the safe
  assumption for anything newer

## What this costs

Every call records its own cost, and each agent run reports what it spent, so
this stops being an estimate as soon as the system runs. Rough monthly figures at
a plausible starting volume (two drafts a day, twenty inbound messages a day,
daily monitoring, weekly strategy):

| Agent | Tier | ~$/month |
|---|---|---|
| Social Engagement (replies, judge, triage) | mixed | 5.40 |
| Content | reasoning | 1.80 |
| Chief-of-Staff | reasoning | 1.80 |
| SEO / Site | balanced | 0.90 |
| Competitive Intelligence | reasoning + web | 3.00 |
| Growth-Strategy | reasoning | 0.50 |
| Objection / FAQ | balanced | 0.30 |
| Marketing Analytics | balanced | 0.25 |
| Finance-Watch | balanced | 0.20 |
| Lead/Pipeline, Ops-Health, Site-Integrity | none | 0.00 |
| **Total** | | **≈ $14** |

The three channel strategists are not in that table. They were written after it,
when the owner widened the channel agents from "publish what is already
approved" to owning their platform end to end, and what they cost depends on how
often the draft shelf actually needs refilling rather than on how often they
wake. Every run records its own spend, so that number should be read off the
reports table rather than guessed at here. Facebook is dormant and costs
nothing until `FACEBOOK_ENABLED` is true.

Competitive Intelligence is the largest single line after Social Engagement, and
it is the one line that is not purely tokens. Its research pass may run up to
eight web searches, billed at $10 per 1,000 on top of the tokens the results
consume, which is about eight cents a month. The rest is two Opus passes a week
over a lot of retrieved text. `INTEL_WEB_RESEARCH_ENABLED="false"` in
`wrangler.toml` drops it to roughly a third of that, and the agent then works
from the watchlist alone and says so in the brief.

Running the same work entirely on Opus 5 lands around $16 to $17. The saving is
about a third today, and it widens as volume grows: the tiered calls are the ones
that scale with inbound messages and site pages, while the reasoning-tier calls
are fixed at two drafts a day and one roll-up.

The larger saving is the fourth tier. Three of fifteen agents make no model calls
at all, and two of the three hourly monitors are among them. An implementation
that reflexively put a model behind every agent would spend more on Ops-Health
checking a threshold every hour than on writing all the public copy.

## Two principles behind the table

**Confidence floors do the safety work, not model size.** The engagement agent
will not act on a category call below 85% confidence, and the FAQ agent will not
answer from the library below 80%. A stronger model raises the average quality of
the call; the floor is what stops a bad call reaching the public.

**Every judgement failure resolves toward asking you.** If the model is
unreachable, or a rule cannot be evaluated, the action is queued rather than
taken. That property is what makes it safe to run the cheap tier where the cheap
tier is enough.
