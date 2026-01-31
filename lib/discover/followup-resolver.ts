/**
 * Followup Resolver - Resolves follow-up questions against last search results
 * Enables Perplexity-style "is it halal?" questions about previously shown dishes
 */

import type { Intent, LastResultDish } from "@/lib/types/discover";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/discover/i18n";

export type FollowupType = "RESOLVED" | "CLARIFY" | "NOT_FOUND" | "PASS" | "TRANSLATE_LAST" | "PAGINATE" | "SHOW_MORE_RESTAURANT";

export interface FollowupResolution {
    type: FollowupType;
    matchedDish?: LastResultDish;
    candidates?: LastResultDish[];
    answer?: string;
    tagFound?: boolean;
    targetLanguage?: string;  // For TRANSLATE_LAST
    matchedRestaurantId?: string;  // For SHOW_MORE_RESTAURANT
    matchedRestaurantName?: string;  // For SHOW_MORE_RESTAURANT
}

// Tag keywords that trigger tag follow-up detection (diet/religious/free-from only - no ingredient words)
const TAG_KEYWORDS = [
    "halal", "vegan", "vegetarian", "veg", "kosher", "satvik", "satvic",
    "gluten-free", "gluten free", "glutenfri", "nut-free", "dairy-free", "lactose-free",
    // Allergen meta-keywords (triggers __allergens__ mode)
    "allergen", "allergens", "allergy", "allergies"
];

// Known allergen slugs for single-allergen detection (e.g., "contains milk?")
const KNOWN_ALLERGENS = [
    "milk", "eggs", "egg", "nuts", "peanuts", "peanut", "tree-nuts", "treenuts",
    "wheat", "gluten", "soy", "soybeans", "soybean", "fish", "shellfish", "crustacean",
    "sesame", "mustard", "celery", "lupin", "molluscs", "sulphites", "sulfites"
];

// Pronouns that reference the last result
const REFERENCE_PRONOUNS = ["it", "this", "that", "the dish", "the food", "these"];

// Pagination patterns for "show more" requests
const PAGINATION_PATTERNS = [
    /show\s+more/i,
    /more\s+results/i,
    /next\s+page/i,
    /load\s+more/i,
    /visa\s+fler/i,     // Swedish: "show more"
    /fler\s+resultat/i, // Swedish: "more results"
];

// Per-restaurant "show more from X" patterns
const SHOW_MORE_RESTAURANT_PATTERNS = [
    /show\s+(?:more|all)\s+from\s+(.+)/i,
    /more\s+from\s+(.+)/i,
    /show\s+all\s+(?:dishes\s+)?(?:at|from)\s+(.+)/i,
    /(?:pull|get|view|show|see)\s+(?:menu|dishes)\s+(?:of|from|at)\s+(.+)/i,
    /(?:pull|get|view|show|see)\s+(?:full|entire|complete)\s+menu\s+(?:of|from|at)\s+(.+)/i,
    /(?:full|entire|complete)\s+menu\s+(?:of|from|at)\s+(.+)/i,
    /visa\s+(?:fler|allt)\s+från\s+(.+)/i,  // Swedish
];

/**
 * Check if query is asking about a tag/allergen
 */
