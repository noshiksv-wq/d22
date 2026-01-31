-- B2C Public Search Preparation
-- Adds public visibility flags and performance indexes for cross-restaurant search

-- ============================================
-- PUBLIC VISIBILITY FLAGS
-- ============================================
-- All restaurants and dishes are public by default (as per requirement)
ALTER TABLE public.restaurants 
ADD COLUMN IF NOT EXISTS public_searchable BOOLEAN DEFAULT true;

ALTER TABLE public.dishes 
ADD COLUMN IF NOT EXISTS public BOOLEAN DEFAULT true;

-- Set existing data to public (backfill)
UPDATE public.restaurants 
SET public_searchable = true 
WHERE public_searchable IS NULL;

UPDATE public.dishes 
SET public = true 
WHERE public IS NULL;

-- ============================================
-- PERFORMANCE INDEXES FOR B2C SEARCH
-- ============================================

-- Restaurant indexes for location-based filtering
CREATE INDEX IF NOT EXISTS idx_restaurants_public_searchable 
ON public.restaurants (public_searchable) 
WHERE public_searchable = true;

CREATE INDEX IF NOT EXISTS idx_restaurants_city 
ON public.restaurants (city) 
WHERE city IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_country_city 
ON public.restaurants (country, city) 
WHERE country IS NOT NULL AND city IS NOT NULL;

-- Dish indexes for public filtering
CREATE INDEX IF NOT EXISTS idx_dishes_public 
ON public.dishes (public) 
WHERE public = true;

-- Composite index for common B2C queries (menu + public + name search)
-- Note: dishes link to restaurants via menus, so we index on menu_id
CREATE INDEX IF NOT EXISTS idx_dishes_menu_public 
ON public.dishes (menu_id, public) 
WHERE public = true;

CREATE INDEX IF NOT EXISTS idx_dishes_public_name 
ON public.dishes (public, name) 
WHERE public = true;

-- Tag indexes (already exist but ensure they're optimized)
CREATE INDEX IF NOT EXISTS idx_dish_tags_tag_id_optimized 
ON public.dish_tags (tag_id);

CREATE INDEX IF NOT EXISTS idx_dish_tags_dish_id_optimized 
ON public.dish_tags (dish_id);

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================
COMMENT ON COLUMN public.restaurants.public_searchable IS 'If true, restaurant appears in B2C public search. Default true for all signups.';
COMMENT ON COLUMN public.dishes.public IS 'If true, dish appears in B2C public search. Default true for all dishes.';

-- ============================================
-- CONSTRAINTS
-- ============================================
-- Ensure public flags cannot be null (after backfilling)
ALTER TABLE public.restaurants 
ALTER COLUMN public_searchable SET NOT NULL,
ALTER COLUMN public_searchable SET DEFAULT true;

ALTER TABLE public.dishes 
ALTER COLUMN public SET NOT NULL,
ALTER COLUMN public SET DEFAULT true;
