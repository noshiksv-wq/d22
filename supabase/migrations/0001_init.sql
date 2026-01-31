-- Enable required extensions
create extension if not exists "pgvector";
create extension if not exists "postgis";

-- restaurants table
create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location geography(point, 4326),
  opening_hours jsonb,
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- menus table
create table if not exists public.menus (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- dishes table, with pgvector embedding
create table if not exists public.dishes (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.menus (id) on delete cascade,
  name text not null,
  description text,
  price numeric(10,2) not null,
  embedding vector(1536),
  tags jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- tags table (global tags catalog)
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  severity text not null check (severity in ('high', 'medium')),
  created_at timestamptz not null default now()
);

-- basic indexes
create index if not exists idx_menus_restaurant_id on public.menus (restaurant_id);
create index if not exists idx_dishes_menu_id on public.dishes (menu_id);
create index if not exists idx_dishes_embedding on public.dishes using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

