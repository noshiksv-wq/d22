-- Add dish availability and ordering controls
-- is_available: For "Sold Out" status (operational)
-- is_orderable: For "In-Store Only" status (policy/legal)

ALTER TABLE public.dishes
ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS is_orderable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.dishes.is_available IS 'Operational flag: false = Sold Out';
COMMENT ON COLUMN public.dishes.is_orderable IS 'Policy flag: false = In-Store Only (e.g. Alcohol)';
