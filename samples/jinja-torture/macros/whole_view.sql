-- Whole-model macro: the entire model body is one call to this WITH-first
-- query generator (a production shape — hundreds of generated normalized
-- views in the originating project).
{% macro whole_view(table_name) %}

-- Latest row per key from the raw feed
with latest as (
    select max(loaded_at) as max_loaded, id
    from {{ source('torture', table_name) }}
    group by id
)
select r.*, false as is_deleted
from {{ source('torture', table_name) }} r
inner join latest l on l.id = r.id and r.loaded_at = l.max_loaded

{% endmacro %}
