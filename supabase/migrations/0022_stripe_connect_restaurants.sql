-- Stripe Connect Express columns for restaurants
-- Adds Stripe account management fields to restaurants table

ALTER TABLE public.restaurants
ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN DEFAULT FALSE NOT NULL,
ADD COLUMN IF NOT EXISTS stripe_details_submitted BOOLEAN DEFAULT FALSE NOT NULL,
ADD COLUMN IF NOT EXISTS payments_enabled BOOLEAN DEFAULT TRUE NOT NULL;

-- Index for Stripe account lookups
CREATE INDEX IF NOT EXISTS idx_restaurants_stripe_account_id 
ON public.restaurants(stripe_account_id) 
WHERE stripe_account_id IS NOT NULL;

-- Comments
COMMENT ON COLUMN public.restaurants.stripe_account_id IS 'Stripe Connect Express account ID';
COMMENT ON COLUMN public.restaurants.stripe_charges_enabled IS 'Whether the Stripe account can accept charges';
COMMENT ON COLUMN public.restaurants.stripe_details_submitted IS 'Whether Stripe onboarding details have been submitted';
COMMENT ON COLUMN public.restaurants.payments_enabled IS 'Restaurant toggle to enable/disable online payments';
