select 1
from t
left join u
    on t.a = u.a
    or t.b = u.b
