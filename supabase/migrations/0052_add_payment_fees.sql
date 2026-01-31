-- Add fee tracking columns to payments table
-- Store amounts in minor units (öre/cents) as integers
ALTER TABLE payments 
ADD COLUMN IF NOT EXISTS stripe_fee_amount INTEGER,
ADD COLUMN IF NOT EXISTS platform_fee_amount INTEGER,
ADD COLUMN IF NOT EXISTS net_amount INTEGER,
ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS refund_id TEXT,
ADD COLUMN IF NOT EXISTS refunded_amount INTEGER;

-- Add comments for clarity
COMMENT ON COLUMN payments.stripe_fee_amount IS 'Stripe processing fee in minor units (e.g. 150 = 1.50 SEK). Usually negative.';
COMMENT ON COLUMN payments.platform_fee_amount IS 'Platform application fee in minor units. Usually negative.';
COMMENT ON COLUMN payments.net_amount IS 'Net amount settled to connected account in minor units.';
COMMENT ON COLUMN payments.refunded_amount IS 'Amount refunded in minor units.';
