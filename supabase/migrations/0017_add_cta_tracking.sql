-- Add CTA Click Tracking to Analytics
-- Extends analytics_simple to track conversion actions (phone, directions, order)

-- ============================================
-- ADD CTA_TYPE COLUMN
-- ============================================
ALTER TABLE analytics_simple
  ADD COLUMN IF NOT EXISTS cta_type TEXT;

-- ============================================
-- UPDATE EVENT CHECK CONSTRAINT
-- ============================================
-- Drop existing constraint
ALTER TABLE analytics_simple
  DROP CONSTRAINT IF EXISTS analytics_simple_event_check;

-- Add new constraint with cta_click
ALTER TABLE analytics_simple
  ADD CONSTRAINT analytics_simple_event_check
  CHECK (event IN ('view','chat','message','intent','cta_click'));

-- ============================================
-- UPDATE RLS POLICY FOR CTA CLICKS
-- ============================================
-- Drop existing policy
DROP POLICY IF EXISTS "widget_can_log_events" ON analytics_simple;

-- Create updated policy with cta_click validation
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
  AND created_at > NOW() - INTERVAL '10 minutes'
  AND created_at < NOW() + INTERVAL '1 minute'
);

-- ============================================
-- COMMENTS
-- ============================================
COMMENT ON COLUMN analytics_simple.cta_type IS 'Type of CTA clicked: phone, directions, or order (only set when event = cta_click)';
