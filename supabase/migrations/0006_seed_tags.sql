-- Update tags table schema and seed allergen/dietary data

-- 1. Add type column to categorize tags
ALTER TABLE public.tags 
ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'diet';

-- 2. Add check constraint for type (drop first if exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_type_check') THEN
    ALTER TABLE public.tags DROP CONSTRAINT tags_type_check;
  END IF;
END $$;

ALTER TABLE public.tags 
ADD CONSTRAINT tags_type_check CHECK (type IN ('allergen', 'diet', 'religious'));

-- 3. Update severity constraint to allow 'none'
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_severity_check') THEN
    ALTER TABLE public.tags DROP CONSTRAINT tags_severity_check;
  END IF;
END $$;

ALTER TABLE public.tags 
ADD CONSTRAINT tags_severity_check CHECK (severity IN ('high', 'medium', 'none'));

-- 4. Add unique constraint on name for ON CONFLICT
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_name_unique') THEN
    ALTER TABLE public.tags ADD CONSTRAINT tags_name_unique UNIQUE (name);
  END IF;
END $$;

-- 5. Seed Data

-- EU/US Allergens (high severity - life-threatening)
INSERT INTO public.tags (name, type, severity) VALUES
  ('Peanuts', 'allergen', 'high'),
  ('Tree Nuts', 'allergen', 'high'),
  ('Crustaceans', 'allergen', 'high'),
  ('Fish', 'allergen', 'high'),
  ('Eggs', 'allergen', 'high'),
  ('Milk', 'allergen', 'high'),
  ('Sesame', 'allergen', 'high')
ON CONFLICT (name) DO NOTHING;

-- EU Allergens (medium severity)
INSERT INTO public.tags (name, type, severity) VALUES
  ('Gluten', 'allergen', 'medium'),
  ('Soybeans', 'allergen', 'medium'),
  ('Celery', 'allergen', 'medium'),
  ('Mustard', 'allergen', 'medium'),
  ('Sulphites', 'allergen', 'medium'),
  ('Lupin', 'allergen', 'medium'),
  ('Molluscs', 'allergen', 'medium')
ON CONFLICT (name) DO NOTHING;

-- US Specific Allergens (medium severity)
INSERT INTO public.tags (name, type, severity) VALUES
  ('Wheat', 'allergen', 'medium'),
  ('Coconut', 'allergen', 'medium')
ON CONFLICT (name) DO NOTHING;

-- Diets (no danger, preference only)
INSERT INTO public.tags (name, type, severity) VALUES
  ('Vegan', 'diet', 'none'),
  ('Vegetarian', 'diet', 'none'),
  ('Pescetarian', 'diet', 'none')
ON CONFLICT (name) DO NOTHING;

-- Religious/Lifestyle (no danger, requirement)
INSERT INTO public.tags (name, type, severity) VALUES
  ('Halal', 'religious', 'none'),
  ('Kosher', 'religious', 'none'),
  ('Jain', 'religious', 'none'),
  ('Satvik', 'religious', 'none')
ON CONFLICT (name) DO NOTHING;

-- Update any existing tags that might have old severity values
UPDATE public.tags SET type = 'diet' WHERE type IS NULL;

