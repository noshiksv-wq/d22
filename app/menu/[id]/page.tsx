import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

interface Menu {
  id: string;
  name: string;
  dishes: Dish[];
}

interface Dish {
  id: string;
  name: string;
  description: string | null;
  price: number;
}

interface Restaurant {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  cuisine_type: string | null;
}

export default async function MenuPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Fetch restaurant
  const { data: restaurant, error: restaurantError } = await supabase
    .from("restaurants")
    .select("id, name, city, address, phone, email, cuisine_type")
    .eq("id", id)
    .eq("public_searchable", true)
    .single();

  if (restaurantError || !restaurant) {
    notFound();
  }

  // Fetch menus for this restaurant
  const { data: menus, error: menusError } = await supabase
    .from("menus")
    .select("id, name")
    .eq("restaurant_id", id)
    .order("created_at", { ascending: true });

  if (menusError) {
    console.error("[MenuPage] Error fetching menus:", menusError);
  }

  const menuIds = menus?.map((m) => m.id) || [];

  // Fetch sections for these menus
  const { data: sections, error: sectionsError } = await supabase
    .from("sections")
    .select("id, name, display_order, menu_id")
    .in("menu_id", menuIds)
    .order("display_order", { ascending: true });

  if (sectionsError) {
    console.error("[MenuPage] Error fetching sections:", sectionsError);
  }

  // Fetch dishes for all menus
  let allDishes: (Dish & { menu_id: string; section_id: string | null })[] = [];
  if (menuIds.length > 0) {
    const { data: dishesData, error: dishesError } = await supabase
      .from("dishes")
      .select("id, name, description, price, menu_id, section_id")
      .in("menu_id", menuIds)
      .eq("public", true)
      .order("created_at", { ascending: true }); // Serial order

    if (dishesError) {
      console.error("[MenuPage] Error fetching dishes:", dishesError);
    } else {
      allDishes = (dishesData || []) as (Dish & {
        menu_id: string;
        section_id: string | null;
      })[];
    }
  }

  // Structure the data: Menu -> Sections -> Dishes
  interface FullSection {
    id: string;
    name: string;
    dishes: Dish[];
  }

  interface FullMenu {
    id: string;
    name: string;
    sections: FullSection[];
    uncategorizedDishes: Dish[]; // Dishes with no section
  }

  const menusWithSections: FullMenu[] = (menus || []).map((menu) => {
    // 1. Get sections for this menu
    const menuSections = (sections || [])
      .filter((s) => s.menu_id === menu.id)
      .map((section) => ({
        id: section.id,
        name: section.name,
        dishes: allDishes.filter(
          (d) => d.menu_id === menu.id && d.section_id === section.id
        ),
      }))
      // Filter out empty sections if desired (optional, but usually good to hide empty ones)
      // .filter(s => s.dishes.length > 0) 
      ;

    // 2. Get uncategorized dishes (no section)
    const uncategorized = allDishes.filter(
      (d) => d.menu_id === menu.id && !d.section_id
    );

    return {
      id: menu.id,
      name: menu.name,
      sections: menuSections,
      uncategorizedDishes: uncategorized,
    };
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {restaurant.name}
          </h1>
          <div className="flex flex-wrap gap-4 text-sm text-gray-600">
            {restaurant.city && (
              <span className="flex items-center gap-1">
                📍 {restaurant.city}
              </span>
            )}
            {restaurant.cuisine_type && (
              <span className="px-2 py-1 bg-gray-100 rounded text-gray-700">
                {restaurant.cuisine_type}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Menu Content */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {menusWithSections.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-12 text-center">
            <p className="text-gray-500 text-lg">
              No menu available at this time.
            </p>
          </div>
        ) : (
          <div className="space-y-16">
            {menusWithSections.map((menu) => (
              <div key={menu.id} className="space-y-8">
                {/* Menu Title (only show if multiple menus or if it has a specific name like 'Dinner') */}
                <div className="border-b pb-2">
                  <h2 className="text-2xl font-bold text-gray-800">
                    {menu.name}
                  </h2>
                </div>

                {/* Sections */}
                {menu.sections.map((section) => (
                  section.dishes.length > 0 && (
                    <div key={section.id} className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
                      <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-100">
                        <h3 className="text-lg font-semibold text-gray-800">
                          {section.name}
                        </h3>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {section.dishes.map((dish) => (
                          <div
                            key={dish.id}
                            className="flex justify-between items-start gap-4 p-6 hover:bg-gray-50/30 transition-colors"
                          >
                            <div className="flex-1">
                              <h4 className="font-medium text-gray-900 mb-1">
                                {dish.name}
                              </h4>
                              {dish.description && (
                                <p className="text-sm text-gray-500 leading-relaxed">
                                  {dish.description}
                                </p>
                              )}
                            </div>
                            <div className="text-right whitespace-nowrap">
                              <span className="font-semibold text-gray-900 block">
                                {typeof dish.price === "number"
                                  ? `${dish.price.toFixed(0)} kr`
                                  : dish.price}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                ))}

                {/* Uncategorized Dishes */}
                {menu.uncategorizedDishes.length > 0 && (
                  <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
                    <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-100">
                      <h3 className="text-lg font-semibold text-gray-800">
                        Other Dishes
                      </h3>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {menu.uncategorizedDishes.map((dish) => (
                        <div
                          key={dish.id}
                          className="flex justify-between items-start gap-4 p-6 hover:bg-gray-50/30 transition-colors"
                        >
                          <div className="flex-1">
                            <h4 className="font-medium text-gray-900 mb-1">
                              {dish.name}
                            </h4>
                            {dish.description && (
                              <p className="text-sm text-gray-500 leading-relaxed">
                                {dish.description}
                              </p>
                            )}
                          </div>
                          <div className="text-right whitespace-nowrap">
                            <span className="font-semibold text-gray-900 block">
                              {typeof dish.price === "number"
                                ? `${dish.price.toFixed(0)} kr`
                                : dish.price}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

