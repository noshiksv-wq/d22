/**
 * hybrid-search.ts - Parallel semantic + trigram search with score merging
 * 
 * Phase 1: Investor demo quality search
 * - Runs semantic (embeddings) and trigram (fuzzy) in parallel
 * - Query-aware weight selection
 * - Null-safe score merging
 * - Exact match boosting
 */

import { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { generateEmbedding } from "@/lib/embeddings";

// ============================================
// TYPES
// ============================================

export interface HybridCandidate {
    dish_id: string;
    dish_name: string;
    dish_description: string | null;
    dish_price: number;
    restaurant_id: string;
    restaurant_name: string;
    restaurant_city: string | null;
    restaurant_address: string | null;
    section_name?: string | null;
    semanticScore: number | null;  // 0-1 or null if no embedding match
    trigramScore: number | null;   // 0-1 or null if no text match
    finalScore: number;            // Combined score
    source: 'semantic' | 'trigram' | 'both';
}

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
    section_name?: string | null;
}

interface HybridSearchOptions {
    query: string;
    city?: string | null;
    dietaryTagIds?: string[];
    supabase: SupabaseClient;
    openai: OpenAI;
    limitPerSource?: number;  // Default 40
}

// ============================================
// QUERY ANALYSIS (for weight selection)
// ============================================

/**
 * Analyze query to determine optimal semantic vs trigram weights
 * Returns { semanticWeight, trigramWeight } that sum to 1.0
 */
function analyzeQueryForWeights(query: string): { semanticWeight: number; trigramWeight: number } {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 0);

    // Semantic-heavy indicators: vibe/mood queries
    const semanticIndicators = [
        "like", "similar", "something", "craving", "want", "mood",
        "feeling", "recommend", "suggestion", "type of", "kind of",
        "spicy", "creamy", "light", "heavy", "comfort", "healthy"
    ];
    const hasSemanticIndicator = semanticIndicators.some(ind => lower.includes(ind));

    // Trigram-heavy indicators: short queries or likely dish names
    const isShortQuery = words.length <= 3;

    // Common dish name patterns (likely exact/near-exact match intent)
    const dishPatterns = [
        /chicken/i, /pizza/i, /burger/i, /curry/i, /naan/i, /rice/i,
        /pasta/i, /salad/i, /soup/i, /steak/i, /fish/i, /lamb/i,
        /vindaloo/i, /korma/i, /biryani/i, /masala/i, /tikka/i,
        /margherita/i, /funghi/i, /prosciutto/i, /calzone/i
    ];
    const likelyDishName = dishPatterns.some(p => p.test(lower));

    // Decision logic
    if (hasSemanticIndicator) {
        // Vibe query: semantic dominates
        return { semanticWeight: 0.7, trigramWeight: 0.3 };
    }

    if (isShortQuery || likelyDishName) {
        // Short or dish name: trigram dominates (handles typos better)
        return { semanticWeight: 0.4, trigramWeight: 0.6 };
    }

    // Default balanced
    return { semanticWeight: 0.55, trigramWeight: 0.45 };
}

// ============================================
// EXACT MATCH BOOST
// ============================================

/**
 * Boost score if dish name contains query tokens (case-insensitive)
 * Returns bonus to add to finalScore (0 to 0.15)
 */
function calculateExactMatchBoost(dishName: string, query: string): number {
    const dishLower = dishName.toLowerCase();
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    if (queryTokens.length === 0) return 0;

    // Count matching tokens
    const matchingTokens = queryTokens.filter(token => dishLower.includes(token));
    const matchRatio = matchingTokens.length / queryTokens.length;

    // Full token match in name: bonus 0.15
    // Partial match: proportional bonus
    return Math.min(0.15, matchRatio * 0.15);
}

// ============================================
// TOKEN PRECISION FILTER (Step 6: Dish Precision)
// ============================================

