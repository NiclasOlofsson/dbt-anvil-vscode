select
    usecase,
    shipment_id,
    so_reference,
    companykey,
    ship_date,
    coalesce(
        has_display_item = 0                                          -- no display items on the route
        and regular_item_count >= 3                                  -- ignore 1-2 item odd orders
        and physical_fit_ceiling > 0
        and per_item_ceiling_sum - physical_fit_ceiling >= 10        -- >= 10 pallets of "waste"
        and per_item_ceiling_sum >= 2 * physical_fit_ceiling,        -- 2x fragmentation guard
        false
    ) as is_demo_route
from route_demo_metrics
