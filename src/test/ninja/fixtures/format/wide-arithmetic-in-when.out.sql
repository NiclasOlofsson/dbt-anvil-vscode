select
    case
        when sum(case when not is_active then ceiling(qty) end)
            - ceiling(sum(case when not is_active then qty end)) >= 10
            and sum(case when not is_active then ceiling(qty) end)
            / nullif(ceiling(sum(case when not is_active then qty end)), 0) >= 2 then true
        else false
    end as flag
from t
