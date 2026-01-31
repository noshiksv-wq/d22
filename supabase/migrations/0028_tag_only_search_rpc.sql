CREATE OR REPLACE FUNCTION public.search_public_dishes_by_tags(
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
            AND (target_city IS NULL OR r.city ILIKE '%' || target_city || '%')
            AND (
                service_filters IS NULL OR
                (service_filters ? 'dine_in' AND r.accepts_dine_in = (service_filters->>'dine_in')::boolean) OR
                (service_filters ? 'takeaway' AND r.accepts_takeaway = (service_filters->>'takeaway')::boolean) OR
                (service_filters ? 'delivery' AND r.accepts_delivery = (service_filters->>'delivery')::boolean) OR
                (service_filters ? 'reservations' AND r.accepts_reservations = (service_filters->>'reservations')::boolean)
            )
    ),
    matching_dishes AS (
        SELECT
            d.id AS dish_id,
            d.name AS dish_name,
            d.description AS dish_description,
            d.price AS dish_price,
            m.restaurant_id
        FROM
            public.dishes d
        INNER JOIN
            public.menus m ON m.id = d.menu_id
        INNER JOIN
            candidate_restaurants cr ON cr.id = m.restaurant_id
        WHERE
            d.public IS TRUE
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
    SELECT
        cr.id AS restaurant_id,
        cr.name AS restaurant_name,
        cr.city AS restaurant_city,
        cr.address AS restaurant_address,
        md.dish_id,
        md.dish_name,
        md.dish_description,
        md.dish_price,
        1::double precision AS similarity_score
    FROM
        matching_dishes md
    INNER JOIN
        candidate_restaurants cr ON cr.id = md.restaurant_id
    ORDER BY
        md.dish_name ASC
    LIMIT limit_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_public_dishes_by_tags TO anon, authenticated;
