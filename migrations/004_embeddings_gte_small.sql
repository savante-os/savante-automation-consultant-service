-- Switch the RAG index to gte-small (384-dim) embeddings and add semantic ranking
-- to the faceted match. gte-small runs locally (Transformers.js) for ingestion AND
-- is built into Supabase Edge Functions (Supabase.ai) for the query — no OpenAI key.
-- See docs/INGESTION_AND_TAGGING.md and service/.

-- Re-define the embedding column at 384 dims (1536 was OpenAI's text-embedding-3-small).
-- Safe to drop/recreate while the table is still unpopulated.
drop index if exists public.templates_embedding_idx;
alter table public.templates drop column if exists embedding;
alter table public.templates add column embedding vector(384);

create index if not exists templates_embedding_idx
  on public.templates using hnsw (embedding vector_cosine_ops);

-- Faceted hard filter + semantic ranking. Pass the 384-dim query embedding.
-- Drop the old 1536 signature from migration 003 first.
drop function if exists public.match_templates_faceted(
  vector, integer, text, text[], text[], boolean, text, boolean);

create or replace function public.match_templates_faceted(
  query_embedding vector(384),
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
