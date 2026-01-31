-- Add selection logic columns to modifier_groups for Choices vs Add-ons

ALTER TABLE public.modifier_groups 
ADD COLUMN IF NOT EXISTS min_selection INTEGER DEFAULT 0;

ALTER TABLE public.modifier_groups 
ADD COLUMN IF NOT EXISTS max_selection INTEGER DEFAULT NULL;

ALTER TABLE public.modifier_groups 
ADD COLUMN IF NOT EXISTS modifier_type TEXT DEFAULT 'addon';

-- Add check constraint for modifier_type
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'modifier_groups_modifier_type_check'
  ) THEN
    ALTER TABLE public.modifier_groups 
    ADD CONSTRAINT modifier_groups_modifier_type_check 
    CHECK (modifier_type IN ('choice', 'addon'));
  END IF;
END $$;

-- Update existing rows to have proper defaults
UPDATE public.modifier_groups 
SET modifier_type = 'addon', min_selection = 0, max_selection = NULL 
WHERE modifier_type IS NULL;

