-- Faceted columns + hybrid (filter-first, semantic-rank) retrieval.
-- Companion to 001_templates.sql. See docs/INGESTION_AND_TAGGING.md.

-- ── Facet columns derived deterministically during ingestion ──
alter table public.templates add column if not exists trigger_type text[] default '{}';
alter table public.templates add column if not exists output_targets text[] default '{}';
alter table public.templates add column if not exists has_ai boolean default false;
alter table public.templates add column if not exists is_rag boolean default false;
alter table public.templates add column if not exists license text;        -- self-hosted only
alter table public.templates add column if not exists stack text;          -- self-hosted only
alter table public.templates add column if not exists unmaintained boolean default false;

-- GIN indexes so array-overlap (&&) facet filters stay fast
create index if not exists templates_integrations_gin on public.templates using gin (integrations);
create index if not exists templates_trigger_gin       on public.templates using gin (trigger_type);
create index if not exists templates_tags_gin          on public.templates using gin (tags);
create index if not exists templates_has_ai_idx        on public.templates (has_ai);
create index if not exists templates_is_rag_idx        on public.templates (is_rag);

-- ── Hybrid match: hard facet WHERE first, semantic ranking second ──
-- Pass null for any facet to ignore it. Array facets use overlap (&&).
create or replace function public.match_templates_faceted(
  query_embedding vector(1536),
  match_count integer default 12,
  filter_category text default null,
  filter_integrations text[] default null,
  filter_trigger text[] default null,
  filter_is_rag boolean default null,
  filter_source text default null,
  exclude_unmaintained boolean default true
)
returns table (
  id text,
  source text,
  name text,
  category text,
  tags text[],
  integrations text[],
  trigger_type text[],
  has_ai boolean,
  is_rag boolean,
  description text,
  import_ref text,
  popularity integer,
  similarity double precision
)
language plpgsql
as $$
begin
  return query
  select
    t.id, t.source, t.name, t.category, t.tags, t.integrations,
    t.trigger_type, t.has_ai, t.is_rag, t.description, t.import_ref, t.popularity,
    1 - (t.embedding <=> query_embedding) as similarity
  from public.templates t
  where t.embedding is not null
    and (filter_category    is null or t.category ilike filter_category)
    and (filter_integrations is null or t.integrations && filter_integrations)
    and (filter_trigger     is null or t.trigger_type && filter_trigger)
    and (filter_is_rag      is null or t.is_rag = filter_is_rag)
    and (filter_source      is null or t.source = filter_source)
    and (not exclude_unmaintained or t.unmaintained is not true)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
