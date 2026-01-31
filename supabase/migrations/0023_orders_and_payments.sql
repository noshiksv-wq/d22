-- Orders and Payments tables
-- Creates orders, order_items, and payments tables for online ordering

-- ============================================
-- ORDERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'widget' CHECK (source IN ('widget', 'discovery')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'placed', 'accepted', 'completed', 'cancelled')),
  fulfillment_type TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfillment_type = 'pickup'),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('pay_in_store', 'stripe_card')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded')),
  customer_name TEXT,
  customer_phone TEXT,
  pickup_time TIMESTAMPTZ,
  notes TEXT,
  subtotal_amount INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
  total_amount INTEGER NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'SEK',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_created 
ON public.orders(restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status 
ON public.orders(restaurant_id, status, created_at DESC);

-- ============================================
-- ORDER ITEMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  dish_id UUID, -- Nullable (dish may be deleted later)
  dish_name TEXT NOT NULL, -- Snapshot at order time
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0), -- Price in öre (snapshot)
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  modifiers JSONB NOT NULL DEFAULT '{}'::jsonb -- Modifier selections
);

-- Index for order items
CREATE INDEX IF NOT EXISTS idx_order_items_order_id 
ON public.order_items(order_id);

-- ============================================
-- PAYMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  checkout_session_id TEXT UNIQUE,
  payment_intent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'succeeded', 'failed', 'refunded')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0), -- Amount in öre
  currency TEXT NOT NULL DEFAULT 'SEK',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for payments
CREATE INDEX IF NOT EXISTS idx_payments_order_id 
ON public.payments(order_id);

-- Comments
COMMENT ON TABLE public.orders IS 'Customer orders for pickup';
COMMENT ON TABLE public.order_items IS 'Items in each order (with price snapshots)';
COMMENT ON TABLE public.payments IS 'Payment records for orders';

COMMENT ON COLUMN public.orders.subtotal_amount IS 'Subtotal in öre (Swedish cents)';
COMMENT ON COLUMN public.orders.total_amount IS 'Total amount in öre (Swedish cents)';
COMMENT ON COLUMN public.order_items.unit_price IS 'Price per unit in öre (snapshot at order time)';
COMMENT ON COLUMN public.payments.amount IS 'Payment amount in öre (Swedish cents)';
