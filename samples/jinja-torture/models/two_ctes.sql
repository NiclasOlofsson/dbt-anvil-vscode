-- Origin: nba_latest_results under leading-comma config — the CTE separator
-- comma emitted its blank line on top of the blank the previous run itself
-- wrote, growing one blank line per reflow pass. Two CTEs exercise the
-- separator; the gate pins the fixed point under every format config.
with orders as (
    select order_id, customer_id
    from {{ ref('stg_orders') }}
),
customers as (
    select customer_id
    from {{ ref('stg_customers') }}
)
select o.order_id
from orders o
inner join customers c
    on o.customer_id = c.customer_id
