-- Regression: a line whose first content is a {{ ref(...) }} tag.
-- Previously indent rules would replace [col 0 .. first-sql-token-col)
-- and silently delete the jinja.
select
    bf.id,
    bf.max_modified_datetime
from {{ ref('silver__basefinancialdimension') }} as bf
left join {{ ref('gold__sourcesystem') }} as ss on bf.sourcesystembkey = ss.sourcename
