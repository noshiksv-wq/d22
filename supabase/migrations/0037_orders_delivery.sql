-- Delivery Orders Support
-- Adds delivery fields to orders table and geocode cache

-- 1. Add delivery columns to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'pickup';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_street TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_city TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zipcode TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(10,7);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(10,7);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee INTEGER DEFAULT 0;

-- 2. Add customer_email column if not exists
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;

-- 3. Add constraint for order_type
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check 
  CHECK (order_type IN ('pickup', 'delivery'));

-- 4. Create geocode cache table (simple, with TTL)
CREATE TABLE IF NOT EXISTS geocode_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_hash TEXT NOT NULL UNIQUE, -- SHA256 of normalized address
  address_original TEXT NOT NULL,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  success BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- 5. Index for cache lookups
CREATE INDEX IF NOT EXISTS idx_geocode_cache_hash ON geocode_cache(address_hash);
CREATE INDEX IF NOT EXISTS idx_geocode_cache_expires ON geocode_cache(expires_at);

-- 6. Enable RLS (public read for cache, service role write)
ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (drop first if exists to avoid error on re-run)
DROP POLICY IF EXISTS "service_role_geocode_cache" ON geocode_cache;
CREATE POLICY "service_role_geocode_cache" ON geocode_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7. Comments
COMMENT ON TABLE geocode_cache IS 'Cache for geocoded addresses to reduce external API calls';
COMMENT ON COLUMN orders.order_type IS 'pickup or delivery';
COMMENT ON COLUMN orders.delivery_fee IS 'Delivery fee in öre (cents)';
COMMENT ON COLUMN orders.delivery_street IS 'Street address for delivery';
COMMENT ON COLUMN orders.delivery_city IS 'City for delivery';
COMMENT ON COLUMN orders.delivery_zipcode IS 'Zipcode for delivery';
