with a as (
    select 1 as x
),
b as (
    select 2 as x
)

select *
from a
join b on a.x = b.x
