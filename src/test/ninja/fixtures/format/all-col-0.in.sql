{{ config(materialized='table') }}
-- Everything starts at column 0. The formatter's depth rules have to
-- indent structure from a flat baseline.
with base as (
select
a.id,
a.name,
a.status,
a.created_at,
case when a.flag = 1 then 'yes'
when a.flag = 0 then 'no'
end as flag_text,
count(*) as cnt
from {{ ref('src_b') }} as a
left join {{ ref('src_c') }} as b
on a.id = b.id
inner join {{ ref('src_d') }} as c on a.x = c.x
where a.deleted is null
and a.flag = 1
group by 1, 2, 3, 4
having count(*) > 1
order by 1 desc
limit 100
)
select
a.id,
a.name,
a.status,
a.created_at,
a.flag_text,
a.cnt
from base as a
left join {{ ref('other') }} as b on a.id = b.id
where a.cnt is not null
union all
select 1, 2, 3, 4, 5, 6 from {{ ref('tail') }}
