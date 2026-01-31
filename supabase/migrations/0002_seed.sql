-- Sample data for validation

insert into public.restaurants (name, location, opening_hours)
values (
  'Nordix Test Bistro',
  null,
  '{
    "mon_fri": "11:00-22:00",
    "sat_sun": "10:00-23:00"
  }'::jsonb
)
on conflict do nothing;

with r as (
  select id from public.restaurants where name = 'Nordix Test Bistro' limit 1
)
insert into public.menus (restaurant_id, name)
select r.id, 'Main Menu'
from r
on conflict do nothing;

with m as (
  select id from public.menus where name = 'Main Menu' limit 1
)
insert into public.dishes (menu_id, name, description, price, embedding, tags)
select
  m.id,
  'Nordic Salmon Bowl',
  'Grilled salmon with roasted root vegetables, dill yogurt, and rye crumble.',
  19.50,
  null,
  '["gluten-free", "seafood"]'::jsonb
from m
on conflict do nothing;

insert into public.tags (name, severity)
values ('Vegan', 'high'),
       ('Vegetarian', 'medium'),
       ('Gluten-free', 'medium')
on conflict do nothing;

