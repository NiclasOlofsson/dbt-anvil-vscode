with a as (
    select 1 as x
),
{# old version
b as (
    select 2 as x
),
#} b as (
    select 2 as x
)

select * from b
