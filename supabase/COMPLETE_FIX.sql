-- Complete Fix for B2C Discovery Search
-- Run this entire script in Supabase SQL Editor

-- ============================================
-- Step 1: Make Function SECURITY DEFINER
-- ============================================
ALTER FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) SECURITY DEFINER;

-- ============================================
-- Step 2: Grant Execute Permissions (with full signature)
-- ============================================
GRANT EXECUTE ON FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) TO anon, authenticated;

-- Also try without parameters (PostgreSQL will match by name)
GRANT EXECUTE ON FUNCTION public.search_public_dishes TO anon, authenticated;

-- ============================================
-- Step 3: Verify Function Setup
-- ============================================
SELECT 
    p.proname as function_name,
    CASE 
        WHEN p.prosecdef THEN 'SECURITY DEFINER ✓'
        ELSE 'SECURITY INVOKER ✗'
    END as security_type,
    CASE 
        WHEN p.proacl IS NULL THEN 'No explicit permissions'
        ELSE array_to_string(p.proacl, ', ')
    END as permissions
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

-- ============================================
-- Step 4: Test Function Call
-- ============================================
-- This should return results
SELECT 
    restaurant_name,
    restaurant_city,
    jsonb_array_length(matching_dishes) as dish_count
FROM public.search_public_dishes('butter naan', 'GOTHENBURG', null, null, null, null, null)
LIMIT 3;

-- ============================================
-- Step 5: Verify RLS Policies
-- ============================================
SELECT 
    tablename,
    policyname,
    roles,
    cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('restaurants', 'menus', 'dishes', 'tags', 'dish_tags')
  AND (roles::text[] && ARRAY['anon']::text[] OR roles::text[] && ARRAY['"anon"']::text[])
ORDER BY tablename, policyname;

