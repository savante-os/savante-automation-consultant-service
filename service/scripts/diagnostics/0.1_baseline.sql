-- Baseline diagnostics for the recommendation engine. Run against your own project
-- (SQL editor or psql) before and after changing retrieval, to measure the effect.

-- Index size
select source, count(*), count(embedding) as embedded,
       count(*) filter (where coalesce(description,'') = '') as sin_descripcion
from templates group by source;

-- Duplicate names (workflows)
select count(*) from (
  select lower(name) from templates where source <> 'self-hosted'
  group by 1 having count(*) > 1) d;

-- Recommendations with zero candidates / tier distribution
select count(*) as total,
       count(*) filter (where cardinality(matched_template_ids) = 0) as zero_candidates,
       count(*) filter (where tier = 'Audit') as audit
from recommendations;

-- Tools picked in the intake form that do not exist in the catalog
with elegidas as (select unnest(current_tools) as tool from leads),
     catalogo as (select distinct unnest(integrations) as tool from templates)
select e.tool, count(*) from elegidas e
left join catalogo c on c.tool = e.tool
where c.tool is null group by 1 order by 2 desc;

-- Channels picked in the intake form that do not exist as a trigger_type
with elegidos as (select unnest(input_channels) as ch from leads),
     catalogo as (select distinct unnest(trigger_type) as ch from templates)
select e.ch, count(*) from elegidos e
left join catalogo c on c.ch = e.ch
where c.ch is null group by 1 order by 2 desc;
