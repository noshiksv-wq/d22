-- Make search_public_dishes_by_tags_strict RLS-safe for anon client
-- Uses SECURITY DEFINER to bypass RLS while keeping internal filters for public_searchable/public

CREATE OR REPLACE FUNCTION public.search_public_dishes_by_tags_strict(
  query_text text DEFAULT NULL::text,
  target_city text DEFAULT NULL::text,
  dietary_tag_ids uuid[] DEFAULT NULL::uuid[],
  service_filters jsonb DEFAULT NULL::jsonb,
  limit_count integer DEFAULT 50
)
RETURNS TABLE(
  restaurant_id uuid,
  restaurant_name text,
  restaurant_city text,
  restaurant_address text,
  dish_id uuid,
  dish_name text,
  dish_description text,
  dish_price numeric,
  section_name text,
  similarity_score double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
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
    1::double precision as similarity_score
  from matching_dishes md
  join candidate_restaurants cr on cr.id = md.restaurant_id
  order by md.dish_name asc
  limit limit_count;
end;
$function$;

-- Ensure correct ownership and grants
ALTER FUNCTION public.search_public_dishes_by_tags_strict(text,text,uuid[],jsonb,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_dishes_by_tags_strict(text,text,uuid[],jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_dishes_by_tags_strict(text,text,uuid[],jsonb,integer) TO anon, authenticated;
