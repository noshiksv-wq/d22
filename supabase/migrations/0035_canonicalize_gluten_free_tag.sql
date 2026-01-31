-- Canonicalize duplicate "Gluten Free" diet tags without deleting IDs

-- 1) Repoint dish_tags from duplicate -> canonical
UPDATE public.dish_tags
SET tag_id = '991a8c82-3e92-4ead-8e6c-99587af0c2e0'
WHERE tag_id = '7936ae5f-821c-4c70-877f-a4c3171182ff';

-- 2) Mark duplicate tag as non-canonical
UPDATE public.tags
SET name = 'Gluten Free (duplicate)',
    slug = 'gluten-free-duplicate'
WHERE id = '7936ae5f-821c-4c70-877f-a4c3171182ff';

-- 3) Upsert aliases
INSERT INTO public.tag_aliases(alias, tag_type, tag_slug)
VALUES
  ('gluten free', 'diet', 'gluten-free'),
  ('glutenfri',  'diet', 'gluten-free'),
  ('gluten-free','diet', 'gluten-free')
ON CONFLICT (alias) DO UPDATE
SET tag_type = EXCLUDED.tag_type,
    tag_slug = EXCLUDED.tag_slug;

-- Verification queries (commented for manual execution)
-- Run these in Supabase SQL editor after migration:

-- Verify dish_tags has 0 rows with the duplicate id:
-- SELECT COUNT(*) FROM public.dish_tags WHERE tag_id = '7936ae5f-821c-4c70-877f-a4c3171182ff';

-- Verify exactly one diet tag has slug gluten-free:
-- SELECT id, name, type, slug FROM public.tags WHERE type = 'diet' AND slug LIKE 'gluten-free%';

-- Verify alias rows exist and point to (diet, gluten-free):
-- SELECT * FROM public.tag_aliases WHERE alias IN ('gluten free', 'glutenfri', 'gluten-free');
