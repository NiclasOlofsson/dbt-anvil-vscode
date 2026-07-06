-- Purpose: pins quoted-identifier span integrity (extract-boundary plan Phase 0).
-- A backtick-quoted mixed-case column reference, a backtick-quoted column
-- alias, and a backtick-quoted CTE name, all in one real model.
with `My Cte` as (
    select order_id, `My Col` as `My Alias`
    from {{ ref('stg_orders') }}
)
select order_id, `My Alias`
from `My Cte`
