-- A {{ }} tag on its own line after a complete clause is a predicate-tail
-- macro (fills WHERE/AND); it keeps its line. A tag right after a keyword
-- (`from`, `join`) is that keyword's operand and joins it.
select
    o.order_id,
    o.status
from
    {{ ref('stg_orders') }} as o
left join {{ ref('stg_customers') }} as c
    on c.customer_id = o.customer_id
    {{ not_deleted('c.first_name', 'and') }}
where o.status = 'done'
    {{ recent_orders('o.order_date', 'and') }}
    {{ only_completed('o.status') }}
