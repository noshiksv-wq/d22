-- Semantic Search RPC Function
-- Uses pgvector embeddings for semantic similarity search
-- Returns flat rows (one row per dish match) for grouping in TypeScript

CREATE OR REPLACE FUNCTION public.search_public_dishes_semantic(
    query_embedding vector(1536),
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
    similarity_score FLOAT
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
    -- 2. Find dishes with embeddings that match query + dietary filters
    matching_dishes AS (
        SELECT
            d.id AS dish_id,
            d.name AS dish_name,
            d.description AS dish_description,
            d.price AS dish_price,
            m.restaurant_id,
            -- Calculate cosine similarity (1 - distance)
            -- embedding <=> query_embedding gives cosine distance (0 = identical, 2 = opposite)
            -- We want similarity (higher = better), so: 1 - distance
            1 - (d.embedding <=> query_embedding) AS similarity_score
        FROM 
            public.dishes d
        INNER JOIN
            public.menus m ON m.id = d.menu_id
        INNER JOIN
            candidate_restaurants cr ON cr.id = m.restaurant_id
        WHERE
            d.public IS TRUE
            AND d.embedding IS NOT NULL
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

-- Grant execute permission to anon and authenticated users
GRANT EXECUTE ON FUNCTION public.search_public_dishes_semantic TO anon, authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION public.search_public_dishes_semantic IS 'Semantic search for dishes using pgvector embeddings. Returns flat rows (one per dish) for grouping in application code.';

