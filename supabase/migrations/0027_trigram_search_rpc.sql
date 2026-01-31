-- Trigram Fallback Search RPC Function
-- Uses pg_trgm for fuzzy text matching (typo tolerance)
-- Returns flat rows (one row per dish match) matching semantic RPC signature
-- Called when semantic search returns < 3 results

-- Drop any existing versions of this function to avoid signature conflicts
DROP FUNCTION IF EXISTS public.search_public_dishes_fuzzy(
    TEXT, TEXT, UUID[], JSONB, INT
);

CREATE OR REPLACE FUNCTION public.search_public_dishes_fuzzy(
    search_text TEXT,
    target_city TEXT DEFAULT NULL,
    dietary_tag_ids UUID[] DEFAULT NULL,
    service_filters JSONB DEFAULT NULL,
    limit_count INT DEFAULT 50
)
RETURNS TABLE (
    restaurant_id UUID,
    restaurant_name TEXT,
    restaurant_city TEXT,
    restaurant_address TEXT,
    dish_id UUID,
    dish_name TEXT,
    dish_description TEXT,
    dish_price NUMERIC,
    similarity_score DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH
    -- 1. Filter candidate restaurants (public, city, service filters)
    candidate_restaurants AS (
        SELECT
            r.id,
            r.name,
            r.city,
            r.address
        FROM 
            public.restaurants r
        WHERE
            r.public_searchable IS TRUE 
            -- Filter by city (case-insensitive)
            AND (target_city IS NULL OR r.city ILIKE '%' || target_city || '%')
            -- Filter by service options (if provided)
            AND (
                service_filters IS NULL OR
                (service_filters ? 'dine_in' AND r.accepts_dine_in = (service_filters->>'dine_in')::boolean) OR
                (service_filters ? 'takeaway' AND r.accepts_takeaway = (service_filters->>'takeaway')::boolean) OR
                (service_filters ? 'delivery' AND r.accepts_delivery = (service_filters->>'delivery')::boolean) OR
                (service_filters ? 'reservations' AND r.accepts_reservations = (service_filters->>'reservations')::boolean)
            )
    ),
    -- 2. Find dishes using trigram similarity on name, description, and section name
    matching_dishes AS (
        SELECT
            d.id AS dish_id,
            d.name AS dish_name,
            d.description AS dish_description,
            d.price AS dish_price,
            m.restaurant_id,
            -- Calculate similarity: use GREATEST to take best match from name, description, or section name
            -- similarity() returns value between 0 and 1 (1 = identical)
            GREATEST(
                similarity(d.name, search_text),
                COALESCE(similarity(d.description, search_text), 0),
                COALESCE(similarity(s.name, search_text), 0)
            )::double precision AS similarity_score
        FROM 
            public.dishes d
        INNER JOIN
            public.menus m ON m.id = d.menu_id
        INNER JOIN
            candidate_restaurants cr ON cr.id = m.restaurant_id
        LEFT JOIN
            public.sections s ON s.id = d.section_id
        WHERE
            d.public IS TRUE
            -- Filter for dietary tags (if provided)
            AND (
                dietary_tag_ids IS NULL OR 
                dietary_tag_ids = ARRAY[]::UUID[] OR
                EXISTS (
                    SELECT 1 
                    FROM public.dish_tags dt 
                    WHERE dt.dish_id = d.id 
                    AND dt.tag_id = ANY(dietary_tag_ids)
                )
            )
            -- Only return dishes with reasonable similarity (threshold: 0.1)
            -- Check name, description, OR section name (allows "Funghi" in "Pizza Bianca" section to match "pizza")
            AND (
                similarity(d.name, search_text) > 0.1 OR
                (d.description IS NOT NULL AND similarity(d.description, search_text) > 0.1) OR
                (s.name IS NOT NULL AND similarity(s.name, search_text) > 0.1)
            )
    )
    -- 3. Join with restaurant info and return flat rows
    SELECT
        cr.id AS restaurant_id,
        cr.name AS restaurant_name,
        cr.city AS restaurant_city,
        cr.address AS restaurant_address,
        md.dish_id,
        md.dish_name,
        md.dish_description,
        md.dish_price,
        md.similarity_score
    FROM
        matching_dishes md
    INNER JOIN
        candidate_restaurants cr ON cr.id = md.restaurant_id
    -- Sort by similarity (descending - best matches first)
    ORDER BY
        md.similarity_score DESC
    LIMIT limit_count;
END;
$$;

-- Grant execute permission to anon and authenticated users (with full signature to avoid ambiguity)
GRANT EXECUTE ON FUNCTION public.search_public_dishes_fuzzy(
    TEXT, TEXT, UUID[], JSONB, INT
) TO anon, authenticated;

-- Add comment for documentation (with full signature to avoid ambiguity)
COMMENT ON FUNCTION public.search_public_dishes_fuzzy(
    TEXT, TEXT, UUID[], JSONB, INT
) IS 'Fuzzy text search for dishes using pg_trgm trigram similarity (typo tolerance). Returns flat rows matching semantic RPC signature. Used as fallback when semantic search returns < 3 results. Now includes section name matching.';

