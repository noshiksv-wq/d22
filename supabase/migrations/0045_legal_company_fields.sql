-- Add legal company information columns
-- These fields are for internal legal/business purposes and should NOT be used in AI search or public discovery

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS legal_company_name TEXT,
  ADD COLUMN IF NOT EXISTS legal_company_address TEXT,
  ADD COLUMN IF NOT EXISTS country_of_registration TEXT;

-- Add comment to document that these fields should not be included in embeddings/search
COMMENT ON COLUMN public.restaurants.legal_company_name IS 'Legal entity name - NOT for AI search or public display';
COMMENT ON COLUMN public.restaurants.legal_company_address IS 'Legal registered address - NOT for AI search or public display';
COMMENT ON COLUMN public.restaurants.country_of_registration IS 'Country where business is registered - NOT for AI search or public display';
COMMENT ON COLUMN public.restaurants.business_registration IS 'Business registration/Org.nr - NOT for AI search or public display';
COMMENT ON COLUMN public.restaurants.vat_number IS 'VAT registration number - NOT for AI search or public display';
