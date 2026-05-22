{{ config(materialized="table") }}
with cte_x as (
    select 1 as x
)
select *
from cte_x
