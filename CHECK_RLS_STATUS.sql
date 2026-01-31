-- Quick Check: Are RLS Policies in Place?
-- Run this in Supabase SQL Editor to verify RLS setup

-- Check if RLS is enabled and policies exist
SELECT 
    tablename,
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = tablename
            AND n.nspname = 'public'
            AND c.relrowsecurity = true
        ) THEN 'RLS Enabled'
        ELSE 'RLS Disabled'
    END as rls_status,
    (
        SELECT COUNT(*)
        FROM pg_policies
        WHERE schemaname = 'public'
        AND tablename = t.tablename
        AND (roles::text[] && ARRAY['anon']::text[] OR roles::text[] && ARRAY['"anon"']::text[])
    ) as anon_policies_count
FROM (
    SELECT unnest(ARRAY['restaurants', 'menus', 'dishes', 'tags', 'dish_tags']) as tablename
) t
ORDER BY tablename;

-- Check specific policies
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('restaurants', 'menus', 'dishes', 'tags', 'dish_tags')
  AND (roles::text[] && ARRAY['anon']::text[] OR roles::text[] && ARRAY['"anon"']::text[])
ORDER BY tablename, policyname;

