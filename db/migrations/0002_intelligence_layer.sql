-- VX-03 — Intelligence layer
--
-- Two changes, and they must both land before the Competitive Intelligence
-- agent is deployed. The agent checks for this migration before it does
-- anything and stops with a readable message if it is missing, rather than
-- failing halfway through a run.
--
--   1. A fourth batch, 'intelligence'. reports and pending_approvals both
--      constrain agent_batch, so a new batch is a schema change, not just a
--      TypeScript union. Rather than widen the list every time, the CHECK is
--      dropped: application code owns the vocabulary (src/core/types.ts), and
--      duplicating it here only ever produced a constraint violation the day
--      someone forgot to run a migration.
--
--   2. intel_briefs — the library. A fourth table, and the architecture doc's
--      "three tables, no more" is being departed from deliberately:
--
--      The obvious alternative was to put briefs in `memory`, which already
--      stores JSON by key. That is wrong here. Every agent's run pulls memory
--      rows into its prompt by salience, so a full multi-page brief in that
--      table would be read, and paid for, by every other agent on every tick.
--      A brief is a document to be retrieved deliberately, not context to be
--      broadcast. It gets its own table and a one-line pointer note in memory.
--
-- Safe to re-run: every statement is guarded.

-- ---------------------------------------------------------------------------
-- 1. Let a new batch exist without a migration next time.
-- ---------------------------------------------------------------------------
alter table public.reports           drop constraint if exists reports_agent_batch_check;
alter table public.pending_approvals drop constraint if exists pending_approvals_agent_batch_check;

comment on column public.reports.agent_batch is
  'marketing | sales_management | executive | intelligence | orchestration. '
  'Vocabulary owned by src/core/types.ts; deliberately not constrained here.';
comment on column public.pending_approvals.agent_batch is
  'marketing | sales_management | executive | intelligence | orchestration. '
  'Vocabulary owned by src/core/types.ts; deliberately not constrained here.';

-- ---------------------------------------------------------------------------
-- 2. intel_briefs — the Competitive Intelligence agent's library.
--
-- `document` holds the whole structured brief exactly as it was composed, so a
-- brief read a year later is the brief that was written, not a reconstruction.
-- The columns beside it are the ones worth querying and sorting on.
-- ---------------------------------------------------------------------------
create table if not exists public.intel_briefs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- The cycle this brief covers. One brief per date: a re-run on the same day
  -- revises that day's brief rather than filing a near-duplicate beside it.
  brief_date    date not null unique,

  title         text not null,
  headline      text not null,

  -- The full IntelBrief. See src/core/intel.ts for the shape.
  document      jsonb not null default '{}'::jsonb,

  -- Denormalised counts, so the library list does not have to open every
  -- document to say what is in it.
  gap_count     int not null default 0,
  move_count    int not null default 0,
  source_count  int not null default 0,

  -- Provenance. What it looked at, and what it cost.
  sources_watched int not null default 0,
  sources_changed int not null default 0,
  web_research  boolean not null default false,
  searches_used int not null default 0,
  model         text,
  cost_usd      numeric(10, 6) not null default 0,

  run_id        uuid
);

create index if not exists intel_briefs_date_idx    on public.intel_briefs (brief_date desc);
create index if not exists intel_briefs_created_idx on public.intel_briefs (created_at desc);

-- Same posture as the other three tables: RLS on, no policies. The Worker
-- reaches this with the service role key, which bypasses RLS; an anon key that
-- leaked would read nothing.
alter table public.intel_briefs enable row level security;
