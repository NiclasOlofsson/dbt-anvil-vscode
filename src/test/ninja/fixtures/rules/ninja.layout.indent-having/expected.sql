select x
from t
group by x
having count(*) > 1
