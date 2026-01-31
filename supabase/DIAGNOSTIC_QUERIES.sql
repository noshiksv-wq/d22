-- Diagnostic Queries for B2C Discovery Search
-- Run these in Supabase SQL Editor to diagnose search issues

-- ============================================
-- 1. Check Public Flags
-- ============================================
SELECT 
  'Restaurants with public_searchable = true' as check_type,
  COUNT(*) as count
FROM public.restaurants 
WHERE public_searchable = true;

SELECT 
  'Dishes with public = true' as check_type,
  COUNT(*) as count
FROM public.dishes 
WHERE public = true;

-- ============================================
-- 2. Check if dishes contain "naan"
-- ============================================
SELECT 
  d.id,
  d.name,
  d.public,
  r.name as restaurant_name,
  r.public_searchable,
  r.city
FROM public.dishes d
JOIN public.menus m ON m.id = d.menu_id
JOIN public.restaurants r ON r.id = m.restaurant_id
WHERE d.name ILIKE '%naan%'
LIMIT 20;

-- ============================================
-- 3. Test RPC Function Directly
-- ============================================
-- Simple search
SELECT *
FROM public.search_public_dishes('naan', null, null, null, null, null, null)
LIMIT 5;

-- Search with city
SELECT *
FROM public.search_public_dishes('naan', 'GOTHENBURG', null, null, null, null, null)
LIMIT 5;

-- Search for butter naan
SELECT *
FROM public.search_public_dishes('butter naan', 'GOTHENBURG', null, null, null, null, null)
LIMIT 5;

-- ============================================
-- 4. Check RLS Policies
-- ============================================
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('restaurants', 'menus', 'dishes', 'tags', 'dish_tags')
ORDER BY tablename, policyname;

-- ============================================
-- 5. Check if RLS is Enabled
-- ============================================
SELECT 
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
WHERE t.schemaname = 'public'
  AND t.tablename IN ('restaurants', 'menus', 'dishes', 'tags', 'dish_tags')
ORDER BY tablename;

-- ============================================
-- 6. Check Function Permissions
-- ============================================
SELECT 
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  CASE 
    WHEN p.proacl IS NULL THEN 'Default permissions (owner only)'
    ELSE array_to_string(p.proacl, ', ')
  END as permissions
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

-- Alternative: Check if function is granted to anon/authenticated
SELECT 
  'search_public_dishes' as function_name,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.proname = 'search_public_dishes'
        AND p.pronamespace = 'public'::regnamespace
        AND (p.proacl IS NULL OR 'anon' = ANY(SELECT unnest(p.proacl)::text))
    ) THEN 'Has anon access'
    ELSE 'No anon access'
  END as anon_access,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.proname = 'search_public_dishes'
        AND p.pronamespace = 'public'::regnamespace
        AND (p.proacl IS NULL OR 'authenticated' = ANY(SELECT unnest(p.proacl)::text))
    ) THEN 'Has authenticated access'
    ELSE 'No authenticated access'
  END as authenticated_access;

-- ============================================
-- 7. Test as Anon User (if possible)
-- ============================================
-- Note: This requires switching to anon role in Supabase
-- SET ROLE anon;
-- SELECT * FROM public.search_public_dishes('naan', null, null, null, null, null, null);
-- RESET ROLE;

