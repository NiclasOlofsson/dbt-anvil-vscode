{#
  dbt-duckdb has no function materialization of its own, and dbt's default emits
  CREATE FUNCTION ... RETURNS, which DuckDB rejects. DuckDB's scalar functions are
  macros, so build the function resource as one.
#}
{% macro duckdb__scalar_function_sql(target_relation) %}
    {%- set args = [] -%}
    {%- for arg in model.arguments -%}
        {%- do args.append(arg.name) -%}
    {%- endfor %}
    CREATE OR REPLACE MACRO {{ target_relation.include(database=False).render() }}({{ args | join(', ') }}) AS (
        {{ model.compiled_code }}
    );
{% endmacro %}
