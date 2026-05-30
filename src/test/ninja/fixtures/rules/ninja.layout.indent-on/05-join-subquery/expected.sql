select 1
from t
left join (
    select
        id,
        name
    from u
    where active
) as sub
    on sub.id = t.uid
    and sub.name <> ''
