with cte as (
  select 1 as a
),

/* notes:

  • point one;
  • point two;

*/
cte2 as (
    select *
    from cte
)

select *
from cte2
