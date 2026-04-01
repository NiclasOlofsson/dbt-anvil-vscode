-- nba_dlt external source not present in sample — read directly from seed CSV.
with
    cte_seed as (select * from {{ source("nba", "nba_results") }})
select
    strptime(b."Date", '%a %b %-d %Y')::date as "date",
    b."Start (ET)" as "Start (ET)",
    b."Visitor/Neutral" as "VisTm",
    b.pts::int as visiting_team_score,
    b."Home/Neutral" as "HomeTm",
    b.pts_1::int as home_team_score,
    b."Attend." as "Attend.",
    b.arena as arena,
    b.notes as notes,
    case
        when b.pts::int > b.pts_1::int then b."Visitor/Neutral" else b."Home/Neutral"
    end as winner,
    case when b.pts::int > b.pts_1::int then b."Home/Neutral" else b."Visitor/Neutral" end as loser,
    case
        when b.pts::int > b.pts_1::int
        then b.pts::int
        else b.pts_1::int
    end as winner_pts,
    case
        when b.pts::int > b.pts_1::int
        then b.pts_1::int
        else b.pts::int
    end as loser_pts
from cte_seed b
where strptime(b."Date", '%a %b %-d %Y')::date <= '{{ var( 'nba_start_date' ) }}'
