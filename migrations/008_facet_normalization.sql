-- Case-insensitive facet matching (Gmail/gmail/GMAIL must all match) + the extra
-- retrieval facets used by the recommend pipeline (uses_ai, primary_channels, use_case).
--
-- match_templates_faceted grows from the 8-param version in 004 to 11 params:
--   filter_uses_ai          hard "client said no AI" constraint (never relaxed)
--   filter_primary_channels channel the business pain arrives through (instagram, whatsapp, …)
--   filter_use_case         inferred use case (inbound_support, scheduling, reporting, …)
-- The 8-param signature from 004 is dropped first: leaving both overloads in place makes
-- named-argument RPC calls ambiguous.
--
-- The three new template columns are enrichment facets. The ingestion scripts in this repo
-- do not populate them yet; `uses_ai` falls back to `has_ai` (backfill + trigger below) so
-- the hard filter behaves sensibly, and rows with null `primary_channels` / `use_case` simply never match
-- those filters (the recommend pipeline's fallback ladder relaxes them automatically).

alter table public.templates add column if not exists uses_ai boolean;
alter table public.templates add column if not exists primary_channels text[];
alter table public.templates add column if not exists use_case text;
alter table public.templates add column if not exists summary text;

update public.templates set uses_ai = has_ai where uses_ai is null;

-- Keep uses_ai filled for rows loaded later (e.g. by load-supabase), without overriding an
-- explicit value from an enrichment step.
create or replace function public.templates_default_uses_ai() returns trigger
language plpgsql as $$
begin
  if new.uses_ai is null then new.uses_ai := new.has_ai; end if;
  return new;
end;
$$;

drop trigger if exists templates_default_uses_ai on public.templates;
create trigger templates_default_uses_ai
  before insert or update on public.templates
  for each row execute function public.templates_default_uses_ai();

create index if not exists templates_primary_channels_gin on public.templates using gin (primary_channels);

drop function if exists public.match_templates_faceted(
  vector, integer, text, text[], text[], boolean, text, boolean);

create or replace function public.lower_array(arr text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(lower(x)), '{}') from unnest(arr) as t(x);
$$;

alter table public.templates
  add column if not exists integrations_norm text[]
  generated always as (public.lower_array(coalesce(integrations, '{}'))) stored;

alter table public.templates
  add column if not exists trigger_type_norm text[]
  generated always as (public.lower_array(coalesce(trigger_type, '{}'))) stored;

create index if not exists templates_integrations_norm_gin on public.templates using gin (integrations_norm);
create index if not exists templates_trigger_norm_gin      on public.templates using gin (trigger_type_norm);

-- filter_integrations / filter_trigger compare against the *_norm (lowercased) columns
-- instead of the raw arrays.
create or replace function public.match_templates_faceted(
  query_embedding vector,
  match_count integer default 12,
  filter_category text default null,
  filter_integrations text[] default null,
  filter_trigger text[] default null,
  filter_is_rag boolean default null,
  filter_source text default null,
  filter_uses_ai boolean default null,
  filter_primary_channels text[] default null,
  filter_use_case text default null,
  exclude_unmaintained boolean default true
)
returns table (
  id text, source text, name text, category text, tags text[], integrations text[],
  trigger_type text[], has_ai boolean, is_rag boolean, uses_ai boolean, primary_channels text[],
  use_case text, description text, import_ref text, popularity integer, similarity double precision
)
language plpgsql as $$
declare
  v_integrations text[] := (select array_agg(lower(x)) from unnest(filter_integrations) x);
  v_trigger text[]      := (select array_agg(lower(x)) from unnest(filter_trigger) x);
begin
  return query
  select t.id, t.source, t.name, t.category, t.tags, t.integrations, t.trigger_type,
         t.has_ai, t.is_rag, t.uses_ai, t.primary_channels, t.use_case, t.description,
         t.import_ref, t.popularity,
         1 - (t.embedding <=> query_embedding) as similarity
  from public.templates t
  where t.embedding is not null
    and (filter_category         is null or t.category ilike filter_category)
    and (filter_integrations     is null or t.integrations_norm && v_integrations)
    and (filter_trigger          is null or t.trigger_type_norm && v_trigger)
    and (filter_is_rag           is null or t.is_rag = filter_is_rag)
    and (filter_source           is null or t.source = filter_source)
    and (filter_uses_ai          is null or t.uses_ai = filter_uses_ai)
    and (filter_primary_channels is null or t.primary_channels && filter_primary_channels)
    and (filter_use_case         is null or t.use_case = filter_use_case)
    and (not exclude_unmaintained or t.unmaintained is not true)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
