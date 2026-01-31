-- Trigram Search RPC for Restaurant Names
-- Uses pg_trgm for fuzzy restaurant name matching
-- Called by findBestRestaurantMatch when exact match fails

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
        similarity(r.name, search_text)::double precision AS similarity_score
    FROM 
        public.restaurants r
    WHERE
        r.public_searchable IS TRUE
        -- Only return restaurants with reasonable similarity (threshold: 0.2)
        AND similarity(r.name, search_text) > 0.2
    ORDER BY
        similarity_score DESC
    LIMIT 5;
END;
$$;

-- Grant execute permission to anon and authenticated users
GRANT EXECUTE ON FUNCTION public.search_restaurant_by_name(TEXT) TO anon, authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION public.search_restaurant_by_name IS 'Fuzzy restaurant name search using pg_trgm similarity. Returns top 5 matches above threshold 0.2.';
