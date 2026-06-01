select
    a,
    coalesce(this_is_a_very_long_column_name_aaaaaaa, another_very_long_column_name_bbbbbbb, yet_another_long_column_name_ccccc) as foo,
    b
from t
