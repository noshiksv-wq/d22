-- Phase 2 Preparation: Geolocation & Required Fields
-- This migration adds location coordinates for map-based search

-- ============================================
-- GEOLOCATION
-- ============================================
-- Add latitude and longitude for precise location
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 7);
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7);

-- Create index for geospatial queries
CREATE INDEX IF NOT EXISTS idx_restaurants_location 
ON public.restaurants (latitude, longitude) 
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================
COMMENT ON COLUMN public.restaurants.latitude IS 'GPS latitude coordinate for map display and distance calculations';
COMMENT ON COLUMN public.restaurants.longitude IS 'GPS longitude coordinate for map display and distance calculations';
COMMENT ON COLUMN public.restaurants.city IS 'Required for location-based search (e.g., "restaurants in Gothenburg")';
COMMENT ON COLUMN public.restaurants.cuisine_type IS 'Required for cuisine filtering (e.g., "Indian restaurants")';
COMMENT ON COLUMN public.restaurants.opening_hours IS 'Required for "open now" filtering';

-- ============================================
-- UPDATE EXISTING RESTAURANTS WITH GOTHENBURG COORDINATES (Default)
-- ============================================
-- Gothenburg city center coordinates: 57.7089, 11.9746
UPDATE public.restaurants 
SET 
  latitude = COALESCE(latitude, 57.7089),
  longitude = COALESCE(longitude, 11.9746)
WHERE latitude IS NULL OR longitude IS NULL;

