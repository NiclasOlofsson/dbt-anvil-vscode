select
    a,
    case
        when lower(status) in ('cancelled', 'canceled', 'returned', 'refunded') then 1
        else 0
    end as is_cancelled_or_returned,
    b,
from x