/**
 * Check if dish name contains ALL significant tokens from query
 * Used to filter out partial matches like "Chicken Korma" when searching for "butter chicken"
 * 
 * Returns { isFullMatch, matchRatio }
 */
function checkTokenPrecision(dishName: string, query: string): { isFullMatch: boolean; matchRatio: number } {
    const dishLower = dishName.toLowerCase();
    const dishDescription = ""; // We only check name for precision
    const combined = dishLower;

    // Get significant tokens (3+ chars, excluding common words)
    const stopWords = new Set(["the", "and", "with", "for", "from", "our"]);
    const queryTokens = query.toLowerCase()
        .split(/\s+/)
        .filter(t => t.length >= 3 && !stopWords.has(t));

    if (queryTokens.length === 0) {
        return { isFullMatch: true, matchRatio: 1 };
    }

    // Count matching tokens
    const matchingTokens = queryTokens.filter(token => combined.includes(token));
    const matchRatio = matchingTokens.length / queryTokens.length;

    // Full match = ALL tokens present
    const isFullMatch = matchingTokens.length === queryTokens.length;

    return { isFullMatch, matchRatio };
}

/**
 * Determine if query is specific enough to require precision filtering
 * Short, specific queries like "butter chicken" should be filtered
 * Vibe queries like "something spicy" should not
 */
function requiresPrecisionFiltering(query: string): boolean {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 0);

    // Vibe/mood indicators - don't filter these
    const vibeIndicators = [
        "something", "anything", "like", "similar", "craving", "want",
        "mood", "feeling", "recommend", "suggestion", "type of", "kind of"
    ];
    if (vibeIndicators.some(v => lower.includes(v))) {
        return false;
    }

    // 2-4 word specific queries benefit from precision filtering
    return words.length >= 2 && words.length <= 4;
}

// ============================================
// TRANSLATION HELPER
// ============================================

/**
 * Translate query to Swedish tokens if detected as non-Swedish
 * Returns original query if already Swedish or ambiguous
 */
async function translateQueryToSwedish(query: string, openai: OpenAI): Promise<string> {
    // Skip short queries or strictly numeric
    if (query.length < 3 || /^\d+$/.test(query)) return query;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Use fast model
            messages: [
                {
                    role: "system",
                    content: `You are a query translator for a Swedish food app. 
                    Translate the user's food query to Swedish. 
                    - If it's already Swedish, return SAME.
                    - If it's English, return the Swedish translation (e.g. "soup" -> "soppa", "spicy chicken" -> "stark kyckling").
                    - Return ONLY the translation or SAME. No other text.`
                },
                { role: "user", content: query }
            ],
            temperature: 0,
            max_tokens: 10
        });

        const translation = completion.choices[0]?.message?.content?.trim();

        if (!translation || translation === "SAME" || translation.toLowerCase() === query.toLowerCase()) {
            return query;
        }

        console.log(`[hybrid-search] Translated query: "${query}" -> "${translation}"`);
        return translation;
    } catch (error) {
        console.warn("[hybrid-search] Translation failed:", error);
        return query;
    }
}

// ============================================
// NULL-SAFE SCORE MERGING
// ============================================

/**
 * Merge semantic and trigram scores with null safety
 * If only one score exists, use it directly (don't penalize)
 * If both exist, use weighted average + exact match boost
 */
