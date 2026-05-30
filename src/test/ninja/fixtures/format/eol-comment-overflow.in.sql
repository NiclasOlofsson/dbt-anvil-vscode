select a
from t
where cp.long_field_name = 'a_long_string_value'   -- this comment together with the line would exceed the max line length limit easily
    and cp.other > 0
