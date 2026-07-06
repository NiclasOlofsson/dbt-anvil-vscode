-- Deliberate violation: a bare JOIN that MUST surface
-- ninja.ambiguity.implicit-join — proves the ninja gate cannot go
-- vacuously green.
select o.order_id
from {{ ref('stg_orders') }} o
join {{ ref('stg_customers') }} c
    on o.customer_id = c.customer_id
