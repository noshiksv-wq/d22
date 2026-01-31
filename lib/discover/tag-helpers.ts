/**
 * Tag helper functions for grouping and displaying dish tags
 * Used across InlineMenuCard and discovery card list
 */

import type { TagInfo } from '@/lib/types/discover';

// Tags that represent "free-from" claims (should be displayed in their own group)
const FREE_FROM_SLUGS = ['gluten-free', 'dairy-free', 'nut-free', 'lactose-free'];

/**
 * Group dish tags by category for display
 */
export function groupDishTags(tags: TagInfo[] | undefined) {
    const safeTags = tags || [];

    return {
        // Regular dietary tags (not free-from)
        dietary: safeTags.filter(t => t.type === 'diet' && !FREE_FROM_SLUGS.includes(t.slug)),

        // Free-from claims (special diet subgroup)
        freeFrom: safeTags.filter(t => t.type === 'diet' && FREE_FROM_SLUGS.includes(t.slug)),

        // Allergen tags (contains)
        allergens: safeTags.filter(t => t.type === 'allergen'),

        // Religious dietary tags
        religious: safeTags.filter(t => t.type === 'religious'),
    };
}

// Disclaimer texts
export const DISCLAIMERS = {
    allergen: "Allergy info is based on tags. Confirm with the restaurant about cross-contamination.",
    freeFrom: "Free-from labels are based on tags. Confirm cross-contamination if allergy is severe.",
};
