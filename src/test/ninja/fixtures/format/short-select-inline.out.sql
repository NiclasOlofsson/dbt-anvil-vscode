with cte1 as (
    select * from t
),

cte2 as (
    select count(*) from u
),

cte3 as (
    select
        id,
        name
    from v
)
select * from cte1
