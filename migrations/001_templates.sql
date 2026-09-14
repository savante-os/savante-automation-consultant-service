-- Template RAG index schema for Supabase pgvector
create extension if not exists vector;

create table if not exists public.templates (
  id text primary key,
  source text not null,
  name text not null,
  category text,
  tags text[] default '{}',
  integrations text[] default '{}',
  description text,
  import_ref text not null,
  popularity integer default 0,
  content text not null,
  embedding vector(1536),
  updated_at timestamptz default now()
);

create index if not exists templates_category_idx on public.templates (category);
create index if not exists templates_source_idx on public.templates (source);

create index if not exists templates_embedding_idx
  on public.templates
  using hnsw (embedding vector_cosine_ops);

create or replace function public.match_templates(
  query_embedding vector(1536),
  match_count integer default 8,
  filter_category text default null
)
returns table (
  id text,
  source text,
  name text,
  category text,
  tags text[],
  integrations text[],
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
    t.id,
    t.source,
    t.name,
    t.category,
    t.tags,
    t.integrations,
    t.description,
    t.import_ref,
    t.popularity,
    1 - (t.embedding <=> query_embedding) as similarity
  from public.templates t
  where t.embedding is not null
    and (filter_category is null or t.category ilike filter_category)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
