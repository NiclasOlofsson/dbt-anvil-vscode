select 1 as x
from {{ ref('schema', 'table') }}
