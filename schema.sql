
\restrict U0WTy43ymMdhY8gaLtEjO71rOGTQdDLNcVYc40byQE1PxZcEqMWb6iCL3RfSHF1


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."consume_ai_message"("p_restaurant_id" "uuid") RETURNS TABLE("allowed" boolean, "used" integer, "lim" integer, "mstart" "date")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_month DATE;
    v_limit INTEGER;
    v_current_usage INTEGER;
    v_new_usage INTEGER;
BEGIN
    v_month := DATE_TRUNC('month', NOW())::DATE;

    SELECT ai_message_limit INTO v_limit
    FROM restaurants
    WHERE id = p_restaurant_id;

    IF v_limit IS NULL THEN
        RETURN QUERY SELECT false, 0, 0, v_month;
        RETURN;
    END IF;

    INSERT INTO ai_usage_monthly AS t (restaurant_id, month_start, message_count)
    VALUES (p_restaurant_id, v_month, 0)
    ON CONFLICT (restaurant_id, month_start) DO NOTHING;

    SELECT message_count INTO v_current_usage
    FROM ai_usage_monthly AS t
    WHERE t.restaurant_id = p_restaurant_id AND t.month_start = v_month
    FOR UPDATE;

    IF v_current_usage >= v_limit THEN
        RETURN QUERY SELECT false, v_current_usage, v_limit, v_month;
    ELSE
        v_new_usage := v_current_usage + 1;
        
        UPDATE ai_usage_monthly AS t
        SET message_count = v_new_usage,
            updated_at = NOW()
        WHERE t.restaurant_id = p_restaurant_id AND t.month_start = v_month;

        RETURN QUERY SELECT true, v_new_usage, v_limit, v_month;
    END IF;
END;
$$;


