-- Origin: mart_solution site_kpi family (11 models of the Oatly ratchet) —
-- a {% for %} loop generating UNION ALL arms with a loop.last-guarded
-- separator. After control-tag blanking the doc ends in a dangling
-- `union all` → EOF error. Legacy's render pass rescued this class.
{%- set sites = ['alpha', 'beta', 'gamma'] -%}

{% for site in sites %}
    select
        site_key,
        {{ to_number('energy_kwh') }} as energy
    from {{ ref('stg_sites') }}
    where site_name = {{ "'%s'" % site }}
    {% if not loop.last %}
    union all
    {% endif %}
{% endfor %}
