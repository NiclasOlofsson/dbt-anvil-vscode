select a, b, c
from t
where a = 1 and b = 2 and c = 3
group by a, b, c
having count(*) > 1 and max(c) < 100
order by a, b, c
;

select
    a,
    row_number() over (partition by a, b order by c desc, d desc) as rn
from t
;

select
    case when a = 1 then 'one' when a = 2 then 'two' else 'other' end as label,
    b
from t
;
