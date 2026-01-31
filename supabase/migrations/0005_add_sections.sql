-- Add sections table between menus and dishes
-- Structure: Menu > Section > Dishes

-- Create sections table
CREATE TABLE IF NOT EXISTS public.sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id UUID NOT NULL REFERENCES public.menus(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add section_id to dishes (nullable for migration)
ALTER TABLE public.dishes 
ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES public.sections(id) ON DELETE CASCADE;

-- Create index for sections
CREATE INDEX IF NOT EXISTS idx_sections_menu_id ON public.sections(menu_id);
CREATE INDEX IF NOT EXISTS idx_dishes_section_id ON public.dishes(section_id);

-- Disable RLS for development (enable with proper policies for production)
ALTER TABLE public.sections DISABLE ROW LEVEL SECURITY;

