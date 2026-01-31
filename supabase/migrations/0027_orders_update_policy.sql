-- RLS UPDATE Policy for Orders
-- Allows restaurant owners to update status of their own restaurant's orders

-- Allow restaurant owners to UPDATE their own restaurant's orders
CREATE POLICY "owners_update_own_orders"
ON public.orders
FOR UPDATE
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
)
WITH CHECK (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- Comment
COMMENT ON POLICY "owners_update_own_orders" ON public.orders IS 
  'Restaurant owners can update orders for their restaurants (e.g., status changes)';
