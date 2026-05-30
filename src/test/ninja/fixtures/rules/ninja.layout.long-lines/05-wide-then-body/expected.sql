select
    a,
    round(case
        when home_team_win_probability / 10000 >= 0.50 then
            round(- 30.564 * home_team_win_probability / 10000 + 14.763, 1)
        else round(- 30.564 * home_team_win_probability / 10000 + 15.801, 1)
    end * 2, 0) / 2.0 as implied_line
from x
