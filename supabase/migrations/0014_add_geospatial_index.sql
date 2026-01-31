-- Add Geospatial Index for Efficient Radius Queries
-- This enables high-performance location-based searches using PostGIS

-- ============================================
-- ENABLE POSTGIS EXTENSION
-- ============================================
-- PostGIS extension is required for GEOGRAPHY type and spatial functions
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================
-- ENSURE LATITUDE/LONGITUDE COLUMNS EXIST
-- ============================================
-- Add latitude and longitude columns if they don't exist
-- These are needed to backfill the location column
ALTER TABLE public.restaurants 
ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 7),
ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7);

-- ============================================
-- ENSURE LOCATION COLUMN EXISTS
-- ============================================
-- Add location column (GEOGRAPHY type) if it doesn't exist
-- This column stores lat/lng as a PostGIS geography point for efficient spatial queries
ALTER TABLE public.restaurants 
ADD COLUMN IF NOT EXISTS location GEOGRAPHY(POINT, 4326);

-- ============================================
-- GEOSPATIAL INDEX (GiST)
-- ============================================
-- Create GiST index on location column for efficient ST_DWithin queries
-- This is essential for radius-based searches (e.g., "restaurants within 5km")
CREATE INDEX IF NOT EXISTS idx_restaurants_location_gist
ON public.restaurants USING GIST (location)
WHERE location IS NOT NULL;

-- ============================================
-- BACKFILL LOCATION FROM LAT/LONG
-- ============================================
-- Populate location column from existing latitude/longitude columns
-- Note: PostGIS ST_MakePoint expects (longitude, latitude) order
UPDATE public.restaurants 
SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE location IS NULL 
  AND longitude IS NOT NULL 
  AND latitude IS NOT NULL;

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================
COMMENT ON INDEX idx_restaurants_location_gist IS 'GiST index for efficient geospatial radius queries using ST_DWithin';
