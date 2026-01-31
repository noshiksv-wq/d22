-- Fix Analytics Tracking for Authenticated Users
-- Previously, the 'widget_can_log_events' policy was restricted TO anon.
-- This caused 403 errors when authenticated users (like owners testing their site) triggered events.
-- We change it TO authenticated, anon (effectively public)

DROP POLICY IF EXISTS "widget_can_log_events" ON analytics_simple;

CREATE POLICY "widget_can_log_events"
ON analytics_simple FOR INSERT
TO authenticated, anon
WITH CHECK (
  event IN ('view','chat','message','intent','cta_click')
  AND restaurant_id IS NOT NULL
  AND session IS NOT NULL
  AND (
    event <> 'cta_click' 
    OR cta_type IN ('phone','directions','order')
  )
);
