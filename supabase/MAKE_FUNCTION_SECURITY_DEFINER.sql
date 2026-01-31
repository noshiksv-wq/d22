-- Make search_public_dishes function SECURITY DEFINER
-- This allows it to bypass RLS when called by anon users
-- Run this in Supabase SQL Editor

ALTER FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) SECURITY DEFINER;

-- Verify it's set
SELECT 
    p.proname as function_name,
    CASE 
        WHEN p.prosecdef THEN 'SECURITY DEFINER'
        ELSE 'SECURITY INVOKER'
    END as security_type
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

