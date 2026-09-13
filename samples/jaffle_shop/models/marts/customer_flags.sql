select
    customer_id,
    first_name,
    {{ function('is_positive_int') }}(cast(customer_id as varchar)) as has_positive_id
from {{ ref('stg_customers') }}
