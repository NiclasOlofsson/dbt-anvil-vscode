select {{ ref( 'a' )}} as v
from {{ ref('t') }} as t
    -- old: {{ ref( 'b' )}} as r
    -- new: column c
