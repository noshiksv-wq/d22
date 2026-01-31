-- Add currency support for global expansion

-- Add currency column to restaurants table
ALTER TABLE public.restaurants 
ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'SEK';

-- Add check constraint for valid 3-letter currency codes
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_currency_check') THEN
    ALTER TABLE public.restaurants 
    ADD CONSTRAINT restaurants_currency_check 
    CHECK (currency IN ('SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD', 'JPY', 'INR'));
  END IF;
END $$;

-- Update existing restaurants to have SEK as default
UPDATE public.restaurants SET currency = 'SEK' WHERE currency IS NULL;

