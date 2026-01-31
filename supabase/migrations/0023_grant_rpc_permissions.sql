-- Grant Execute Permissions on search_public_dishes RPC
-- This is REQUIRED for B2C discovery search to work with anonymous users

-- Grant execute permission to authenticated and anon users (for B2C public access)
GRANT EXECUTE ON FUNCTION public.search_public_dishes(
    search_query TEXT,
    target_city TEXT,
    user_lat DOUBLE PRECISION,
    user_lng DOUBLE PRECISION,
    search_radius_km DOUBLE PRECISION,
    dietary_tag_ids UUID[],
    service_filters JSONB
) TO anon, authenticated;

-- Verify the grant
DO $$
BEGIN
    RAISE NOTICE 'Permissions granted. Function search_public_dishes is now accessible to anon and authenticated users.';
END $$;

