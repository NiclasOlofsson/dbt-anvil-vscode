select a
from t
inner join u as so
    on
        cps.gold_companykey = so.gold_companykey
        and lower(cps.salesordernumber) = lower(so.ordernumber)
        and cps.gold_itemkey = so.gold_itemkey
        and (
            so.companykey in (2030, 2080, 2130)
            or (so.companykey in (1030, 3020) and so.flag = 1)
            or (so.companykey = 4000 and so.other is null)
        )
