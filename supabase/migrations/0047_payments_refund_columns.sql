-- Add refund-related columns to payments table
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS charge_id TEXT,
ADD COLUMN IF NOT EXISTS refund_id TEXT,
ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- Add index for charge lookups
CREATE INDEX IF NOT EXISTS idx_payments_charge_id 
ON public.payments(charge_id) 
WHERE charge_id IS NOT NULL;

-- Comments
COMMENT ON COLUMN public.payments.charge_id IS 'Stripe Charge ID for refund processing';
COMMENT ON COLUMN public.payments.refund_id IS 'Stripe Refund ID after refund is processed';
COMMENT ON COLUMN public.payments.refunded_at IS 'Timestamp when refund was processed';
