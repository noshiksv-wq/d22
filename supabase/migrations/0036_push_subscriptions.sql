-- Push Subscriptions Table
-- Stores web push subscriptions for restaurant owners

-- 1. Create table
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  subscription JSONB, -- Full subscription object for future-proofing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Unique per restaurant + endpoint combination
  UNIQUE(restaurant_id, endpoint)
);

-- 2. Indexes
CREATE INDEX idx_push_subs_restaurant ON push_subscriptions(restaurant_id);

-- 3. Enable RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies

-- Restaurant owners can manage their own subscriptions
CREATE POLICY "owners_manage_push_subs"
ON push_subscriptions
FOR ALL
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM restaurants WHERE owner_id = auth.uid()
  )
)
WITH CHECK (
  restaurant_id IN (
    SELECT id FROM restaurants WHERE owner_id = auth.uid()
  )
);

-- Admins have full access
CREATE POLICY "admins_manage_push_subs"
ON push_subscriptions
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- 5. Comments
COMMENT ON TABLE push_subscriptions IS 'Web push subscriptions for restaurant order notifications';
COMMENT ON COLUMN push_subscriptions.endpoint IS 'Push service endpoint URL';
COMMENT ON COLUMN push_subscriptions.p256dh IS 'User public key for encryption';
COMMENT ON COLUMN push_subscriptions.auth IS 'Auth secret for encryption';
COMMENT ON COLUMN push_subscriptions.subscription IS 'Full subscription JSON for future-proofing';
