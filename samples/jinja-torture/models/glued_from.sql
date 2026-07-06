-- Origin: bronze_d365__salesorderlinev2 — a ref tag GLUED to the FROM keyword
-- (no whitespace). Compiled SQL survives only because the rendered relation
-- starts with a quote character; a bare identifier fill fuses into `fromjjj…`.
select order_id
from{{ ref('stg_orders') }}
