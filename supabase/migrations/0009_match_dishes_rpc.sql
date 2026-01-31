-- Add welcome_message to restaurants
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS welcome_message TEXT 
  DEFAULT 'Hi! Ask me anything about our menu.';

-- Create match_dishes RPC with restaurant_id filter
-- SECURITY: Always pass filter_restaurant_id to prevent cross-restaurant data leakage
CREATE OR REPLACE FUNCTION match_dishes(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter_restaurant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  price numeric,
  menu_id uuid,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.name,
    d.description,
    d.price,
    d.menu_id,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM public.dishes d
  JOIN public.menus m ON d.menu_id = m.id
  WHERE 
    d.embedding IS NOT NULL
    AND (filter_restaurant_id IS NULL OR m.restaurant_id = filter_restaurant_id)
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Grant execute permission to authenticated and anon users
GRANT EXECUTE ON FUNCTION match_dishes TO authenticated;
GRANT EXECUTE ON FUNCTION match_dishes TO anon;

