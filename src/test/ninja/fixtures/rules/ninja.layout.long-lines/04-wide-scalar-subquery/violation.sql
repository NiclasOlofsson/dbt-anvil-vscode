select a
from x
where x.order_sequence = (select max(y.order_sequence) from very_long_table_name as y where y.customer_id = x.customer_id)
