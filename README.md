# Discovery Chat App

A Next.js-based food discovery application that helps users find restaurants and dishes using natural language queries. Built with Next.js, Supabase, OpenAI, and Tailwind CSS.

## Features

- 🔍 **Smart Search**: Search for dishes and restaurants using natural language
- 🏙️ **City Filtering**: Filter results by city (e.g., "butter naan in Gothenburg")
- 🥗 **Dietary Filters**: Supports vegetarian, vegan, halal, gluten-free, and more
- 💬 **Chat Interface**: Conversational AI-powered discovery experience
- 🎨 **Modern UI**: Clean, responsive design with Shadcn UI components

## Getting Started

First, install dependencies:

```bash
npm install
```

Create a `.env.local` file with your credentials (see `SETUP.md` for details):

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
OPENAI_API_KEY=your_openai_api_key
```

Run the development server:

```bash
npm run dev
# or on port 3001
npm run dev:3001
```

Open [http://localhost:3000](http://localhost:3000) (or [http://localhost:3001](http://localhost:3001)) with your browser to see the result.

Navigate to `/discover` to use the discovery chat interface.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
