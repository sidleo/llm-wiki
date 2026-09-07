select sum(amount_usd) as revenue
from `sales.line_items`
where order_id in (
    select order_id from `sales.orders`
    where extract(year from placed_at) = @year
)
