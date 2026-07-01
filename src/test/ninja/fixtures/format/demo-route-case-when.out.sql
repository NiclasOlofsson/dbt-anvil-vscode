select
    usecase,
    shipment_id,
    so_reference,
    companykey,
    ship_date,
    case
        when max(case when is_display_pallet then 1 else 0 end) = 0
            and count(distinct case when not is_display_pallet then item_no end) >= 3
            and ceiling(sum(case when not is_display_pallet then calculated_pallets end)) > 0
            and sum(case when not is_display_pallet then ceiling(calculated_pallets) end)
                - ceiling(sum(case when not is_display_pallet then calculated_pallets end)) >= 10
            and sum(case when not is_display_pallet then ceiling(calculated_pallets) end)
                / nullif(ceiling(sum(case when not is_display_pallet then calculated_pallets end)), 0) >= 2
            then true
        else false
    end as is_demo_route
from transports_with_calculated_pallets
group by
    1,
    2,
    3,
    4,
    5
