/**
 * Unified response builder for Discover Chat API
 * Ensures consistent response shape like Perplexity - always includes restaurants + grounded state
 */

import type { RestaurantCard, ChatState, GroundedState } from "@/lib/types/discover";

export interface BuildChatResponseParams {
    messageId: string;
    content: string;
    restaurants?: RestaurantCard[];
    followupChips?: string[];
    chatState: ChatState;
    grounded?: GroundedState | null;
    context?: string; // For logging
}

export interface ChatResponsePayload {
    message: {
        id: string;
        role: "assistant";
        content: string;
        restaurants: RestaurantCard[];  // ALWAYS an array
        followupChips: string[];        // ALWAYS an array
    };
    chatState: ChatState;
    grounded: GroundedState | null;
}

/**
 * Build a consistent chat response with guaranteed shape.
 * - message.restaurants is ALWAYS an array (empty if no results)
 * - message.followupChips is ALWAYS an array
 * - grounded state is preserved for follow-ups
 */
export function buildChatResponse({
    messageId,
    content,
    restaurants = [],
    followupChips = [],
    chatState,
    grounded = null,
    context = "unknown",
}: BuildChatResponseParams): ChatResponsePayload {
    // Normalize restaurants to ensure consistent shape
    const normalizedRestaurants: RestaurantCard[] = (restaurants || []).map(r => ({
        id: r.id,
        name: r.name,
        city: r.city ?? null,
        cuisine_type: r.cuisine_type ?? null,
        highlight: r.highlight ?? null,
        address: r.address ?? null,
        distance_km: r.distance_km ?? null,
        matches: (r.matches || []).map(m => ({
            id: m.id,
            name: m.name,
            description: m.description ?? null,
            price: m.price ?? 0,
            tags: m.tags ?? [],
            section_name: m.section_name ?? null,
        })),
    }));

    // Log for debugging
    console.log(`[buildChatResponse][${context}]`, {
        restaurantsCount: normalizedRestaurants.length,
        matchesCount: normalizedRestaurants.reduce((sum, r) => sum + (r.matches?.length ?? 0), 0),
        hasGrounded: !!grounded,
        mode: chatState.mode,
    });

    return {
        message: {
            id: messageId,
            role: "assistant",
            content,
            restaurants: normalizedRestaurants,
            followupChips: followupChips || [],
        },
        chatState,
        grounded,
    };
}

/**
 * Build grounded state from current search results for follow-up context.
 */
export function buildGroundedState({
    restaurants,
    lastQuery,
    lastDietary,
}: {
    restaurants: RestaurantCard[];
    lastQuery?: string;
    lastDietary?: string[];
}): GroundedState {
    return {
        restaurants: restaurants.map(r => ({
            id: r.id,
            name: r.name,
            city: r.city ?? null,
            address: r.address ?? null,
            matches: (r.matches || []).map(m => ({
                id: m.id,
                name: m.name,
                description: m.description ?? null,
                price: m.price ?? null,
            })),
        })),
        lastQuery,
        lastDietary,
    };
}
