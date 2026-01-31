/**
 * restaurant-lookup.ts - Fuzzy restaurant lookup for profile card display
 * 
 * Phase 1: Google-style restaurant profile feature
 * - Exact-ish match using ILIKE
 * - Trigram fallback for fuzzy matching
 * - Returns full restaurant profile with all details
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { RestaurantCard, DishMatch } from "@/lib/types/discover";

// ============================================
// TYPES
// ============================================

export interface RestaurantProfile extends RestaurantCard {
    is_open_now?: boolean;
    today_hours?: string;
    menu_preview?: DishMatch[];
}

interface RestaurantRow {
    id: string;
    name: string;
    city: string | null;
    address: string | null;
    cuisine_type: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    opening_hours: Record<string, string> | null;
    accepts_dine_in: boolean | null;
    accepts_takeaway: boolean | null;
    accepts_delivery: boolean | null;
    accepts_reservations: boolean | null;
    amenities: {
        kid_friendly?: boolean;
        wheelchair_accessible?: boolean;
        outdoor_seating?: boolean;
        has_wifi?: boolean;
        has_parking?: boolean;
        pet_friendly?: boolean;
        has_bar?: boolean;
    } | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
    owner_id: string | null;
}

// ============================================
// HELPER: Compute open/closed status
// ============================================

function computeOpenStatus(
    openingHours: Record<string, string> | null,
    timezone: string | null
): { isOpen: boolean; todayHours: string | null } {
    if (!openingHours) {
        return { isOpen: false, todayHours: null };
    }

    // Get current day in restaurant's timezone
    const tz = timezone || "Europe/Stockholm";
    const now = new Date();

    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            weekday: "long",
        });
        const dayName = formatter.format(now).toLowerCase();

        // Get hours for today
        const todayHours = openingHours[dayName] || openingHours[dayName.slice(0, 3)] || null;

        if (!todayHours || todayHours.toLowerCase() === "closed") {
            return { isOpen: false, todayHours: "Closed today" };
        }

        // Parse hours (format: "11:00-22:00" or "11:00-23:59")
        const match = todayHours.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (!match) {
            return { isOpen: false, todayHours };
        }

        const [, openH, openM, closeH, closeM] = match.map(Number);

        // Get current time in restaurant timezone
        const timeFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const currentTime = timeFormatter.format(now);
        const [currentH, currentM] = currentTime.split(":").map(Number);

        const currentMinutes = currentH * 60 + currentM;
        const openMinutes = openH * 60 + openM;
        const closeMinutes = closeH * 60 + closeM;

        const isOpen = currentMinutes >= openMinutes && currentMinutes < closeMinutes;

        return { isOpen, todayHours };
    } catch (error) {
        console.warn("[restaurant-lookup] Error computing open status:", error);
        return { isOpen: false, todayHours: null };
    }
}

// ============================================
// MAIN: Find best restaurant match
// ============================================

export async function findBestRestaurantMatch(opts: {
    queryText: string;
    city?: string | null;
    supabase: SupabaseClient;
}): Promise<RestaurantProfile | null> {
    const { queryText, city, supabase } = opts;

    if (!queryText || queryText.trim().length === 0) {
        return null;
    }

    const cleanQuery = queryText.trim();
    console.log("[restaurant-lookup] Searching for:", { query: cleanQuery, city });

    // Step 1: Try exact-ish match using ILIKE
    let query = supabase
        .from("restaurants")
        .select(`
      id, name, city, address, cuisine_type,
      phone, email, website, opening_hours,
      accepts_dine_in, accepts_takeaway, accepts_delivery, accepts_reservations,
      amenities, latitude, longitude, timezone, owner_id
    `)
        .eq("public_searchable", true)
        .ilike("name", `%${cleanQuery}%`);

    if (city) {
        query = query.ilike("city", `%${city}%`);
    }

    const { data: exactMatches, error: exactError } = await query.limit(5);

    if (exactError) {
        console.error("[restaurant-lookup] Exact match error:", exactError);
    }

    if (exactMatches && exactMatches.length > 0) {
        console.log(`[restaurant-lookup] Found ${exactMatches.length} exact-ish matches`);

        // Pick the best match (shortest name that contains query = most specific)
        const bestMatch = exactMatches.reduce((best, current) => {
            const bestScore = best.name.toLowerCase() === cleanQuery.toLowerCase() ? 1000 : best.name.length;
            const currentScore = current.name.toLowerCase() === cleanQuery.toLowerCase() ? 1000 : current.name.length;
            return currentScore > bestScore ? current : best;
        });

        return await buildRestaurantProfile(bestMatch as RestaurantRow, supabase);
    }

    // Step 2: Try trigram similarity fallback
    console.log("[restaurant-lookup] No exact match, trying trigram fallback...");

    try {
        // Use the existing trigram RPC or direct similarity query
        const { data: fuzzyMatches, error: fuzzyError } = await supabase
            .rpc("search_restaurant_by_name", { search_text: cleanQuery })
            .limit(5);

        if (fuzzyError) {
            // RPC might not exist, try alternative approach
            console.warn("[restaurant-lookup] Trigram RPC not available:", fuzzyError.message);
            return null;
        }

        if (fuzzyMatches && fuzzyMatches.length > 0) {
            const bestFuzzy = fuzzyMatches[0];
            console.log(`[restaurant-lookup] Trigram found ${fuzzyMatches.length} matches, best: ${bestFuzzy.name}`);

            // Re-fetch full details since RPC might return limited fields
            const { data: fullData } = await supabase
                .from("restaurants")
                .select(`
          id, name, city, address, cuisine_type,
          phone, email, website, opening_hours,
          accepts_dine_in, accepts_takeaway, accepts_delivery, accepts_reservations,
          amenities, latitude, longitude, timezone, owner_id
        `)
                .eq("id", bestFuzzy.id)
                .single();

            if (fullData) {
                return await buildRestaurantProfile(fullData as RestaurantRow, supabase);
            }
        }
    } catch (rpcError) {
        console.warn("[restaurant-lookup] Trigram search failed:", rpcError);
    }

    console.log("[restaurant-lookup] No restaurant match found");
    return null;
}

// ============================================
// HELPER: Build full profile with menu preview
// ============================================

async function buildRestaurantProfile(
    restaurant: RestaurantRow,
    supabase: SupabaseClient
): Promise<RestaurantProfile> {
    // Compute open/closed status
    const { isOpen, todayHours } = computeOpenStatus(
        restaurant.opening_hours,
        restaurant.timezone
    );

    // Fetch menu preview (top 3 dishes)
    const { data: menuData } = await supabase
        .from("dishes")
        .select(`
      id, name, description, price,
      menus!inner(restaurant_id)
    `)
        .eq("menus.restaurant_id", restaurant.id)
        .eq("public", true)
        .order("created_at", { ascending: true })
        .limit(3);

    const menuPreview: DishMatch[] = (menuData || []).map((d: { id: string; name: string; description: string | null; price: number }) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        price: d.price,
    }));

    console.log(`[restaurant-lookup] Built profile for ${restaurant.name}:`, {
        isOpen,
        todayHours,
        menuPreviewCount: menuPreview.length,
    });

    return {
        id: restaurant.id,
        name: restaurant.name,
        city: restaurant.city,
        address: restaurant.address,
        cuisine_type: restaurant.cuisine_type,
        phone: restaurant.phone,
        email: restaurant.email,
        website: restaurant.website,
        opening_hours: restaurant.opening_hours,
        accepts_dine_in: restaurant.accepts_dine_in ?? undefined,
        accepts_takeaway: restaurant.accepts_takeaway ?? undefined,
        accepts_delivery: restaurant.accepts_delivery ?? undefined,
        accepts_reservations: restaurant.accepts_reservations ?? undefined,
        amenities: restaurant.amenities,
        is_open_now: isOpen,
        today_hours: todayHours ?? undefined,
        menu_preview: menuPreview,
        ownerId: restaurant.owner_id,
    };
}
