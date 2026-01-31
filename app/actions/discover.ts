"use server";

import { createClient } from "@/lib/supabase/server";
import type { RestaurantCard, Intent, DishMatch, MenuPayload, TagInfo } from "@/lib/types/discover";
import { generateEmbedding } from "@/lib/embeddings";
import { hybridSearchDishes, hybridToFlatRows } from "@/lib/discover/hybrid-search";
import { isGenericFoodQuery } from "@/lib/discover/planner";
import OpenAI from "openai";

// Post-filter stopwords: these words should not be required to match in dish names/descriptions
const POSTFILTER_STOPWORDS = new Set([
  "any", "some", "something", "want", "find", "show",
  "option", "options", "choice", "choices",
  "drink", "drinks", "beverage", "beverages",
  "flavor", "flavour", "with", "to", "for", "me",
]);

// Dietary keyword mapping (same as chat.ts for consistency)
const dietaryKeywords: Record<string, string[]> = {
  "gluten free": ["gluten free", "gluten-free", "glutenfritt", "glutenfri"],
  "vegetarian": ["vegetarian", "vegetarisk", "veg", "vego", "veggie", "ve", "VE", "meat-free", "kÃ¶ttfri", "vegeterian", "vegatarian", "vegeratian"], // Common misspellings
  "vegan": ["vegan", "vegansk", "plant-based", "vÃ¤xtbaserad"],
  "halal": ["halal", "helal"],
  "kosher": ["kosher"],
  "jain": ["jain"],
  "satvik": ["satvik", "sattvic"],
  "pescetarian": ["pescetarian"],
  "lactose free": ["lactose free", "lactose-free", "laktosfri", "mjÃ¶lkfri"],
  "nut free": ["nut free", "nut-free", "no nuts", "peanut free", "tree nut free"],
};

/**
 * Check if intent requires strict tag-based filtering (satvik/halal/allergy)
 * These require explicit tags - no inference allowed
 */
function requiresStrictTagFiltering(intent: Intent): boolean {
  const queryText = `${intent.original_query} ${intent.dish_query || ""} ${intent.dietary?.join(" ") || ""} ${intent.allergy?.join(" ") || ""}`.toLowerCase();

  const strictKeywords = [
    "satvik", "sattvic",
    "halal", "helal",
    "allergy", "allergic", "allergen",
    "nut free", "nut-free", "peanut", "tree nut",
    "gluten free", "gluten-free",
  ];

  return strictKeywords.some((keyword) => queryText.includes(keyword));
}

/**
 * Normalize query string: lowercase, remove punctuation/emojis, collapse whitespace
 * Preserves Unicode letters/numbers (including Ã¥Ã¤Ã¶) for multilingual support
 */
function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // removes ?,!,., emojis; keeps Ã¥Ã¤Ã¶
    .replace(/\s+/g, " ")
    .trim();
}

/** 
 * Simple similarity function (handles common spelling variations)
 * Returns true if strings are "close enough"
 */
function isSimilar(str1: string, str2: string): boolean {
  // Normalize both strings
  const a = str1.toLowerCase().replace(/[^a-z]/g, '');
  const b = str2.toLowerCase().replace(/[^a-z]/g, '');

  // Exact match after normalization
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Handle common variations (dal/daal, makhani/makhni, etc.)
  const normalize = (s: string) => s
    .replace(/aa/g, 'a')  // daal -> dal
    .replace(/ee/g, 'i')  // tandooree -> tandoori
    .replace(/oo/g, 'u')  // tandoor -> tandur
    .replace(/ph/g, 'f')  // phirni -> firni
    .replace(/ani$/g, 'ni') // makhani -> makhni
    .replace(/y$/g, 'i');  // curry -> curri

  const normA = normalize(a);
  const normB = normalize(b);
  if (normA === normB) return true;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // Levenshtein distance for short strings (allow 1-2 char difference)
  // At least 70% match for similar words
  if (Math.abs(a.length - b.length) <= 2 && a.length >= 3) {
    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) matches++;
    }
    return matches / Math.max(a.length, b.length) >= 0.7;
  }
  return false;
}

/**
 * Precision Gate: Encapsulated matching logic
 * - Short queries (1 word): Strict length check to prevent "vindaloo" -> "aloo"
 * - Multi-word queries: Require >= 2 token matches
 */
function matchesPrecisionGate(dishName: string, queryWords: string[]): boolean {
  const dishWords = dishName.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

  if (queryWords.length >= 2) {
    let matches = 0;
    for (const qWord of queryWords) {
      if (dishWords.some(dWord => isSimilar(qWord, dWord))) matches++;
    }
    return matches >= 2;
  }

  return queryWords.some(qWord =>
    dishWords.some(dWord => isSimilar(qWord, dWord) && Math.abs(qWord.length - dWord.length) <= 2)
  );
}

// Flat row from semantic or trigram RPC (one row per dish match)
interface FlatSearchRow {
  restaurant_id: string;
  restaurant_name: string;
  restaurant_city: string | null;
  restaurant_address: string | null;
  dish_id: string;
  dish_name: string;
  dish_description: string | null;
  dish_price: number;
  similarity_score: number;
  section_name?: string | null; // Optional - may not be in all RPCs
  tags?: TagInfo[]; // Hydrated tags
}

type RpcResult<T> = { data: T | null; error: unknown };

/**
 * Get public menu data for a restaurant, grouped by sections
 * 
 * @param restaurantId - The restaurant ID
 * @returns Menu payload with sections and items
 */
