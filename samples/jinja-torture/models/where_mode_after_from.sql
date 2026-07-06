-- Origin: the OTHER where-mode slot — directly after a bare FROM. This slot
-- is why where-mode could never answer `conjunct` (AND 1=1 breaks here);
-- the where-clause fill is valid in both slots.
select order_id, quantity
from {{ ref('stg_orders') }}
{{ soft_delete_filter('is_deleted','where') }}
