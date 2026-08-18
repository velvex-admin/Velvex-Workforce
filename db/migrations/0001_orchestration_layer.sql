-- VX-03 — Orchestration Layer schema
-- Architecture doc, "Orchestration Layer": three tables, no more.
--   reports           routine activity log from every agent
--   memory            durable context the Chief-of-Staff keeps and queries
--   pending_approvals anything outside an agent's routine scope, waiting on you
--
-- Safe to re-run: every statement is guarded.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- reports — the record of what has been done.
-- Only routine activity lands here. Anything needing a decision goes to
-- pending_approvals instead; that split is enforced in application code by the
-- Chief-of-Staff filter (src/agents/orchestration/chief-of-staff.ts).
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  agent_id      text not null,
  agent_batch   text not null
                check (agent_batch in ('marketing','sales_management','executive','orchestration')),

  action_type   text not null,
  summary       text not null,
  detail        jsonb not null default '{}'::jsonb,

  -- How the autonomy boundary classified the action that produced this report.
  -- 'routine' is the normal case. 'approved' means it was queued, you approved
  -- it, and this is the record of it actually running.
  classification text not null default 'routine'
                check (classification in ('routine','approved')),

  outcome       text not null default 'executed'
                check (outcome in ('executed','observed','no_op','failed','blocked_inactive')),

  channel       text,          -- 'linkedin' | 'facebook' | 'x' | 'site' | null
  external_ref  text,          -- post id, page path, etc.
  approval_id   uuid,          -- set when this action came out of the queue
  run_id        uuid,          -- groups everything one scheduled tick produced

  model         text,
  effort        text,
  usage         jsonb,

  error         text
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_agent_idx      on public.reports (agent_id, created_at desc);
create index if not exists reports_batch_idx      on public.reports (agent_batch, created_at desc);
create index if not exists reports_run_idx        on public.reports (run_id);

-- ---------------------------------------------------------------------------
-- memory — what makes continuity possible at all.
-- Every agent run starts with no memory of the last one; the Chief-of-Staff
-- reads and writes this table so the system has a past.
-- ---------------------------------------------------------------------------
create table if not exists public.memory (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Stable handle so an agent can overwrite its own note instead of
  -- accumulating near-duplicates: e.g. 'marketing.pillars', 'pipeline.stalled'.
  key           text not null unique,
  scope         text not null default 'global',   -- 'global' or an agent id

  kind          text not null default 'fact'
                check (kind in ('fact','decision','preference','pattern','voice','entity','metric')),

  content       text not null,
  detail        jsonb not null default '{}'::jsonb,

  -- 1..10. The Chief-of-Staff pulls high-salience memory first when it builds
  -- context for another agent.
  salience      int not null default 5 check (salience between 1 and 10),

  source_agent  text,
  tags          text[] not null default '{}',
  expires_at    timestamptz,
  superseded_by uuid references public.memory (id) on delete set null
);

create index if not exists memory_scope_idx    on public.memory (scope, salience desc);
create index if not exists memory_kind_idx     on public.memory (kind);
create index if not exists memory_tags_idx     on public.memory using gin (tags);
create index if not exists memory_updated_idx  on public.memory (updated_at desc);

create or replace function public.memory_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists memory_touch_updated_at on public.memory;
create trigger memory_touch_updated_at
  before update on public.memory
  for each row execute function public.memory_touch_updated_at();

-- ---------------------------------------------------------------------------
-- pending_approvals — anything outside an agent's routine scope.
-- `action` holds the exact proposal, so approving it executes the thing that
-- was actually reviewed rather than something reconstructed later.
-- ---------------------------------------------------------------------------
create table if not exists public.pending_approvals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  agent_id      text not null,
  agent_batch   text not null
                check (agent_batch in ('marketing','sales_management','executive','orchestration')),

  title         text not null,
  rationale     text not null,          -- why the agent wants this
  action        jsonb not null,         -- the ProposedAction, executed verbatim on approval

  -- Which approval rule fired, by id, e.g. 'seo.pricing_or_legal_page'.
  -- Recorded so the boundary itself can be audited, not just its outcomes.
  trigger_rule  text not null,
  trigger_reason text not null default '',

  risk          text not null default 'medium' check (risk in ('low','medium','high')),

  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','executed','failed','expired')),

  -- Stops the same proposal re-queueing on every tick.
  dedupe_key    text unique,

  decided_at    timestamptz,
  decided_by    text,
  decision_note text,

  executed_at   timestamptz,
  execution_result jsonb,
  error         text
);

create index if not exists pending_approvals_status_idx on public.pending_approvals (status, created_at desc);
create index if not exists pending_approvals_agent_idx  on public.pending_approvals (agent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lock the tables down. The Worker talks to Supabase with the service role key,
-- which bypasses RLS. Enabling RLS with no policies means the anon/public key
-- can read and write nothing, even if it ever leaks.
-- ---------------------------------------------------------------------------
alter table public.reports           enable row level security;
alter table public.memory            enable row level security;
alter table public.pending_approvals enable row level security;
