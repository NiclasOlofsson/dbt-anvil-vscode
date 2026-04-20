{{config(materialized='table',tags=['dim','gold'])}}
-- Kitchen-sink fixture: as many rule violations as we can cram in.

WITH base AS (
SELECT   a.id  ,
  a.NAME
,a.status
,a.created_at
,CASE WHEN a.flag=1 THEN 'yes'
 WHEN a.flag=0 THEN 'no'
END AS flag_text
,COUNT(*) AS cnt
FROM {{ref( 'src_b' )}} a
LEFT JOIN {{ref('src_c')}} b
on a.id=b.id
INNER JOIN {{ref('src_d')}} c ON a.x<>c.x
WHERE a.deleted IS NOT NULL
  AND a.flag!=1
  GROUP BY 1,2,3,4,5
HAVING COUNT(*) >1
  ORDER BY 1 DESC
  LIMIT 100
)

SELECT
  a.id  ,
a.NAME,
  a.status,
a.created_at,
a.flag_text,
a.cnt
FROM base a
LEFT JOIN {{ref('other')}} b ON a.id=b.id
WHERE a.cnt IS NOT NULL
UNION
SELECT 1,2,3,4,5,6 FROM {{ref('tail')}}
