-- Super Admin Allowlist
-- Creates admin_users table and helper function for checking admin status

-- Admin allowlist table
CREATE TABLE IF NOT EXISTS admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Allow logged-in users to check if THEY are admin (needed for route guard)
CREATE POLICY "self_can_check_admin"
ON admin_users FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Helper function for policies
CREATE OR REPLACE FUNCTION is_admin(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = p_uid);
$$;

-- Comments
COMMENT ON TABLE admin_users IS 'Super admin allowlist - users who can manage all restaurants';
COMMENT ON FUNCTION is_admin IS 'Helper function to check if a user is an admin';
