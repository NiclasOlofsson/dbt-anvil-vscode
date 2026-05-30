with base as (
    select
        a
        , b
        , c
    from t
)

, final as (

    select
        x
        , y
    from base
)

select *
from final
