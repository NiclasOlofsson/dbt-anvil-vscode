with cte as (
    select
        a,
        b,
        -- two-line comment header
        -- second line was dedented
        c
    from t
)
select *
from cte
