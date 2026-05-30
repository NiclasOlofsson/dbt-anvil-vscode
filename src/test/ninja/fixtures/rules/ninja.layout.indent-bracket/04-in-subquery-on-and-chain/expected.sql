select *
from t
inner join u
    on t.a = u.a
    and t.b = u.b
    and t.c in (
        select v.c from v
)