function mergeScores(
    semanticScore: number | null,
    trigramScore: number | null,
    weights: { semanticWeight: number; trigramWeight: number },
    exactMatchBoost: number
): { finalScore: number; source: 'semantic' | 'trigram' | 'both' } {
    const hasSemantic = semanticScore !== null && semanticScore > 0;
    const hasTrigram = trigramScore !== null && trigramScore > 0;

    if (hasSemantic && hasTrigram) {
        // Both sources: weighted merge + boost
        const merged = (semanticScore! * weights.semanticWeight) + (trigramScore! * weights.trigramWeight);
        return {
            finalScore: Math.min(1.0, merged + exactMatchBoost),
            source: 'both'
        };
    }

    if (hasSemantic) {
        // Only semantic: use it directly + boost
        return {
            finalScore: Math.min(1.0, semanticScore! + exactMatchBoost),
            source: 'semantic'
        };
    }

    if (hasTrigram) {
        // Only trigram: use it directly + boost
        return {
            finalScore: Math.min(1.0, trigramScore! + exactMatchBoost),
            source: 'trigram'
        };
    }

    // Neither (shouldn't happen, but safety)
    return { finalScore: 0, source: 'trigram' };
}

// ============================================
// MAIN HYBRID SEARCH FUNCTION
// ============================================

