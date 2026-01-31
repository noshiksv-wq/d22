-- Fix Permissions for search_public_dishes RPC Function
-- Run this in Supabase SQL Editor

-- ============================================
-- Step 1: Grant Execute Permission
-- ============================================
-- Method 1: Grant with full signature
GRANT EXECUTE ON FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) TO anon, authenticated;

-- Method 2: If above doesn't work, try without parameters (PostgreSQL will match by name)
GRANT EXECUTE ON FUNCTION public.search_public_dishes TO anon, authenticated;

-- ============================================
-- Step 2: Verify Permissions
-- ============================================
-- Check if function exists
SELECT 
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments,
    p.proacl as permissions_array
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

-- Check permissions in a more readable format
SELECT 
    'search_public_dishes' as function_name,
    CASE 
        WHEN p.proacl IS NULL THEN 'No explicit permissions (defaults to owner)'
        ELSE array_to_string(p.proacl, E'\n')
    END as permissions
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

-- ============================================
-- Step 3: Test Direct Call (as service_role to verify function works)
-- ============================================
-- This should work regardless of permissions
SELECT * FROM public.search_public_dishes('naan', null, null, null, null, null, null) LIMIT 3;

-- ============================================
-- Step 4: Alternative - Make Function SECURITY DEFINER
-- ============================================
-- If GRANT doesn't work, we can make the function run with definer privileges
-- This allows it to bypass RLS when called by anon users
-- (Uncomment if needed)
/*
ALTER FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) SECURITY DEFINER;
*/

