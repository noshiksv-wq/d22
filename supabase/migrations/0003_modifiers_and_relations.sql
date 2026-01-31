-- Phase 2: Modifiers and relationship tables

-- modifier_groups (e.g., "Spice Level", "Size")
CREATE TABLE IF NOT EXISTS public.modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- modifier_options (e.g., "Mild", "Hot" for Spice Level)
CREATE TABLE IF NOT EXISTS public.modifier_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_adjustment NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dish_tags junction table
CREATE TABLE IF NOT EXISTS public.dish_tags (
  dish_id UUID NOT NULL REFERENCES public.dishes(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  PRIMARY KEY (dish_id, tag_id)
);

-- dish_modifiers junction table
CREATE TABLE IF NOT EXISTS public.dish_modifiers (
  dish_id UUID NOT NULL REFERENCES public.dishes(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (dish_id, modifier_group_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_modifier_groups_restaurant_id ON public.modifier_groups(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_modifier_options_group_id ON public.modifier_options(group_id);
CREATE INDEX IF NOT EXISTS idx_dish_tags_dish_id ON public.dish_tags(dish_id);
CREATE INDEX IF NOT EXISTS idx_dish_tags_tag_id ON public.dish_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_dish_modifiers_dish_id ON public.dish_modifiers(dish_id);
CREATE INDEX IF NOT EXISTS idx_dish_modifiers_modifier_group_id ON public.dish_modifiers(modifier_group_id);

-- Enable RLS (Row Level Security) for new tables
ALTER TABLE public.modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_modifiers ENABLE ROW LEVEL SECURITY;

-- RLS Policies for modifier_groups
CREATE POLICY "Users can view modifier groups for their restaurants" ON public.modifier_groups
  FOR SELECT USING (
    restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can insert modifier groups for their restaurants" ON public.modifier_groups
  FOR INSERT WITH CHECK (
    restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can update modifier groups for their restaurants" ON public.modifier_groups
  FOR UPDATE USING (
    restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can delete modifier groups for their restaurants" ON public.modifier_groups
  FOR DELETE USING (
    restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
  );

-- RLS Policies for modifier_options (via group ownership)
CREATE POLICY "Users can view modifier options for their groups" ON public.modifier_options
  FOR SELECT USING (
    group_id IN (
      SELECT id FROM public.modifier_groups 
      WHERE restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
    )
  );

CREATE POLICY "Users can insert modifier options for their groups" ON public.modifier_options
  FOR INSERT WITH CHECK (
    group_id IN (
      SELECT id FROM public.modifier_groups 
      WHERE restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
    )
  );

CREATE POLICY "Users can update modifier options for their groups" ON public.modifier_options
  FOR UPDATE USING (
    group_id IN (
      SELECT id FROM public.modifier_groups 
      WHERE restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
    )
  );

CREATE POLICY "Users can delete modifier options for their groups" ON public.modifier_options
  FOR DELETE USING (
    group_id IN (
      SELECT id FROM public.modifier_groups 
      WHERE restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid())
    )
  );

-- RLS Policies for dish_tags (via dish ownership)
CREATE POLICY "Users can view dish tags for their dishes" ON public.dish_tags
  FOR SELECT USING (
    dish_id IN (
      SELECT d.id FROM public.dishes d
      JOIN public.menus m ON d.menu_id = m.id
      JOIN public.restaurants r ON m.restaurant_id = r.id
      WHERE r.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage dish tags for their dishes" ON public.dish_tags
  FOR ALL USING (
    dish_id IN (
      SELECT d.id FROM public.dishes d
      JOIN public.menus m ON d.menu_id = m.id
      JOIN public.restaurants r ON m.restaurant_id = r.id
      WHERE r.owner_id = auth.uid()
    )
  );

-- RLS Policies for dish_modifiers (via dish ownership)
CREATE POLICY "Users can view dish modifiers for their dishes" ON public.dish_modifiers
  FOR SELECT USING (
    dish_id IN (
      SELECT d.id FROM public.dishes d
      JOIN public.menus m ON d.menu_id = m.id
      JOIN public.restaurants r ON m.restaurant_id = r.id
      WHERE r.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage dish modifiers for their dishes" ON public.dish_modifiers
  FOR ALL USING (
    dish_id IN (
      SELECT d.id FROM public.dishes d
      JOIN public.menus m ON d.menu_id = m.id
      JOIN public.restaurants r ON m.restaurant_id = r.id
      WHERE r.owner_id = auth.uid()
    )
  );

