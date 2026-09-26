-- Full retrieval traceability per recommendation, so you can reconstruct exactly
-- what the LLM saw (query, filters, fallback level, candidates, rejected citations)
-- without re-running the pipeline.
--
-- `matched_template_ids` (existing column) is left as-is for backward compatibility
-- (workflows only, legacy). `retrieval_trace.software_candidates` is the new field that
-- fixes that asymmetry going forward.

alter table public.recommendations
  add column if not exists retrieval_trace jsonb default '{}'::jsonb;

comment on column public.recommendations.retrieval_trace is
  'Shape: {query_text, filters_applied, fallback_level, candidates:[{id,name,similarity}], '
  'software_candidates:[{id,name,similarity}], rejected_citations:[{type,ref,name}], llm_retries}';

create index if not exists recommendations_retrieval_trace_gin
  on public.recommendations using gin (retrieval_trace);
