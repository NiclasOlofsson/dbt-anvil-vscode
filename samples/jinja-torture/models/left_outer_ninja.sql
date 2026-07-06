-- Origin: F5 finding 3 — the implicit-join lint fired on a templated
-- LEFT OUTER JOIN (the qualifier set lacked OUTER). Pinned here at project
-- level: this model must never surface ninja.ambiguity.implicit-join.
select o.order_id
from {{ ref('stg_orders') }} o
left outer join {{ ref('stg_customers') }} c
    on o.customer_id = c.customer_id
