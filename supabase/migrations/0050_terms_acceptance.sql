-- Add terms acceptance tracking columns to restaurants table
ALTER TABLE restaurants
ADD COLUMN IF NOT EXISTS terms_version TEXT,
ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS authority_confirmed_at TIMESTAMPTZ;

-- Optional: Add public_searchable column if it doesn't exist
ALTER TABLE restaurants
ADD COLUMN IF NOT EXISTS public_searchable BOOLEAN NOT NULL DEFAULT false;

-- Add index for efficient querying of public restaurants
CREATE INDEX IF NOT EXISTS idx_restaurants_public_searchable 
ON restaurants(public_searchable) 
WHERE public_searchable = true;

COMMENT ON COLUMN restaurants.terms_version IS 'Version of terms accepted (e.g., "2025-12-29")';
COMMENT ON COLUMN restaurants.terms_accepted_at IS 'Timestamp when terms were accepted';
COMMENT ON COLUMN restaurants.authority_confirmed_at IS 'Timestamp when authority to represent was confirmed';
COMMENT ON COLUMN restaurants.public_searchable IS 'Whether restaurant appears in public discovery';
