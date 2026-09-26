-- Extras for the MCP catalog API (companion to 005_mcp_keys.sql):
-- categories lookup (for the list_categories tool) and a usage-by-day view
-- (for admin/pricing observability). See docs/MCP_CATALOG.md.

-- Distinct catalog categories + row counts, from the public-safe view only.
create or replace function public.list_template_categories()
returns table (category text, count integer)
language sql
stable
security definer
set search_path = public
as $$
  select category, count(*)::int
  from public.templates_public
  where category is not null
  group by category
  order by count(*) desc, category asc;
$$;

revoke all on function public.list_template_categories() from anon, authenticated;

-- Usage by day, joined out to the human account (email) and plan, for pricing/abuse review.
create or replace view public.mcp_usage_by_day as
select
  date_trunc('day', l.at) as day,
  u.email,
  u.plan,
  l.tool,
  count(*) as calls,
  count(*) filter (where l.status = 200) as ok_calls,
  count(*) filter (where l.status = 429) as rate_limited,
  count(*) filter (where l.status in (401, 403)) as auth_failures,
  avg(l.latency_ms)::int as avg_latency_ms
from public.mcp_request_log l
left join public.mcp_api_keys k on k.id = l.api_key_id
left join public.mcp_users u on u.id = coalesce(l.user_id, k.user_id)
group by 1, 2, 3, 4;

revoke all on public.mcp_usage_by_day from anon, authenticated;

comment on function public.list_template_categories() is
  'Distinct categories + counts from templates_public. Backs the list_categories MCP tool.';
comment on view public.mcp_usage_by_day is
  'Calls per client (email) per day per tool, with success/429/auth-failure breakdown. For pricing/abuse review.';
