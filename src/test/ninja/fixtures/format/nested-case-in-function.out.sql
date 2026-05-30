select
    case
        when max(case when is_active then 1 else 0 end) = 0 then 'inactive'
        when sum(case when is_active then qty else 0 end) > 100 then 'high'
        else 'normal'
    end as bucket
from t
