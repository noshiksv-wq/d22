-- Modifier option tags (reuse existing tags table)

create table if not exists public.modifier_option_tags (
  modifier_option_id uuid not null references public.modifier_options(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (modifier_option_id, tag_id)
);

create index if not exists idx_modifier_option_tags_option_id on public.modifier_option_tags(modifier_option_id);
create index if not exists idx_modifier_option_tags_tag_id on public.modifier_option_tags(tag_id);

-- Enable RLS
alter table public.modifier_option_tags enable row level security;

-- RLS policies: owner of the restaurant that owns the modifier option can manage
create policy "Users can view modifier option tags" on public.modifier_option_tags
  for select using (
    modifier_option_id in (
      select id from public.modifier_options
      where group_id in (
        select id from public.modifier_groups
        where restaurant_id in (select id from public.restaurants where owner_id = auth.uid())
      )
    )
  );

create policy "Users can insert modifier option tags" on public.modifier_option_tags
  for insert with check (
    modifier_option_id in (
      select id from public.modifier_options
      where group_id in (
        select id from public.modifier_groups
        where restaurant_id in (select id from public.restaurants where owner_id = auth.uid())
      )
    )
  );

create policy "Users can delete modifier option tags" on public.modifier_option_tags
  for delete using (
    modifier_option_id in (
      select id from public.modifier_options
      where group_id in (
        select id from public.modifier_groups
        where restaurant_id in (select id from public.restaurants where owner_id = auth.uid())
      )
    )
  );

