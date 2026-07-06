-- Scalar-expression helpers. Bodies are expr-shaped, so the classifier
-- answers nothing and the engine uses the identifier fill — which is the
-- point for the twin-tags model (fill uniqueness).
{% macro macro_one() %}coalesce(quantity, 0){% endmacro %}

{% macro macro_two() %}coalesce(subtotal, 0){% endmacro %}

{% macro to_number(col) %}cast({{ col }} as decimal(18,2)){% endmacro %}
