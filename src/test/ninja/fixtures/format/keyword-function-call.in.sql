select
    isnull(a) as has_a,
    coalesce(b, c) as bc,
    nullif(d, 0) as safe_d,
    cast(e as int) as ei
from t
