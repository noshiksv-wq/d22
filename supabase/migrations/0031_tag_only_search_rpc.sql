-- Tag-only search RPC function for B2C discovery
-- Searches dishes by tags only (no text query), with geospatial and service filtering
-- Similar to search_public_dishes but focused on tag-based filtering

CREATE OR REPLACE FUNCTION public.search_public_dishes_by_tags(
    tag_ids UUID[] DEFAULT NULL,
    target_city TEXT DEFAULT NULL,
    user_lat DOUBLE PRECISION DEFAULT NULL,
    user_lng DOUBLE PRECISION DEFAULT NULL,
    search_radius_km DOUBLE PRECISION DEFAULT NULL,
    service_filters JSONB DEFAULT NULL,
    require_all_tags BOOLEAN DEFAULT false
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
    -- 2. Dish Filtering (Find Dishes that match tags)
    filtered_dishes AS (
        SELECT
            d.id,
            d.menu_id,
            d.name,
            d.description,
            d.price,
            s.name AS section_name,
            m.restaurant_id
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
            -- Filter for tags: ALL tags if require_all_tags=true, ANY tag if false
            AND (
                tag_ids IS NULL OR 
                tag_ids = ARRAY[]::UUID[] OR
                (
                    CASE 
                        WHEN require_all_tags = true THEN
                            -- Dish must have ALL provided tags
                            (
                                SELECT COUNT(DISTINCT dt.tag_id)
                                FROM public.dish_tags dt 
                                WHERE dt.dish_id = d.id 
                                AND dt.tag_id = ANY(tag_ids)
                            ) = array_length(tag_ids, 1)
                        ELSE
                            -- Dish must have ANY of the provided tags (existing behavior)
                            EXISTS (
                                SELECT 1 
                                FROM public.dish_tags dt 
                                WHERE dt.dish_id = d.id 
                                AND dt.tag_id = ANY(tag_ids)
                            )
                    END
                )
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
                    'section_name', fd.section_name
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
            -- Only return restaurants that have matching dishes
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
GRANT EXECUTE ON FUNCTION public.search_public_dishes_by_tags TO anon, authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION public.search_public_dishes_by_tags IS 'B2C tag-only search function for finding restaurants and dishes by dietary tags. Supports geospatial, service filtering, and optional require_all_tags parameter (default false for backward compatibility). Uses SECURITY DEFINER to bypass RLS for public data access.';
