-- Plain-parse control.
select id as customer_id, region, chain_id, source_key, is_deleted
from {{ source('torture', 'raw_customers') }}
