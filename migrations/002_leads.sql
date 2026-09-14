-- Leads + recommendations schema for the intake → RAG → quote funnel
-- Companion to 001_templates.sql. See docs/SOLUTION_ARCHITECTURE.md and
-- docs/INTAKE_QUESTIONNAIRE.md.
--
-- SECURITY: both tables below hold personal data (contact name, email, company,
-- budget, urgency, decision role). They are written ONLY by the recommend edge
-- function using the service role key, which bypasses RLS. No client-side or
-- anon-key access is intended. Row level security is enabled at the bottom of
-- this file with no policies, so PostgREST returns zero rows to anon and
-- authenticated callers. Do not add a permissive policy without first deciding
-- who is allowed to read leads.

-- ── Leads (created from the structured intake; see INTAKE_QUESTIONNAIRE.md) ──
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  -- Block A — identity
  company text,
  niche text,
  country text,
  city text,
  team_size text,
  contact_name text,
  email text,
  -- Block B — pain (feeds the RAG query)
  pain_primary text,
  pain_secondary text,
  pain_volume text,
  pain_time_each text,
  pain_cost text,
  -- Block C — technical context (refines matching)
  current_tools text[] default '{}',
  input_channels text[] default '{}',
  output_targets text[] default '{}',
  hosting_pref text,
  wants_ai text,                      -- C5: ninguna | ia | rag
  -- Block D — commercial qualification
  urgency text,
  budget_band text,
  decision_role text,
  -- funnel / promo control
  free_credits_used integer default 0,
  email_verified boolean default false,
  status text default 'new',          -- new | recommended | contacted | audit_paid | won | lost
  source text,                        -- where the intake came from, e.g. web
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists leads_niche_idx on public.leads (niche);
create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_email_idx on public.leads (email);

-- ── Recommendations (one synthesized result per intake run) ──
create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads (id) on delete cascade,
  query_text text,                    -- the text-query built from the intake
  -- LLM structured output (see SOLUTION_ARCHITECTURE.md §4 step 3)
  summary text,
  recommended_software jsonb default '[]'::jsonb,   -- [{id,name,why}]
  recommended_workflows jsonb default '[]'::jsonb,  -- [{import_ref,name,why}]
  suggested_stack text,
  complexity text,                    -- Baja | Media | Alta
  implementation_days integer,
  price_estimate jsonb,               -- {setup_usd:[min,max], care_plan_usd_mo:[min,max]}
  tier text,                          -- Audit | Single Automation | System
  -- the raw RAG hits that grounded this recommendation (for traceability)
  matched_template_ids text[] default '{}',
  -- cost / gating
  llm_model text,
  was_paid boolean default false,     -- false = served from the free promo credits
  created_at timestamptz default now()
);

create index if not exists recommendations_lead_idx on public.recommendations (lead_id);

-- ── Row level security ──
alter table public.leads enable row level security;
alter table public.recommendations enable row level security;
-- Deny by default: RLS on with no policy means anon/authenticated get zero
-- rows. The edge function uses the service role key, which bypasses RLS.
