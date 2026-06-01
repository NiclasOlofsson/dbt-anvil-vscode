select
    a,
    coalesce(so.customer_pallet_picking_logic, coalesce(wh.chep_pallet_picking_logic, so.warehouse_pallet_picking_logic)) as pallet_picking_logic,
    b
from t
