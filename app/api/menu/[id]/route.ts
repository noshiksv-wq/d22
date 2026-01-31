import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { MenuPayload, MenuSection, MenuItem, TagInfo } from "@/lib/types/discover";

/**
 * GET /api/menu/[id]
 * Returns menu data as JSON for in-place expansion in discover page
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: restaurantId } = await params;

    if (!restaurantId) {
        return NextResponse.json({ error: "Restaurant ID required" }, { status: 400 });
    }

    try {
        const supabase = await createClient();

        // Fetch restaurant name
        const { data: restaurant, error: restError } = await supabase
            .from("restaurants")
            .select("id, name, city, public_searchable")
            .eq("id", restaurantId)
            .eq("public_searchable", true)
            .single();

        if (restError || !restaurant) {
            return NextResponse.json({ error: "Restaurant not found" }, { status: 404 });
        }

        // Fetch menus
        const { data: menus, error: menusError } = await supabase
            .from("menus")
            .select("id, name")
            .eq("restaurant_id", restaurantId)
            .order("created_at", { ascending: true });

        console.log("[api/menu] menus:", { restaurantId, menus, menusError });

        const menuIds = menus?.map(m => m.id) || [];

        // Fetch sections
        const { data: sections, error: sectionsError } = await supabase
            .from("sections")
            .select("id, name, display_order, menu_id")
            .in("menu_id", menuIds)
            .order("display_order", { ascending: true });

        console.log("[api/menu] sections:", { menuIds, sections: sections?.length, sectionsError });

        // Fetch dishes with tags
        const { data: dishes, error: dishesError } = await supabase
            .from("dishes")
            .select(`
        id, 
        name, 
        description, 
        price, 
        menu_id, 
        section_id,
        public,
        dish_tags(
          tags(id, name, slug, type)
        )
      `)
            .in("menu_id", menuIds)
            .eq("public", true)
            .order("name", { ascending: true });

        console.log("[api/menu] dishes:", {
            menuIds,
            dishesCount: dishes?.length,
            dishesError,
            sampleDish: dishes?.[0] ? { id: dishes[0].id, name: dishes[0].name, public: (dishes[0] as any).public } : null
        });

        // Also check total dishes without public filter for debugging
        const { count: totalDishCount } = await supabase
            .from("dishes")
            .select("*", { count: "exact", head: true })
            .in("menu_id", menuIds);

        console.log("[api/menu] total dishes (including non-public):", totalDishCount);

        // Build MenuPayload with proper Menu → Section → Dish hierarchy
        // Group by menu first, then sections within each menu
        const menuGroups: { id: string; name: string; sections: MenuSection[] }[] = [];
        const allSections: MenuSection[] = []; // Flat sections for backward compatibility

        for (const menu of menus || []) {
            const menuSections: MenuSection[] = [];
            const menuSectionsList = sections?.filter(s => s.menu_id === menu.id) || [];

            // Group dishes by section within this menu
            const sectionMap = new Map<string, { name: string; items: MenuItem[] }>();
            const uncategorizedItems: MenuItem[] = [];

            for (const dish of dishes || []) {
                if (dish.menu_id !== menu.id) continue;

                // Extract tags from dish_tags join
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tags: TagInfo[] = (dish.dish_tags || [])
                    .map((dt: any) => dt.tags)
                    .filter((t: any): t is TagInfo => t !== null && t !== undefined && t.id);

                const menuItem: MenuItem = {
                    id: dish.id,
                    name: dish.name,
                    description: dish.description,
                    price: dish.price,
                    tags,
                };

                if (dish.section_id) {
                    const section = menuSectionsList.find(s => s.id === dish.section_id);
                    if (section) {
                        if (!sectionMap.has(section.id)) {
                            sectionMap.set(section.id, { name: section.name, items: [] });
                        }
                        sectionMap.get(section.id)!.items.push(menuItem);
                    } else {
                        uncategorizedItems.push(menuItem);
                    }
                } else {
                    uncategorizedItems.push(menuItem);
                }
            }

            // Convert map to array, preserving section order from database
            for (const section of menuSectionsList) {
                if (sectionMap.has(section.id)) {
                    const sectionData = sectionMap.get(section.id)!;
                    menuSections.push(sectionData);
                    allSections.push(sectionData); // Also add to flat list
                }
            }

            // Add uncategorized items as "Other" section
            if (uncategorizedItems.length > 0) {
                const otherSection = { name: "Other", items: uncategorizedItems };
                menuSections.push(otherSection);
                allSections.push(otherSection);
            }

            if (menuSections.length > 0) {
                menuGroups.push({
                    id: menu.id,
                    name: menu.name,
                    sections: menuSections,
                });
            }
        }

        const menuPayload: MenuPayload = {
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            city: restaurant.city,
            sections: allSections, // Flat sections for backward compatibility
            menus: menuGroups, // Proper hierarchy with menu names
        };

        return NextResponse.json(menuPayload);

    } catch (error) {
        console.error("[api/menu] Error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
