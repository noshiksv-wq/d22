-- Stripe Events table for webhook debugging and idempotency
-- Stores all received Stripe webhook events for auditing and debugging

CREATE TABLE IF NOT EXISTS public.stripe_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    account TEXT,
    order_id TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'skipped')),
    error TEXT,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for debugging queries
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON public.stripe_events(type);
CREATE INDEX IF NOT EXISTS idx_stripe_events_order_id ON public.stripe_events(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_events_created_at ON public.stripe_events(created_at);
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON public.stripe_events(status);

-- Enable RLS
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- Only admins can view stripe events (for debugging)
CREATE POLICY "admins_full_access_stripe_events"
ON public.stripe_events
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE admin_users.user_id = auth.uid()
    )
);

-- Comments
COMMENT ON TABLE public.stripe_events IS 'Stripe webhook events log for debugging and idempotency';
COMMENT ON COLUMN public.stripe_events.event_id IS 'Stripe event ID (evt_xxx) - ensures idempotency';
COMMENT ON COLUMN public.stripe_events.type IS 'Event type (e.g., checkout.session.completed)';
COMMENT ON COLUMN public.stripe_events.account IS 'Connected account ID if from connected account';
COMMENT ON COLUMN public.stripe_events.order_id IS 'Extracted order ID from metadata';
COMMENT ON COLUMN public.stripe_events.status IS 'Processing status: received, processed, failed, skipped';
COMMENT ON COLUMN public.stripe_events.error IS 'Error message if processing failed';
COMMENT ON COLUMN public.stripe_events.raw_data IS 'Full event payload for debugging';
