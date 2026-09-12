{#
  Predicate-tail macros: the body opens with a clause keyword and is appended
  after a complete FROM/ON/WHERE. Three spellings of the same family, all of
  which the editor has to shape correctly for the calling model to parse:

  - literal-led body (`and ...`)
  - the keyword as a parameter with a signature default (`mode='and'`)
  - the keyword as a parameter with a jinja default filter
#}

{% macro only_completed(column_name) %}
    and lower({{ column_name }}) = 'completed'
{% endmacro %}

{% macro recent_orders(column_name, mode='and') %}
    {{ mode }} {{ column_name }} >= date '2018-01-01'
{% endmacro %}

{% macro not_deleted(column_name, mode) %}
    {{ mode | default('where') }} {{ column_name }} is not null
{% endmacro %}
