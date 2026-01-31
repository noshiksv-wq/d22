-- Relax the time check for analytics events to handle client clock skew
-- Previous policy required created_at to be within -10m to +1m of server time, which caused 403s
DROP POLICY IF EXISTS "widget_can_log_events" ON analytics_simple;

CREATE POLICY "widget_can_log_events"
ON analytics_simple FOR INSERT
TO anon
WITH CHECK (
  event IN ('view','chat','message','intent','cta_click')
  AND restaurant_id IS NOT NULL
  AND session IS NOT NULL
  AND (
    event <> 'cta_click' 
    OR cta_type IN ('phone','directions','order')
  )
  -- Removed the strict time check:
  -- AND created_at > NOW() - INTERVAL '10 minutes'
  -- AND created_at < NOW() + INTERVAL '1 minute'
);