function isTagQuestion(query: string): { isTag: boolean; tagName: string | null } {
    const lowerQuery = query.toLowerCase();

    // PRIORITY 1: Check for general allergen questions -> __allergens__ mode
    if (lowerQuery.match(/(?:any|what|which)\s+allergens?/i) ||
        lowerQuery.match(/allergen\s+info/i) ||
        lowerQuery.match(/contains?\s+allergens?/i) ||
        lowerQuery.match(/has\s+allergens?/i) ||
        lowerQuery.match(/allergi(?:c|es)/i)) {
        return { isTag: true, tagName: "__allergens__" };
    }

    // PRIORITY 2: Check for single-allergen questions (e.g., "contains milk?", "has peanuts?")
    const singleAllergenPatterns = [
        /(?:contains?|has|have|with|without)\s+(\w+)/i,
        /(?:is\s+there|any)\s+(\w+)\s+in/i,
        /(\w+)\s+(?:free|allergy)/i
    ];
    for (const pattern of singleAllergenPatterns) {
        const match = lowerQuery.match(pattern);
        if (match) {
            const potentialAllergen = match[1].toLowerCase();
            if (KNOWN_ALLERGENS.includes(potentialAllergen)) {
                return { isTag: true, tagName: potentialAllergen };
            }
        }
    }

    // PRIORITY 3: Check for explicit diet/religious tag keywords
    for (const tag of TAG_KEYWORDS) {
        if (lowerQuery.includes(tag)) {
            // If it's an allergen meta-keyword, use __allergens__ mode
            if (["allergen", "allergens", "allergy", "allergies"].includes(tag)) {
                return { isTag: true, tagName: "__allergens__" };
            }
            return { isTag: true, tagName: tag };
        }
    }

    // PRIORITY 4: Check for "is it X" / "does it have X" patterns
    const patterns = [
        /is\s+(it|this|that)\s+(\w+)/i,
        /does\s+(it|this|that)\s+(have|contain)\s+(\w+)/i,
        /is\s+the\s+\w+\s+(\w+)/i
    ];

    for (const pattern of patterns) {
        const match = lowerQuery.match(pattern);
        if (match) {
            const potentialTag = match[match.length - 1].toLowerCase();
            if (TAG_KEYWORDS.includes(potentialTag)) {
                return { isTag: true, tagName: potentialTag };
            }
            // Also check known allergens
            if (KNOWN_ALLERGENS.includes(potentialTag)) {
                return { isTag: true, tagName: potentialTag };
            }
        }
    }

    return { isTag: false, tagName: null };
}

/**
 * Check if query references a previous dish by name or pronoun
 */
function findDishReference(
    query: string,
    intent: Intent,
    lastResults: LastResultDish[]
): { matches: LastResultDish[]; usedPronoun: boolean } {
    const lowerQuery = query.toLowerCase();

    // Check for pronoun reference ("is it halal?")
    const usesPronoun = REFERENCE_PRONOUNS.some(p => lowerQuery.includes(p));

    // If pronoun used and only 1 dish in last results, that's the match
    if (usesPronoun && lastResults.length === 1) {
        return { matches: lastResults, usedPronoun: true };
    }

    // Check for dish name mention
    const matches: LastResultDish[] = [];

    // First try intent.dish_query
    if (intent.dish_query) {
        const dishQuery = intent.dish_query.toLowerCase();
        for (const dish of lastResults) {
            const dishName = dish.dish_name.toLowerCase();
            if (dishName.includes(dishQuery) || dishQuery.includes(dishName)) {
                matches.push(dish);
            }
        }
        if (matches.length > 0) {
            return { matches, usedPronoun: false };
        }
    }

    // Try matching against query words
    const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 2);
    for (const dish of lastResults) {
        const dishWords = dish.dish_name.toLowerCase().split(/\s+/);
        const hasMatch = queryWords.some(qw =>
            dishWords.some(dw => dw.includes(qw) || qw.includes(dw))
        );
        if (hasMatch) {
            matches.push(dish);
        }
    }

    // If pronoun used but multiple dishes, return all for clarification
    if (usesPronoun && matches.length === 0) {
        return { matches: lastResults, usedPronoun: true };
    }

    return { matches, usedPronoun: usesPronoun };
}

/**
 * Lookup tags for a dish directly from DB - returns full tag info
 */
type DishTagInfo = { slug: string; name: string; type: string };

async function getDishTagsFromDB(dishId: string): Promise<DishTagInfo[]> {
    try {
        const supabase = await createClient();

        const { data, error } = await supabase
            .from("dish_tags")
            .select(`tags!inner(name, slug, type)`)
            .eq("dish_id", dishId);

        if (error || !data) {
            console.log("[followup-resolver] DB lookup failed:", error);
            return [];
        }

        // Extract full tag info
        return data.map((row: any) => ({
            slug: row.tags?.slug || '',
            name: row.tags?.name || row.tags?.slug || '',
            type: row.tags?.type || 'diet'
        })).filter(t => t.slug);
    } catch (err) {
        console.error("[followup-resolver] Error fetching dish tags:", err);
        return [];
    }
}

