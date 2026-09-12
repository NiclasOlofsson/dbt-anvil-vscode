{#
  Exercises the sample macros in every slot they are written for: expression
  macros in the select list, predicate-tail macros after FROM, ON and WHERE.
  Every line of SQL here should parse clean in the editor.
#}
with orders as (
    select * from {{ ref('stg_orders') }}
),

customers as (
    select * from {{ ref('stg_customers') }}
),

completed as (
    select
        order_id,
        customer_id,
        order_date,
        {{ clean_string('status') }} as status,
        {{ status_bucket('status') }} as status_bucket
    from orders
    {{ not_deleted('status') }}
    {{ only_completed('status') }}
    {{ recent_orders('order_date') }}
),

final as (
    select
        completed.order_id,
        completed.order_date,
        completed.status,
        completed.status_bucket,
        customers.first_name,
        customers.last_name
    from completed
    left join customers
        on customers.customer_id = completed.customer_id
        {{ not_deleted('customers.first_name', 'and') }}
    where completed.status_bucket = 'done'
        {{ recent_orders('completed.order_date', 'and') }}
)

select * from final
