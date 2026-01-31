-- Complete Restaurant Profile Migration
-- Adds all fields needed for a professional restaurant management platform

-- ============================================
-- BASIC INFO
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS cuisine_type TEXT;

-- ============================================
-- LOCATION
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS city TEXT DEFAULT 'Gothenburg';
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS zip_code TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Sweden';
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Stockholm';

-- ============================================
-- CONTACT
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS website TEXT;

-- ============================================
-- SOCIAL MEDIA
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS facebook TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS tiktok TEXT;

-- ============================================
-- BRANDING
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#000000';
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS secondary_color TEXT DEFAULT '#ffffff';

-- ============================================
-- SERVICE OPTIONS
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS accepts_dine_in BOOLEAN DEFAULT true;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS accepts_takeaway BOOLEAN DEFAULT true;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS accepts_delivery BOOLEAN DEFAULT false;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS accepts_reservations BOOLEAN DEFAULT false;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS reservation_url TEXT;

-- ============================================
-- FINANCIAL
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 12.00;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS service_charge NUMERIC(5,2) DEFAULT 0;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS minimum_order NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) DEFAULT 0;

-- ============================================
-- OPERATIONS
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS avg_prep_time INTEGER DEFAULT 20;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS seating_capacity INTEGER;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC(5,2);

-- ============================================
-- THIRD-PARTY INTEGRATIONS
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS uber_eats_url TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS doordash_url TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS deliveroo_url TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS google_maps_id TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS tripadvisor_url TEXT;

-- ============================================
-- AMENITIES (stored as JSON for flexibility)
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS amenities JSONB DEFAULT '{
  "wheelchair_accessible": false,
  "has_parking": false,
  "has_wifi": false,
  "outdoor_seating": false,
  "pet_friendly": false,
  "kid_friendly": true,
  "has_bar": false,
  "has_private_rooms": false
}'::jsonb;

-- ============================================
-- LEGAL
-- ============================================
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS business_registration TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS vat_number TEXT;

-- ============================================
-- Create storage bucket for restaurant assets
-- (Run this separately in Supabase Dashboard > Storage)
-- ============================================
-- INSERT INTO storage.buckets (id, name, public) 
-- VALUES ('restaurant-assets', 'restaurant-assets', true)
-- ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Set defaults for existing restaurants
-- ============================================
UPDATE public.restaurants SET
  city = COALESCE(city, 'Gothenburg'),
  country = COALESCE(country, 'Sweden'),
  timezone = COALESCE(timezone, 'Europe/Stockholm'),
  primary_color = COALESCE(primary_color, '#000000'),
  accepts_dine_in = COALESCE(accepts_dine_in, true),
  accepts_takeaway = COALESCE(accepts_takeaway, true),
  tax_rate = COALESCE(tax_rate, 12.00),
  avg_prep_time = COALESCE(avg_prep_time, 20)
WHERE true;

