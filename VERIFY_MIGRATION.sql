-- Quick verification: Check if function is SECURITY DEFINER
-- Run this in Supabase SQL Editor

SELECT 
    p.proname as function_name,
    CASE 
        WHEN p.prosecdef THEN 'SECURITY DEFINER ✓ (Correct)'
        ELSE 'SECURITY INVOKER ✗ (Needs Fix)'
    END as security_type,
    p.proconfig as search_path_config
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

-- Also check permissions
SELECT 
    'Function permissions' as check_type,
    CASE 
        WHEN p.proacl IS NULL THEN 'No explicit permissions'
        ELSE array_to_string(p.proacl, E'\n')
    END as permissions
FROM pg_proc p
WHERE p.proname = 'search_public_dishes'
  AND p.pronamespace = 'public'::regnamespace;

