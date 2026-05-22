select 1
from t
inner join u as so
on t.a = so.a and t.b = so.b and lower(t.c) = lower(so.c)
