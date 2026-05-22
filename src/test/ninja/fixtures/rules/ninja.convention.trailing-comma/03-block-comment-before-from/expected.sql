with cte as (
    select
        a,
        b,
        last_target,
    /* block comment about last_target */

    from t
)
select *
from cte
