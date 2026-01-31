-- Analytics Simple Table
-- MVP analytics tracking for restaurant widget events
-- Uses simple table + client-side aggregation (no RPC needed for MVP)

-- 1. Analytics table
CREATE TABLE analytics_simple (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  event TEXT NOT NULL CHECK (event IN ('view','chat','message','intent')),
  session UUID NOT NULL,
  language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for performance
CREATE INDEX idx_analytics_restaurant_time
ON analytics_simple (restaurant_id, created_at DESC);

CREATE INDEX idx_analytics_time
ON analytics_simple (created_at DESC);

-- Index for common query pattern (restaurant + event + time)
CREATE INDEX idx_analytics_restaurant_event_time
ON analytics_simple (restaurant_id, event, created_at DESC);

-- 3. DB-enforced deduplication (prevents duplicate events per session)
CREATE UNIQUE INDEX analytics_once_per_session_view
ON analytics_simple (restaurant_id, session)
WHERE event = 'view';

CREATE UNIQUE INDEX analytics_once_per_session_chat
ON analytics_simple (restaurant_id, session)
WHERE event = 'chat';

-- 4. RLS Policies
ALTER TABLE analytics_simple ENABLE ROW LEVEL SECURITY;

-- Anonymous can insert events (with time window validation)
CREATE POLICY "widget_can_log_events"
ON analytics_simple FOR INSERT
TO anon
WITH CHECK (
  event IN ('view','chat','message','intent')
  AND restaurant_id IS NOT NULL
  AND session IS NOT NULL
  AND created_at > NOW() - INTERVAL '10 minutes'
  AND created_at < NOW() + INTERVAL '1 minute'
);

-- Owners read their own analytics (uses owner_id to match schema)
CREATE POLICY "owners_read_own_analytics"
ON analytics_simple FOR SELECT
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM restaurants WHERE owner_id = auth.uid()
  )
);

-- Comments for documentation
COMMENT ON TABLE analytics_simple IS 'Simple analytics tracking for restaurant widget events. Client-side aggregation for MVP.';
COMMENT ON COLUMN analytics_simple.event IS 'Event type: view (page load), chat (chat opened), message (user message), intent (order intent detected)';
COMMENT ON COLUMN analytics_simple.session IS 'Browser session UUID for deduplication';
COMMENT ON COLUMN analytics_simple.language IS 'Detected language from user messages';
