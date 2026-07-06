-- Origin: fill-uniqueness review (the legacy __j0__/__j1__ numbering point) —
-- two SAME-LENGTH expression tags as select items. Their fills must be
-- distinct identifiers or every name-keyed consumer collides.
select
    {{ macro_one() }} as qty,
    {{ macro_two() }} as sub
from {{ ref('stg_orders') }}
