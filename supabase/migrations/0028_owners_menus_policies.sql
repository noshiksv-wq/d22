-- RLS Policies for Menus and Dishes - Restaurant Owner Access
-- Allows restaurant owners to manage menus and dishes for their restaurants
-- This complements the public_read policies (for B2C) and admin_full_access policies (for admins)
--
-- IMPORTANT: The public_read_menus and public_read_dishes policies from migration 0025
-- should still work for anonymous users. These owner policies only apply to authenticated
-- restaurant owners and do not interfere with public access.

-- ============================================
-- MENUS - Owner Policies
-- ============================================
-- Restaurant owners can SELECT menus for their restaurants
CREATE POLICY "owners_select_own_menus"
ON public.menus
FOR SELECT
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- Restaurant owners can INSERT menus for their restaurants
CREATE POLICY "owners_insert_own_menus"
ON public.menus
FOR INSERT
TO authenticated
WITH CHECK (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- Restaurant owners can UPDATE menus for their restaurants
CREATE POLICY "owners_update_own_menus"
ON public.menus
FOR UPDATE
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
)
WITH CHECK (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- Restaurant owners can DELETE menus for their restaurants
CREATE POLICY "owners_delete_own_menus"
ON public.menus
FOR DELETE
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- Comments
COMMENT ON POLICY "owners_select_own_menus" ON public.menus IS 
  'Restaurant owners can view menus for their restaurants';
COMMENT ON POLICY "owners_insert_own_menus" ON public.menus IS 
  'Restaurant owners can create menus for their restaurants';
COMMENT ON POLICY "owners_update_own_menus" ON public.menus IS 
  'Restaurant owners can update menus for their restaurants';
COMMENT ON POLICY "owners_delete_own_menus" ON public.menus IS 
  'Restaurant owners can delete menus for their restaurants';

-- ============================================
-- DISHES - Owner Policies
-- ============================================
-- Restaurant owners can SELECT dishes for their restaurants (via menu ownership)
CREATE POLICY "owners_select_own_dishes"
ON public.dishes
FOR SELECT
TO authenticated
USING (
  menu_id IN (
    SELECT m.id FROM public.menus m
    JOIN public.restaurants r ON m.restaurant_id = r.id
    WHERE r.owner_id = auth.uid()
  )
);

-- Restaurant owners can INSERT dishes for their restaurants (via menu ownership)
CREATE POLICY "owners_insert_own_dishes"
ON public.dishes
FOR INSERT
TO authenticated
WITH CHECK (
  menu_id IN (
    SELECT m.id FROM public.menus m
    JOIN public.restaurants r ON m.restaurant_id = r.id
    WHERE r.owner_id = auth.uid()
  )
);

-- Restaurant owners can UPDATE dishes for their restaurants (via menu ownership)
CREATE POLICY "owners_update_own_dishes"
ON public.dishes
FOR UPDATE
TO authenticated
USING (
  menu_id IN (
    SELECT m.id FROM public.menus m
    JOIN public.restaurants r ON m.restaurant_id = r.id
    WHERE r.owner_id = auth.uid()
  )
)
WITH CHECK (
  menu_id IN (
    SELECT m.id FROM public.menus m
    JOIN public.restaurants r ON m.restaurant_id = r.id
    WHERE r.owner_id = auth.uid()
  )
);

-- Restaurant owners can DELETE dishes for their restaurants (via menu ownership)
CREATE POLICY "owners_delete_own_dishes"
ON public.dishes
FOR DELETE
TO authenticated
USING (
  menu_id IN (
    SELECT m.id FROM public.menus m
    JOIN public.restaurants r ON m.restaurant_id = r.id
    WHERE r.owner_id = auth.uid()
  )
);

-- Comments for dishes policies
COMMENT ON POLICY "owners_select_own_dishes" ON public.dishes IS 
  'Restaurant owners can view dishes for their restaurants';
COMMENT ON POLICY "owners_insert_own_dishes" ON public.dishes IS 
  'Restaurant owners can create dishes for their restaurants';
COMMENT ON POLICY "owners_update_own_dishes" ON public.dishes IS 
  'Restaurant owners can update dishes for their restaurants';
COMMENT ON POLICY "owners_delete_own_dishes" ON public.dishes IS 
  'Restaurant owners can delete dishes for their restaurants';
