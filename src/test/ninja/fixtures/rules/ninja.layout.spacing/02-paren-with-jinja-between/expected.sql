select coalesce(1, {{ var('x') }}) as v
from t
