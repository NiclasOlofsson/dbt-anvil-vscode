{#
  Expression-only macro bodies. Neither of these is a statement: the body is a
  CASE expression, meant to be dropped into a select list. The editor must not
  flag the macro file itself (sqllens #48), and a model calling one must parse.
#}

{% macro clean_string(column_name) %}
    case
        when trim({{ column_name }}) = '' then null
        when upper(trim({{ column_name }})) = 'NULL' then null
        else trim({{ column_name }})
    end
{% endmacro %}

{% macro status_bucket(column_name) %}
    case
        when lower({{ column_name }}) = 'completed' then 'done'
        when lower({{ column_name }}) in ('cancelled', 'canceled', 'returned', 'refunded') then 'lost'
        else 'open'
    end
{% endmacro %}
