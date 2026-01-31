-- Platform Settings (Key-Value Store)
-- Singleton table to store global configuration like application usage fees

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Enable RLS
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Admins can do everything
CREATE POLICY "admins_full_access_platform_settings"
ON public.platform_settings
FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());

-- Everyone (authenticated) can read settings (needed for API routes / server components)
-- We might want to restrict this to only specific keys in the future, but for now unrestricted read is fine for internal APIs
-- Ideally, public users shouldn't read this directly, but our APIs will use Service Role or authenticated checks.
-- Let's stick to "authenticated" can read for now.
CREATE POLICY "authenticated_read_platform_settings"
ON public.platform_settings
FOR SELECT
TO authenticated
USING (true);

-- Comments
COMMENT ON TABLE public.platform_settings IS 'Global configuration storage';
COMMENT ON COLUMN public.platform_settings.key IS 'Setting key (e.g. application_fee_percent)';
COMMENT ON COLUMN public.platform_settings.value IS 'Setting value in JSON format';
