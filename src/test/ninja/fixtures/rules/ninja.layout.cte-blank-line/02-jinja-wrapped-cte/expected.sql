with a as (
    select 1 as x
),
{% if true %}

b as (
    select 2 as x
),
{% endif %}

c as (
    select 3 as x
)
select *
from c
