select 1
from t
left join u
on t.a = u.a and t.b = u.b
inner join v
on u.id = v.uid and v.deleted is null
