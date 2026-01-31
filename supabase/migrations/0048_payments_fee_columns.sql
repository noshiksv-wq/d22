-- Add fee and net amount columns to payments table
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS balance_transaction_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_fee_amount INTEGER,
ADD COLUMN IF NOT EXISTS net_amount INTEGER,
ADD COLUMN IF NOT EXISTS platform_fee_amount INTEGER,
ADD COLUMN IF NOT EXISTS refunded_amount INTEGER;

-- Comments
COMMENT ON COLUMN public.payments.balance_transaction_id IS 'Stripe Balance Transaction ID';
COMMENT ON COLUMN public.payments.stripe_fee_amount IS 'Stripe processing fee in minor units (e.g. öre)';
COMMENT ON COLUMN public.payments.net_amount IS 'Net amount settled to connected account in minor units';
COMMENT ON COLUMN public.payments.platform_fee_amount IS 'Platform application fee in minor units';
COMMENT ON COLUMN public.payments.refunded_amount IS 'Total refunded amount in minor units';
