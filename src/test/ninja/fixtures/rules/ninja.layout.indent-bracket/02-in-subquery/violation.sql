select *
from t
where id in (
        select id from u
)
