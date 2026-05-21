{{ config(materialized='table', tags=['dim', 'gold']) }}
-- Kitchen-sink fixture: as many rule violations as we can cram in.
with base as (
    select
        a.id,
        a.name,
        a.status,
        a.created_at,
        case when a.flag = 1 then 'yes' when a.flag = 0 then 'no' end as flag_text,
        count(*) as cnt,
    from {{ ref( 'src_b' ) }} a
    left join {{ ref('src_c') }} b on a.id = b.id
    inner join {{ ref('src_d') }} c on a.x <> c.x
    where a.deleted is not null and
        a.flag != 1
    GROUP BY 1, 2, 3, 4, 5
    having count(*) > 1
    ORDER BY 1 desc
    limit 100
)
select
    a.id,
    a.name,
    a.status,
    a.created_at,
    a.flag_text,
    a.cnt,
from base a
left join {{ ref('other') }} b on a.id = b.id
where a.cnt is not null
union
select
    1,
    2,
    3,
    4,
    5,
    6,
from {{ ref('tail') }}
