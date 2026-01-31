-- Enable pg_trgm extension for fuzzy text matching (similarity function)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Drop existing function if it exists (to avoid signature conflicts)
-- Must be done BEFORE creating the new function
-- Use CASCADE to drop all overloads
DROP FUNCTION IF EXISTS public.search_public_dishes_fuzzy CASCADE;

-- Enhance search_public_dishes_fuzzy to include section information
-- This allows fuzzy matching against section names (e.g., "tandoori", "antipasti", "naan")
-- and returns section names in results for better semantic understanding

CREATE OR REPLACE FUNCTION public.search_public_dishes_fuzzy(
    search_text TEXT DEFAULT NULL,
    target_city TEXT DEFAULT NULL,
    user_lat DOUBLE PRECISION DEFAULT NULL,
    user_lng DOUBLE PRECISION DEFAULT NULL,
    search_radius_km DOUBLE PRECISION DEFAULT NULL,
    similarity_threshold DOUBLE PRECISION DEFAULT 0.1,
    dietary_tag_ids UUID[] DEFAULT NULL,
    service_filters JSONB DEFAULT NULL
)
RETURNS TABLE (
    restaurant_id UUID,
    restaurant_name TEXT,
    restaurant_city TEXT,
    restaurant_address TEXT,
    restaurant_phone TEXT,
    restaurant_email TEXT,
    opening_hours JSONB,
    service_options JSONB,
    amenities JSONB,
    seating_capacity INTEGER,
    avg_prep_time INTEGER,
    distance_km DOUBLE PRECISION,
    matching_dishes JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER  -- This allows the function to bypass RLS
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH
    -- 1. Geospatial & City Filtering (Find Candidate Restaurants)
    candidate_restaurants AS (
        SELECT
            r.id,
            r.name,
            r.city,
            r.address,
            r.phone,
            r.email,
            r.opening_hours,
            jsonb_build_object(
                'dine_in', r.accepts_dine_in,
                'takeaway', r.accepts_takeaway,
                'delivery', r.accepts_delivery,
                'reservations', r.accepts_reservations
            ) AS service_options,
            r.amenities,
            r.seating_capacity,
            r.avg_prep_time,
            -- Calculate distance if location data is provided
            CASE 
                WHEN user_lat IS NOT NULL AND user_lng IS NOT NULL AND r.location IS NOT NULL THEN
                    ST_Distance(
                        r.location, 
                        ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography
                    ) / 1000.0  -- Convert meters to kilometers
                ELSE NULL
            END AS distance_km
        FROM 
            public.restaurants r
        WHERE
            r.public_searchable IS TRUE 
            -- Filter by city (case-insensitive)
            AND (target_city IS NULL OR r.city ILIKE '%' || target_city || '%')
            -- Filter by radius (if provided)
            AND (
                search_radius_km IS NULL OR 
                user_lat IS NULL OR 
                user_lng IS NULL OR
                (
                    r.location IS NOT NULL AND 
                    ST_DWithin(
                        r.location, 
                        ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography, 
                        search_radius_km * 1000
                    )
                )
            )
            -- Filter by service options (if provided) - ALL provided keys must match
            AND (
                service_filters IS NULL OR
                (
                    (NOT (service_filters ? 'dine_in') OR r.accepts_dine_in = (service_filters->>'dine_in')::boolean) AND
                    (NOT (service_filters ? 'takeaway') OR r.accepts_takeaway = (service_filters->>'takeaway')::boolean) AND
                    (NOT (service_filters ? 'delivery') OR r.accepts_delivery = (service_filters->>'delivery')::boolean) AND
                    (NOT (service_filters ? 'reservations') OR r.accepts_reservations = (service_filters->>'reservations')::boolean)
                )
            )
    ),
    -- 2. Dish Filtering with Fuzzy Matching (Find Dishes that match search_text using similarity)
    filtered_dishes AS (
        SELECT
            d.id,
            d.menu_id,
            d.name,
            d.description,
            d.price,
            s.name AS section_name,
            m.restaurant_id,
            -- Calculate similarity scores for each field
            similarity(d.name, search_text) AS name_similarity,
            similarity(COALESCE(d.description, ''), search_text) AS description_similarity,
            similarity(COALESCE(s.name, ''), search_text) AS section_similarity,
            -- Use GREATEST to get the best similarity score
            GREATEST(
                similarity(d.name, search_text),
                similarity(COALESCE(d.description, ''), search_text),
                similarity(COALESCE(s.name, ''), search_text)
            ) AS best_similarity
        FROM 
            public.dishes d
        INNER JOIN
            public.menus m ON m.id = d.menu_id
        LEFT JOIN
            public.sections s ON s.id = d.section_id
        WHERE
            d.public IS TRUE
            -- Restrict to candidate restaurants only
            AND m.restaurant_id IN (SELECT id FROM candidate_restaurants)
            -- Filter for dietary tags - dish must have ALL provided tags
            AND (
                dietary_tag_ids IS NULL OR 
                dietary_tag_ids = ARRAY[]::UUID[] OR
                (
                    SELECT COUNT(DISTINCT dt.tag_id)
                    FROM public.dish_tags dt 
                    WHERE dt.dish_id = d.id 
                    AND dt.tag_id = ANY(dietary_tag_ids)
                ) = array_length(dietary_tag_ids, 1)
            )
            -- Fuzzy matching: accept if ANY field crosses the threshold (OR logic)
            AND (
                search_text IS NULL OR 
                search_text = '' OR
                similarity(d.name, search_text) > similarity_threshold OR
                similarity(COALESCE(d.description, ''), search_text) > similarity_threshold OR
                similarity(COALESCE(s.name, ''), search_text) > similarity_threshold
            )
    ),
    -- 3. Grouping: Match dishes to restaurants and aggregate
    restaurant_dishes AS (
        SELECT
            cr.id AS restaurant_id,
            cr.name AS restaurant_name,
            cr.city AS restaurant_city,
            cr.address AS restaurant_address,
            cr.phone AS restaurant_phone,
            cr.email AS restaurant_email,
            cr.opening_hours,
            cr.service_options,
            cr.amenities,
            cr.seating_capacity,
            cr.avg_prep_time,
            cr.distance_km,
            jsonb_agg(
                jsonb_build_object(
                    'id', fd.id,
                    'name', fd.name,
                    'description', fd.description,
                    'price', fd.price,
                    'section_name', fd.section_name,
                    'similarity', fd.best_similarity
                )
                ORDER BY fd.best_similarity DESC, fd.name
            ) FILTER (WHERE fd.id IS NOT NULL) AS matching_dishes
        FROM 
            candidate_restaurants cr
        LEFT JOIN
            filtered_dishes fd ON fd.restaurant_id = cr.id
        GROUP BY 
            cr.id, cr.name, cr.city, cr.address, cr.phone, cr.email, 
            cr.opening_hours, cr.service_options, cr.amenities, 
            cr.seating_capacity, cr.avg_prep_time, cr.distance_km
        HAVING 
            -- Only return restaurants that have matching dishes (or no query was provided)
            search_text IS NULL OR 
            search_text = '' OR
            COUNT(fd.id) > 0
    )
    -- 4. Final Output
    SELECT
        rd.restaurant_id,
        rd.restaurant_name,
        rd.restaurant_city,
        rd.restaurant_address,
        rd.restaurant_phone,
        rd.restaurant_email,
        rd.opening_hours,
        rd.service_options,
        rd.amenities,
        rd.seating_capacity,
        rd.avg_prep_time,
        rd.distance_km,
        COALESCE(rd.matching_dishes, '[]'::jsonb) AS matching_dishes
    FROM
        restaurant_dishes rd
    -- Sort by distance (if available) or by best similarity score
    ORDER BY
        rd.distance_km ASC NULLS LAST,
        (
            SELECT MAX((dish->>'similarity')::double precision)
            FROM jsonb_array_elements(COALESCE(rd.matching_dishes, '[]'::jsonb)) AS dish
        ) DESC NULLS LAST,
        jsonb_array_length(COALESCE(rd.matching_dishes, '[]'::jsonb)) DESC
    LIMIT 50;  -- Limit results for performance
END;
$$;

-- Grant execute permission to authenticated and anon users (for B2C public access)
GRANT EXECUTE ON FUNCTION public.search_public_dishes_fuzzy TO anon, authenticated;

-- Performance index (safe to include, already exists from migration 0005)
CREATE INDEX IF NOT EXISTS idx_dishes_section_id ON public.dishes(section_id);

-- Add GIN index for trigram similarity searches on dish names (optional but recommended for performance)
CREATE INDEX IF NOT EXISTS idx_dishes_name_trgm ON public.dishes USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sections_name_trgm ON public.sections USING gin(name gin_trgm_ops);

-- Add comment for documentation
COMMENT ON FUNCTION public.search_public_dishes_fuzzy IS 'B2C fuzzy search function for finding restaurants and dishes using PostgreSQL trigram similarity. Includes section names in matching and results, enabling semantic understanding of cuisine types from section names (e.g., "Tandoori", "Antipasti", "Naan"). Uses SECURITY DEFINER to bypass RLS for public data access. Similarity threshold defaults to 0.1 (10% similarity).';
