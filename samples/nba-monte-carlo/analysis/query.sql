select * from {{ ref('reg_season_actuals_enriched') }}

;
select * from {{ ref('nba_elo') }}


