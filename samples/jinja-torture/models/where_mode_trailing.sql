-- Origin: gold__vendor (the first F5 smoke finding) — where-mode trailing
-- filter after a complete ON predicate, before UNION ALL. Needs the
-- where-clause fill shape; the identifier fill is a syntax error here.
select v.order_id, v.customer_id
from {{ ref('stg_orders') }} v
left outer join {{ ref('stg_customers') }} ch
    on (v.customer_id = ch.customer_id and ch.source_key = 'd365')
{{ soft_delete_filter('v.is_deleted','where') }}
union all
select '-1' as order_id, '-1' as customer_id