export async function hybridSearchDishes(opts: HybridSearchOptions): Promise<HybridCandidate[]> {
    const { query, city, dietaryTagIds, supabase, openai, limitPerSource = 40 } = opts;

    if (!query || query.trim().length === 0) {
        return [];
    }

    const startTime = Date.now();
    const weights = analyzeQueryForWeights(query);

    console.log("[hybrid-search] Starting parallel retrieval", {
        query,
        city,
        dietaryTagIds,
        weights
    });

    // Build common RPC params
    const rpcParams = {
        target_city: city || null,
        dietary_tag_ids: dietaryTagIds && dietaryTagIds.length > 0 ? dietaryTagIds : null,
        limit_count: limitPerSource
    };

    // ============================================
    // PARALLEL RETRIEVAL
    // ============================================

    // Start all searches in parallel
    // 1. Semantic Search (Concepts)
    const semanticPromise = (async (): Promise<FlatSearchRow[]> => {
        try {
            const embedding = await generateEmbedding(query);
            const { data, error } = await supabase.rpc("search_public_dishes_semantic", {
                ...rpcParams,
                query_embedding: embedding
            });

            if (error) {
                console.warn("[hybrid-search] Semantic RPC error:", error);
                return [];
            }
            return (data as FlatSearchRow[]) || [];
        } catch (err) {
            console.warn("[hybrid-search] Semantic search failed:", err);
            return [];
        }
    })();

    // 2. Trigram Search (Text Matching - Original + Translated)
    const trigramPromise = (async (): Promise<FlatSearchRow[]> => {
        try {
            // Attempt translation parallel to semantic search
            const translatedQuery = await translateQueryToSwedish(query, openai);

            const queriesToRun = [query];
            if (translatedQuery !== query) {
                queriesToRun.push(translatedQuery);
            }

            // Run trigram searches in parallel
            const searchPromises = queriesToRun.map(async (q) => {
                const { data, error } = await supabase.rpc("search_public_dishes_fuzzy", {
                    ...rpcParams,
                    search_text: q
                });
                if (error) throw error;
                return (data as FlatSearchRow[]) || [];
            });

            const results = await Promise.all(searchPromises);

            // Deduplicate results by dish_id
            const seen = new Set<string>();
            const uniqueResults: FlatSearchRow[] = [];

            for (const batch of results) {
                for (const row of batch) {
                    if (!seen.has(row.dish_id)) {
                        seen.add(row.dish_id);
                        uniqueResults.push(row);
                    }
                }
            }

            return uniqueResults;
        } catch (err) {
            console.warn("[hybrid-search] Trigram search failed:", err);
            return [];
        }
    })();

    // Wait for both semantic and trigram (which includes translation inside)
    const [semanticResults, trigramResults] = await Promise.all([semanticPromise, trigramPromise]);

    const retrievalTime = Date.now() - startTime;

    console.log("[hybrid-search] Retrieval complete", {
        semanticCount: semanticResults.length,
        trigramCount: trigramResults.length,
        retrievalTimeMs: retrievalTime
    });

    // ============================================
    // MERGE AND SCORE
    // ============================================

    // Build lookup maps
    const semanticByDish = new Map<string, FlatSearchRow>();
    for (const row of semanticResults) {
        semanticByDish.set(row.dish_id, row);
    }

    const trigramByDish = new Map<string, FlatSearchRow>();
    for (const row of trigramResults) {
        trigramByDish.set(row.dish_id, row);
    }

    // Get all unique dish IDs
    const allDishIds = new Set([
        ...semanticResults.map(r => r.dish_id),
        ...trigramResults.map(r => r.dish_id)
    ]);

    // Build merged candidates
    const candidates: HybridCandidate[] = [];

    for (const dishId of allDishIds) {
        const semantic = semanticByDish.get(dishId);
        const trigram = trigramByDish.get(dishId);

        // Use whichever source has the data (prefer semantic for metadata if both)
        const base = semantic || trigram!;

        const semanticScore = semantic?.similarity_score ?? null;
        const trigramScore = trigram?.similarity_score ?? null;
        const exactBoost = calculateExactMatchBoost(base.dish_name, query);

        const { finalScore, source } = mergeScores(semanticScore, trigramScore, weights, exactBoost);

        candidates.push({
            dish_id: base.dish_id,
            dish_name: base.dish_name,
            dish_description: base.dish_description,
            dish_price: base.dish_price,
            restaurant_id: base.restaurant_id,
            restaurant_name: base.restaurant_name,
            restaurant_city: base.restaurant_city,
            restaurant_address: base.restaurant_address,
            section_name: base.section_name,
            semanticScore,
            trigramScore,
            finalScore,
            source
        });
    }

    // Sort by finalScore descending
    candidates.sort((a, b) => b.finalScore - a.finalScore);

    // ============================================
    // PRECISION FILTERING (Step 6: Dish Precision)
    // For specific queries like "butter chicken", demote partial matches
    // ============================================
    // New Strategy: Demote instead of Delete (Phase 4)
    if (requiresPrecisionFiltering(query)) {
        candidates.forEach(c => {
            const { isFullMatch, matchRatio } = checkTokenPrecision(c.dish_name, query);

            if (isFullMatch) {
                // Keep high score (or slightly boost?)
                // c.finalScore *= 1.0; 
            } else if (matchRatio < 0.6) {
                // Demote partial matches (e.g. "chicken korma" when searching "butter chicken")
                // Penalty: 0.3x score
                const originalScore = c.finalScore;
                c.finalScore *= 0.3;
                console.log(`[hybrid-search] Precision demotion: ${c.dish_name} (${originalScore.toFixed(3)} -> ${c.finalScore.toFixed(3)})`);
            }
        });

        // Re-sort after score adjustments
        candidates.sort((a, b) => b.finalScore - a.finalScore);
    }
    // Log top results for debugging
    const totalTime = Date.now() - startTime;
    console.log("[hybrid-search] Merge complete", {
        totalCandidates: candidates.length,
        totalTimeMs: totalTime,
        top5: candidates.slice(0, 5).map(c => ({
            name: c.dish_name,
            restaurant: c.restaurant_name,
            semantic: c.semanticScore?.toFixed(3) ?? "null",
            trigram: c.trigramScore?.toFixed(3) ?? "null",
            final: c.finalScore.toFixed(3),
            source: c.source
        }))
    });

    return candidates;
}

// ============================================
// HELPER: Convert HybridCandidate[] to FlatSearchRow[] for compatibility
// ============================================

export function hybridToFlatRows(candidates: HybridCandidate[]): FlatSearchRow[] {
    return candidates.map(c => ({
        restaurant_id: c.restaurant_id,
        restaurant_name: c.restaurant_name,
        restaurant_city: c.restaurant_city,
        restaurant_address: c.restaurant_address,
        dish_id: c.dish_id,
        dish_name: c.dish_name,
        dish_description: c.dish_description,
        dish_price: c.dish_price,
        similarity_score: c.finalScore,
        section_name: c.section_name
    }));
}
