/**
 * Result Limiter - Ensures bounded, high-signal response lists
 * Never returns more than MAX_RESTAURANTS or MAX_DISHES_PER_RESTAURANT
 */

import type { RestaurantCard, DishMatch } from "@/lib/types/discover";

// Configurable limits
export const MAX_RESTAURANTS = 5;
export const MAX_DISHES_PER_RESTAURANT = 3;

export interface LimitedDishMatch extends DishMatch {
    // All DishMatch fields inherited
}

export interface LimitedRestaurantCard extends Omit<RestaurantCard, 'matches'> {
    matches: LimitedDishMatch[];
    more_dishes_count: number;  // How many dishes were truncated
}

export interface LimitedDiscoveryResult {
    restaurants: LimitedRestaurantCard[];
    more_restaurants_count: number;  // How many restaurants were truncated
    total_restaurants_found: number;
    total_dishes_found: number;
}

/**
 * Limit discovery results to bounded, high-signal lists.
 * Pure shaping function - does not alter search logic.
 */
export function limitDiscoveryResults(
    restaurants: RestaurantCard[],
    maxRestaurants: number = MAX_RESTAURANTS,
    maxDishesPerRestaurant: number = MAX_DISHES_PER_RESTAURANT
): LimitedDiscoveryResult {
    const totalRestaurants = restaurants.length;
    const totalDishes = restaurants.reduce((sum, r) => sum + (r.matches?.length ?? 0), 0);

    // Limit restaurants
    const limitedRestaurants = restaurants.slice(0, maxRestaurants);
    const moreRestaurantsCount = Math.max(0, totalRestaurants - maxRestaurants);

    // Limit dishes per restaurant and add metadata
    const shapedRestaurants: LimitedRestaurantCard[] = limitedRestaurants.map(r => {
        const allMatches = r.matches || [];
        const limitedMatches = allMatches.slice(0, maxDishesPerRestaurant);
        const moreDishesCount = Math.max(0, allMatches.length - maxDishesPerRestaurant);

        return {
            id: r.id,
            name: r.name,
            city: r.city ?? null,
            cuisine_type: r.cuisine_type ?? null,
            highlight: r.highlight ?? null,
            address: r.address ?? null,
            distance_km: r.distance_km ?? null,
            matches: limitedMatches,
            more_dishes_count: moreDishesCount,
            // Restaurant details
            phone: r.phone ?? null,
            email: r.email ?? null,
            website: r.website ?? null,
            opening_hours: r.opening_hours ?? null,
            // Service options
            accepts_dine_in: r.accepts_dine_in,
            accepts_takeaway: r.accepts_takeaway,
            accepts_delivery: r.accepts_delivery,
            accepts_reservations: r.accepts_reservations,
            // Amenities
            amenities: r.amenities ?? null,
        };
    });

    console.log("[result-limiter]", {
        inputRestaurants: totalRestaurants,
        outputRestaurants: shapedRestaurants.length,
        moreRestaurantsCount,
        totalDishes,
        truncatedRestaurants: shapedRestaurants.filter(r => r.more_dishes_count > 0).length
    });

    return {
        restaurants: shapedRestaurants,
        more_restaurants_count: moreRestaurantsCount,
        total_restaurants_found: totalRestaurants,
        total_dishes_found: totalDishes,
    };
}

/**
 * Check if any restaurant has truncated dishes
 */
export function hasMoreDishes(result: LimitedDiscoveryResult): boolean {
    return result.restaurants.some(r => r.more_dishes_count > 0);
}

/**
 * Check if there are more restaurants available
 */
export function hasMoreRestaurants(result: LimitedDiscoveryResult): boolean {
    return result.more_restaurants_count > 0;
}

/**
 * Build a summary text for UI display
 */
export function buildLimitSummary(result: LimitedDiscoveryResult): string | null {
    const parts: string[] = [];

    if (result.more_restaurants_count > 0) {
        parts.push(`+${result.more_restaurants_count} more restaurants`);
    }

    const totalMoreDishes = result.restaurants.reduce((sum, r) => sum + r.more_dishes_count, 0);
    if (totalMoreDishes > 0) {
        parts.push(`+${totalMoreDishes} more dishes across results`);
    }

    return parts.length > 0 ? parts.join(" · ") : null;
}
