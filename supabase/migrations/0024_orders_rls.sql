-- RLS Policies for Orders, Order Items, and Payments
-- Restaurant owners can view their own orders and payments
-- Order creation is done via server-side API routes (not direct client inserts)

-- ============================================
-- ENABLE RLS
-- ============================================
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- ============================================
-- ORDERS POLICIES
-- ============================================
-- Restaurant owners can SELECT their own restaurant's orders
CREATE POLICY "owners_select_own_orders"
ON public.orders
FOR SELECT
TO authenticated
USING (
  restaurant_id IN (
    SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
  )
);

-- ============================================
-- ORDER ITEMS POLICIES
-- ============================================
-- Restaurant owners can SELECT order items for their restaurant's orders
CREATE POLICY "owners_select_own_order_items"
ON public.order_items
FOR SELECT
TO authenticated
USING (
  order_id IN (
    SELECT id FROM public.orders 
    WHERE restaurant_id IN (
      SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
    )
  )
);

-- ============================================
-- PAYMENTS POLICIES
-- ============================================
-- Restaurant owners can SELECT payments for their restaurant's orders
CREATE POLICY "owners_select_own_payments"
ON public.payments
FOR SELECT
TO authenticated
USING (
  order_id IN (
    SELECT id FROM public.orders 
    WHERE restaurant_id IN (
      SELECT id FROM public.restaurants WHERE owner_id = auth.uid()
    )
  )
);

-- Comments
COMMENT ON POLICY "owners_select_own_orders" ON public.orders IS 
  'Restaurant owners can view orders for their restaurants';
COMMENT ON POLICY "owners_select_own_order_items" ON public.order_items IS 
  'Restaurant owners can view order items for their restaurant orders';
COMMENT ON POLICY "owners_select_own_payments" ON public.payments IS 
  'Restaurant owners can view payments for their restaurant orders';

-- Note: Order creation, updates, and payment records are created via server-side API routes
-- using service role or elevated permissions, not through direct client inserts.
