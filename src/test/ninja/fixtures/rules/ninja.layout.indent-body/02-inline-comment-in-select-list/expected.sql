with cte as (
    select
        a,
        b,
        -- note about the next column
        c
    from t
)
select * from cte
