-- Fix search_public_dishes RPC to use SECURITY DEFINER
-- This allows the function to bypass RLS when reading menus, dishes, and restaurants
-- which is necessary for anonymous users to search public data

-- Recreate the function with SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.search_public_dishes(
    search_query TEXT DEFAULT NULL,
    target_city TEXT DEFAULT NULL,
    user_lat DOUBLE PRECISION DEFAULT NULL,
    user_lng DOUBLE PRECISION DEFAULT NULL,
    search_radius_km DOUBLE PRECISION DEFAULT NULL,
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
            -- Filter by service options (if provided)
            AND (
                service_filters IS NULL OR
                (service_filters ? 'dine_in' AND r.accepts_dine_in = (service_filters->>'dine_in')::boolean) OR
                (service_filters ? 'takeaway' AND r.accepts_takeaway = (service_filters->>'takeaway')::boolean) OR
                (service_filters ? 'delivery' AND r.accepts_delivery = (service_filters->>'delivery')::boolean) OR
                (service_filters ? 'reservations' AND r.accepts_reservations = (service_filters->>'reservations')::boolean)
            )
    ),
    -- 2. Dish Filtering (Find Dishes that match query + dietary tags)
    filtered_dishes AS (
        SELECT
            d.id,
            d.menu_id,
            d.name,
            d.description,
            d.price,
            m.restaurant_id
        FROM 
            public.dishes d
        INNER JOIN
            public.menus m ON m.id = d.menu_id
        WHERE
            d.public IS TRUE
            -- Filter for dietary tags (using dish_tags join)
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
            -- Basic keyword/text search (if query provided)
            AND (
                search_query IS NULL OR 
                search_query = '' OR
                d.name ILIKE '%' || search_query || '%' OR 
                (d.description IS NOT NULL AND d.description ILIKE '%' || search_query || '%')
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
                    'price', fd.price
                )
                ORDER BY fd.name
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
            search_query IS NULL OR 
            search_query = '' OR
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
    -- Sort by distance (if available) or by number of matching dishes
    ORDER BY
        rd.distance_km ASC NULLS LAST,
        jsonb_array_length(COALESCE(rd.matching_dishes, '[]'::jsonb)) DESC
    LIMIT 50;  -- Limit results for performance
END;
$$;

-- Grant execute permission to authenticated and anon users (for B2C public access)
GRANT EXECUTE ON FUNCTION public.search_public_dishes TO anon, authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION public.search_public_dishes IS 'B2C public search function for finding restaurants and dishes with geospatial, dietary, and service filtering. Uses SECURITY DEFINER to bypass RLS for public data access.';
