# Deployment Checklist for Vercel

## Environment Variables

Make sure these are set in Vercel Dashboard → Settings → Environment Variables:

### Required Variables:
1. `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
2. `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Your Supabase anonymous key
3. `OPENAI_API_KEY` - Your OpenAI API key

### How to Set:
1. Go to Vercel Dashboard
2. Select your project
3. Go to Settings → Environment Variables
4. Add each variable for **Production**, **Preview**, and **Development** environments
5. Redeploy after adding variables

## Database Setup

### Critical: Run these migrations on your production Supabase database:

1. **RLS Policies** (if not already applied):
   - Run `supabase/migrations/0022_b2c_public_read_policies.sql`
   - This enables anonymous users to read public restaurants and dishes

2. **Function Permissions** (if not already applied):
   - Run `supabase/migrations/0024_fix_rpc_security_definer.sql`
   - This makes the function SECURITY DEFINER so it bypasses RLS

3. **Verify Setup**:
   - Run `VERIFY_MIGRATION.sql` to check function is SECURITY DEFINER
   - Run `CHECK_RLS_STATUS.sql` to verify RLS policies exist

## Common Issues

### Issue: Search returns empty results
**Solution**: 
- Verify environment variables are set in Vercel
- Check that RLS policies are applied (migration 0022)
- Check that function is SECURITY DEFINER (migration 0024)
- Test the RPC function directly in Supabase SQL Editor

### Issue: "Missing Supabase environment variables" error
**Solution**: 
- Add environment variables in Vercel Dashboard
- Make sure variable names match exactly (case-sensitive)
- Redeploy after adding variables

### Issue: Function permissions error
**Solution**: 
- Run migration 0024 to set SECURITY DEFINER
- Grant execute permissions: `GRANT EXECUTE ON FUNCTION public.search_public_dishes TO anon, authenticated;`

## Testing After Deployment

1. Test the debug endpoint: `https://your-app.vercel.app/api/discover/debug?q=butter+naan`
2. Test the chat interface: `https://your-app.vercel.app/discover`
3. Try searches: "butter naan", "naan", "butter naan in gothenburg"

## Debugging

If search doesn't work:
1. Check Vercel function logs (Vercel Dashboard → Functions → View Logs)
2. Check browser console for errors
3. Test RPC function directly in Supabase SQL Editor
4. Verify environment variables are set correctly

