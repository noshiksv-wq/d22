-- Admin Access for Orders
-- Grants full access to orders, order_items, and payments for users with is_admin() true

-- ORDERS
CREATE POLICY "admins_full_access_orders"
ON public.orders
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- ORDER ITEMS
CREATE POLICY "admins_full_access_order_items"
ON public.order_items
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- PAYMENTS
CREATE POLICY "admins_full_access_payments"
ON public.payments
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());
