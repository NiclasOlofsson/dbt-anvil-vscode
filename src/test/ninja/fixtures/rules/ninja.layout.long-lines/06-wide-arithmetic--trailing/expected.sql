select
    r.scenario_id,
    r.winning_team,
    ((r.wins - r.actual_wins) * floor(random() * 5)) +
    ((r.losses - r.actual_losses_count) * floor(random() * - 5)) as fuzz_score
from r
