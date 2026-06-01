select
    case
        -- Path A: display pallet
        when is_display_pallet then cast(qty as decimal (20, 6))
        when pallet_conversion_factor is not null and pallet_conversion_factor > 0
            -- Exact-arithmetic conversion: avoids FP non-associativity in downstream sum(),
            -- which made ceiling(sum(...)) execution-plan-dependent.
            then cast(qty as decimal (20, 6)) / cast(pallet_conversion_factor as decimal (20, 6))
        else null
    end as calculated_pallets
from t
