-- B2C Public Read Policies for Discovery Search
-- Enables anonymous users to read public restaurants and dishes for B2C search
-- This is REQUIRED for the search_public_dishes RPC to work with anon users

-- ============================================
-- RESTAURANTS - Public Read for B2C Search
-- ============================================
-- Enable RLS if not already enabled
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "public_read_restaurants" ON public.restaurants;

-- Create public read policy (only for public_searchable restaurants)
CREATE POLICY "public_read_restaurants"
ON public.restaurants
FOR SELECT
TO anon, authenticated
USING (public_searchable = true);

COMMENT ON POLICY "public_read_restaurants" ON public.restaurants IS 'B2C public read access - allows anon users to read public_searchable restaurants';

-- ============================================
-- MENUS - Public Read (needed for dish joins)
-- ============================================
-- Enable RLS if not already enabled
ALTER TABLE public.menus ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "public_read_menus" ON public.menus;

-- Create public read policy (menus are public if their restaurant is public)
CREATE POLICY "public_read_menus"
ON public.menus
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.restaurants r
    WHERE r.id = menus.restaurant_id
    AND r.public_searchable = true
  )
);

COMMENT ON POLICY "public_read_menus" ON public.menus IS 'B2C public read access - allows anon users to read menus from public restaurants';

-- ============================================
-- DISHES - Public Read for B2C Search
-- ============================================
-- Enable RLS if not already enabled
ALTER TABLE public.dishes ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "public_read_dishes" ON public.dishes;

-- Create public read policy (only for public dishes from public restaurants)
CREATE POLICY "public_read_dishes"
ON public.dishes
FOR SELECT
TO anon, authenticated
USING (
  public = true
  AND EXISTS (
    SELECT 1 FROM public.menus m
    JOIN public.restaurants r ON r.id = m.restaurant_id
    WHERE m.id = dishes.menu_id
    AND r.public_searchable = true
  )
);

COMMENT ON POLICY "public_read_dishes" ON public.dishes IS 'B2C public read access - allows anon users to read public dishes from public restaurants';

-- ============================================
-- TAGS - Public Read (needed for dietary filters)
-- ============================================
-- Enable RLS if not already enabled
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "public_read_tags" ON public.tags;

-- Create public read policy (tags are public for dietary filtering)
CREATE POLICY "public_read_tags"
ON public.tags
FOR SELECT
TO anon, authenticated
USING (true);

COMMENT ON POLICY "public_read_tags" ON public.tags IS 'B2C public read access - allows anon users to read tags for dietary filtering';

-- ============================================
-- DISH_TAGS - Public Read (needed for dietary filters)
-- ============================================
-- Enable RLS if not already enabled
ALTER TABLE public.dish_tags ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "public_read_dish_tags" ON public.dish_tags;

-- Create public read policy (dish_tags are public for dietary filtering)
CREATE POLICY "public_read_dish_tags"
ON public.dish_tags
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.dishes d
    JOIN public.menus m ON m.id = d.menu_id
    JOIN public.restaurants r ON r.id = m.restaurant_id
    WHERE d.id = dish_tags.dish_id
    AND d.public = true
    AND r.public_searchable = true
  )
);

COMMENT ON POLICY "public_read_dish_tags" ON public.dish_tags IS 'B2C public read access - allows anon users to read dish_tags for dietary filtering';
