-- Admin RLS Policies
-- Adds admin access policies to tables that already have RLS enabled
-- IMPORTANT: Only adds policies, does NOT enable RLS on new tables

-- ============================================
-- MODIFIER GROUPS (already has RLS)
-- ============================================
CREATE POLICY "admin_full_access_modifier_groups"
ON public.modifier_groups
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ============================================
-- MODIFIER OPTIONS (already has RLS)
-- ============================================
CREATE POLICY "admin_full_access_modifier_options"
ON public.modifier_options
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ============================================
-- DISH TAGS (already has RLS)
-- ============================================
CREATE POLICY "admin_full_access_dish_tags"
ON public.dish_tags
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ============================================
-- DISH MODIFIERS (already has RLS)
-- ============================================
CREATE POLICY "admin_full_access_dish_modifiers"
ON public.dish_modifiers
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ============================================
-- MODIFIER OPTION TAGS (already has RLS)
-- ============================================
CREATE POLICY "admin_full_access_modifier_option_tags"
ON public.modifier_option_tags
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ============================================
-- ANALYTICS SIMPLE (already has RLS - read-only for admins)
-- ============================================
CREATE POLICY "admin_read_analytics"
ON public.analytics_simple
FOR SELECT
TO authenticated
USING (is_admin());
