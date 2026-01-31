-- Add privacy acceptance and accepted_by tracking
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS privacy_version TEXT,
  ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_accepted_by UUID;

-- Also track who accepted terms (cheap audit)
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS terms_accepted_by UUID,
  ADD COLUMN IF NOT EXISTS authority_confirmed_by UUID;

-- Backfill accepted_by with owner_id where timestamps already exist
UPDATE public.restaurants
SET
  terms_accepted_by = COALESCE(terms_accepted_by, owner_id),
  authority_confirmed_by = COALESCE(authority_confirmed_by, owner_id)
WHERE
  (terms_accepted_at IS NOT NULL OR authority_confirmed_at IS NOT NULL);

-- Comments for documentation
COMMENT ON COLUMN restaurants.privacy_version IS 'Version of privacy policy accepted';
COMMENT ON COLUMN restaurants.privacy_accepted_at IS 'Timestamp when privacy policy was accepted';
COMMENT ON COLUMN restaurants.privacy_accepted_by IS 'User ID who accepted privacy policy';
COMMENT ON COLUMN restaurants.terms_accepted_by IS 'User ID who accepted terms';
COMMENT ON COLUMN restaurants.authority_confirmed_by IS 'User ID who confirmed authority';
