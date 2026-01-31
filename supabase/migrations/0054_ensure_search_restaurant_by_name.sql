-- Ensure pg_trgm extension is enabled
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- Re-define function to ensure it exists and handles case-insensitivity better
CREATE OR REPLACE FUNCTION public.search_restaurant_by_name(
    search_text TEXT
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    city TEXT,
    similarity_score DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id,
        r.name,
        r.city,
        similarity(lower(r.name), lower(search_text))::double precision AS similarity_score
    FROM 
        public.restaurants r
    WHERE
        r.public_searchable IS TRUE
        -- Threshold 0.2 is standard for loose matches ("indina" -> "Indian" should pass)
        AND similarity(lower(r.name), lower(search_text)) > 0.2
    ORDER BY
        similarity_score DESC
    LIMIT 5;
END;
$$;

-- Grant execute permission to anon and authenticated users
GRANT EXECUTE ON FUNCTION public.search_restaurant_by_name(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.search_restaurant_by_name IS 'Fuzzy restaurant name search using pg_trgm similarity (case-insensitive). Returns top 5 matches.';
