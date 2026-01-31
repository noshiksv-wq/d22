-- Add slug column to tags and create tag_aliases table for robust tag resolution

-- 1. Add slug column to public.tags if missing
ALTER TABLE public.tags 
ADD COLUMN IF NOT EXISTS slug TEXT;

-- 2. Backfill slug from name
-- Function: lowercase + replace non-alphanumeric with - + trim leading/trailing -
UPDATE public.tags
SET slug = TRIM(
  REGEXP_REPLACE(
    REGEXP_REPLACE(LOWER(name), '[^a-z0-9]', '-', 'g'),
    '-+', '-', 'g'
  ),
  '-'
)
WHERE slug IS NULL;

-- 3. Ensure slug is not null
ALTER TABLE public.tags 
ALTER COLUMN slug SET NOT NULL;

-- 4. Add unique index on (type, slug)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_type_slug_unique 
ON public.tags (type, slug);

-- 5. Create public.tag_aliases table
-- Drop and recreate to ensure correct structure (safe for new table)
DROP TABLE IF EXISTS public.tag_aliases CASCADE;

CREATE TABLE public.tag_aliases (
  alias TEXT PRIMARY KEY,
  tag_type TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Add index on (tag_type, tag_slug) for efficient lookups
CREATE INDEX IF NOT EXISTS idx_tag_aliases_type_slug 
ON public.tag_aliases (tag_type, tag_slug);

-- 7. Seed aliases for common user terms
-- Note: Using INSERT ... ON CONFLICT DO NOTHING to avoid duplicates

-- Vegetarian aliases → (diet, vegetarian)
INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
  ('veg', 'diet', 'vegetarian'),
  ('ve', 'diet', 'vegetarian'),
  ('vego', 'diet', 'vegetarian'),
  ('veggie', 'diet', 'vegetarian'),
  ('vegetarisk', 'diet', 'vegetarian'),
  ('köttfri', 'diet', 'vegetarian')
ON CONFLICT (alias) DO NOTHING;

-- Vegan aliases → (diet, vegan)
INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
  ('vegansk', 'diet', 'vegan'),
  ('plant-based', 'diet', 'vegan'),
  ('växtbaserad', 'diet', 'vegan')
ON CONFLICT (alias) DO NOTHING;

-- Gluten-free aliases → (allergen, gluten-free)
-- Note: Check if 'gluten-free' tag exists, otherwise use 'gluten'
DO $$
DECLARE
  gluten_free_slug TEXT;
BEGIN
  SELECT slug INTO gluten_free_slug 
  FROM public.tags 
  WHERE type = 'allergen' AND (slug = 'gluten-free' OR name ILIKE '%gluten%free%')
  LIMIT 1;
  
  IF gluten_free_slug IS NULL THEN
    SELECT slug INTO gluten_free_slug 
    FROM public.tags 
    WHERE type = 'allergen' AND slug = 'gluten'
    LIMIT 1;
  END IF;
  
  IF gluten_free_slug IS NOT NULL THEN
    INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
      ('gluten free', 'allergen', gluten_free_slug),
      ('glutenfri', 'allergen', gluten_free_slug)
    ON CONFLICT (alias) DO NOTHING;
  END IF;
END $$;

-- Tree nuts aliases → (allergen, tree-nuts)
DO $$
DECLARE
  tree_nuts_slug TEXT;
BEGIN
  SELECT slug INTO tree_nuts_slug 
  FROM public.tags 
  WHERE type = 'allergen' AND (slug = 'tree-nuts' OR name ILIKE '%tree%nut%')
  LIMIT 1;
  
  IF tree_nuts_slug IS NOT NULL THEN
    INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
      ('nut free', 'allergen', tree_nuts_slug),
      ('nötfri', 'allergen', tree_nuts_slug)
    ON CONFLICT (alias) DO NOTHING;
  END IF;
END $$;

-- Milk aliases → (allergen, milk)
DO $$
DECLARE
  milk_slug TEXT;
BEGIN
  SELECT slug INTO milk_slug 
  FROM public.tags 
  WHERE type = 'allergen' AND slug = 'milk'
  LIMIT 1;
  
  IF milk_slug IS NOT NULL THEN
    INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
      ('dairy free', 'allergen', milk_slug),
      ('mjölkfri', 'allergen', milk_slug)
    ON CONFLICT (alias) DO NOTHING;
  END IF;
END $$;

-- Lactose-free aliases → (allergen, lactose-free) if tag exists
DO $$
DECLARE
  lactose_free_slug TEXT;
BEGIN
  SELECT slug INTO lactose_free_slug 
  FROM public.tags 
  WHERE type = 'allergen' AND (slug = 'lactose-free' OR name ILIKE '%lactose%free%')
  LIMIT 1;
  
  IF lactose_free_slug IS NOT NULL THEN
    INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
      ('lactose free', 'allergen', lactose_free_slug),
      ('laktosfri', 'allergen', lactose_free_slug)
    ON CONFLICT (alias) DO NOTHING;
  END IF;
END $$;

-- 8. Verification queries (commented for manual execution)
-- Run these in Supabase SQL editor after migration:

-- Check for duplicate slugs:
-- SELECT type, slug, count(*) FROM public.tags GROUP BY 1,2 HAVING count(*) > 1;

-- List all tag aliases:
-- SELECT * FROM public.tag_aliases ORDER BY alias;

-- List all tags with type and slug:
-- SELECT id, name, type, slug FROM public.tags ORDER BY type, name;
