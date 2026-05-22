with base as (
    select
        a,
        b
    from t
),

-- second CTE
final as (
    select
        x,
        y
    from base
)

select * from final
