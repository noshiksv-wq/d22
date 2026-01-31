# Discovery Chat App - Setup Instructions

## Environment Variables

Create a `.env.local` file in the root directory with the following variables:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
OPENAI_API_KEY=your_openai_api_key
```

## Database Requirements

Your Supabase database must have:

1. **RPC Function**: `search_public_dishes` (already exists in your shared DB)
2. **Tables**: 
   - `restaurants` (with `public_searchable = true` for discoverable restaurants)
   - `dishes`
   - `menus`
   - `tags`
   - `dish_tags`
3. **RLS Policies**: Public read access to these tables (or proper anon policies)

## Running the App

1. Install dependencies (already done):
```bash
npm install
```

2. Set up environment variables in `.env.local`

3. Start the development server:
```bash
npm run dev
```

4. Navigate to `http://localhost:3000/discover`

## Testing

### Discovery Mode
- Try: "halal butter chicken in Göteborg"
- Try: "vegan pizza in Stockholm"
- Try: "gluten free naan"

### Restaurant Mode
- Click on a restaurant card
- Try asking about the restaurant (simplified mode for v1)

## Troubleshooting

### Error: "Cannot read properties of undefined (reading 'split')"
- Check that all environment variables are set correctly
- Verify Supabase URL and keys are correct
- Check that the `search_public_dishes` RPC function exists in your database

### No restaurants showing up
- Verify restaurants have `public_searchable = true` in the database
- Check RLS policies allow anonymous reads
- Test the RPC function directly in Supabase SQL editor

### OpenAI API errors
- Verify `OPENAI_API_KEY` is set correctly
- Check API key has sufficient credits
- Verify the key has access to `gpt-4o-mini` model

