# Things the architecture doc does not settle

Kept here rather than guessed at. Each one has a note on what was built in the
meantime, so nothing is blocked waiting on an answer.

## 1. How does the SEO agent write to the site?

The SEO / Site agent is given write access: "can make changes directly rather
than only suggesting them". The architecture doc names no platform, though the
live site is now known: velvex-site.netlify.app, a static build on Netlify.

That narrows it without settling it. Writing to a Netlify site means either
committing to the repository that builds it, or using the Netlify API with a
token. The site's repository is not this one, and this session was asked to work
only in Velvex-Workforce, so neither path was taken.

**Built instead:** the agent runs in full. It inventories pages, finds real
issues (missing or badly sized meta descriptions, missing alt text, orphan
pages), drafts the fix through the voice profile, and applies its own routine and
protected-page rules to each one. Every edit is written out completely, page,
exact before, exact after, into the site change queue, where it waits.

Wiring it up means implementing the `SiteWriter` interface in
`src/connectors/site.ts` once, against whichever you prefer: a commit to the
site's repository, or the Netlify API. Tell me which and it is a small job.

One thing worth knowing either way: `/faq` on the live site carries the $999
price, the money-back guarantee and the confidentiality commitment. It is a
pricing and contract-adjacent page wearing a different name, so it is on the
protected list and every edit to it is queued for you.

## 2. Where does the pipeline, finance and site data come from?

The doc has the Lead/Pipeline agent tracking "the outcome states already defined
in the operations dashboard", and Finance-Watch tracking "margins, PayPal flow,
and cost-per-client". Both of those live in Phase 0 systems that this project is
explicitly not to touch, and no read path from them is specified.

**Built instead:** a push interface. `PUT /api/state/<key>` accepts a JSON
snapshot; the shapes are in `src/core/state.ts`. n8n can post these on a
schedule without this project ever holding a Phase 0 credential. Until data
arrives, each agent reports plainly that it has none rather than inventing
figures.

## 3. How does the Ops-Health agent watch the operations pipeline?

The doc has it watching n8n and Supabase for error rates and stuck cases,
"separate from, and reporting alongside" the Phase 0 error workflow. Reading
those directly would mean wiring Phase 0 credentials into this project, which
the build scope rules out.

**Built instead:** the agent reads a single read-only status endpoint,
configured through `OPS_PIPELINE_STATUS_URL`, and is inactive until one exists.
It only ever issues GET requests, and the runner's observe-only guard stops it
acting on anything it finds. Exposing a small status endpoint from the
operations side is the intended way to switch it on.

## 4. Who delivers an answer to a prospect?

The Objection / FAQ agent "maintains and uses" approved answers, but the doc
also says any direct client-facing action needs approval, and Apollo and Clay
own the outreach sequence.

**Built as:** the agent prepares the answer in approved language and records it.
It does not contact anyone. Whatever is already talking to the prospect reads the
answer from the report. Direct contact stays behind the approval line, which
matches Open Item 02's stated position in the doc.

## 5. Content pillars and the FAQ library (resolved from the live site)

The doc's routine line for the content agent is "drafting within established
topics", and for the FAQ agent "answering known questions in already-approved
language". Neither list exists in the doc, and both were seeded on guesswork in
the first build.

**Now taken from the site.** The FAQ library is the live site's own eight
questions and answers, word for word: that is the strongest available reading of
"already-approved language", since it is text the business has already published
under its own name. The five content pillars are drawn from what the site
actually claims and sells (structural architecture, margin and unit economics,
channel dependency, scale readiness, the diagnostic standard itself). Both still
live in `src/core/config.ts` and are plain code you edit, because widening either
is an approval decision in its own right.

Everything the agents assert about the business now comes from one file,
`src/core/business.ts`: the offer, the $999 price, the 24-hour turnaround, the
Executive Ledger, the Veĺa engine, the money-back guarantee. If any of that
changes on the site, change it there and every agent follows.

## 6. The voice profile bans em dashes; the site uses them

Worth a decision, and it is a one-line change either way.

The architecture doc is explicit that "as human as possible" means avoiding the
robotic AI tells, "em dashes and all". The live Velvex site uses em dashes
freely, in headline copy: "Your structure either holds under scale— or it
doesn't."

The spec was followed: em dashes are banned, and the mechanical check strips them
before any draft can be published. If the site's usage is the real house style,
set `allowEmDash: true` in `src/core/voice.ts` and the check stops firing.

Separately, the voice guide itself has been rewritten to match the register the
site actually uses: declarative, structural vocabulary, no founder anecdotes, no
selling. The earlier draft was written for a friendly small-business consultancy
and would have sounded wrong next to the site.

## 7. Voice profile: Option A or Option B

The doc's own Open Item 01. You said to set the open items aside for now, so the
system uses the doc's Option B: a deliberately non-AI-sounding default voice,
written to be corrected once you see it in action.

It lives in one file, `src/core/voice.ts`, as a style guide plus a set of
mechanical checks that run over every draft before it can be published. Moving to
Option A later means replacing that one file's contents with a profile built from
your own writing. No agent code changes.
