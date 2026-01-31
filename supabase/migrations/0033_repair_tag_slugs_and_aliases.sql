-- Repair tag slugs and correct tag_aliases for Tree Nuts

-- 1) Repair slugs (uppercase-safe slugify)
-- Use: lower(regexp_replace(name, '[^A-Za-z0-9]+', '-', 'g'))
-- Then trim(both '-' from ...)
-- Apply to all rows in public.tags (or at least those with slugs containing leading - or --)
-- Handle duplicates by checking if the new slug already exists for the same type
DO $$
DECLARE
  tag_record RECORD;
  new_slug TEXT;
  slug_exists BOOLEAN;
  counter INTEGER;
BEGIN
  FOR tag_record IN 
    SELECT id, name, type, slug
    FROM public.tags
    WHERE slug IS NULL
       OR slug LIKE '-%'
       OR slug LIKE '%-'
       OR slug LIKE '%--%'
  LOOP
    -- Generate new slug
    new_slug := TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(tag_record.name, '[^A-Za-z0-9]+', '-', 'g')));
    
    -- Check if this slug already exists for this type (excluding current row)
    SELECT EXISTS(
      SELECT 1 
      FROM public.tags 
      WHERE type = tag_record.type 
        AND slug = new_slug 
        AND id != tag_record.id
    ) INTO slug_exists;
    
    -- If duplicate exists, append a counter
    counter := 1;
    WHILE slug_exists LOOP
      new_slug := new_slug || '-' || counter::TEXT;
      SELECT EXISTS(
        SELECT 1 
        FROM public.tags 
        WHERE type = tag_record.type 
          AND slug = new_slug 
          AND id != tag_record.id
      ) INTO slug_exists;
      counter := counter + 1;
    END LOOP;
    
    -- Update the slug
    UPDATE public.tags
    SET slug = new_slug
    WHERE id = tag_record.id;
  END LOOP;
END $$;

-- 2) Fix the tag_aliases rows for "nut free" and "nötfri" to point to the correct slug
-- for the "Tree Nuts" allergen tag by selecting it from tags (don't hardcode)
UPDATE public.tag_aliases
SET tag_slug = (
  SELECT t.slug
  FROM public.tags t
  WHERE t.type = 'allergen' AND LOWER(t.name) = 'tree nuts'
  LIMIT 1
)
WHERE tag_type = 'allergen'
  AND alias IN ('nut free', 'nötfri');

-- (Optional) also fix any existing wrong slug values for these aliases
-- by ensuring they match the tags table value:
UPDATE public.tag_aliases a
SET tag_slug = t.slug
FROM public.tags t
WHERE a.tag_type = t.type
  AND a.tag_slug = '-ree-uts'
  AND t.type = 'allergen'
  AND LOWER(t.name) = 'tree nuts';

-- 3. Verification queries (commented for manual execution)
-- Run these in Supabase SQL editor after migration:

-- Check for slugs starting/ending with hyphens or containing double hyphens:
-- SELECT id, name, type, slug FROM public.tags WHERE LOWER(name) IN ('tree nuts') OR slug LIKE '-%' OR slug LIKE '%--%';

-- Verify "Tree Nuts" allergen tag slug is tree-nuts:
-- SELECT id, name, type, slug FROM public.tags WHERE type = 'allergen' AND LOWER(name) = 'tree nuts';

-- Verify aliases now point to tree-nuts:
-- SELECT * FROM public.tag_aliases WHERE alias IN ('nut free', 'nötfri');
