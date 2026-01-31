-- Fix gluten-free diet tag and update aliases

-- 1) Find all diet tags with slug starting with 'gluten-free' and ensure exactly one has slug 'gluten-free'
DO $$
DECLARE
  gluten_free_tags RECORD;
  canonical_id UUID;
  tag_count INTEGER;
  counter INTEGER;
BEGIN
  -- Count how many diet tags have slug starting with 'gluten-free'
  SELECT COUNT(*) INTO tag_count
  FROM public.tags
  WHERE type = 'diet' AND slug LIKE 'gluten-free%';
  
  IF tag_count > 0 THEN
    -- Find the canonical tag (prefer one that already has slug exactly 'gluten-free', otherwise pick the first)
    SELECT id INTO canonical_id
    FROM public.tags
    WHERE type = 'diet' AND slug = 'gluten-free'
    LIMIT 1;
    
    -- If no tag has exact slug 'gluten-free', pick the first one
    IF canonical_id IS NULL THEN
      SELECT id INTO canonical_id
      FROM public.tags
      WHERE type = 'diet' AND slug LIKE 'gluten-free%'
      ORDER BY created_at ASC
      LIMIT 1;
    END IF;
    
    -- Set canonical tag slug to exactly 'gluten-free'
    UPDATE public.tags
    SET slug = 'gluten-free'
    WHERE id = canonical_id;
    
    -- Rename other tags with gluten-free slugs (excluding the canonical one)
    counter := 1;
    FOR gluten_free_tags IN
      SELECT id, slug
      FROM public.tags
      WHERE type = 'diet' 
        AND slug LIKE 'gluten-free%'
        AND id != canonical_id
      ORDER BY created_at ASC
    LOOP
      -- Check if slug is exactly 'gluten-free' (shouldn't happen after first update, but safe)
      IF gluten_free_tags.slug = 'gluten-free' THEN
        -- This is a duplicate, rename with -duplicate suffix
        UPDATE public.tags
        SET slug = 'gluten-free-duplicate-' || counter::TEXT
        WHERE id = gluten_free_tags.id;
        counter := counter + 1;
      ELSE
        -- This has a variant slug, rename to gluten-free-alt
        UPDATE public.tags
        SET slug = 'gluten-free-alt-' || counter::TEXT
        WHERE id = gluten_free_tags.id;
        counter := counter + 1;
      END IF;
    END LOOP;
  END IF;
END $$;

-- 2) Upsert tag_aliases so 'gluten free' and 'glutenfri' point to (diet, gluten-free)
INSERT INTO public.tag_aliases (alias, tag_type, tag_slug) VALUES
  ('gluten free', 'diet', 'gluten-free'),
  ('glutenfri', 'diet', 'gluten-free')
ON CONFLICT (alias) 
DO UPDATE SET
  tag_type = EXCLUDED.tag_type,
  tag_slug = EXCLUDED.tag_slug;

-- 3. Verification queries (commented for manual execution)
-- Run these in Supabase SQL editor after migration:

-- Verify exactly one diet tag has slug 'gluten-free':
-- SELECT id, name, type, slug FROM public.tags WHERE type = 'diet' AND slug = 'gluten-free';

-- Verify alias rows exist and point to (diet, gluten-free):
-- SELECT * FROM public.tag_aliases WHERE alias IN ('gluten free', 'glutenfri');

-- Check for any other diet tags with gluten-free related slugs:
-- SELECT id, name, type, slug FROM public.tags WHERE type = 'diet' AND slug LIKE 'gluten-free%';