/**
 * Normalize tag name for comparison
 */
function normalizeTag(tag: string): string {
    return tag.toLowerCase()
        .replace(/[^a-z]/g, '')
        .replace(/veg$/, 'vegetarian')
        .replace(/free$/, '');
}

// Language request patterns for translation
const TRANSLATE_PATTERNS = [
    { pattern: /explain\s+in\s+english/i, lang: "en" },
    { pattern: /in\s+english/i, lang: "en" },
    { pattern: /english\s+please/i, lang: "en" },
    { pattern: /translate\s+to\s+english/i, lang: "en" },
    { pattern: /can\s+you\s+translate/i, lang: "en" },
    { pattern: /på\s+engelska/i, lang: "en" },
    { pattern: /på\s+svenska/i, lang: "sv" },
    { pattern: /in\s+swedish/i, lang: "sv" },
];

/**
 * Check if query is a language/translation request
 */
function isLanguageRequest(query: string): { isTranslation: boolean; targetLanguage: string | null } {
    const lowerQuery = query.toLowerCase();

    for (const { pattern, lang } of TRANSLATE_PATTERNS) {
        if (pattern.test(lowerQuery)) {
            return { isTranslation: true, targetLanguage: lang };
        }
    }

    return { isTranslation: false, targetLanguage: null };
}

/**
 * Main resolver function - call this before planner
 */
