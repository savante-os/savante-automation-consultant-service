-- MCP catalog API keys + request log.
-- Companion to 001/003/004 (templates + match_templates_faceted).
-- See docs/MCP_CATALOG.md Phase 1. Invite-only keys for v1 (no signup UI).
--
-- Auth for callers is hashed API keys (sav_live_…), not the Supabase anon JWT.
-- The edge function uses a server-side service_role (or a restricted JWT) in
-- function secrets — never in client mcp.json.
--
-- Retention: mcp_request_log is intended for ~90 days (purge later; no cron here).

create table if not exists public.mcp_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  plan text not null default 'free',  -- free | paid
  created_at timestamptz default now(),
  constraint mcp_users_plan_chk check (plan in ('free', 'paid'))
);

create table if not exists public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.mcp_users (id) on delete cascade,
  name text,                          -- e.g. "Cursor"
  key_prefix text not null,           -- first ~16 chars, e.g. sav_live_abcd12
  key_hash text not null unique,      -- sha256 hex of the full secret
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists mcp_api_keys_user_idx on public.mcp_api_keys (user_id);
create index if not exists mcp_api_keys_prefix_idx on public.mcp_api_keys (key_prefix);

create table if not exists public.mcp_request_log (
  id bigint generated always as identity primary key,
  at timestamptz default now(),
  api_key_id uuid references public.mcp_api_keys (id) on delete set null,
  user_id uuid references public.mcp_users (id) on delete set null,
  tool text not null,                 -- search_automations | search_software | get_template
  status int not null,                -- 200, 400, 401, 403, 404, 429, 500
  latency_ms int,
  result_count int,
  -- facets only, not the user's full chat / pain text
  filters jsonb default '{}'::jsonb
);

create index if not exists mcp_request_log_user_at on public.mcp_request_log (user_id, at desc);
create index if not exists mcp_request_log_key_at on public.mcp_request_log (api_key_id, at desc);
create index if not exists mcp_request_log_key_tool_at
  on public.mcp_request_log (api_key_id, tool, at desc);

-- Sliding 24h usage for rate limits (successful searches only).
create or replace function public.mcp_usage_count(
  p_api_key_id uuid,
  p_tools text[],
  p_since timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.mcp_request_log
  where api_key_id = p_api_key_id
    and tool = any (p_tools)
    and status = 200
    and at >= p_since;
$$;

-- Oldest successful call in the window (for Retry-After).
create or replace function public.mcp_usage_oldest_at(
  p_api_key_id uuid,
  p_tools text[],
  p_since timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select min(at)
  from public.mcp_request_log
  where api_key_id = p_api_key_id
    and tool = any (p_tools)
    and status = 200
    and at >= p_since;
$$;

-- Public catalog columns only — never `content` / workflow graph.
create or replace view public.templates_public as
select
  id,
  source,
  name,
  category,
  tags,
  integrations,
  trigger_type,
  has_ai,
  is_rag,
  description,
  import_ref,
  popularity
from public.templates;

revoke all on public.mcp_users from anon, authenticated;
revoke all on public.mcp_api_keys from anon, authenticated;
revoke all on public.mcp_request_log from anon, authenticated;
revoke all on public.templates_public from anon, authenticated;
revoke all on function public.mcp_usage_count(uuid, text[], timestamptz) from anon, authenticated;
revoke all on function public.mcp_usage_oldest_at(uuid, text[], timestamptz) from anon, authenticated;

alter table public.mcp_users enable row level security;
alter table public.mcp_api_keys enable row level security;
alter table public.mcp_request_log enable row level security;

-- No policies for anon/authenticated: fail closed. service_role bypasses RLS.
-- Later OAuth can add: using (user_id = auth.uid()) on mcp_api_keys.

comment on table public.mcp_users is 'Identity for MCP/GPT Action API keys. One row per person (or workspace).';
comment on table public.mcp_api_keys is 'Hashed API keys (sav_live_…). Secret shown once at issue time.';
comment on table public.mcp_request_log is 'Per-call usage. Facets + counts only. Target retention ~90 days.';
comment on view public.templates_public is 'Catalog fields safe to return from the MCP search API (no content).';
