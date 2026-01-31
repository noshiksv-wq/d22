-- Demo Menu Seed Data
-- Run this in Supabase SQL Editor after creating a restaurant

-- First, get your restaurant ID from the dashboard or run:
-- SELECT id, name FROM restaurants;

-- Then replace 'YOUR_RESTAURANT_ID' below with your actual restaurant ID

DO $$
DECLARE
  v_restaurant_id UUID;
  v_menu_id UUID;
  v_starters_id UUID;
  v_mains_id UUID;
  v_desserts_id UUID;
  v_drinks_id UUID;
BEGIN
  -- Get the first restaurant (or specify your ID)
  SELECT id INTO v_restaurant_id FROM restaurants LIMIT 1;
  
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'No restaurant found. Create a restaurant first in Settings.';
  END IF;

  -- Create Menu
  INSERT INTO menus (restaurant_id, name)
  VALUES (v_restaurant_id, 'Main Menu')
  RETURNING id INTO v_menu_id;

  -- Create Sections
  INSERT INTO sections (menu_id, name, display_order)
  VALUES (v_menu_id, 'Starters', 1)
  RETURNING id INTO v_starters_id;

  INSERT INTO sections (menu_id, name, display_order)
  VALUES (v_menu_id, 'Main Courses', 2)
  RETURNING id INTO v_mains_id;

  INSERT INTO sections (menu_id, name, display_order)
  VALUES (v_menu_id, 'Desserts', 3)
  RETURNING id INTO v_desserts_id;

  INSERT INTO sections (menu_id, name, display_order)
  VALUES (v_menu_id, 'Drinks', 4)
  RETURNING id INTO v_drinks_id;

  -- ============================================
  -- STARTERS
  -- ============================================
  INSERT INTO dishes (menu_id, section_id, name, description, price) VALUES
  (v_menu_id, v_starters_id, 'Garlic Bread', 'Crispy baguette with garlic butter and herbs', 65),
  (v_menu_id, v_starters_id, 'Bruschetta', 'Toasted bread topped with fresh tomatoes, basil, and olive oil', 75),
  (v_menu_id, v_starters_id, 'Soup of the Day', 'Ask your server for today''s homemade soup', 85),
  (v_menu_id, v_starters_id, 'Caesar Salad', 'Romaine lettuce, parmesan, croutons, and caesar dressing', 95),
  (v_menu_id, v_starters_id, 'Spring Rolls', 'Crispy vegetable spring rolls with sweet chili sauce', 79);

  -- ============================================
  -- MAIN COURSES
  -- ============================================
  INSERT INTO dishes (menu_id, section_id, name, description, price) VALUES
  (v_menu_id, v_mains_id, 'Grilled Salmon', 'Atlantic salmon with lemon butter sauce, served with vegetables and potatoes', 245),
  (v_menu_id, v_mains_id, 'Beef Tenderloin', 'Premium beef tenderloin with red wine reduction, roasted vegetables', 295),
  (v_menu_id, v_mains_id, 'Chicken Parmesan', 'Breaded chicken breast with marinara sauce and melted mozzarella', 195),
  (v_menu_id, v_mains_id, 'Vegetarian Pasta', 'Penne with roasted vegetables, sun-dried tomatoes, and pesto cream sauce', 165),
  (v_menu_id, v_mains_id, 'Fish & Chips', 'Beer-battered cod with crispy fries and tartar sauce', 175),
  (v_menu_id, v_mains_id, 'Lamb Chops', 'Grilled lamb chops with mint sauce and rosemary potatoes', 275),
  (v_menu_id, v_mains_id, 'Mushroom Risotto', 'Creamy arborio rice with wild mushrooms and parmesan', 155),
  (v_menu_id, v_mains_id, 'Thai Green Curry', 'Coconut curry with vegetables, served with jasmine rice. Vegan option available', 175);

  -- ============================================
  -- DESSERTS
  -- ============================================
  INSERT INTO dishes (menu_id, section_id, name, description, price) VALUES
  (v_menu_id, v_desserts_id, 'Chocolate Lava Cake', 'Warm chocolate cake with molten center, served with vanilla ice cream', 95),
  (v_menu_id, v_desserts_id, 'Tiramisu', 'Classic Italian dessert with espresso-soaked ladyfingers and mascarpone', 85),
  (v_menu_id, v_desserts_id, 'Crème Brûlée', 'Vanilla custard with caramelized sugar top', 85),
  (v_menu_id, v_desserts_id, 'Cheesecake', 'New York style cheesecake with berry compote', 89),
  (v_menu_id, v_desserts_id, 'Fruit Sorbet', 'Selection of refreshing fruit sorbets. Vegan friendly', 65);

  -- ============================================
  -- DRINKS
  -- ============================================
  INSERT INTO dishes (menu_id, section_id, name, description, price) VALUES
  (v_menu_id, v_drinks_id, 'Soft Drinks', 'Coca-Cola, Fanta, Sprite, or sparkling water', 35),
  (v_menu_id, v_drinks_id, 'Fresh Juice', 'Orange, apple, or mixed berry juice', 45),
  (v_menu_id, v_drinks_id, 'Coffee', 'Espresso, cappuccino, or latte', 39),
  (v_menu_id, v_drinks_id, 'Tea Selection', 'Earl Grey, green tea, or herbal infusions', 35),
  (v_menu_id, v_drinks_id, 'House Wine', 'Red or white, by the glass', 85),
  (v_menu_id, v_drinks_id, 'Craft Beer', 'Local craft beer selection', 75);

  RAISE NOTICE 'Demo menu created successfully! Menu ID: %', v_menu_id;
END $$;

-- Verify the data
SELECT 
  m.name as menu_name,
  s.name as section_name,
  d.name as dish_name,
  d.price
FROM menus m
JOIN sections s ON s.menu_id = m.id
JOIN dishes d ON d.section_id = s.id
ORDER BY s.display_order, d.name;

