-- Origin: gold__warehouse family — and-mode trailing filter after a complete
-- ON predicate. The mode arrives as a call ARGUMENT, so classification must
-- bind the literal ('and' → conjunct fill).
select o.order_id, o.quantity
from {{ ref('stg_orders') }} o
left outer join {{ ref('stg_customers') }} c
    on (o.customer_id = c.customer_id and c.region = 'eu')
{{ soft_delete_filter('o.is_deleted','and') }}