export async function getPublicMenu(restaurantId: string): Promise<MenuPayload | null> {
  try {
    const supabase = await createClient();

    // Get restaurant info
    type RestaurantRow = { id: string; name: string; city: string | null };
    const { data: restaurant } = (await supabase
      .from("restaurants")
      .select("id, name, city")
      .eq("id", restaurantId)
      .eq("public_searchable", true)
      .single()) as { data: RestaurantRow | null };

    if (!restaurant) {
      console.log("[getPublicMenu] Restaurant not found or not public:", restaurantId);
      return null;
    }

    // Get menus for this restaurant
    const { data: menus } = (await supabase
      .from("menus")
      .select("id")
      .eq("restaurant_id", restaurantId)) as { data: { id: string }[] | null };

    if (!menus || menus.length === 0) {
      console.log("[getPublicMenu] No menus found for restaurant:", restaurantId);
      return {
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        city: restaurant.city,
        sections: [],
      };
    }

    const menuIds = menus.map((m) => m.id);

    // Get sections for all menus, ordered by display_order
    // Note: sections table has RLS disabled, so this should work
    const { data: sections, error: sectionsError } = (await supabase
      .from("sections")
      .select("id, name, display_order, menu_id")
      .in("menu_id", menuIds)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true })) as {
        data: { id: string; name: string; display_order: number; menu_id: string }[] | null;
        error: unknown;
      };

    if (sectionsError) {
      console.error("[getPublicMenu] Error fetching sections:", sectionsError);
      // Continue without sections - dishes will go into "Other" section
    }

    // Get all public dishes for these menus
    const { data: dishes } = (await supabase
      .from("dishes")
      .select("id, name, description, price, section_id, menu_id")
      .in("menu_id", menuIds)
      .eq("public", true)
      .order("created_at", { ascending: true })) as {
        data: {
          id: string;
          name: string;
          description: string | null;
          price: number;
          section_id: string | null;
          menu_id: string;
        }[] | null;
      };

    // Fetch tags for all dishes - include slug and type for UI categorization
    const dishIds = dishes?.map((d) => d.id) || [];
    type TagInfo = { id: string; name: string; slug: string; type: 'diet' | 'allergen' | 'religious' };
    let dishTagsMap = new Map<string, TagInfo[]>();

    if (dishIds.length > 0) {
      // Fetch dish_tags with tags joined - include slug and type
      const { data: dishTagsData } = (await supabase
        .from("dish_tags")
        .select("dish_id, tag_id, tags(id, name, slug, type)")
        .in("dish_id", dishIds)) as {
          data: { dish_id: string; tag_id: string; tags: { id: string; name: string; slug: string; type: string } | null }[] | null;
        };

      if (dishTagsData) {
        for (const dt of dishTagsData) {
          if (dt.tags) {
            if (!dishTagsMap.has(dt.dish_id)) {
              dishTagsMap.set(dt.dish_id, []);
            }
            dishTagsMap.get(dt.dish_id)!.push({
              id: dt.tags.id,
              name: dt.tags.name,
              slug: dt.tags.slug || '',
              type: (dt.tags.type as 'diet' | 'allergen' | 'religious') || 'diet',
            });
          }
        }
      }
    }

    if (!dishes) {
      return {
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        city: restaurant.city,
        sections: [],
      };
    }

    // Group dishes by section
    const sectionsMap = new Map<string, { name: string; items: any[] }>();

    // First, add all sections (even if empty)
    if (sections && sections.length > 0) {
      for (const section of sections) {
        sectionsMap.set(section.id, {
          name: section.name,
          items: [],
        });
      }
    }

    // Group dishes by section_id
    for (const dish of dishes) {
      const dishTags = dishTagsMap.get(dish.id) || [];
      const dishItem = {
        id: dish.id,
        name: dish.name,
        description: dish.description,
        price: dish.price,
        tags: dishTags.length > 0 ? dishTags : undefined,
      };

      if (dish.section_id && sectionsMap.has(dish.section_id)) {
        sectionsMap.get(dish.section_id)!.items.push(dishItem);
      } else {
        // Dishes without section_id go into an "Other" section
        if (!sectionsMap.has("__no_section__")) {
          sectionsMap.set("__no_section__", {
            name: "Other",
            items: [],
          });
        }
        sectionsMap.get("__no_section__")!.items.push(dishItem);
      }
    }

    // Convert to array format, filter out empty sections
    let sectionsArray = Array.from(sectionsMap.entries())
      .map(([id, section]) => ({
        name: section.name,
        items: section.items,
      }))
      .filter((section) => section.items.length > 0);

    // Ensure getPublicMenu always returns sections; if none, create a single "Menu" section
    if (sectionsArray.length === 0 && dishes.length > 0) {
      // Create a single "Menu" section with all dishes
      sectionsArray = [{
        name: "Menu",
        items: dishes.map((dish) => {
          const dishTags = dishTagsMap.get(dish.id) || [];
          return {
            id: dish.id,
            name: dish.name,
            description: dish.description,
            price: dish.price,
            tags: dishTags.length > 0 ? dishTags : undefined,
          };
        }),
      }];
    }

    // Deterministic sorting: sort sections by name, items by name
    sectionsArray = sectionsArray
      .map((section) => ({
        ...section,
        items: [...section.items].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      city: restaurant.city,
      sections: sectionsArray,
    };
  } catch (error) {
    console.error("[getPublicMenu] Error:", error);
    return null;
  }
}

/**
 * Search restaurants and dishes across all public restaurants
 * Returns formatted restaurant cards for discovery mode
 *
 * @param intent - Parsed user intent (dish_query, city, dietary, etc.)
 * @returns Array of restaurant cards (max 5)
 */
