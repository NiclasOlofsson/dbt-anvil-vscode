-- Plain-parse control: a bare staging model, no torture.
select id as order_id, customer_id, quantity, subtotal, is_deleted, loaded_at
from {{ source('torture', 'raw_orders') }}
