select
    case
        when max(case when is_active then 1 else 0 end) = 0
            and count(distinct case when not is_active then id end) >= 3
            and ceiling(sum(case when not is_active then qty end)) > 0
        then 'inactive'
        else 'other'
    end as bucket
from t
