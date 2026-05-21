with t as (
    select very_long_column_name_one, very_long_column_name_two, very_long_column_name_three, very_long_column_name_four from x
)
select * from t
