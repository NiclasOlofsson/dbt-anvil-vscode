-- Plain-parse control.
select id as site_key, site_name, energy_kwh
from {{ source('torture', 'raw_sites') }}
