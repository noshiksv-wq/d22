-- Allow restaurant owners to view their own analytics
-- This was missing, causing the dashboard to show empty/error state for owners

CREATE POLICY "restaurant_owners_read_own_analytics"
ON public.analytics_simple
FOR SELECT
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);
