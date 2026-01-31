-- Add limit column to restaurants
ALTER TABLE restaurants 
ADD COLUMN IF NOT EXISTS ai_message_limit INTEGER NOT NULL DEFAULT 500;

-- Create ai_usage_monthly table
CREATE TABLE IF NOT EXISTS ai_usage_monthly (
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    month_start DATE NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (restaurant_id, month_start)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ai_usage_monthly_restaurant_id ON ai_usage_monthly(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_monthly_month_start ON ai_usage_monthly(month_start);

-- RLS Policies for ai_usage_monthly
ALTER TABLE ai_usage_monthly ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists (for migration re-runs)
DROP POLICY IF EXISTS "Owners can view their own AI usage" ON ai_usage_monthly;

-- Allow owners to read their own usage
CREATE POLICY "Owners can view their own AI usage"
ON ai_usage_monthly FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM restaurants
        WHERE restaurants.id = ai_usage_monthly.restaurant_id
        AND restaurants.owner_id = auth.uid()
    )
);

-- Drop existing function if exists
DROP FUNCTION IF EXISTS consume_ai_message(UUID);

-- RPC Function to atomically check and increment usage
-- Note: Return columns use short names (lim, mstart) to avoid conflicts with table columns
CREATE FUNCTION consume_ai_message(p_restaurant_id UUID)
RETURNS TABLE (
    allowed BOOLEAN,
    used INTEGER,
    lim INTEGER,
    mstart DATE
) 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    v_month DATE;
    v_limit INTEGER;
    v_current_usage INTEGER;
    v_new_usage INTEGER;
BEGIN
    v_month := DATE_TRUNC('month', NOW())::DATE;

    SELECT ai_message_limit INTO v_limit
    FROM restaurants
    WHERE id = p_restaurant_id;

    IF v_limit IS NULL THEN
        RETURN QUERY SELECT false, 0, 0, v_month;
        RETURN;
    END IF;

    INSERT INTO ai_usage_monthly AS t (restaurant_id, month_start, message_count)
    VALUES (p_restaurant_id, v_month, 0)
    ON CONFLICT (restaurant_id, month_start) DO NOTHING;

    SELECT message_count INTO v_current_usage
    FROM ai_usage_monthly AS t
    WHERE t.restaurant_id = p_restaurant_id AND t.month_start = v_month
    FOR UPDATE;

    IF v_current_usage >= v_limit THEN
        RETURN QUERY SELECT false, v_current_usage, v_limit, v_month;
    ELSE
        v_new_usage := v_current_usage + 1;
        
        UPDATE ai_usage_monthly AS t
        SET message_count = v_new_usage,
            updated_at = NOW()
        WHERE t.restaurant_id = p_restaurant_id AND t.month_start = v_month;

        RETURN QUERY SELECT true, v_new_usage, v_limit, v_month;
    END IF;
END;
$$;
