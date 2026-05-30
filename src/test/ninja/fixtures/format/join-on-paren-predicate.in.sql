select a
from t
left join u as cust
    on (
        (so.x is not null and so.x = cust.y)
        or (so.x is null and so.z = cust.w)
    )
