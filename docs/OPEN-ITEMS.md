# Things the architecture doc does not settle

Kept here rather than guessed at. Each one has a note on what was built in the
meantime, so nothing is blocked waiting on an answer.

## 1. What platform does the website run on?

The SEO / Site agent is given write access: "can make changes directly rather
than only suggesting them". But no site platform is named anywhere in the doc,
and no site credentials appear in the Credentials & Build Scope table. Webflow,
WordPress and a static repo are three different integrations, and there was no
way to pick one correctly.

**Built instead:** the agent runs in full. It inventories pages, finds real
issues (missing or badly sized meta descriptions, missing alt text, orphan
pages), drafts the fix through the voice profile, and applies its own routine /
protected-page rules to each one. Every edit is written out completely — page,
exact before, exact after — into the site change queue, where it waits.
Connecting a real platform means implementing the `SiteWriter` interface in
`src/connectors/site.ts` once. Nothing else changes.

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

## 5. Content pillars and FAQ library are seeded, not given

The doc's routine line for the content agent is "drafting within established
topics", and for the FAQ agent "answering known questions in already-approved
language". Neither list exists in the doc.

**Built as:** both are seeded with reasonable starting sets in
`src/core/config.ts` — five content pillars, five FAQ entries — and both are
plain code you edit. Widening either is itself an approval decision, which is
why an agent cannot edit them at runtime. Anything outside them is queued, so a
short list is safe rather than limiting.

## 6. Voice profile: Option A or Option B

The doc's own Open Item 01. You said to set the open items aside for now, so the
system uses the doc's Option B: a deliberately non-AI-sounding default voice,
written to be corrected once you see it in action.

It lives in one file, `src/core/voice.ts`, as a style guide plus a set of
mechanical checks that run over every draft before it can be published. Moving to
Option A later means replacing that one file's contents with a profile built from
your own writing. No agent code changes.