export async function resolveFollowupFromLastResults(
    query: string,
    intent: Intent,
    lastResults: LastResultDish[]
): Promise<FollowupResolution> {
    console.log("[followup-resolver] Starting resolution", {
        query,
        lastResultsCount: lastResults.length,
        dishQuery: intent.dish_query
    });

    // PRIORITY 1: Check for translation request BEFORE tag detection
    const { isTranslation, targetLanguage } = isLanguageRequest(query);
    if (isTranslation && targetLanguage) {
        console.log("[followup-resolver] Translation request detected", { targetLanguage });
        return { type: "TRANSLATE_LAST", targetLanguage };
    }

    // PRIORITY 1.5: Check for dish ATTRIBUTE questions (spicy, creamy, sweet)
    // These are NOT tag questions but need grounded answers from description/tags
    const ATTRIBUTE_PATTERNS = [
        { regex: /(?:is it|is this|is the dish|how).*\b(?:spicy|hot|stark|🌶)\b/i, attr: "spiciness", keywords: ["spicy", "hot", "chili", "chilli", "stark", "extra stark", "🌶"] },
        { regex: /(?:is it|is this|is the dish|how).*\b(?:creamy|cream)\b/i, attr: "creaminess", keywords: ["creamy", "cream", "grädde", "smör", "cashew", "korma", "makhani", "malai"] },
        { regex: /(?:is it|is this|is the dish|how).*\b(?:sweet|söt)\b/i, attr: "sweetness", keywords: ["sweet", "söt", "sugar", "honey"] },
        { regex: /spice\s*level/i, attr: "spiciness", keywords: ["spicy", "hot", "chili", "chilli", "stark"] },
    ];

    const attrMatch = ATTRIBUTE_PATTERNS.find(p => p.regex.test(query));
    if (attrMatch && lastResults.length > 0) {
        // Smart dish selection: try to match by name first
        const queryLower = query.toLowerCase();
        let targetDish = lastResults[0]; // fallback to first

        // Check if query mentions a dish name from lastResults
        for (const dish of lastResults) {
            const dishWords = dish.dish_name.toLowerCase().split(/\s+/);
            if (dishWords.some(w => w.length > 3 && queryLower.includes(w))) {
                targetDish = dish;
                break;
            }
        }

        // Check description for hints
        const descLower = (targetDish.description || "").toLowerCase();
        const nameIncludesHint = attrMatch.keywords.some(k => targetDish.dish_name.toLowerCase().includes(k));
        const descIncludesHint = attrMatch.keywords.some(k => descLower.includes(k));
        const hasEvidence = nameIncludesHint || descIncludesHint;

        const evidenceNote = hasEvidence
            ? `Based on the menu, ${targetDish.dish_name} appears to be ${attrMatch.attr === "spiciness" ? "spicy" : attrMatch.attr === "creaminess" ? "creamy" : "sweet"} (${nameIncludesHint ? "name suggests" : "description mentions"}). Please confirm with the restaurant.`
            : `I don't have ${attrMatch.attr} info for ${targetDish.dish_name} in the menu data. Please ask the restaurant directly.`;

        console.log("[followup-resolver] Attribute question detected", { attr: attrMatch.attr, dish: targetDish.dish_name, hasEvidence });

        return {
            type: "RESOLVED",
            matchedDish: targetDish,
            answer: evidenceNote,
            tagFound: hasEvidence
        };
    }

    // PRIORITY 2: Check for per-restaurant "show more from X" / "menu of X"
    for (const pattern of SHOW_MORE_RESTAURANT_PATTERNS) {
        const match = query.match(pattern);
        if (match && match[1]) {
            const restaurantNameQuery = match[1].trim().toLowerCase();
            console.log("[followup-resolver] Show more/menu from restaurant detected", { restaurantNameQuery });

            // Try to find matching restaurant from last results first (for ID)
            let matchedRestaurant: { id: string; name: string } | null = null;

            if (lastResults.length > 0) {
                for (const dish of lastResults) {
                    const name = dish.restaurant_name.toLowerCase();
                    if (name.includes(restaurantNameQuery) || restaurantNameQuery.includes(name)) {
                        matchedRestaurant = { id: dish.restaurant_id, name: dish.restaurant_name };
                        break;
                    }
                }
            }

            // Even if not found in lastResults (e.g. fresh query), return the name so route handler can search DB
            if (matchedRestaurant) {
                console.log("[followup-resolver] Matched restaurant in lastResults", matchedRestaurant);
                return {
                    type: "SHOW_MORE_RESTAURANT",
                    matchedRestaurantId: matchedRestaurant.id,
                    matchedRestaurantName: matchedRestaurant.name
                };
            } else {
                // Return name only - handler will need to lookup ID
                console.log("[followup-resolver] Extracted restaurant name (no ID yet)", restaurantNameQuery);
                return {
                    type: "SHOW_MORE_RESTAURANT",
                    matchedRestaurantName: match[1].trim() // Keep original casing for display/search
                };
            }
        }
    }

    // PRIORITY 3: Check for general pagination request ("show more")
    const isPaginationRequest = PAGINATION_PATTERNS.some(pattern => pattern.test(query));
    if (isPaginationRequest) {
        console.log("[followup-resolver] Pagination request detected");
        return { type: "PAGINATE" };
    }

    // PRIORITY 4: Check if this is a tag question
    const { isTag, tagName } = isTagQuestion(query);
    if (!isTag || !tagName) {
        console.log("[followup-resolver] Not a tag question, passing");
        return { type: "PASS" };
    }

    // Find dish reference
    const { matches, usedPronoun } = findDishReference(query, intent, lastResults);

    console.log("[followup-resolver] Dish reference search", {
        matchCount: matches.length,
        usedPronoun,
        tagName
    });

    // No matches found
    if (matches.length === 0) {
        return { type: "NOT_FOUND" };
    }

    // PLURAL/MENU INTENT CHECK: Don't clarify if user wants a list, not a specific dish
    // 2-part rule: must contain menu noun, OR action word + menu noun
    const queryLowerForPlural = query.toLowerCase();
    const MENU_NOUNS = ["menu", "items", "dishes", "options", "starters", "mains", "desserts", "veg", "vegetarian", "vegan", "halal"];
    const ACTION_WORDS = ["show", "list", "what", "any", "do they have", "are there"];
    const hasMenuNoun = MENU_NOUNS.some(n => queryLowerForPlural.includes(n));
    const hasActionWord = ACTION_WORDS.some(a => queryLowerForPlural.includes(a));
    const isPluralIntent = hasMenuNoun && (hasActionWord || queryLowerForPlural.includes(" they "));

    if (isPluralIntent) {
        console.log("[followup-resolver] Plural/menu intent detected, passing to search", { hasMenuNoun, hasActionWord });
        return { type: "PASS" };
    }

    // Multiple matches - need clarification (only for singular dish questions)
    if (matches.length > 1 && usedPronoun) {
        const topCandidates = matches.slice(0, 3);
        const dishList = topCandidates.map(d => d.dish_name).join(", ");
        return {
            type: "CLARIFY",
            candidates: topCandidates,
            answer: `Which dish are you asking about? ${dishList}?`
        };
    }

    // Single match (or multiple with explicit name) - do DB lookup
    const dish = matches[0];

    // FIX: Dish mismatch guard - if user asked about a specific dish by name,
    // verify the matched dish is similar to what they asked about.
    // Prevents "butter chicken halal?" from answering about Chicken Vindaloo.
    if (intent.dish_query && intent.dish_query.trim().length > 0) {
        const queryDish = intent.dish_query.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const matchedDish = dish.dish_name.toLowerCase().replace(/[^a-z\s]/g, '').trim();

        // Check for strong word overlap
        const queryWords = queryDish.split(/\s+/).filter(w => w.length >= 3);
        const dishWords = matchedDish.split(/\s+/).filter(w => w.length >= 3);

        const overlapCount = queryWords.filter(qw =>
            dishWords.some(dw => dw.includes(qw) || qw.includes(dw))
        ).length;

        // Require at least 1 significant word match, or substring match
        const hasSubstringMatch = matchedDish.includes(queryDish) || queryDish.includes(matchedDish);
        const hasWordOverlap = overlapCount >= 1;

        if (!hasSubstringMatch && !hasWordOverlap) {
            console.log("[followup-resolver] Dish mismatch guard triggered, passing to search", {
                queryDish,
                matchedDish,
                overlapCount
            });
            return { type: "PASS" }; // Let restaurant-mode VERIFY_TAG handle it properly
        }
    }

    const dishContext = `${dish.dish_name} at ${dish.restaurant_name}`;
    // Use intent.language if available, otherwise default to "en"
    const lang = intent?.language || "en";

    // Fetch full tag info from DB
    const dbTags = await getDishTagsFromDB(dish.dish_id);

    console.log("[followup-resolver] Tag check", {
        dish: dish.dish_name,
        tagName,
        dbTags: dbTags.map(tag => tag.slug),
        lang
    });

    // SPECIAL CASE: __allergens__ mode - list all allergen tags
    if (tagName === "__allergens__") {
        const allergens = dbTags.filter(tag => tag.type === 'allergen');
        let answer: string;
        if (allergens.length > 0) {
            const allergenList = allergens.map(tag => tag.name).join(', ');
            answer = `${t(lang, "YES_PREFIX")} ${t(lang, "ALLERGEN_TAGGED_PREFIX", { list: allergenList })} (${dishContext})`;
        } else {
            answer = `${t(lang, "NO_PREFIX")} ${t(lang, "ALLERGEN_NOT_TAGGED", { dish: dishContext })}`;
        }

        return {
            type: "RESOLVED",
            matchedDish: dish,
            answer,
            tagFound: allergens.length > 0
        };
    }

    // SINGLE TAG CHECK: diet/religious/allergen by slug match
    const normalizedTagName = normalizeTag(tagName);
    const matchingTag = dbTags.find(tag =>
        normalizeTag(tag.slug) === normalizedTagName ||
        normalizeTag(tag.name) === normalizedTagName
    );
    const hasTag = !!matchingTag;

    // Build answer using localized strings
    const disclaimer = matchingTag?.type === 'allergen' ? ` ${t(lang, "TAGS_GUIDANCE_DISCLAIMER")}` : '';
    const answer = hasTag
        ? `${t(lang, "YES_PREFIX")} ${dishContext} is tagged "${matchingTag!.name}" in our data.${disclaimer}`
        : `${t(lang, "NO_PREFIX")} ${dishContext} is not tagged "${tagName}" in our data.`;

    return {
        type: "RESOLVED",
        matchedDish: dish,
        answer,
        tagFound: hasTag
    };
}
