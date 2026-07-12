{{ config(
    tags=["CHEP", "mart_serving"],
    materialized="table"
) }}

-- THe packing slip is the triggering operation
with customer_packing_slip as (
    select cp.* from {{ ref('foo') }} as cp
)
select * from customer_packing_slip