export async function searchRestaurantsAndDishes(
  intent: Intent,
  opts?: { openai?: OpenAI }
): Promise<RestaurantCard[]> {
  // 1. Normalize and extract query
  let cleanedQuery = intent.dish_query ? normalizeQuery(intent.dish_query) : null;

  // If dish_query empty but ingredients exist, build a query from them
  if (!cleanedQuery && intent.ingredients?.length) {
    cleanedQuery = normalizeQuery(intent.ingredients.join(" "));
  }

  // 2. Extract city (with safety net for "in Gothenburg" pattern)
  let targetCity = intent.city;

  // Safety net: if parser didn't extract city, try to pull it from query
  if (!targetCity && cleanedQuery) {
    const cityMatch = cleanedQuery.match(/\b(?:in|i)\s+([a-zÃ¥Ã¤Ã¶\-]+)$/i);
    if (cityMatch?.[1]) {
      targetCity = cityMatch[1];
      // remove from query
      cleanedQuery = cleanedQuery.replace(cityMatch[0], "").trim();
    }
  }

  console.log("[searchRestaurantsAndDishes] Called with intent:", {
    dish_query: cleanedQuery,
    city: targetCity,
    dietary: intent.dietary,
    ingredients: intent.ingredients,
    is_vague: intent.is_vague,
  });

  try {
    console.log("[searchRestaurantsAndDishes] Creating Supabase client...");
    const supabase = await createClient();
    console.log("[searchRestaurantsAndDishes] Supabase client created successfully");

    // Initialize OpenAI client (used for hybrid search translation)
    const openai = opts?.openai || new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "",
    });

    // 4. Find dietary tag IDs from intent.dietary and intent.hard_tags
    // Also build list of matched dietary keywords to remove from search query
    const requiredTagIds: string[] = [];
    const matchedDietaryKeywords: string[] = [];
    const hasHardTags = intent.hard_tags && intent.hard_tags.length > 0;

    // Helper to add keywords + corresponding tag IDs (deduped)
    const addDietaryKeywordsAndTags = async (variants: string[]) => {
      const hasNewKeyword = variants.some((variant) => !matchedDietaryKeywords.includes(variant));
      if (!hasNewKeyword) return;

      // Add keywords (dedupe)
      for (const variant of variants) {
        if (!matchedDietaryKeywords.includes(variant)) {
          matchedDietaryKeywords.push(variant);
        }
      }

      // Fetch tag IDs (dedupe)
      const orClauses = variants.map((v) => `name.ilike.%${v}%`).join(",");
      type TagRow = { id: string; name?: string };
      const { data: matchingTags } = (await supabase
        .from("tags")
        .select("id, name")
        .or(orClauses)) as { data: TagRow[] | null };


      if (matchingTags) {
        for (const tag of matchingTags) {
          if (!requiredTagIds.includes(tag.id)) {
            requiredTagIds.push(tag.id);
          }
        }
      }
    };

    // First, process hard_tags if they exist (these require strict tag filtering)
    if (hasHardTags && intent.hard_tags) {
      for (const hardTag of intent.hard_tags) {
        const tagName = hardTag.toLowerCase();
        // Map hard tag names to tag database names
        const tagMappings: Record<string, string[]> = {
          "satvik": ["satvik", "sattvic"],
          "halal": ["halal", "helal"],
          "gluten-free": ["gluten free", "gluten-free", "glutenfritt", "glutenfri"],
          "nut-free": ["nut free", "nut-free", "peanut free", "tree nut free"],
          "lactose-free": ["lactose free", "lactose-free", "dairy free", "dairy-free", "laktosfri", "mjÃ¶lkfri"],
        };

        const variants = tagMappings[tagName] || [tagName];
        await addDietaryKeywordsAndTags(variants);
      }
    }

    // Also process regular dietary requirements
    if (intent.dietary && intent.dietary.length > 0) {
      for (const dietaryReq of intent.dietary) {
        const queryLower = dietaryReq.toLowerCase();
        for (const [, variants] of Object.entries(dietaryKeywords)) {
          if (variants.some((kw) => queryLower.includes(kw))) {
            await addDietaryKeywordsAndTags(variants);
            break;
          }
        }
      }
    }

    // Bonus: detect dietary keywords directly in the query (e.g., "veg pizza") even if parser missed them
    const queryToScan = cleanedQuery || intent.original_query;
    if (queryToScan) {
      const queryLower = queryToScan.toLowerCase();
      for (const [, variants] of Object.entries(dietaryKeywords)) {
        if (variants.some((kw) => queryLower.includes(kw))) {
          await addDietaryKeywordsAndTags(variants);
        }
      }
    }

    // 4.5. Build keywordQuery by removing dietary keywords and filler words
    let keywordQuery = cleanedQuery || "";

    // Remove matched dietary keywords
    if (keywordQuery && matchedDietaryKeywords.length > 0) {
      for (const keyword of matchedDietaryKeywords) {
        // Remove keyword as whole word (case-insensitive)
        const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        keywordQuery = keywordQuery.replace(regex, " ");
      }
    }

    // Remove filler words
    const fillerWords = ["any", "some", "something", "pls", "please", "want", "looking", "find", "show", "me", "do", "they", "have"];
    for (const filler of fillerWords) {
      const regex = new RegExp(`\\b${filler}\\b`, "gi");
      keywordQuery = keywordQuery.replace(regex, " ");
    }

    // Clean up: collapse multiple spaces and trim
    keywordQuery = keywordQuery.replace(/\s+/g, " ").trim();

    // IMPORTANT: dishSearchText is the user query minus dietary words and filler words
    // If dishSearchText is empty, user asked only dietary (e.g., "vegan food")
    const dishSearchText = keywordQuery.length > 0 ? keywordQuery : null;
    const finalSearchQuery = dishSearchText;

    console.log("[searchRestaurantsAndDishes] Query processing:", {
      originalQuery: intent.original_query,
      cleanedQuery: cleanedQuery,
      keywordQuery: keywordQuery,
      dishSearchText: dishSearchText,
      dietaryTagIds: requiredTagIds,
      matchedDietaryKeywords: matchedDietaryKeywords,
    });

    // 5. Prepare service_filters (future-proof: null if empty object)
    const serviceFilters = null; // Currently always null, but ready for future use
    const service_filters =
      serviceFilters && Object.keys(serviceFilters).length > 0 ? serviceFilters : null;

    // 6. Centralize RPC base parameters
    const rpcBase = {
      target_city: targetCity || null,
      dietary_tag_ids: requiredTagIds.length > 0 ? requiredTagIds : null,
      service_filters,
      limit_count: 50,
    };

    console.log("[searchRestaurantsAndDishes] Starting hybrid search:", {
      dish_query: cleanedQuery,
      targetCity: rpcBase.target_city,
      dietaryTagIds: requiredTagIds,
    });

    let flatRows: FlatSearchRow[] = [];

    // ROUTING LOGIC:
    // - If dishSearchText is non-empty: call search_public_dishes_fuzzy with search_text AND dietary_tag_ids filter
    // - Only call search_public_dishes_by_tags when dishSearchText is empty (tag-only search)

    let rpcUsed: string | null = null;

    // Step 0: Tag-only search ONLY when dishSearchText is empty
    if (!dishSearchText && requiredTagIds.length > 0) {
      rpcUsed = "search_public_dishes_by_tags";
      console.log(
        "[searchRestaurantsAndDishes] dishSearchText is empty; running tag-only RPC search_public_dishes_by_tags..."
      );

      const { data: tagOnlyData, error: tagOnlyError } =
        ((await supabase.rpc("search_public_dishes_by_tags", {
          ...rpcBase,
          dietary_tag_ids: requiredTagIds, // guaranteed non-empty here
        })) as RpcResult<FlatSearchRow[]>);

      if (tagOnlyError) {
        console.error(
          "[searchRestaurantsAndDishes] Tag-only RPC error:",
          JSON.stringify(tagOnlyError, null, 2)
        );
      } else if (tagOnlyData && tagOnlyData.length > 0) {
        flatRows = tagOnlyData;
        console.log(
          `[searchRestaurantsAndDishes] Tag-only search returned ${tagOnlyData.length} results`
        );
      }
    }

    // Step 1: If tags exist AND dishSearchText exists, use fuzzy search WITH tag filter
    // This ensures "veg pizza" returns ONLY vegetarian pizzas, not all pizzas
    if (requiredTagIds.length > 0 && dishSearchText && dishSearchText.trim().length > 0) {
      rpcUsed = "search_public_dishes_fuzzy (with tag filter)";
      console.log(
        "[searchRestaurantsAndDishes] Tags + dish query; using fuzzy search with tag filter:",
        {
          search_text: dishSearchText,
          dietary_tag_ids: requiredTagIds,
          target_city: rpcBase.target_city,
        }
      );

      const { data: fuzzyData, error: fuzzyError } =
        ((await supabase.rpc("search_public_dishes_fuzzy", {
          ...rpcBase,
          search_text: dishSearchText,
        })) as RpcResult<FlatSearchRow[]>);

      if (fuzzyError) {
        console.error("[searchRestaurantsAndDishes] Fuzzy RPC error (with tags):", JSON.stringify(fuzzyError, null, 2));
      } else if (fuzzyData && fuzzyData.length > 0) {
        flatRows = fuzzyData;
        console.log(`[searchRestaurantsAndDishes] Fuzzy search (with tag filter) returned ${fuzzyData.length} results`);
      } else {
        console.log(`[searchRestaurantsAndDishes] Fuzzy search (with tag filter) returned 0 results`);
      }
    } else if (dishSearchText && dishSearchText.trim().length > 0) {
      // No tags required - use hybrid or legacy search based on feature flag

      // ============================================
      // HYBRID SEARCH (Phase 1) - Feature Flagged
      // ============================================
      if (process.env.DISCOVERY_HYBRID_SEARCH === '1') {
        console.log("[searchRestaurantsAndDishes] Using HYBRID search (parallel semantic + trigram)");
        rpcUsed = "hybrid_search";

        try {
          const hybridCandidates = await hybridSearchDishes({
            query: dishSearchText,
            city: rpcBase.target_city,
            dietaryTagIds: rpcBase.dietary_tag_ids || undefined,
            supabase,
            openai,
          });

          // Convert to FlatSearchRow format for downstream compatibility
          flatRows = hybridToFlatRows(hybridCandidates);
          console.log(`[searchRestaurantsAndDishes] Hybrid search returned ${flatRows.length} results`);
        } catch (hybridError) {
          console.error("[searchRestaurantsAndDishes] Hybrid search failed, falling back to legacy:", hybridError);
          // Fall through to legacy search below
        }
      }

      // ============================================
      // LEGACY SEARCH (sequential fallback)
      // ============================================
      if (flatRows.length === 0) {
        // Try semantic search first (primary search)
        try {
          const queryEmbedding = await generateEmbedding(dishSearchText);
          rpcUsed = "search_public_dishes_semantic";
          console.log(
            "[searchRestaurantsAndDishes] dishSearchText is non-empty; trying semantic search first:",
            {
              search_text: dishSearchText,
              dietary_tag_ids: rpcBase.dietary_tag_ids,
              target_city: rpcBase.target_city,
            }
          );

          const { data: semanticData, error: semanticError } =
            ((await supabase.rpc("search_public_dishes_semantic", {
              ...rpcBase,
              query_embedding: queryEmbedding,
            })) as RpcResult<FlatSearchRow[]>);

          if (semanticError) {
            console.warn("[searchRestaurantsAndDishes] Semantic RPC error:", JSON.stringify(semanticError, null, 2));
          } else if (semanticData && semanticData.length > 0) {
            flatRows = semanticData;
            console.log(`[searchRestaurantsAndDishes] Semantic search returned ${semanticData.length} results`);

            // If semantic results < 3, try trigram fallback for typo tolerance
            if (semanticData.length < 3) {
              console.log("[searchRestaurantsAndDishes] Semantic results < 3, trying trigram fallback...");
              const { data: fuzzyData, error: fuzzyError } =
                ((await supabase.rpc("search_public_dishes_fuzzy", {
                  ...rpcBase,
                  search_text: dishSearchText,
                })) as RpcResult<FlatSearchRow[]>);

              if (!fuzzyError && fuzzyData && fuzzyData.length > 0) {
                // Merge results, deduplicate by dish_id (keep semantic results first)
                const existingDishIds = new Set(flatRows.map(r => r.dish_id));
                const newFuzzyRows = fuzzyData.filter(r => !existingDishIds.has(r.dish_id));
                flatRows = [...flatRows, ...newFuzzyRows];
                rpcUsed = "search_public_dishes_semantic + search_public_dishes_fuzzy (fallback)";
                console.log(`[searchRestaurantsAndDishes] Trigram fallback added ${newFuzzyRows.length} additional results (total: ${flatRows.length})`);
              }
            }
          } else {
            // Semantic returned 0 results, try trigram fallback
            console.log("[searchRestaurantsAndDishes] Semantic search returned 0 results, trying trigram fallback...");
            const { data: fuzzyData, error: fuzzyError } =
              ((await supabase.rpc("search_public_dishes_fuzzy", {
                ...rpcBase,
                search_text: dishSearchText,
              })) as RpcResult<FlatSearchRow[]>);

            if (fuzzyError) {
              console.error("[searchRestaurantsAndDishes] Fuzzy RPC error:", JSON.stringify(fuzzyError, null, 2));
            } else if (fuzzyData && fuzzyData.length > 0) {
              flatRows = fuzzyData;
              rpcUsed = "search_public_dishes_fuzzy (semantic returned 0)";
              console.log(`[searchRestaurantsAndDishes] Trigram fallback returned ${fuzzyData.length} results`);
            } else {
            }
          }
        } catch (embeddingError) {
          // Embedding generation failed, fall back to trigram
          console.warn("[searchRestaurantsAndDishes] Embedding generation failed, using trigram search:", embeddingError);
          rpcUsed = "search_public_dishes_fuzzy (embedding failed)";

          const { data: fuzzyData, error: fuzzyError } =
            ((await supabase.rpc("search_public_dishes_fuzzy", {
              ...rpcBase,
              search_text: dishSearchText,
            })) as RpcResult<FlatSearchRow[]>);

          if (fuzzyError) {
            console.error("[searchRestaurantsAndDishes] Fuzzy RPC error:", JSON.stringify(fuzzyError, null, 2));
          } else if (fuzzyData && fuzzyData.length > 0) {
            flatRows = fuzzyData;
            console.log(`[searchRestaurantsAndDishes] Trigram search returned ${fuzzyData.length} results`);
          }
        }
      }
    }

    // Debug logs
    console.log("[searchRestaurantsAndDishes] Debug logs:", {
      originalQuery: intent.original_query,
      dishSearchText: dishSearchText,
      dietaryTagIds: requiredTagIds,
      rpcUsed: rpcUsed,
    });


    // 6.5. Batch-fetch section_name for all dishes (needed for post-filter)
    if (flatRows.length > 0) {
      const dishIds = flatRows.map(row => row.dish_id);
      type DishWithSection = { id: string; sections: { name: string } | null };
      const { data: dishesWithSections } = (await supabase
        .from("dishes")
        .select("id, sections(name)")
        .in("id", dishIds)) as { data: DishWithSection[] | null };

      // Create a map of dish_id -> section_name
      const sectionNameMap = new Map<string, string | null>();
      if (dishesWithSections) {
        for (const dish of dishesWithSections) {
          sectionNameMap.set(dish.id, dish.sections?.name || null);
        }
      }

      // Populate section_name in flatRows
      for (const row of flatRows) {
        row.section_name = sectionNameMap.get(row.dish_id) || null;
      }

      console.log(`[searchRestaurantsAndDishes] Batch-fetched section_name for ${sectionNameMap.size} dishes`);
    }

    // 7. Post-filter (stopword-aware): only apply if meaningful tokens remain
    if (dishSearchText && dishSearchText.trim().length > 0 && flatRows.length > 0) {
      const rawTokens = dishSearchText.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      const searchTokens = rawTokens.filter(t => !POSTFILTER_STOPWORDS.has(t));

      if (searchTokens.length > 0) {
        const originalCount = flatRows.length;
        const filteredOutDishes: string[] = [];

        flatRows = flatRows.filter((row) => {
          const dishName = (row.dish_name || "").toLowerCase();
          const dishDescription = (row.dish_description || "").toLowerCase();
          const sectionName = (row.section_name || "").toLowerCase();

          // ALL meaningful tokens must appear in name, description, or section_name
          const allTokensMatch = searchTokens.every((token) =>
            dishName.includes(token) ||
            dishDescription.includes(token) ||
            sectionName.includes(token)
          );

          if (!allTokensMatch) {
            filteredOutDishes.push(row.dish_name);
          }

          return allTokensMatch;
        });

        if (flatRows.length < originalCount) {
          console.log(
            `[searchRestaurantsAndDishes] Post-filter: ${originalCount} â†’ ${flatRows.length} results (removed ${originalCount - flatRows.length} dishes that didn't match ALL tokens)`
          );
          console.log(
            `[searchRestaurantsAndDishes] Required tokens: ${searchTokens.join(", ")}`
          );
          if (filteredOutDishes.length > 0) {
            console.log(
              `[searchRestaurantsAndDishes] Example filtered dishes: ${filteredOutDishes.slice(0, 5).join(", ")}`
            );
          }
        } else {
          console.log(`[Post-filter] Kept ${flatRows.length}/${originalCount} using tokens:`, searchTokens);
        }
      } else {
        console.log("[Post-filter] Skipped: only stopwords in query:", rawTokens);
      }
    }

    if (flatRows.length === 0) {
      console.log("[searchRestaurantsAndDishes] No results found after filtering");
      return [];
    }

    console.log(
      `[searchRestaurantsAndDishes] Found ${flatRows.length} dish matches across ${new Set(flatRows.map((r) => r.restaurant_id)).size} unique restaurants`
    );

    // Batch fetch TAGS for all found dishes (needed for UI chips)
    if (flatRows.length > 0) {
      const dishIds = flatRows.map(r => r.dish_id);

      const { data: tagData } = await supabase
        .from("dish_tags")
        .select("dish_id, tags!inner(id, name, slug, type)")
        .in("dish_id", dishIds) as { data: Array<{ dish_id: string; tags: TagInfo }> | null };

      if (tagData && tagData.length > 0) {
        const tagsByDishId = new Map<string, TagInfo[]>();
        for (const row of tagData) {
          if (!tagsByDishId.has(row.dish_id)) {
            tagsByDishId.set(row.dish_id, []);
          }
          tagsByDishId.get(row.dish_id)!.push(row.tags);
        }

        // Apply tags to flatRows
        for (const row of flatRows) {
          row.tags = tagsByDishId.get(row.dish_id);
        }
        console.log(`[searchRestaurantsAndDishes] Hydrated tags for ${tagsByDishId.size} dishes`);
      }
    }

    // 8. Group dishes by restaurant
    const restaurantMap = new Map<string, FlatSearchRow[]>();
    for (const row of flatRows) {
      if (!restaurantMap.has(row.restaurant_id)) {
        restaurantMap.set(row.restaurant_id, []);
      }
      restaurantMap.get(row.restaurant_id)!.push(row);
    }

    // 9. Get additional restaurant details (not in RPC output)
    const restaurantIds = Array.from(restaurantMap.keys());
    type RestaurantDetailsRow = {
      id: string;
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
        child_friendly?: boolean;
        wheelchair_accessible?: boolean;
        outdoor_seating?: boolean;
        parking?: boolean;
        wifi?: boolean;
      } | null;
    };
    const { data: restaurantData } = (await supabase
      .from("restaurants")
      .select("id, cuisine_type, phone, email, website, opening_hours, accepts_dine_in, accepts_takeaway, accepts_delivery, accepts_reservations, amenities")
      .in("id", restaurantIds)) as { data: RestaurantDetailsRow[] | null };

    const restaurantDetailsMap = new Map<string, RestaurantDetailsRow>();
    if (restaurantData) {
      for (const r of restaurantData) {
        restaurantDetailsMap.set(r.id, r);
      }
    }

    // 9. Map to RestaurantCard format
    const restaurantCards: RestaurantCard[] = Array.from(restaurantMap.entries())
      .map(([restaurantId, rows]) => {
        const sortedDishes = [...rows].sort((a, b) => b.similarity_score - a.similarity_score);
        const bestDish = sortedDishes[0];
        const details = restaurantDetailsMap.get(restaurantId);

        return {
          id: restaurantId,
          name: bestDish.restaurant_name,
          city: bestDish.restaurant_city,
          cuisine_type: details?.cuisine_type || null,
          highlight: bestDish.dish_name || null,
          matches: sortedDishes.slice(0, 3).map((d) => ({
            id: d.dish_id,
            name: d.dish_name,
            description: d.dish_description,
            price: d.dish_price,
            section_name: d.section_name || null,
            tags: d.tags || [],
          })),
          address: bestDish.restaurant_address,
          distance_km: null,
          // Restaurant details
          phone: details?.phone || null,
          email: details?.email || null,
          website: details?.website || null,
          opening_hours: details?.opening_hours || null,
          accepts_dine_in: details?.accepts_dine_in ?? undefined,
          accepts_takeaway: details?.accepts_takeaway ?? undefined,
          accepts_delivery: details?.accepts_delivery ?? undefined,
          accepts_reservations: details?.accepts_reservations ?? undefined,
          amenities: details?.amenities || null,
        };
      })
      .slice(0, 5); // Limit to top 5 restaurants

    console.log("[searchRestaurantsAndDishes] ===== RETURNING RESULTS =====");
    console.log("[searchRestaurantsAndDishes] Returning restaurant cards:", {
      count: restaurantCards.length,
      isArray: Array.isArray(restaurantCards),
      restaurantIds: restaurantCards.map((r) => r.id),
      firstCard: restaurantCards.length > 0 ? {
        id: restaurantCards[0].id,
        name: restaurantCards[0].name,
        city: restaurantCards[0].city,
      } : null,
      allCards: restaurantCards,
    });
    return restaurantCards;
  } catch (error) {
    console.error("[searchRestaurantsAndDishes] Error caught:", {
      error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return [];
  }
}

/**
 * Search dishes within a specific restaurant's menu
 * Returns matched dishes scoped to the restaurant
 * 
 * @param restaurantId - The restaurant ID to search within
 * @param intent - Parsed user intent (dish_query, dietary, etc.)
 * @returns Restaurant info and array of matched dishes
 */
export async function searchMenuInRestaurant(
  restaurantId: string,
  intent: Intent
): Promise<{
  restaurant: { id: string; name: string; city: string | null };
  dishes: DishMatch[];
  requiresStrictTags?: boolean;
  bestMatchDish?: { id: string; name: string; description?: string | null; price?: number | null } | null;
}> {
  let cleanedQuery = intent.dish_query ? normalizeQuery(intent.dish_query) : null;

  // If dish_query empty but ingredients exist, build a query from them
  if (!cleanedQuery && intent.ingredients?.length) {
    cleanedQuery = normalizeQuery(intent.ingredients.join(" "));
  }

  try {
    const supabase = await createClient();

    // First, get restaurant info
    type RestaurantRow = { id: string; name: string; city: string | null };
    const { data: restaurantData } = (await supabase
      .from("restaurants")
      .select("id, name, city")
      .eq("id", restaurantId)
      .eq("public_searchable", true)
      .single()) as { data: RestaurantRow | null };

    if (!restaurantData) {
      console.log("[searchMenuInRestaurant] Restaurant not found or not public:", restaurantId);
      return {
        restaurant: { id: restaurantId, name: "Unknown", city: null },
        dishes: [],
      };
    }

    // Check if strict tag filtering is required (satvik/halal/allergy)
    const isStrictTagRequired = requiresStrictTagFiltering(intent);

    // Find dietary tag IDs if needed
    const requiredTagIds: string[] = [];
    const queryText = `${intent.original_query} ${intent.dish_query || ""} ${intent.dietary?.join(" ") || ""} ${intent.allergy?.join(" ") || ""}`.toLowerCase();

    // Check for allergy keywords
    const allergyKeywords = ["peanut", "tree nut", "nut free", "nut-free", "gluten", "dairy", "milk", "egg", "fish", "shellfish", "soy", "sesame"];
    const hasAllergyKeywords = allergyKeywords.some((kw) => queryText.includes(kw));

    if (intent.dietary && intent.dietary.length > 0) {
      for (const dietaryReq of intent.dietary) {
        const queryLower = dietaryReq.toLowerCase();

        // FIX: First try direct key match (e.g., "vegan" → "vegan" entry only)
        // This prevents "vegan" from matching "vegetarian" via the "veg" variant
        let matched = false;
        for (const [key, variants] of Object.entries(dietaryKeywords)) {
          // Direct key match takes priority
          const isDirectMatch = key === queryLower || variants.includes(queryLower);

          if (isDirectMatch) {
            const orClauses = variants.map((v) => `name.ilike.%${v}%`).join(",");
            type TagRow = { id: string };
            const { data: matchingTags } = (await supabase
              .from("tags")
              .select("id")
              .or(orClauses)) as { data: TagRow[] | null };

            if (matchingTags && matchingTags.length > 0) {
              requiredTagIds.push(...matchingTags.map((t) => t.id));
            }
            matched = true;
            break;
          }
        }

        // Fallback: only if no direct match, try substring (avoid false positives)
        if (!matched) {
          for (const [, variants] of Object.entries(dietaryKeywords)) {
            // Use word-boundary-like matching to avoid "vegan" matching "veg"
            if (variants.some((kw) => kw === queryLower || queryLower === kw)) {
              const orClauses = variants.map((v) => `name.ilike.%${v}%`).join(",");
              type TagRow = { id: string };
              const { data: matchingTags } = (await supabase
                .from("tags")
                .select("id")
                .or(orClauses)) as { data: TagRow[] | null };

              if (matchingTags && matchingTags.length > 0) {
                requiredTagIds.push(...matchingTags.map((t) => t.id));
              }
              break;
            }
          }
        }
      }
    }

    // Also check allergy array
    if (intent.allergy && intent.allergy.length > 0) {
      for (const allergyReq of intent.allergy) {
        const queryLower = allergyReq.toLowerCase();
        for (const keyword of allergyKeywords) {
          if (queryLower.includes(keyword)) {
            const orClauses = allergyKeywords.map((kw) => `name.ilike.%${kw}%`).join(",");
            type TagRow = { id: string };
            const { data: matchingTags } = (await supabase
              .from("tags")
              .select("id")
              .or(orClauses)) as { data: TagRow[] | null };

            if (matchingTags && matchingTags.length > 0) {
              requiredTagIds.push(...matchingTags.map((t) => t.id));
            }
            break;
          }
        }
      }
    }

    // For strict tag requirements, we MUST have tag IDs
    if (isStrictTagRequired && requiredTagIds.length === 0) {
      console.log("[searchMenuInRestaurant] Strict tag required but no matching tags found");
      // Still proceed, but we'll check for tagged matches later
    }

    const serviceFilters = null;
    let dishes: DishMatch[] = [];

    // Check if hard tags exist (require strict tag-only search)
    const hasHardTags = intent.hard_tags && intent.hard_tags.length > 0;

    // NEW STRATEGY: If hard tags exist, search by tag THEN filter by dish_query if present
    if (hasHardTags && requiredTagIds.length > 0) {
      // Tag search within restaurant
      const { data: tagData, error: tagError } = ((await supabase.rpc(
        "search_public_dishes_by_tags",
        {
          target_city: null,
          dietary_tag_ids: requiredTagIds,
          service_filters: serviceFilters,
          limit_count: 50,
        }
      )) as RpcResult<FlatSearchRow[]>);

      if (tagError) {
        console.error("[searchMenuInRestaurant] Tag-only RPC error:", tagError);
      } else if (tagData && tagData.length > 0) {
        // Filter by restaurant_id
        let restaurantDishes = tagData
          .filter((row) => row.restaurant_id === restaurantId)
          .map((row) => ({
            id: row.dish_id,
            name: row.dish_name,
            description: row.dish_description,
            price: row.dish_price,
          }));

        // A) NEW: If dish_query exists, further filter by name match with FUZZY matching
        if (cleanedQuery && cleanedQuery.trim().length > 0) {
          const queryLower = cleanedQuery.toLowerCase();
          const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);

          const filteredByQuery = restaurantDishes.filter(d => matchesPrecisionGate(d.name, queryWords));

          console.log("[searchMenuInRestaurant] Tag+Query filter:", {
            taggedCount: restaurantDishes.length,
            queryFilteredCount: filteredByQuery.length,
            query: cleanedQuery
          });

          // FIX: If query was provided but no matches found, return empty (don't show all tagged dishes)
          if (filteredByQuery.length > 0) {
            restaurantDishes = filteredByQuery;
          } else {
            restaurantDishes = [];
          }
        }

        dishes = restaurantDishes;
        console.log("[searchMenuInRestaurant] Tag-only search found", dishes.length, "dishes");
      } else {
        // No tagged matches - return empty (will trigger "not tagged" response)
        console.log("[searchMenuInRestaurant] Hard tags required but no tagged dishes found");
        return {
          restaurant: restaurantData,
          dishes: [],
          requiresStrictTags: true,
        };
      }
    } else if (cleanedQuery && cleanedQuery.trim().length > 0) {
      // Strategy: Try semantic â†’ fuzzy â†’ direct ILIKE, all filtered by restaurant_id
      // Try semantic search first
      try {
        const queryEmbedding = await generateEmbedding(cleanedQuery);
        const { data: semanticData, error: semanticError } = ((await supabase.rpc(
          "search_public_dishes_semantic",
          {
            query_embedding: queryEmbedding,
            target_city: null,
            dietary_tag_ids: requiredTagIds.length > 0 ? requiredTagIds : null,
            service_filters: serviceFilters,
            limit_count: 50,
          }
        )) as RpcResult<FlatSearchRow[]>);

        if (!semanticError && semanticData && semanticData.length > 0) {
          // Filter by restaurant_id
          const restaurantDishes = semanticData
            .filter((row) => row.restaurant_id === restaurantId)
            .map((row) => ({
              id: row.dish_id,
              name: row.dish_name,
              description: row.dish_description,
              price: row.dish_price,
              section_name: row.section_name || null,
            }));

          if (restaurantDishes.length > 0) {
            // Apply Precision Gate to RPC results
            const queryWords = cleanedQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
            const verifiedDishes = restaurantDishes.filter(d => matchesPrecisionGate(d.name, queryWords));

            if (verifiedDishes.length > 0) {
              dishes = verifiedDishes;
              console.log("[searchMenuInRestaurant] Semantic search found", dishes.length, "dishes (verified)");
            }
          }
        }
      } catch (embeddingError) {
        console.log("[searchMenuInRestaurant] Semantic search failed, trying fuzzy...");
      }

      // Fallback to fuzzy trigram search
      if (dishes.length === 0) {
        try {
          const { data: fuzzyData, error: fuzzyError } = ((await supabase.rpc(
            "search_public_dishes_fuzzy",
            {
              search_text: cleanedQuery,
              target_city: null,
              dietary_tag_ids: requiredTagIds.length > 0 ? requiredTagIds : null,
              service_filters: serviceFilters,
              limit_count: 50,
            }
          )) as RpcResult<FlatSearchRow[]>);

          if (!fuzzyError && fuzzyData && fuzzyData.length > 0) {
            // Filter by restaurant_id
            const restaurantDishes = fuzzyData
              .filter((row) => row.restaurant_id === restaurantId)
              .map((row) => ({
                id: row.dish_id,
                name: row.dish_name,
                description: row.dish_description,
                price: row.dish_price,
                section_name: row.section_name || null,
              }));

            if (restaurantDishes.length > 0) {
              // Apply Precision Gate to RPC results
              const queryWords = cleanedQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
              const verifiedDishes = restaurantDishes.filter(d => matchesPrecisionGate(d.name, queryWords));

              if (verifiedDishes.length > 0) {
                dishes = verifiedDishes;
                console.log("[searchMenuInRestaurant] Fuzzy search found", dishes.length, "dishes (verified)");
              }
            }
          }
        } catch (fuzzyError) {
          console.log("[searchMenuInRestaurant] Fuzzy search failed, trying direct query...");
        }
      }

      // Final fallback: Direct ILIKE query on dishes table
      if (dishes.length === 0) {
        // Get menu IDs for this restaurant
        const { data: menus } = (await supabase
          .from("menus")
          .select("id")
          .eq("restaurant_id", restaurantId)) as { data: { id: string }[] | null };

        if (menus && menus.length > 0) {
          const menuIds = menus.map((m) => m.id);

          // Build query with dietary tag filtering
          let dishQuery = supabase
            .from("dishes")
            .select("id, name, description, price")
            .in("menu_id", menuIds)
            .eq("public", true)
            .or(`name.ilike.%${cleanedQuery}%,description.ilike.%${cleanedQuery}%`)
            .limit(20);

          // Apply dietary tag filter if needed
          if (requiredTagIds.length > 0) {
            const { data: dishTags } = (await supabase
              .from("dish_tags")
              .select("dish_id")
              .in("tag_id", requiredTagIds)) as { data: { dish_id: string }[] | null };

            if (dishTags && dishTags.length > 0) {
              const dishIds = dishTags.map((dt) => dt.dish_id);
              dishQuery = dishQuery.in("id", dishIds);
            } else {
              // No dishes match dietary tags
              return {
                restaurant: restaurantData,
                dishes: [],
              };
            }
          }

          const { data: directDishes } = (await dishQuery) as {
            data: {
              id: string;
              name: string;
              description: string | null;
              price: number;
              section_id: string | null;
              sections: { name: string } | null;
            }[] | null;
          };

          if (directDishes && directDishes.length > 0) {
            dishes = directDishes.map((d) => ({
              id: d.id,
              name: d.name,
              description: d.description,
              price: d.price,
              section_name: d.sections?.name || null,
            }));
            console.log("[searchMenuInRestaurant] Direct query found", dishes.length, "dishes");
          }
        }
      }
    } else if (requiredTagIds.length > 0) {
      // Tag-only search within restaurant
      const { data: tagData, error: tagError } = ((await supabase.rpc(
        "search_public_dishes_by_tags",
        {
          target_city: null,
          dietary_tag_ids: requiredTagIds,
          service_filters: serviceFilters,
          limit_count: 50,
        }
      )) as RpcResult<FlatSearchRow[]>);

      if (!tagError && tagData && tagData.length > 0) {
        // Filter by restaurant_id
        const restaurantDishes = tagData
          .filter((row) => row.restaurant_id === restaurantId)
          .map((row) => ({
            id: row.dish_id,
            name: row.dish_name,
            description: row.dish_description,
            price: row.dish_price,
            section_name: row.section_name || null,
          }));

        dishes = restaurantDishes;
        console.log("[searchMenuInRestaurant] Tag-only search found", dishes.length, "dishes");
      }
    }

    // Limit to top 10 dishes
    dishes = dishes.slice(0, 10);

    // Calculate bestMatchDish using fuzzy matching for tag-check scenarios
    let bestMatchDish: { id: string; name: string; description?: string | null; price?: number | null } | null = null;
    if (cleanedQuery && cleanedQuery.trim().length > 0 && dishes.length > 0) {
      const queryLower = cleanedQuery.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);

      // Helper for fuzzy similarity
      const isSimilarWord = (str1: string, str2: string): boolean => {
        const a = str1.toLowerCase().replace(/[^a-z]/g, '');
        const b = str2.toLowerCase().replace(/[^a-z]/g, '');
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;

        const normalize = (s: string) => s
          .replace(/aa/g, 'a')
          .replace(/ee/g, 'i')
          .replace(/oo/g, 'u')
          .replace(/ani$/g, 'ni')
          .replace(/y$/g, 'i');

        const normA = normalize(a);
        const normB = normalize(b);
        if (normA === normB) return true;
        if (normA.includes(normB) || normB.includes(normA)) return true;

        if (Math.abs(a.length - b.length) <= 2 && a.length >= 3) {
          let matches = 0;
          for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] === b[i]) matches++;
          }
          return matches / Math.max(a.length, b.length) >= 0.7;
        }
        return false;
      };

      // Find best match with highest word overlap
      let bestScore = 0;
      for (const dish of dishes) {
        const dishName = dish.name.toLowerCase();
        const dishWords = dishName.split(/\s+/).filter(w => w.length >= 2);

        // Score: count of matching query words
        const matchingWords = queryWords.filter(qWord =>
          dishWords.some(dWord => isSimilarWord(qWord, dWord))
        );
        const score = matchingWords.length;

        if (score > bestScore) {
          bestScore = score;
          bestMatchDish = {
            id: dish.id,
            name: dish.name,
            description: dish.description,
            price: dish.price
          };
        }
      }

      if (bestMatchDish) {
        console.log("[searchMenuInRestaurant] Best match found:", {
          query: cleanedQuery,
          matchedDish: bestMatchDish.name,
          score: bestScore
        });
      }
    }

    // Batch fetch tags for all dishes before returning
    if (dishes.length > 0) {
      const dishIds = dishes.map(d => d.id);
      type DishTagRow = { dish_id: string; tags: { id: string; name: string; slug: string; type: string } };
      const { data: tagData } = await supabase
        .from("dish_tags")
        .select("dish_id, tags!inner(id, name, slug, type)")
        .in("dish_id", dishIds) as { data: Array<{ dish_id: string; tags: TagInfo }> | null };

      if (tagData && tagData.length > 0) {
        // Group tags by dish_id
        const tagsByDishId = new Map<string, TagInfo[]>();
        for (const row of tagData) {
          if (!tagsByDishId.has(row.dish_id)) {
            tagsByDishId.set(row.dish_id, []);
          }
          tagsByDishId.get(row.dish_id)!.push(row.tags);
        }

        // Attach tags to dishes
        dishes = dishes.map(d => ({
          ...d,
          tags: tagsByDishId.get(d.id) || undefined,
        }));
      }
    }

    return {
      restaurant: restaurantData,
      dishes,
      bestMatchDish,
    };
  } catch (error) {
    console.error("[searchMenuInRestaurant] Error:", error);
    return {
      restaurant: { id: restaurantId, name: "Unknown", city: null },
      dishes: [],
    };
  }
}

