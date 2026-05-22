select
    a,
    row_number() over (partition by r.scenario_id, tournament_group order by wins desc, h2h_wins desc, pt_diff desc) as group_rank,
    b
from x