ALTER FUNCTION "public"."consume_ai_message"("p_restaurant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"("p_uid" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = p_uid);
$$;


ALTER FUNCTION "public"."is_admin"("p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_admin"("p_uid" "uuid") IS 'Helper function to check if a user is an admin';



CREATE OR REPLACE FUNCTION "public"."search_public_dishes"("search_query" "text" DEFAULT NULL::"text", "target_city" "text" DEFAULT NULL::"text", "user_lat" double precision DEFAULT NULL::double precision, "user_lng" double precision DEFAULT NULL::double precision, "search_radius_km" double precision DEFAULT NULL::double precision, "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "restaurant_phone" "text", "restaurant_email" "text", "opening_hours" "jsonb", "service_options" "jsonb", "amenities" "jsonb", "seating_capacity" integer, "avg_prep_time" integer, "distance_km" double precision, "matching_dishes" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
    -- 2. Dish Filtering (Find Dishes that match query + dietary tags + section names)
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
            -- Enhanced keyword/text search: matches dish name, description, AND section name
            AND (
                search_query IS NULL OR 
                search_query = '' OR
                d.name ILIKE '%' || search_query || '%' OR 
                (d.description IS NOT NULL AND d.description ILIKE '%' || search_query || '%') OR
                (s.name IS NOT NULL AND s.name ILIKE '%' || search_query || '%')
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


ALTER FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") IS 'B2C public search function for finding restaurants and dishes with geospatial, dietary, and service filtering. Includes section names in search matching and results, enabling semantic understanding of cuisine types from section names (e.g., "Tandoori", "Antipasti", "Naan"). Uses SECURITY DEFINER to bypass RLS for public data access.';



CREATE OR REPLACE FUNCTION "public"."search_public_dishes_by_tags"("target_city" "text" DEFAULT NULL::"text", "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb", "limit_count" integer DEFAULT 50) RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "dish_id" "uuid", "dish_name" "text", "dish_description" "text", "dish_price" numeric, "similarity_score" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."search_public_dishes_by_tags"("target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text" DEFAULT NULL::"text", "target_city" "text" DEFAULT NULL::"text", "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb", "limit_count" integer DEFAULT 50) RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "dish_id" "uuid", "dish_name" "text", "dish_description" "text", "dish_price" numeric, "section_name" "text", "similarity_score" double precision, "matched_tags" "jsonb")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return query
  with candidate_restaurants as (
    select r.id, r.name, r.city, r.address
    from public.restaurants r
    where r.public_searchable is true
      and (target_city is null or r.city ilike '%' || target_city || '%')
      and (
        service_filters is null or
        (service_filters ? 'dine_in' and r.accepts_dine_in = (service_filters->>'dine_in')::boolean) or
        (service_filters ? 'takeaway' and r.accepts_takeaway = (service_filters->>'takeaway')::boolean) or
        (service_filters ? 'delivery' and r.accepts_delivery = (service_filters->>'delivery')::boolean) or
        (service_filters ? 'reservations' and r.accepts_reservations = (service_filters->>'reservations')::boolean)
      )
  ),
  matching_dishes as (
    select
      d.id as dish_id,
      d.name as dish_name,
      d.description as dish_description,
      d.price as dish_price,
      s.name as section_name,
      m.restaurant_id
    from public.dishes d
    join public.menus m on m.id = d.menu_id
    join public.sections s on s.id = d.section_id
    join candidate_restaurants cr on cr.id = m.restaurant_id
    left join public.dish_tags dt on dt.dish_id = d.id
    where d.public is true
      and (
        query_text is null or btrim(query_text) = '' or
        d.name ilike '%' || query_text || '%' or
        coalesce(d.description,'') ilike '%' || query_text || '%' or
        s.name ilike '%' || query_text || '%'
      )
    group by d.id, d.name, d.description, d.price, s.name, m.restaurant_id
    having (
      dietary_tag_ids is null
      or cardinality(dietary_tag_ids) = 0
      or count(distinct case when dt.tag_id = any(dietary_tag_ids) then dt.tag_id end) = cardinality(dietary_tag_ids)
    )
  ),
  -- NEW: Get all tags for matching dishes
  dish_tags_agg as (
    select
      dt.dish_id,
      jsonb_agg(jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'slug', t.slug,
        'type', t.type
      )) as all_tags
    from public.dish_tags dt
    join public.tags t on t.id = dt.tag_id
    where dt.dish_id in (select md.dish_id from matching_dishes md)
    group by dt.dish_id
  )
  select
    cr.id as restaurant_id,
    cr.name as restaurant_name,
    cr.city as restaurant_city,
    cr.address as restaurant_address,
    md.dish_id,
    md.dish_name,
    md.dish_description,
    md.dish_price,
    md.section_name,
    1::double precision as similarity_score,
    coalesce(dta.all_tags, '[]'::jsonb) as matched_tags  -- Return all tags or empty array
  from matching_dishes md
  join candidate_restaurants cr on cr.id = md.restaurant_id
  left join dish_tags_agg dta on dta.dish_id = md.dish_id
  order by md.dish_name asc
  limit limit_count;
end;
$$;


ALTER FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) IS 'Search public dishes with strict tag filtering, returns all dish tags in matched_tags JSONB array';



CREATE OR REPLACE FUNCTION "public"."search_public_dishes_by_tags_v2"("required_tag_ids" "uuid"[], "query_text" "text" DEFAULT NULL::"text", "target_city" "text" DEFAULT NULL::"text", "max_results" integer DEFAULT 50) RETURNS TABLE("dish_id" "uuid", "dish_name" "text", "dish_description" "text", "dish_price" numeric, "section_name" "text", "restaurant_id" "uuid", "restaurant_name" "text", "city" "text")
    LANGUAGE "sql" STABLE
    AS $$
  select
    d.id as dish_id,
    d.name as dish_name,
    d.description as dish_description,
    d.price as dish_price,
    s.name as section_name,
    r.id as restaurant_id,
    r.name as restaurant_name,
    r.city as city
  from dishes d
  join sections s on s.id = d.section_id
  join restaurants r on r.id = s.menu_id or r.id = d.menu_id -- keep only if your schema actually links like this; otherwise remove
  join dish_tags dt on dt.dish_id = d.id
  where d.public = true
    and r.public_searchable = true
    and (target_city is null or r.city = target_city)
    and (query_text is null or (
      d.name ilike '%' || query_text || '%'
      or coalesce(d.description,'') ilike '%' || query_text || '%'
      or s.name ilike '%' || query_text || '%'
    ))
    and dt.tag_id = any(required_tag_ids)
  group by d.id, d.name, d.description, d.price, s.name, r.id, r.name, r.city
  having count(distinct dt.tag_id) = cardinality(required_tag_ids)
  limit max_results;
$$;


ALTER FUNCTION "public"."search_public_dishes_by_tags_v2"("required_tag_ids" "uuid"[], "query_text" "text", "target_city" "text", "max_results" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text" DEFAULT NULL::"text", "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb", "limit_count" integer DEFAULT 50) RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "dish_id" "uuid", "dish_name" "text", "dish_description" "text", "dish_price" numeric, "similarity_score" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) IS 'Fuzzy text search for dishes using pg_trgm trigram similarity (typo tolerance). Returns flat rows matching semantic RPC signature. Used as fallback when semantic search returns < 3 results. Now includes section name matching.';



CREATE OR REPLACE FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text" DEFAULT NULL::"text", "target_city" "text" DEFAULT NULL::"text", "user_lat" double precision DEFAULT NULL::double precision, "user_lng" double precision DEFAULT NULL::double precision, "search_radius_km" double precision DEFAULT NULL::double precision, "similarity_threshold" double precision DEFAULT 0.1, "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "restaurant_phone" "text", "restaurant_email" "text", "opening_hours" "jsonb", "service_options" "jsonb", "amenities" "jsonb", "seating_capacity" integer, "avg_prep_time" integer, "distance_km" double precision, "matching_dishes" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "similarity_threshold" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "similarity_threshold" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") IS 'B2C fuzzy search function for finding restaurants and dishes using PostgreSQL trigram similarity. Includes section names in matching and results, enabling semantic understanding of cuisine types from section names (e.g., "Tandoori", "Antipasti", "Naan"). Uses SECURITY DEFINER to bypass RLS for public data access. Similarity threshold defaults to 0.1 (10% similarity).';



CREATE OR REPLACE FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text" DEFAULT NULL::"text", "dietary_tag_ids" "uuid"[] DEFAULT NULL::"uuid"[], "service_filters" "jsonb" DEFAULT NULL::"jsonb", "limit_count" integer DEFAULT 50) RETURNS TABLE("restaurant_id" "uuid", "restaurant_name" "text", "restaurant_city" "text", "restaurant_address" "text", "dish_id" "uuid", "dish_name" "text", "dish_description" "text", "dish_price" numeric, "similarity_score" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) IS 'Semantic search for dishes using pgvector embeddings. Returns flat rows (one per dish) for grouping in application code.';



CREATE OR REPLACE FUNCTION "public"."search_restaurant_by_name"("search_text" "text") RETURNS TABLE("id" "uuid", "name" "text", "city" "text", "similarity_score" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."search_restaurant_by_name"("search_text" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_restaurant_by_name"("search_text" "text") IS 'Fuzzy restaurant name search using pg_trgm similarity (case-insensitive). Returns top 5 matches.';



CREATE OR REPLACE FUNCTION "public"."seed_demo_restaurant"("payload" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_restaurant_id uuid;
  v_menu_id uuid;

  sec jsonb;
  dish jsonb;
  tag jsonb;
  mg jsonb;
  mo jsonb;

  v_section_id uuid;
  v_dish_id uuid;
  v_tag_id uuid;
  v_group_id uuid;
  v_option_id uuid;

  v_section_key text;
  v_dish_key text;
  v_group_key text;
  v_option_key text;

begin
  -- Restaurant
  insert into public.restaurants (
    name,
    description,
    tagline,
    cuisine_type,
    address,
    city,
    zip_code,
    country,
    currency,
    phone,
    website,
    accepts_delivery,
    delivery_fee,         -- numeric (usually SEK)
    delivery_radius_km,   -- numeric (km)
    latitude,
    longitude
  )
  values (
    coalesce(payload #>> '{restaurant,name}', 'Demo Restaurant'),
    payload #>> '{restaurant,description}',
    payload #>> '{restaurant,tagline}',
    payload #>> '{restaurant,cuisine_type}',
    payload #>> '{restaurant,address}',
    coalesce(payload #>> '{restaurant,city}', 'Gothenburg'),
    payload #>> '{restaurant,zip_code}',
    coalesce(payload #>> '{restaurant,country}', 'Sweden'),
    coalesce(payload #>> '{restaurant,currency}', 'SEK'),
    payload #>> '{restaurant,phone}',
    payload #>> '{restaurant,website}',
    coalesce((payload #>> '{restaurant,accepts_delivery}')::boolean, false),
    coalesce((payload #>> '{restaurant,delivery_fee}')::numeric, 0),
    (payload #>> '{restaurant,delivery_radius_km}')::numeric,
    (payload #>> '{restaurant,latitude}')::numeric,
    (payload #>> '{restaurant,longitude}')::numeric
  )
  returning id into v_restaurant_id;

  -- Menu
  insert into public.menus (restaurant_id, name)
  values (v_restaurant_id, coalesce(payload #>> '{menu,name}', 'Main Menu'))
  returning id into v_menu_id;

  -- Temp maps (key -> uuid) so JSON can reference things by key
  create temp table tmp_section_map(key text primary key, id uuid) on commit drop;
  create temp table tmp_dish_map(key text primary key, id uuid) on commit drop;
  create temp table tmp_group_map(key text primary key, id uuid) on commit drop;
  create temp table tmp_option_map(key text primary key, id uuid) on commit drop;

  -- Tags (upsert by name)
  if jsonb_typeof(payload->'tags') = 'array' then
    for tag in select * from jsonb_array_elements(payload->'tags')
    loop
      insert into public.tags (name, slug, type, severity)
      values (
        coalesce(tag->>'name', tag->>'slug'),
        coalesce(tag->>'slug', lower(regexp_replace(coalesce(tag->>'name','tag'), '\s+', '-', 'g'))),
        coalesce(tag->>'type', 'diet'),
        coalesce(tag->>'severity', 'none')
      )
      on conflict (name) do update
        set slug = excluded.slug
      returning id into v_tag_id;
    end loop;
  end if;

  -- Sections
  if jsonb_typeof(payload->'sections') = 'array' then
    for sec in select * from jsonb_array_elements(payload->'sections')
    loop
      v_section_key := sec->>'key';
      insert into public.sections (menu_id, name, display_order)
      values (
        v_menu_id,
        coalesce(sec->>'name', v_section_key),
        coalesce((sec->>'display_order')::int, 0)
      )
      returning id into v_section_id;

      insert into tmp_section_map(key, id) values (v_section_key, v_section_id);
    end loop;
  end if;

  -- Dishes + dish tags + dish modifiers
  if jsonb_typeof(payload->'dishes') = 'array' then
    for dish in select * from jsonb_array_elements(payload->'dishes')
    loop
      v_dish_key := dish->>'key';

      select id into v_section_id
      from tmp_section_map
      where key = dish->>'section_key';

      insert into public.dishes (menu_id, section_id, name, description, price, public, tags)
      values (
        v_menu_id,
        v_section_id,
        coalesce(dish->>'name', v_dish_key),
        dish->>'description',
        (dish->>'price')::numeric,
        coalesce((dish->>'public')::boolean, true),
        coalesce(dish->'tags_json', '[]'::jsonb)
      )
      returning id into v_dish_id;

      insert into tmp_dish_map(key, id) values (v_dish_key, v_dish_id);

      -- dish_tags (expects dish.tags = ["vegan","wheat"] where values match tags.slug OR tags.name)
      if jsonb_typeof(dish->'tags') = 'array' then
        insert into public.dish_tags (dish_id, tag_id)
        select
          v_dish_id,
          t.id
        from public.tags t
        join lateral jsonb_array_elements_text(dish->'tags') x(tag_key) on true
        where t.slug = x.tag_key or t.name = x.tag_key
        on conflict do nothing;
      end if;

      -- dish_modifiers (expects dish.modifier_groups = ["extra_toppings"])
      if jsonb_typeof(dish->'modifier_groups') = 'array' then
        insert into public.dish_modifiers (dish_id, modifier_group_id)
        select
          v_dish_id,
          gm.id
        from tmp_group_map gm
        join lateral jsonb_array_elements_text(dish->'modifier_groups') x(gkey) on true
        where gm.key = x.gkey
        on conflict do nothing;
      end if;
    end loop;
  end if;

  -- Modifier groups
  if jsonb_typeof(payload->'modifier_groups') = 'array' then
    for mg in select * from jsonb_array_elements(payload->'modifier_groups')
    loop
      v_group_key := mg->>'key';

      insert into public.modifier_groups (restaurant_id, name, min_selection, max_selection, modifier_type)
      values (
        v_restaurant_id,
        coalesce(mg->>'name', v_group_key),
        coalesce((mg->>'min_selection')::int, 0),
        (mg->>'max_selection')::int,
        coalesce(mg->>'modifier_type', 'addon')
      )
      returning id into v_group_id;

      insert into tmp_group_map(key, id) values (v_group_key, v_group_id);
    end loop;
  end if;

  -- Modifier options + option tags
  if jsonb_typeof(payload->'modifier_options') = 'array' then
    for mo in select * from jsonb_array_elements(payload->'modifier_options')
    loop
      v_option_key := mo->>'key';

      select id into v_group_id
      from tmp_group_map
      where key = mo->>'group_key';

      insert into public.modifier_options (group_id, name, price_extra, price_adjustment, is_available)
      values (
        v_group_id,
        coalesce(mo->>'name', v_option_key),
        coalesce((mo->>'price_extra')::numeric, 0),
        coalesce((mo->>'price_adjustment')::numeric, 0),
        coalesce((mo->>'is_available')::boolean, true)
      )
      returning id into v_option_id;

      insert into tmp_option_map(key, id) values (v_option_key, v_option_id);

      -- modifier_option_tags (expects mo.tags = ["milk","wheat"] matching tags.slug OR tags.name)
      if jsonb_typeof(mo->'tags') = 'array' then
        insert into public.modifier_option_tags (modifier_option_id, tag_id)
        select
          v_option_id,
          t.id
        from public.tags t
        join lateral jsonb_array_elements_text(mo->'tags') x(tag_key) on true
        where t.slug = x.tag_key or t.name = x.tag_key
        on conflict do nothing;
      end if;
    end loop;
  end if;

  -- Now that groups exist, attach dish_modifiers (second pass for safety)
  if jsonb_typeof(payload->'dishes') = 'array' then
    for dish in select * from jsonb_array_elements(payload->'dishes')
    loop
      v_dish_key := dish->>'key';
      select id into v_dish_id from tmp_dish_map where key = v_dish_key;

      if jsonb_typeof(dish->'modifier_groups') = 'array' then
        insert into public.dish_modifiers (dish_id, modifier_group_id)
        select
          v_dish_id,
          gm.id
        from tmp_group_map gm
        join lateral jsonb_array_elements_text(dish->'modifier_groups') x(gkey) on true
        where gm.key = x.gkey
        on conflict do nothing;
      end if;
    end loop;
  end if;

  return v_restaurant_id;
end;
$$;


ALTER FUNCTION "public"."seed_demo_restaurant"("payload" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."Chat" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "createdAt" timestamp without time zone NOT NULL,
    "userId" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "visibility" character varying DEFAULT 'private'::character varying NOT NULL,
    "lastContext" "jsonb"
);


ALTER TABLE "public"."Chat" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Document" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "createdAt" timestamp without time zone NOT NULL,
    "title" "text" NOT NULL,
    "content" "text",
    "userId" "uuid" NOT NULL,
    "text" character varying DEFAULT 'text'::character varying NOT NULL
);


ALTER TABLE "public"."Document" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Message" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chatId" "uuid" NOT NULL,
    "role" character varying NOT NULL,
    "content" json NOT NULL,
    "createdAt" timestamp without time zone NOT NULL
);


ALTER TABLE "public"."Message" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Message_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chatId" "uuid" NOT NULL,
    "role" character varying NOT NULL,
    "parts" json NOT NULL,
    "attachments" json NOT NULL,
    "createdAt" timestamp without time zone NOT NULL
);


ALTER TABLE "public"."Message_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Stream" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chatId" "uuid" NOT NULL,
    "createdAt" timestamp without time zone NOT NULL
);


ALTER TABLE "public"."Stream" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Suggestion" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "documentId" "uuid" NOT NULL,
    "documentCreatedAt" timestamp without time zone NOT NULL,
    "originalText" "text" NOT NULL,
    "suggestedText" "text" NOT NULL,
    "description" "text",
    "isResolved" boolean DEFAULT false NOT NULL,
    "userId" "uuid" NOT NULL,
    "createdAt" timestamp without time zone NOT NULL
);


ALTER TABLE "public"."Suggestion" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."User" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" character varying(64) NOT NULL,
    "password" character varying(64)
);


ALTER TABLE "public"."User" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Vote" (
    "chatId" "uuid" NOT NULL,
    "messageId" "uuid" NOT NULL,
    "isUpvoted" boolean NOT NULL
);


ALTER TABLE "public"."Vote" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Vote_v2" (
    "chatId" "uuid" NOT NULL,
    "messageId" "uuid" NOT NULL,
    "isUpvoted" boolean NOT NULL
);


ALTER TABLE "public"."Vote_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."admin_users" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_users" IS 'Super admin allowlist - users who can manage all restaurants';



CREATE TABLE IF NOT EXISTS "public"."ai_usage_monthly" (
    "restaurant_id" "uuid" NOT NULL,
    "month_start" "date" NOT NULL,
    "message_count" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_usage_monthly" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."analytics_simple" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "event" "text" NOT NULL,
    "session" "uuid" NOT NULL,
    "language" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cta_type" "text",
    CONSTRAINT "analytics_simple_event_check" CHECK (("event" = ANY (ARRAY['view'::"text", 'chat'::"text", 'message'::"text", 'intent'::"text", 'cta_click'::"text"])))
);


ALTER TABLE "public"."analytics_simple" OWNER TO "postgres";


COMMENT ON TABLE "public"."analytics_simple" IS 'Simple analytics tracking for restaurant widget events. Client-side aggregation for MVP.';



COMMENT ON COLUMN "public"."analytics_simple"."event" IS 'Event type: view (page load), chat (chat opened), message (user message), intent (order intent detected)';



COMMENT ON COLUMN "public"."analytics_simple"."session" IS 'Browser session UUID for deduplication';



COMMENT ON COLUMN "public"."analytics_simple"."language" IS 'Detected language from user messages';



COMMENT ON COLUMN "public"."analytics_simple"."cta_type" IS 'Type of CTA clicked: phone, directions, or order (only set when event = cta_click)';



CREATE TABLE IF NOT EXISTS "public"."dish_modifiers" (
    "dish_id" "uuid" NOT NULL,
    "modifier_group_id" "uuid" NOT NULL
);


ALTER TABLE "public"."dish_modifiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dish_tags" (
    "dish_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."dish_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dishes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "menu_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price" numeric(10,2) NOT NULL,
    "embedding" "public"."vector"(1536),
    "tags" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "section_id" "uuid",
    "public" boolean DEFAULT true NOT NULL,
    "is_available" boolean DEFAULT true NOT NULL,
    "is_orderable" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."dishes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."dishes"."public" IS 'If true, dish appears in B2C public search. Default true for all dishes.';



COMMENT ON COLUMN "public"."dishes"."is_available" IS 'Operational flag: false = Sold Out';



COMMENT ON COLUMN "public"."dishes"."is_orderable" IS 'Policy flag: false = In-Store Only (e.g. Alcohol)';



CREATE TABLE IF NOT EXISTS "public"."geocode_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "address_hash" "text" NOT NULL,
    "address_original" "text" NOT NULL,
    "lat" numeric(10,7),
    "lng" numeric(10,7),
    "success" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL
);


ALTER TABLE "public"."geocode_cache" OWNER TO "postgres";


COMMENT ON TABLE "public"."geocode_cache" IS 'Cache for geocoded addresses to reduce external API calls';



CREATE TABLE IF NOT EXISTS "public"."menus" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."menus" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."modifier_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "min_selection" integer DEFAULT 0 NOT NULL,
    "max_selection" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modifier_type" "text" DEFAULT 'addon'::"text"
);


ALTER TABLE "public"."modifier_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."modifier_option_tags" (
    "modifier_option_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."modifier_option_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."modifier_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "price_extra" numeric(10,2) DEFAULT 0 NOT NULL,
    "is_available" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price_adjustment" numeric(10,2) DEFAULT 0
);


ALTER TABLE "public"."modifier_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "dish_id" "uuid",
    "dish_name" "text" NOT NULL,
    "unit_price" integer NOT NULL,
    "quantity" integer NOT NULL,
    "modifiers" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "order_items_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "order_items_unit_price_check" CHECK (("unit_price" >= 0))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."order_items" IS 'Items in each order (with price snapshots)';



COMMENT ON COLUMN "public"."order_items"."unit_price" IS 'Price per unit in öre (snapshot at order time)';



CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'widget'::"text" NOT NULL,
    "status" "text" NOT NULL,
    "fulfillment_type" "text" DEFAULT 'pickup'::"text" NOT NULL,
    "payment_method" "text" NOT NULL,
    "payment_status" "text" NOT NULL,
    "customer_name" "text",
    "customer_phone" "text",
    "pickup_time" timestamp with time zone,
    "notes" "text",
    "subtotal_amount" integer DEFAULT 0 NOT NULL,
    "total_amount" integer DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'SEK'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_type" "text" DEFAULT 'pickup'::"text",
    "delivery_address" "text",
    "delivery_lat" numeric(10,7),
    "delivery_lng" numeric(10,7),
    "delivery_distance_km" numeric(6,2),
    "delivery_fee" integer DEFAULT 0,
    "delivery_street" "text",
    "delivery_city" "text",
    "delivery_zipcode" "text",
    "customer_email" "text",
    "customer_accepted" boolean DEFAULT false NOT NULL,
    "customer_accepted_at" timestamp with time zone,
    "customer_accepted_docs" "jsonb",
    "customer_ip" "text",
    "customer_user_agent" "text",
    CONSTRAINT "orders_fulfillment_type_check" CHECK (("fulfillment_type" = 'pickup'::"text")),
    CONSTRAINT "orders_order_type_check" CHECK (("order_type" = ANY (ARRAY['pickup'::"text", 'delivery'::"text"]))),
    CONSTRAINT "orders_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['pay_in_store'::"text", 'stripe_card'::"text"]))),
    CONSTRAINT "orders_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['unpaid'::"text", 'pending'::"text", 'paid'::"text", 'refunded'::"text"]))),
    CONSTRAINT "orders_source_check" CHECK (("source" = ANY (ARRAY['widget'::"text", 'discovery'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending_payment'::"text", 'placed'::"text", 'accepted'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "orders_subtotal_amount_check" CHECK (("subtotal_amount" >= 0)),
    CONSTRAINT "orders_total_amount_check" CHECK (("total_amount" >= 0))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."orders" IS 'Customer orders for pickup';



COMMENT ON COLUMN "public"."orders"."subtotal_amount" IS 'Subtotal in öre (Swedish cents)';



COMMENT ON COLUMN "public"."orders"."total_amount" IS 'Total amount in öre (Swedish cents)';



COMMENT ON COLUMN "public"."orders"."order_type" IS 'pickup or delivery';



COMMENT ON COLUMN "public"."orders"."delivery_fee" IS 'Delivery fee in öre (cents)';



COMMENT ON COLUMN "public"."orders"."delivery_street" IS 'Street address for delivery';



COMMENT ON COLUMN "public"."orders"."delivery_city" IS 'City for delivery';



COMMENT ON COLUMN "public"."orders"."delivery_zipcode" IS 'Zipcode for delivery';



COMMENT ON COLUMN "public"."orders"."customer_accepted_docs" IS 'Snapshot of accepted docs: { restaurant: { order_terms_url, privacy_policy_url, versions }, platform: { terms_url, privacy_url, versions } }';



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'stripe'::"text" NOT NULL,
    "checkout_session_id" "text",
    "payment_intent_id" "text",
    "status" "text" NOT NULL,
    "amount" integer DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'SEK'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "charge_id" "text",
    "refund_id" "text",
    "refunded_at" timestamp with time zone,
    "balance_transaction_id" "text",
    "stripe_fee_amount" integer,
    "net_amount" integer,
    "platform_fee_amount" integer,
    "refunded_amount" integer DEFAULT 0 NOT NULL,
    "stripe_application_fee_id" "text",
    "platform_fee_refunded_amount" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "payments_amount_check" CHECK (("amount" >= 0)),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'succeeded'::"text", 'failed'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON TABLE "public"."payments" IS 'Payment records for orders';



COMMENT ON COLUMN "public"."payments"."amount" IS 'Payment amount in öre (Swedish cents)';



COMMENT ON COLUMN "public"."payments"."charge_id" IS 'Stripe Charge ID for refund processing';



COMMENT ON COLUMN "public"."payments"."refund_id" IS 'Stripe Refund ID after refund is processed';



COMMENT ON COLUMN "public"."payments"."refunded_at" IS 'Timestamp when refund was processed';



COMMENT ON COLUMN "public"."payments"."balance_transaction_id" IS 'Stripe Balance Transaction ID';



COMMENT ON COLUMN "public"."payments"."stripe_fee_amount" IS 'Stripe processing fee in minor units (e.g. öre)';



COMMENT ON COLUMN "public"."payments"."net_amount" IS 'Net amount settled to connected account in minor units';



COMMENT ON COLUMN "public"."payments"."platform_fee_amount" IS 'Platform application fee in minor units';



COMMENT ON COLUMN "public"."payments"."refunded_amount" IS 'Total refunded amount in minor units';



CREATE TABLE IF NOT EXISTS "public"."platform_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid"
);


ALTER TABLE "public"."platform_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_settings" IS 'Global configuration storage';



COMMENT ON COLUMN "public"."platform_settings"."key" IS 'Setting key (e.g. application_fee_percent)';



COMMENT ON COLUMN "public"."platform_settings"."value" IS 'Setting value in JSON format';



CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "subscription" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."push_subscriptions" IS 'Web push subscriptions for restaurant order notifications';



COMMENT ON COLUMN "public"."push_subscriptions"."endpoint" IS 'Push service endpoint URL';



COMMENT ON COLUMN "public"."push_subscriptions"."p256dh" IS 'User public key for encryption';



COMMENT ON COLUMN "public"."push_subscriptions"."auth" IS 'Auth secret for encryption';



COMMENT ON COLUMN "public"."push_subscriptions"."subscription" IS 'Full subscription JSON for future-proofing';



CREATE TABLE IF NOT EXISTS "public"."restaurants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "opening_hours" "jsonb",
    "owner_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "currency" "text" DEFAULT 'SEK'::"text",
    "description" "text",
    "tagline" "text",
    "cuisine_type" "text",
    "address" "text",
    "city" "text" DEFAULT 'Gothenburg'::"text",
    "zip_code" "text",
    "country" "text" DEFAULT 'Sweden'::"text",
    "timezone" "text" DEFAULT 'Europe/Stockholm'::"text",
    "phone" "text",
    "email" "text",
    "website" "text",
    "instagram" "text",
    "facebook" "text",
    "tiktok" "text",
    "logo_url" "text",
    "cover_image_url" "text",
    "primary_color" "text" DEFAULT '#000000'::"text",
    "secondary_color" "text" DEFAULT '#ffffff'::"text",
    "accepts_dine_in" boolean DEFAULT true,
    "accepts_takeaway" boolean DEFAULT true,
    "accepts_delivery" boolean DEFAULT false,
    "accepts_reservations" boolean DEFAULT false,
    "reservation_url" "text",
    "tax_rate" numeric(5,2) DEFAULT 12.00,
    "service_charge" numeric(5,2) DEFAULT 0,
    "minimum_order" numeric(10,2) DEFAULT 0,
    "delivery_fee" numeric(10,2) DEFAULT 0,
    "avg_prep_time" integer DEFAULT 20,
    "seating_capacity" integer,
    "delivery_radius_km" numeric(5,2),
    "uber_eats_url" "text",
    "doordash_url" "text",
    "deliveroo_url" "text",
    "google_maps_id" "text",
    "tripadvisor_url" "text",
    "amenities" "jsonb" DEFAULT '{"has_bar": false, "has_wifi": false, "has_parking": false, "kid_friendly": true, "pet_friendly": false, "outdoor_seating": false, "has_private_rooms": false, "wheelchair_accessible": false}'::"jsonb",
    "business_registration" "text",
    "vat_number" "text",
    "public_searchable" boolean DEFAULT true NOT NULL,
    "latitude" numeric(10,7),
    "longitude" numeric(10,7),
    "location" "public"."geography"(Point,4326),
    "stripe_account_id" "text",
    "stripe_charges_enabled" boolean DEFAULT false NOT NULL,
    "stripe_details_submitted" boolean DEFAULT false NOT NULL,
    "payments_enabled" boolean DEFAULT true NOT NULL,
    "legal_company_name" "text",
    "legal_company_address" "text",
    "country_of_registration" "text",
    "ai_message_limit" integer DEFAULT 500 NOT NULL,
    "terms_version" "text",
    "terms_accepted_at" timestamp with time zone,
    "authority_confirmed_at" timestamp with time zone,
    "privacy_version" "text",
    "privacy_accepted_at" timestamp with time zone,
    "privacy_accepted_by" "uuid",
    "terms_accepted_by" "uuid",
    "authority_confirmed_by" "uuid",
    "order_terms_url" "text",
    "privacy_policy_url" "text",
    "order_terms_version" "text" DEFAULT 'v1'::"text",
    "privacy_policy_version" "text" DEFAULT 'v1'::"text",
    "ordering_enabled" boolean DEFAULT false NOT NULL,
    "chat_plan_active" boolean DEFAULT false NOT NULL,
    "chat_subscription_id" "text",
    "chat_subscription_status" "text",
    "chat_subscription_current_period_end" timestamp with time zone,
    "chat_customer_id" "text",
    CONSTRAINT "restaurants_currency_check" CHECK (("currency" = ANY (ARRAY['SEK'::"text", 'EUR'::"text", 'USD'::"text", 'GBP'::"text", 'NOK'::"text", 'DKK'::"text", 'CHF'::"text", 'CAD'::"text", 'AUD'::"text", 'JPY'::"text", 'INR'::"text"])))
);


ALTER TABLE "public"."restaurants" OWNER TO "postgres";


COMMENT ON COLUMN "public"."restaurants"."business_registration" IS 'Business registration/Org.nr - NOT for AI search or public display';



COMMENT ON COLUMN "public"."restaurants"."vat_number" IS 'VAT registration number - NOT for AI search or public display';



COMMENT ON COLUMN "public"."restaurants"."public_searchable" IS 'Whether restaurant appears in public discovery';



COMMENT ON COLUMN "public"."restaurants"."stripe_account_id" IS 'Stripe Connect Express account ID';



COMMENT ON COLUMN "public"."restaurants"."stripe_charges_enabled" IS 'Whether the Stripe account can accept charges';



COMMENT ON COLUMN "public"."restaurants"."stripe_details_submitted" IS 'Whether Stripe onboarding details have been submitted';



COMMENT ON COLUMN "public"."restaurants"."payments_enabled" IS 'Restaurant toggle to enable/disable online payments';



COMMENT ON COLUMN "public"."restaurants"."legal_company_name" IS 'Legal entity name - NOT for AI search or public display';



COMMENT ON COLUMN "public"."restaurants"."legal_company_address" IS 'Legal registered address - NOT for AI search or public display';



COMMENT ON COLUMN "public"."restaurants"."country_of_registration" IS 'Country where business is registered - NOT for AI search or public display';



COMMENT ON COLUMN "public"."restaurants"."terms_version" IS 'Version of terms accepted (e.g., "2025-12-29")';



COMMENT ON COLUMN "public"."restaurants"."terms_accepted_at" IS 'Timestamp when terms were accepted';



COMMENT ON COLUMN "public"."restaurants"."authority_confirmed_at" IS 'Timestamp when authority to represent was confirmed';



COMMENT ON COLUMN "public"."restaurants"."privacy_version" IS 'Version of privacy policy accepted';



COMMENT ON COLUMN "public"."restaurants"."privacy_accepted_at" IS 'Timestamp when privacy policy was accepted';



COMMENT ON COLUMN "public"."restaurants"."privacy_accepted_by" IS 'User ID who accepted privacy policy';



COMMENT ON COLUMN "public"."restaurants"."terms_accepted_by" IS 'User ID who accepted terms';



COMMENT ON COLUMN "public"."restaurants"."authority_confirmed_by" IS 'User ID who confirmed authority';



COMMENT ON COLUMN "public"."restaurants"."ordering_enabled" IS 'Whether online ordering is currently enabled by the restaurant';



COMMENT ON COLUMN "public"."restaurants"."chat_plan_active" IS 'Whether the restaurant has an active chat subscription';



COMMENT ON COLUMN "public"."restaurants"."chat_subscription_id" IS 'Stripe subscription ID for Chat plan';



COMMENT ON COLUMN "public"."restaurants"."chat_subscription_status" IS 'Subscription status: active, past_due, canceled, trialing, incomplete';



COMMENT ON COLUMN "public"."restaurants"."chat_subscription_current_period_end" IS 'When the current subscription period ends';



COMMENT ON COLUMN "public"."restaurants"."chat_customer_id" IS 'Stripe customer ID for this restaurant';



CREATE TABLE IF NOT EXISTS "public"."sections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "menu_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "display_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_events" (
    "event_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "account" "text",
    "order_id" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "error" "text",
    "raw_data" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stripe_events_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'processed'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."stripe_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."stripe_events" IS 'Stripe webhook events log for debugging and idempotency';



COMMENT ON COLUMN "public"."stripe_events"."event_id" IS 'Stripe event ID (evt_xxx) - ensures idempotency';



COMMENT ON COLUMN "public"."stripe_events"."type" IS 'Event type (e.g., checkout.session.completed)';



COMMENT ON COLUMN "public"."stripe_events"."account" IS 'Connected account ID if from connected account';



COMMENT ON COLUMN "public"."stripe_events"."order_id" IS 'Extracted order ID from metadata';



COMMENT ON COLUMN "public"."stripe_events"."status" IS 'Processing status: received, processed, failed, skipped';



COMMENT ON COLUMN "public"."stripe_events"."error" IS 'Error message if processing failed';



COMMENT ON COLUMN "public"."stripe_events"."raw_data" IS 'Full event payload for debugging';



CREATE TABLE IF NOT EXISTS "public"."tag_aliases" (
    "alias" "text" NOT NULL,
    "tag_type" "text" NOT NULL,
    "tag_slug" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tag_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "type" "text" DEFAULT 'diet'::"text",
    "slug" "text" NOT NULL,
    CONSTRAINT "tags_severity_check" CHECK (("severity" = ANY (ARRAY['high'::"text", 'medium'::"text", 'none'::"text"]))),
    CONSTRAINT "tags_type_check" CHECK (("type" = ANY (ARRAY['allergen'::"text", 'diet'::"text", 'religious'::"text"])))
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


ALTER TABLE ONLY "public"."Chat"
    ADD CONSTRAINT "Chat_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Document"
    ADD CONSTRAINT "Document_id_createdAt_pk" PRIMARY KEY ("id", "createdAt");



ALTER TABLE ONLY "public"."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Message_v2"
    ADD CONSTRAINT "Message_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Stream"
    ADD CONSTRAINT "Stream_id_pk" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Suggestion"
    ADD CONSTRAINT "Suggestion_id_pk" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Vote"
    ADD CONSTRAINT "Vote_chatId_messageId_pk" PRIMARY KEY ("chatId", "messageId");



ALTER TABLE ONLY "public"."Vote_v2"
    ADD CONSTRAINT "Vote_v2_chatId_messageId_pk" PRIMARY KEY ("chatId", "messageId");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."ai_usage_monthly"
    ADD CONSTRAINT "ai_usage_monthly_pkey" PRIMARY KEY ("restaurant_id", "month_start");



ALTER TABLE ONLY "public"."analytics_simple"
    ADD CONSTRAINT "analytics_simple_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dish_modifiers"
    ADD CONSTRAINT "dish_modifiers_pkey" PRIMARY KEY ("dish_id", "modifier_group_id");



ALTER TABLE ONLY "public"."dish_tags"
    ADD CONSTRAINT "dish_tags_pkey" PRIMARY KEY ("dish_id", "tag_id");



ALTER TABLE ONLY "public"."dishes"
    ADD CONSTRAINT "dishes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geocode_cache"
    ADD CONSTRAINT "geocode_cache_address_hash_key" UNIQUE ("address_hash");



ALTER TABLE ONLY "public"."geocode_cache"
    ADD CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menus"
    ADD CONSTRAINT "menus_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."modifier_groups"
    ADD CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."modifier_option_tags"
    ADD CONSTRAINT "modifier_option_tags_pkey" PRIMARY KEY ("modifier_option_id", "tag_id");



ALTER TABLE ONLY "public"."modifier_options"
    ADD CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_checkout_session_id_key" UNIQUE ("checkout_session_id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_restaurant_id_endpoint_key" UNIQUE ("restaurant_id", "endpoint");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_events"
    ADD CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."tag_aliases"
    ADD CONSTRAINT "tag_aliases_pkey" PRIMARY KEY ("alias");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_name_unique" UNIQUE ("name");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "analytics_once_per_session_chat" ON "public"."analytics_simple" USING "btree" ("restaurant_id", "session") WHERE ("event" = 'chat'::"text");



CREATE UNIQUE INDEX "analytics_once_per_session_view" ON "public"."analytics_simple" USING "btree" ("restaurant_id", "session") WHERE ("event" = 'view'::"text");



CREATE INDEX "idx_ai_usage_monthly_month_start" ON "public"."ai_usage_monthly" USING "btree" ("month_start");



CREATE INDEX "idx_ai_usage_monthly_restaurant_id" ON "public"."ai_usage_monthly" USING "btree" ("restaurant_id");



CREATE INDEX "idx_analytics_restaurant_event_time" ON "public"."analytics_simple" USING "btree" ("restaurant_id", "event", "created_at" DESC);



CREATE INDEX "idx_analytics_restaurant_time" ON "public"."analytics_simple" USING "btree" ("restaurant_id", "created_at" DESC);



CREATE INDEX "idx_analytics_time" ON "public"."analytics_simple" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_dish_modifiers_dish_id" ON "public"."dish_modifiers" USING "btree" ("dish_id");



CREATE INDEX "idx_dish_modifiers_modifier_group_id" ON "public"."dish_modifiers" USING "btree" ("modifier_group_id");



CREATE INDEX "idx_dish_tags_dish_id" ON "public"."dish_tags" USING "btree" ("dish_id");



CREATE INDEX "idx_dish_tags_dish_id_optimized" ON "public"."dish_tags" USING "btree" ("dish_id");



CREATE INDEX "idx_dish_tags_tag_id" ON "public"."dish_tags" USING "btree" ("tag_id");



CREATE INDEX "idx_dish_tags_tag_id_optimized" ON "public"."dish_tags" USING "btree" ("tag_id");



CREATE INDEX "idx_dishes_description_trgm" ON "public"."dishes" USING "gin" ("description" "public"."gin_trgm_ops") WHERE (("description" IS NOT NULL) AND ("public" = true));



CREATE INDEX "idx_dishes_embedding" ON "public"."dishes" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100') WHERE (("embedding" IS NOT NULL) AND ("public" = true));



CREATE INDEX "idx_dishes_menu_id" ON "public"."dishes" USING "btree" ("menu_id");



CREATE INDEX "idx_dishes_menu_public" ON "public"."dishes" USING "btree" ("menu_id", "public") WHERE ("public" = true);



CREATE INDEX "idx_dishes_name_trgm" ON "public"."dishes" USING "gin" ("name" "public"."gin_trgm_ops") WHERE ("public" = true);



CREATE INDEX "idx_dishes_public" ON "public"."dishes" USING "btree" ("public") WHERE ("public" = true);



CREATE INDEX "idx_dishes_public_name" ON "public"."dishes" USING "btree" ("public", "name") WHERE ("public" = true);



CREATE INDEX "idx_dishes_section_id" ON "public"."dishes" USING "btree" ("section_id");



CREATE INDEX "idx_geocode_cache_expires" ON "public"."geocode_cache" USING "btree" ("expires_at");



CREATE INDEX "idx_geocode_cache_hash" ON "public"."geocode_cache" USING "btree" ("address_hash");



CREATE INDEX "idx_menus_restaurant_id" ON "public"."menus" USING "btree" ("restaurant_id");



CREATE INDEX "idx_modifier_groups_restaurant_id" ON "public"."modifier_groups" USING "btree" ("restaurant_id");



CREATE INDEX "idx_modifier_option_tags_option_id" ON "public"."modifier_option_tags" USING "btree" ("modifier_option_id");



CREATE INDEX "idx_modifier_option_tags_tag_id" ON "public"."modifier_option_tags" USING "btree" ("tag_id");



CREATE INDEX "idx_modifier_options_group_id" ON "public"."modifier_options" USING "btree" ("group_id");



CREATE INDEX "idx_order_items_order_id" ON "public"."order_items" USING "btree" ("order_id");



CREATE INDEX "idx_orders_restaurant_created" ON "public"."orders" USING "btree" ("restaurant_id", "created_at" DESC);



CREATE INDEX "idx_orders_restaurant_status" ON "public"."orders" USING "btree" ("restaurant_id", "status", "created_at" DESC);



CREATE INDEX "idx_payments_app_fee_id" ON "public"."payments" USING "btree" ("stripe_application_fee_id");



CREATE INDEX "idx_payments_charge_id" ON "public"."payments" USING "btree" ("charge_id") WHERE ("charge_id" IS NOT NULL);



CREATE INDEX "idx_payments_order_id" ON "public"."payments" USING "btree" ("order_id");



CREATE INDEX "idx_push_subs_restaurant" ON "public"."push_subscriptions" USING "btree" ("restaurant_id");



CREATE INDEX "idx_restaurants_city" ON "public"."restaurants" USING "btree" ("city") WHERE ("city" IS NOT NULL);



CREATE INDEX "idx_restaurants_country_city" ON "public"."restaurants" USING "btree" ("country", "city") WHERE (("country" IS NOT NULL) AND ("city" IS NOT NULL));



CREATE INDEX "idx_restaurants_location_gist" ON "public"."restaurants" USING "gist" ("location") WHERE ("location" IS NOT NULL);



COMMENT ON INDEX "public"."idx_restaurants_location_gist" IS 'GiST index for efficient geospatial radius queries using ST_DWithin';



CREATE INDEX "idx_restaurants_public_searchable" ON "public"."restaurants" USING "btree" ("public_searchable") WHERE ("public_searchable" = true);



CREATE INDEX "idx_restaurants_stripe_account_id" ON "public"."restaurants" USING "btree" ("stripe_account_id") WHERE ("stripe_account_id" IS NOT NULL);



CREATE INDEX "idx_sections_menu_id" ON "public"."sections" USING "btree" ("menu_id");



CREATE INDEX "idx_sections_name_trgm" ON "public"."sections" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_stripe_events_created_at" ON "public"."stripe_events" USING "btree" ("created_at");



CREATE INDEX "idx_stripe_events_order_id" ON "public"."stripe_events" USING "btree" ("order_id") WHERE ("order_id" IS NOT NULL);



CREATE INDEX "idx_stripe_events_status" ON "public"."stripe_events" USING "btree" ("status");



CREATE INDEX "idx_stripe_events_type" ON "public"."stripe_events" USING "btree" ("type");



CREATE INDEX "idx_tag_aliases_type_slug" ON "public"."tag_aliases" USING "btree" ("tag_type", "tag_slug");



CREATE UNIQUE INDEX "idx_tags_type_slug_unique" ON "public"."tags" USING "btree" ("type", "slug");



CREATE UNIQUE INDEX "tags_slug_unique" ON "public"."tags" USING "btree" ("slug");



CREATE UNIQUE INDEX "tags_type_slug_uniq" ON "public"."tags" USING "btree" ("type", "slug");



ALTER TABLE ONLY "public"."Chat"
    ADD CONSTRAINT "Chat_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id");



ALTER TABLE ONLY "public"."Document"
    ADD CONSTRAINT "Document_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id");



ALTER TABLE ONLY "public"."Message"
    ADD CONSTRAINT "Message_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id");



ALTER TABLE ONLY "public"."Message_v2"
    ADD CONSTRAINT "Message_v2_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id");



ALTER TABLE ONLY "public"."Stream"
    ADD CONSTRAINT "Stream_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id");



ALTER TABLE ONLY "public"."Suggestion"
    ADD CONSTRAINT "Suggestion_documentId_documentCreatedAt_Document_id_createdAt_f" FOREIGN KEY ("documentId", "documentCreatedAt") REFERENCES "public"."Document"("id", "createdAt");



ALTER TABLE ONLY "public"."Suggestion"
    ADD CONSTRAINT "Suggestion_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id");



ALTER TABLE ONLY "public"."Vote"
    ADD CONSTRAINT "Vote_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id");



ALTER TABLE ONLY "public"."Vote"
    ADD CONSTRAINT "Vote_messageId_Message_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id");



ALTER TABLE ONLY "public"."Vote_v2"
    ADD CONSTRAINT "Vote_v2_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id");



ALTER TABLE ONLY "public"."Vote_v2"
    ADD CONSTRAINT "Vote_v2_messageId_Message_v2_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."Message_v2"("id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage_monthly"
    ADD CONSTRAINT "ai_usage_monthly_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."analytics_simple"
    ADD CONSTRAINT "analytics_simple_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");



ALTER TABLE ONLY "public"."dish_modifiers"
    ADD CONSTRAINT "dish_modifiers_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "public"."dishes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dish_modifiers"
    ADD CONSTRAINT "dish_modifiers_modifier_group_id_fkey" FOREIGN KEY ("modifier_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dish_tags"
    ADD CONSTRAINT "dish_tags_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "public"."dishes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dish_tags"
    ADD CONSTRAINT "dish_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dishes"
    ADD CONSTRAINT "dishes_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dishes"
    ADD CONSTRAINT "dishes_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menus"
    ADD CONSTRAINT "menus_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."modifier_groups"
    ADD CONSTRAINT "modifier_groups_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."modifier_option_tags"
    ADD CONSTRAINT "modifier_option_tags_modifier_option_id_fkey" FOREIGN KEY ("modifier_option_id") REFERENCES "public"."modifier_options"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."modifier_option_tags"
    ADD CONSTRAINT "modifier_option_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."modifier_options"
    ADD CONSTRAINT "modifier_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE CASCADE;



CREATE POLICY "Full access to own modifier groups" ON "public"."modifier_groups" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



CREATE POLICY "Full access to own modifier options" ON "public"."modifier_options" USING (("group_id" IN ( SELECT "modifier_groups"."id"
   FROM "public"."modifier_groups"
  WHERE ("modifier_groups"."restaurant_id" IN ( SELECT "restaurants"."id"
           FROM "public"."restaurants"
          WHERE ("restaurants"."owner_id" = "auth"."uid"()))))));



CREATE POLICY "Owners can manage their modifier option tags" ON "public"."modifier_option_tags" USING ((EXISTS ( SELECT 1
   FROM (("public"."modifier_options" "mo"
     JOIN "public"."modifier_groups" "mg" ON (("mo"."group_id" = "mg"."id")))
     JOIN "public"."restaurants" "r" ON (("mg"."restaurant_id" = "r"."id")))
  WHERE (("mo"."id" = "modifier_option_tags"."modifier_option_id") AND ("r"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."modifier_options" "mo"
     JOIN "public"."modifier_groups" "mg" ON (("mo"."group_id" = "mg"."id")))
     JOIN "public"."restaurants" "r" ON (("mg"."restaurant_id" = "r"."id")))
  WHERE (("mo"."id" = "modifier_option_tags"."modifier_option_id") AND ("r"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Owners can view their modifier option tags" ON "public"."modifier_option_tags" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."modifier_options" "mo"
     JOIN "public"."modifier_groups" "mg" ON (("mo"."group_id" = "mg"."id")))
     JOIN "public"."restaurants" "r" ON (("mg"."restaurant_id" = "r"."id")))
  WHERE (("mo"."id" = "modifier_option_tags"."modifier_option_id") AND ("r"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Owners can view their own AI usage" ON "public"."ai_usage_monthly" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurants"
  WHERE (("restaurants"."id" = "ai_usage_monthly"."restaurant_id") AND ("restaurants"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Tags are viewable by everyone" ON "public"."tags" FOR SELECT USING (true);



CREATE POLICY "Users can manage dish tags" ON "public"."dish_tags" USING (true);



CREATE POLICY "admin_full_access_dish_modifiers" ON "public"."dish_modifiers" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_full_access_dish_tags" ON "public"."dish_tags" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_full_access_modifier_groups" ON "public"."modifier_groups" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_full_access_modifier_option_tags" ON "public"."modifier_option_tags" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_full_access_modifier_options" ON "public"."modifier_options" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_full_access_tags" ON "public"."tags" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



COMMENT ON POLICY "admin_full_access_tags" ON "public"."tags" IS 'Admin full access to tags (only if RLS is enabled)';



CREATE POLICY "admin_read_analytics" ON "public"."analytics_simple" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admins_full_access_order_items" ON "public"."order_items" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_full_access_orders" ON "public"."orders" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_full_access_payments" ON "public"."payments" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_full_access_platform_settings" ON "public"."platform_settings" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admins_full_access_stripe_events" ON "public"."stripe_events" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."admin_users"
  WHERE ("admin_users"."user_id" = "auth"."uid"()))));



CREATE POLICY "admins_manage_push_subs" ON "public"."push_subscriptions" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."ai_usage_monthly" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analytics_simple" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated_read_platform_settings" ON "public"."platform_settings" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."dish_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dishes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."geocode_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."menus" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."modifier_option_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owners_delete_own_dishes" ON "public"."dishes" FOR DELETE TO "authenticated" USING (("menu_id" IN ( SELECT "m"."id"
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("m"."restaurant_id" = "r"."id")))
  WHERE ("r"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_delete_own_dishes" ON "public"."dishes" IS 'Restaurant owners can delete dishes for their restaurants';



CREATE POLICY "owners_delete_own_menus" ON "public"."menus" FOR DELETE TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_delete_own_menus" ON "public"."menus" IS 'Restaurant owners can delete menus for their restaurants';



CREATE POLICY "owners_insert_own_dishes" ON "public"."dishes" FOR INSERT TO "authenticated" WITH CHECK (("menu_id" IN ( SELECT "m"."id"
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("m"."restaurant_id" = "r"."id")))
  WHERE ("r"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_insert_own_dishes" ON "public"."dishes" IS 'Restaurant owners can create dishes for their restaurants';



CREATE POLICY "owners_insert_own_menus" ON "public"."menus" FOR INSERT TO "authenticated" WITH CHECK (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_insert_own_menus" ON "public"."menus" IS 'Restaurant owners can create menus for their restaurants';



CREATE POLICY "owners_insert_own_restaurants" ON "public"."restaurants" FOR INSERT TO "authenticated" WITH CHECK (("owner_id" = "auth"."uid"()));



CREATE POLICY "owners_manage_push_subs" ON "public"."push_subscriptions" TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"())))) WITH CHECK (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



CREATE POLICY "owners_read_own_analytics" ON "public"."analytics_simple" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



CREATE POLICY "owners_read_own_restaurants" ON "public"."restaurants" FOR SELECT TO "authenticated" USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "owners_select_own_dishes" ON "public"."dishes" FOR SELECT TO "authenticated" USING (("menu_id" IN ( SELECT "m"."id"
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("m"."restaurant_id" = "r"."id")))
  WHERE ("r"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_select_own_dishes" ON "public"."dishes" IS 'Restaurant owners can view dishes for their restaurants';



CREATE POLICY "owners_select_own_menus" ON "public"."menus" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_select_own_menus" ON "public"."menus" IS 'Restaurant owners can view menus for their restaurants';



CREATE POLICY "owners_select_own_order_items" ON "public"."order_items" FOR SELECT TO "authenticated" USING (("order_id" IN ( SELECT "orders"."id"
   FROM "public"."orders"
  WHERE ("orders"."restaurant_id" IN ( SELECT "restaurants"."id"
           FROM "public"."restaurants"
          WHERE ("restaurants"."owner_id" = "auth"."uid"()))))));



COMMENT ON POLICY "owners_select_own_order_items" ON "public"."order_items" IS 'Restaurant owners can view order items for their restaurant orders';



CREATE POLICY "owners_select_own_orders" ON "public"."orders" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_select_own_orders" ON "public"."orders" IS 'Restaurant owners can view orders for their restaurants';



CREATE POLICY "owners_select_own_payments" ON "public"."payments" FOR SELECT TO "authenticated" USING (("order_id" IN ( SELECT "orders"."id"
   FROM "public"."orders"
  WHERE ("orders"."restaurant_id" IN ( SELECT "restaurants"."id"
           FROM "public"."restaurants"
          WHERE ("restaurants"."owner_id" = "auth"."uid"()))))));



COMMENT ON POLICY "owners_select_own_payments" ON "public"."payments" IS 'Restaurant owners can view payments for their restaurant orders';



CREATE POLICY "owners_update_own_dishes" ON "public"."dishes" FOR UPDATE TO "authenticated" USING (("menu_id" IN ( SELECT "m"."id"
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("m"."restaurant_id" = "r"."id")))
  WHERE ("r"."owner_id" = "auth"."uid"())))) WITH CHECK (("menu_id" IN ( SELECT "m"."id"
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("m"."restaurant_id" = "r"."id")))
  WHERE ("r"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_update_own_dishes" ON "public"."dishes" IS 'Restaurant owners can update dishes for their restaurants';



CREATE POLICY "owners_update_own_menus" ON "public"."menus" FOR UPDATE TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"())))) WITH CHECK (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_update_own_menus" ON "public"."menus" IS 'Restaurant owners can update menus for their restaurants';



CREATE POLICY "owners_update_own_orders" ON "public"."orders" FOR UPDATE TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"())))) WITH CHECK (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



COMMENT ON POLICY "owners_update_own_orders" ON "public"."orders" IS 'Restaurant owners can update orders for their restaurants (e.g., status changes)';



CREATE POLICY "owners_update_own_restaurants" ON "public"."restaurants" FOR UPDATE TO "authenticated" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_read_dish_tags" ON "public"."dish_tags" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM (("public"."dishes" "d"
     JOIN "public"."menus" "m" ON (("m"."id" = "d"."menu_id")))
     JOIN "public"."restaurants" "r" ON (("r"."id" = "m"."restaurant_id")))
  WHERE (("d"."id" = "dish_tags"."dish_id") AND ("d"."public" = true) AND ("r"."public_searchable" = true)))));



CREATE POLICY "public_read_dishes" ON "public"."dishes" FOR SELECT TO "authenticated", "anon" USING ((("public" = true) AND (EXISTS ( SELECT 1
   FROM ("public"."menus" "m"
     JOIN "public"."restaurants" "r" ON (("r"."id" = "m"."restaurant_id")))
  WHERE (("m"."id" = "dishes"."menu_id") AND ("r"."public_searchable" = true))))));



CREATE POLICY "public_read_menus" ON "public"."menus" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurants" "r"
  WHERE (("r"."id" = "menus"."restaurant_id") AND ("r"."public_searchable" = true)))));



CREATE POLICY "public_read_restaurants" ON "public"."restaurants" FOR SELECT TO "authenticated", "anon" USING (("public_searchable" = true));



CREATE POLICY "public_read_tags" ON "public"."tags" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "restaurant_owners_read_own_analytics" ON "public"."analytics_simple" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "restaurants"."id"
   FROM "public"."restaurants"
  WHERE ("restaurants"."owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."restaurants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "self_can_check_admin" ON "public"."admin_users" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "service_role_geocode_cache" ON "public"."geocode_cache" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."stripe_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "widget_can_log_events" ON "public"."analytics_simple" FOR INSERT TO "authenticated", "anon" WITH CHECK ((("event" = ANY (ARRAY['view'::"text", 'chat'::"text", 'message'::"text", 'intent'::"text", 'cta_click'::"text"])) AND ("restaurant_id" IS NOT NULL) AND ("session" IS NOT NULL) AND (("event" <> 'cta_click'::"text") OR ("cta_type" = ANY (ARRAY['phone'::"text", 'directions'::"text", 'order'::"text"])))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."consume_ai_message"("p_restaurant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."consume_ai_message"("p_restaurant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consume_ai_message"("p_restaurant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"("p_uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes"("search_query" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags"("target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags"("target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags"("target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_strict"("query_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_v2"("required_tag_ids" "uuid"[], "query_text" "text", "target_city" "text", "max_results" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_v2"("required_tag_ids" "uuid"[], "query_text" "text", "target_city" "text", "max_results" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_by_tags_v2"("required_tag_ids" "uuid"[], "query_text" "text", "target_city" "text", "max_results" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "similarity_threshold" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "similarity_threshold" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_fuzzy"("search_text" "text", "target_city" "text", "user_lat" double precision, "user_lng" double precision, "search_radius_km" double precision, "similarity_threshold" double precision, "dietary_tag_ids" "uuid"[], "service_filters" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_dishes_semantic"("query_embedding" "public"."vector", "target_city" "text", "dietary_tag_ids" "uuid"[], "service_filters" "jsonb", "limit_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_restaurant_by_name"("search_text" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_restaurant_by_name"("search_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_restaurant_by_name"("search_text" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_demo_restaurant"("payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."seed_demo_restaurant"("payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_demo_restaurant"("payload" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."Chat" TO "anon";
GRANT ALL ON TABLE "public"."Chat" TO "authenticated";
GRANT ALL ON TABLE "public"."Chat" TO "service_role";



GRANT ALL ON TABLE "public"."Document" TO "anon";
GRANT ALL ON TABLE "public"."Document" TO "authenticated";
GRANT ALL ON TABLE "public"."Document" TO "service_role";



GRANT ALL ON TABLE "public"."Message" TO "anon";
GRANT ALL ON TABLE "public"."Message" TO "authenticated";
GRANT ALL ON TABLE "public"."Message" TO "service_role";



GRANT ALL ON TABLE "public"."Message_v2" TO "anon";
GRANT ALL ON TABLE "public"."Message_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."Message_v2" TO "service_role";



GRANT ALL ON TABLE "public"."Stream" TO "anon";
GRANT ALL ON TABLE "public"."Stream" TO "authenticated";
GRANT ALL ON TABLE "public"."Stream" TO "service_role";



GRANT ALL ON TABLE "public"."Suggestion" TO "anon";
GRANT ALL ON TABLE "public"."Suggestion" TO "authenticated";
GRANT ALL ON TABLE "public"."Suggestion" TO "service_role";



GRANT ALL ON TABLE "public"."User" TO "anon";
GRANT ALL ON TABLE "public"."User" TO "authenticated";
GRANT ALL ON TABLE "public"."User" TO "service_role";



GRANT ALL ON TABLE "public"."Vote" TO "anon";
GRANT ALL ON TABLE "public"."Vote" TO "authenticated";
GRANT ALL ON TABLE "public"."Vote" TO "service_role";



GRANT ALL ON TABLE "public"."Vote_v2" TO "anon";
GRANT ALL ON TABLE "public"."Vote_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."Vote_v2" TO "service_role";



GRANT ALL ON TABLE "public"."admin_users" TO "anon";
GRANT ALL ON TABLE "public"."admin_users" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_users" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_monthly" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_simple" TO "anon";
GRANT ALL ON TABLE "public"."analytics_simple" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_simple" TO "service_role";



GRANT ALL ON TABLE "public"."dish_modifiers" TO "anon";
GRANT ALL ON TABLE "public"."dish_modifiers" TO "authenticated";
GRANT ALL ON TABLE "public"."dish_modifiers" TO "service_role";



GRANT ALL ON TABLE "public"."dish_tags" TO "anon";
GRANT ALL ON TABLE "public"."dish_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."dish_tags" TO "service_role";



GRANT ALL ON TABLE "public"."dishes" TO "anon";
GRANT ALL ON TABLE "public"."dishes" TO "authenticated";
GRANT ALL ON TABLE "public"."dishes" TO "service_role";



GRANT ALL ON TABLE "public"."geocode_cache" TO "anon";
GRANT ALL ON TABLE "public"."geocode_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."geocode_cache" TO "service_role";



GRANT ALL ON TABLE "public"."menus" TO "anon";
GRANT ALL ON TABLE "public"."menus" TO "authenticated";
GRANT ALL ON TABLE "public"."menus" TO "service_role";



GRANT ALL ON TABLE "public"."modifier_groups" TO "anon";
GRANT ALL ON TABLE "public"."modifier_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."modifier_groups" TO "service_role";



GRANT ALL ON TABLE "public"."modifier_option_tags" TO "anon";
GRANT ALL ON TABLE "public"."modifier_option_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."modifier_option_tags" TO "service_role";



GRANT ALL ON TABLE "public"."modifier_options" TO "anon";
GRANT ALL ON TABLE "public"."modifier_options" TO "authenticated";
GRANT ALL ON TABLE "public"."modifier_options" TO "service_role";



GRANT ALL ON TABLE "public"."order_items" TO "anon";
GRANT ALL ON TABLE "public"."order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_items" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."platform_settings" TO "anon";
GRANT ALL ON TABLE "public"."platform_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_settings" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."restaurants" TO "anon";
GRANT ALL ON TABLE "public"."restaurants" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurants" TO "service_role";



GRANT ALL ON TABLE "public"."sections" TO "anon";
GRANT ALL ON TABLE "public"."sections" TO "authenticated";
GRANT ALL ON TABLE "public"."sections" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_events" TO "service_role";



GRANT ALL ON TABLE "public"."tag_aliases" TO "anon";
GRANT ALL ON TABLE "public"."tag_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."tag_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






\unrestrict U0WTy43ymMdhY8gaLtEjO71rOGTQdDLNcVYc40byQE1PxZcEqMWb6iCL3RfSHF1

RESET ALL;
