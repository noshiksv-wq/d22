-- Admin RLS Policies for Public Tables (Conditional)
-- Adds admin policies to restaurants, menus, dishes, tags IF RLS is already enabled
-- IMPORTANT: This does NOT enable RLS on these tables - only adds policies if RLS exists
-- These tables are intentionally public for menu pages and B2C search

-- ============================================
-- RESTAURANTS (only if RLS is enabled)
-- ============================================
-- Check if RLS is enabled, if so add admin policy
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE t.schemaname = 'public' 
    AND t.tablename = 'restaurants'
    AND c.relrowsecurity = true
  ) THEN
    -- RLS is enabled, add admin policy
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE tablename = 'restaurants' 
      AND policyname = 'admin_full_access_restaurants'
    ) THEN
      CREATE POLICY "admin_full_access_restaurants"
      ON public.restaurants
      FOR ALL
      TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
    END IF;
  END IF;
END $$;

-- ============================================
-- MENUS (only if RLS is enabled)
-- ============================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE t.schemaname = 'public' 
    AND t.tablename = 'menus'
    AND c.relrowsecurity = true
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE tablename = 'menus' 
      AND policyname = 'admin_full_access_menus'
    ) THEN
      CREATE POLICY "admin_full_access_menus"
      ON public.menus
      FOR ALL
      TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
    END IF;
  END IF;
END $$;

-- ============================================
-- DISHES (only if RLS is enabled)
-- ============================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE t.schemaname = 'public' 
    AND t.tablename = 'dishes'
    AND c.relrowsecurity = true
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE tablename = 'dishes' 
      AND policyname = 'admin_full_access_dishes'
    ) THEN
      CREATE POLICY "admin_full_access_dishes"
      ON public.dishes
      FOR ALL
      TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
    END IF;
  END IF;
END $$;

-- ============================================
-- TAGS (only if RLS is enabled)
-- ============================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE t.schemaname = 'public' 
    AND t.tablename = 'tags'
    AND c.relrowsecurity = true
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE tablename = 'tags' 
      AND policyname = 'admin_full_access_tags'
    ) THEN
      CREATE POLICY "admin_full_access_tags"
      ON public.tags
      FOR ALL
      TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
    END IF;
  END IF;
END $$;

-- Comments (only add if policies exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'restaurants' 
    AND policyname = 'admin_full_access_restaurants'
  ) THEN
    COMMENT ON POLICY "admin_full_access_restaurants" ON public.restaurants IS 'Admin full access to restaurants (only if RLS is enabled)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'menus' 
    AND policyname = 'admin_full_access_menus'
  ) THEN
    COMMENT ON POLICY "admin_full_access_menus" ON public.menus IS 'Admin full access to menus (only if RLS is enabled)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'dishes' 
    AND policyname = 'admin_full_access_dishes'
  ) THEN
    COMMENT ON POLICY "admin_full_access_dishes" ON public.dishes IS 'Admin full access to dishes (only if RLS is enabled)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'tags' 
    AND policyname = 'admin_full_access_tags'
  ) THEN
    COMMENT ON POLICY "admin_full_access_tags" ON public.tags IS 'Admin full access to tags (only if RLS is enabled)';
  END IF;
END $$;
