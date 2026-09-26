-- Facet vocabulary stats for your loaded catalog: how many templates carry each value.
-- Use it to align the intake form's options with the values retrieval actually filters on.

-- Integrations: templates per value
select unnest(integrations) as value, count(*) as templates
from templates
group by 1
order by 2 desc;

-- Trigger channels: templates per value
select unnest(trigger_type) as value, count(*) as templates
from templates
group by 1
order by 2 desc;

-- Output targets: templates per value
select unnest(output_targets) as value, count(*) as templates
from templates
group by 1
order by 2 desc;
