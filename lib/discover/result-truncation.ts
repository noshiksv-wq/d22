/**
 * Result Truncation - Handles large results with pagination/summary metadata
 * Merges previous limiter logic with new meta requirements
 */

import type { RestaurantCard, TruncationMeta } from "@/lib/types/discover";

export function truncateCards(
    cards: RestaurantCard[],
    opts?: {
        maxRestaurants?: number;
        maxDishesPerRestaurant?: number;
        offset?: number;  // For pagination
    }
): { cards: RestaurantCard[]; meta: TruncationMeta } {
    const maxRestaurants = opts?.maxRestaurants ?? 8;
    const maxDishesPerRestaurant = opts?.maxDishesPerRestaurant ?? 4;
    const offset = opts?.offset ?? 0;

    const total_restaurants = cards.length;
    const total_matches = cards.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0);

    // Apply offset-based pagination + truncation
    const paginated = cards.slice(offset, offset + maxRestaurants);

    const sliced = paginated.map((c) => {
        const allMatches = c.matches ?? [];
        const totalDishes = allMatches.length;
        const limitedMatches = allMatches.slice(0, maxDishesPerRestaurant);
        const shownCount = limitedMatches.length;
        const moreDishesCount = Math.max(0, totalDishes - maxDishesPerRestaurant);
        const hasMoreDishes = totalDishes > shownCount;

        return {
            ...c,
            matches: limitedMatches,
            more_dishes_count: moreDishesCount, // Preserve UI functionality
            // Per-restaurant pagination
            pagination: {
                shown: shownCount,
                total: totalDishes,
                remaining: totalDishes - shownCount,
                next_offset: hasMoreDishes ? shownCount : undefined,
            },
        };
    });

    const restaurants_returned = sliced.length;
    const dishes_per_restaurant = maxDishesPerRestaurant;

    const returned_matches = sliced.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0);

    // Calculate if more results exist
    const hasMoreRestaurants = offset + restaurants_returned < total_restaurants;
    const truncated = hasMoreRestaurants || total_matches > returned_matches;

    // Calculate next_offset (undefined if no more pages)
    const next_offset = hasMoreRestaurants ? offset + restaurants_returned : undefined;

    return {
        cards: sliced,
        meta: {
            total_restaurants,
            total_matches,
            truncated,
            restaurants_returned,
            dishes_per_restaurant,
            next_offset,
        },
    };
}

