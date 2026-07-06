-- Mode-as-argument filter family: appends a `where` or `and` clause depending
-- on the call-site literal. The body LEADS with a parameter, so shape
-- classification must bind call args (the gold__vendor F5 finding shape).
{% macro soft_delete_filter(column_name,stat) %}
    {{ stat }} {{ column_name }}=false
{% endmacro %}
