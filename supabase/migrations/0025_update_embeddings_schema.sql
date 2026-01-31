-- Enable pg_trgm extension for trigram similarity (typo tolerance)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add GIN indexes on dish name and description for trigram search
-- These indexes enable fast fuzzy text matching
CREATE INDEX IF NOT EXISTS idx_dishes_name_trgm 
ON public.dishes USING gin (name gin_trgm_ops)
WHERE public = true;

CREATE INDEX IF NOT EXISTS idx_dishes_description_trgm 
ON public.dishes USING gin (description gin_trgm_ops)
WHERE description IS NOT NULL AND public = true;

-- Ensure the embedding index exists (should already exist from 0001_init.sql, but ensure it's optimized)
-- Using ivfflat for approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_dishes_embedding 
ON public.dishes USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100)
WHERE embedding IS NOT NULL AND public = true;

-- Add comment for documentation
COMMENT ON EXTENSION pg_trgm IS 'Enables trigram similarity matching for fuzzy text search (typo tolerance)';

