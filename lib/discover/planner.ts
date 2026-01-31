import { z } from "zod";
import type { ChatState, Intent, ChatPrefs, GroundedState } from "@/lib/types/discover";
import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

// ============================================
// 1. Zod Schema & Types
// ============================================

export type ActionType =
    | "FOLLOWUP"
    | "EXPLAIN"
    | "SEARCH"
    | "RESHOW"
    | "CLARIFY"
    | "EXIT_RESTAURANT"
    | "SHOW_MENU"
    | "RESTAURANT_LOOKUP";

// Structured Outputs compatible schema: all fields required, optional modeled as nullable
export const PlanSchema = z.object({
    action: z.enum(["FOLLOWUP", "EXPLAIN", "SEARCH", "RESHOW", "CLARIFY", "EXIT_RESTAURANT", "SHOW_MENU", "RESTAURANT_LOOKUP"]),
    confidence: z.number().min(0).max(1),
    reason: z.string().nullable(),

    prefs_patch: z.object({
        language: z.string().nullable(),
        dietary: z.array(z.string()).nullable(),
        city: z.string().nullable(),
        budgetMaxSek: z.number().nullable(),
    }).nullable(),

    dish_query: z.string().nullable(),

    search: z.object({
        queryText: z.string().nullable(),
        tags: z.array(z.string()).nullable(),
        city: z.string().nullable(),
        budgetMaxSek: z.number().nullable(),
    }).nullable(),
});

export type Plan = z.infer<typeof PlanSchema>;

// ============================================
// 2. Helper Detectors (Deterministic)
// ============================================

function normalize(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

const GENERIC_FOOD_TERMS = new Set(["something", "anything", "kuch", "any", "some", "något", "mat", "rätt", "alternativ", "options", "recommend", "suggest"]);

export function isGenericFoodQuery(q: string): boolean {
    const norm = normalize(q);
    // Check strict token match or generic "food"
    return norm.split(" ").some(t => GENERIC_FOOD_TERMS.has(t));
}

export function isDishExplainerQuestion(q: string): boolean {
    const s = q.toLowerCase();
    return (
        s.startsWith("what is ") ||
        s.startsWith("what's ") ||
        s.startsWith("whats ") ||
        s.startsWith("vad är ") ||
        s.includes("is it sweet") ||
        s.includes("is it creamy") ||
        s.includes("is it spicy") ||
        s.includes("mild or spicy") ||
        s.includes("how does it taste") ||
        s.includes("krämig") ||
        s.includes("söt") ||
        s.includes("stark") ||
        s.includes("smakar")
    );
}

export function isStrictDietAllergyQuestion(q: string): boolean {
    const s = q.toLowerCase();
    const strict = [
        "allergy", "allergi", "nuts", "nut", "nöt", "cashew", "almond", "mandel", "sesame", "sesam",
        "milk", "dairy", "mejeri", "lactose", "laktos",
        "gluten", "wheat", "vete",
        "halal", "haram", "pork", "fläsk",
        "vegan", "vegetarian", "vegetarisk",
        "contains", "ingredient", "ingredien"
    ];
    return strict.some(k => s.includes(k));
}

// Check if current intent looks like a repeat of the previous one
export function looksLikeSameIntent(
    query: string,
    prevQuery: string | null,
    prevDietary: string[] | null,
    curDietary: string[] | null
): boolean {
    if (!prevQuery) return false;

    const curQ = normalize(query);
    const oldQ = normalize(prevQuery);
    const qMatch = curQ === oldQ || curQ.includes(oldQ) || oldQ.includes(curQ);

    if (!qMatch) return false;

    // Check dietary equality
    const d1 = JSON.stringify((prevDietary ?? []).sort());
    const d2 = JSON.stringify((curDietary ?? []).sort());

    return d1 === d2;
}

// ============================================
// 3. Guardrails (Safety & Logic Overrides)
// ============================================

export function applyGuardrails(raw: Plan, args: {
    query: string;
    chatState: ChatState | null;
    grounded: GroundedState | null;
    curDietary: string[] | null;
    intent?: Intent | null;
}): { plan: Plan; triggered: string[] } {
    const triggered: string[] = [];
    const plan: Plan = { ...raw };

    // Guardrail 0: Force RESTAURANT_LOOKUP when intent explicitly says so
    // This overrides LLM decisions that incorrectly return SEARCH for restaurant names
    const featureEnabled = !process.env.DISCOVERY_RESTAURANT_PROFILE ||
        process.env.DISCOVERY_RESTAURANT_PROFILE === "1" ||
        process.env.DISCOVERY_RESTAURANT_PROFILE === "true";

    if (args.intent?.is_restaurant_lookup && featureEnabled && plan.action !== "RESTAURANT_LOOKUP") {
        plan.action = "RESTAURANT_LOOKUP";
        triggered.push("restaurantLookup:forcedFromIntent");
    }

    // Guardrail 1: Block EXPLAIN on strict diet/allergy questions -> Force Search or Followup
    if (isStrictDietAllergyQuestion(args.query) && plan.action === "EXPLAIN") {
        plan.action = args.grounded ? "FOLLOWUP" : "SEARCH";
        triggered.push("allergenSafety:blockedExplain");
    }

    // Guardrail 1.5: Bare dish names should SEARCH, not EXPLAIN
    // EXPLAIN is for "what is X?" questions, not for "roganjosh" or "chicken korma" as standalone queries
    if (plan.action === "EXPLAIN" && !isDishExplainerQuestion(args.query)) {
        // If it's just a dish name without "what is" prefix, treat as SEARCH
        plan.action = "SEARCH";
        triggered.push("bareDishName:searchNotExplain");
    }

    // Guardrail 1.6: SHOW_MENU with dish_query should be SEARCH
    // "does anyone have daal makhani in the menu" = SEARCH for daal makhani, NOT show_menu
    if (plan.action === "SHOW_MENU" && args.intent?.dish_query) {
        plan.action = "SEARCH";
        triggered.push("showMenuWithDishQuery:searchInstead");
    }

    // Guardrail 2: Generic query → tag-only search (queryText null)
    // CRITICAL: Only force tag-only when intent has NO specific dish term
    // "any veg pizza?" has dish_query='pizza', so should NOT trigger tag-only
    // "anything veg?" has dish_query=null, so SHOULD trigger tag-only
    const hasDishQuery = args.intent?.dish_query && args.intent.dish_query.trim().length > 0;
    const hasTagTerms = (args.intent?.dietary?.length ?? 0) > 0 ||
        (args.intent?.hard_tags?.length ?? 0) > 0 ||
        (args.intent?.allergy?.length ?? 0) > 0;

    if (plan.action === "SEARCH" && isGenericFoodQuery(args.query) && !hasDishQuery && hasTagTerms) {
        // Force queryText to null to enable strict tag search downstream
        plan.search = { queryText: null, tags: null, city: null, budgetMaxSek: null };
        triggered.push("tagOnlyGeneric:queryTextNull");
    }

    // Guardrail 3: FOLLOWUP requires grounded context, otherwise SEARCH
    if (plan.action === "FOLLOWUP" && !args.grounded) {
        plan.action = "SEARCH";
        triggered.push("followupNoContext:searchInstead");
    }

    // Guardrail 3.5: Restaurant mode + hard_tags + no dish_query → force SEARCH (LIST_TAGGED)
    // "do they have veg dishes" in restaurant mode should list tagged dishes, not FOLLOWUP/MENU_FACT
    const isRestaurantMode = args.chatState?.mode === "restaurant" && args.chatState?.currentRestaurantId;
    const hasHardTags = (args.intent?.hard_tags?.length ?? 0) > 0 || (args.intent?.dietary?.length ?? 0) > 0;
    const noDishQuery = !args.intent?.dish_query || args.intent.dish_query.trim().length === 0;

    if (plan.action === "FOLLOWUP" && isRestaurantMode && hasHardTags && noDishQuery) {
        plan.action = "SEARCH";
        // CRITICAL: Ensure search params are set for a tag-only search
        // If we don't set this, route.ts defaults to empty params and we lose the tag context
        plan.search = {
            queryText: null, // Clear text to force tag-only
            tags: [...(args.intent?.dietary || []), ...(args.intent?.hard_tags || [])],
            city: null,
            budgetMaxSek: null
        };
        triggered.push("restaurantModeTagList:searchNotFollowup");
    }

    // Guardrail 3.6: Restaurant mode + dish_query should always SEARCH (not FOLLOWUP/CLARIFY)
    // This prevents "do they have lamm vindaloo" after 0 results from routing to FOLLOWUP
    const hasDishQueryGuard = !!args.intent?.dish_query && args.intent.dish_query.trim().length > 0;
    if ((plan.action === "FOLLOWUP" || plan.action === "CLARIFY") && isRestaurantMode && hasDishQueryGuard) {
        plan.action = "SEARCH";
        plan.search = {
            queryText: args.intent!.dish_query!,
            tags: null,
            city: null,
            budgetMaxSek: null
        };
        triggered.push("restaurantModeDishQuery:searchNotFollowup");
    }

    // Guardrail 3.7: Restaurant mode + ingredients should always SEARCH (not FOLLOWUP/EXPLAIN)
    // This prevents "do they have something with paneer" from routing to FOLLOWUP
    const hasIngredients = (args.intent?.ingredients?.length ?? 0) > 0;
    if ((plan.action === "FOLLOWUP" || plan.action === "EXPLAIN") && isRestaurantMode && hasIngredients) {
        plan.action = "SEARCH";
        plan.search = {
            queryText: args.intent!.ingredients!.join(" "),
            tags: null,
            city: null,
            budgetMaxSek: null
        };
        triggered.push("restaurantModeIngredients:searchNotFollowup");
    }

    // Guardrail 4: Anti-loop → reshow if same intent and grounded exists
    const prevQ = args.grounded?.lastQuery ?? null;
    const prevDiet = args.grounded?.lastDietary ?? null;

    if (plan.action === "SEARCH" && args.grounded && looksLikeSameIntent(args.query, prevQ, prevDiet, args.curDietary)) {
        plan.action = "RESHOW";
        triggered.push("antiLoop:reshowInsteadOfSearch");
    }

    return { plan, triggered };
}

// ============================================
// 4. Planner Implementation (LLM + Fallback)
// ============================================

export async function generatePlanSafe(args: {
    query: string;
    intent: Intent;
    chatState: ChatState | null;
    grounded: GroundedState | null;
    openai: OpenAI;
}): Promise<{ plan: Plan; triggered: string[]; usedFallback: boolean; rawAction: string | null }> {

    const { query, intent, chatState, grounded, openai } = args;

    // FIX: LLM bypass flag - skip OpenAI call for faster responses (saves ~2s per request)
    // Set DISCOVERY_LLM_PLANNER=1 to enable LLM-based planning
    const useLLMPlanner = process.env.DISCOVERY_LLM_PLANNER === "1";

    // 1. Deterministic Fallback Logic (used if LLM fails or low confidence)
    // Maps intent directly to action
    const fallbackPlan: Plan = (() => {
        if (intent.exit_restaurant) return {
            action: "EXIT_RESTAURANT",
            confidence: 1,
            reason: null,
            prefs_patch: null,
            dish_query: null,
            search: null
        };
        if (intent.show_menu) return {
            action: "SHOW_MENU",
            confidence: 1,
            reason: null,
            prefs_patch: null,
            dish_query: null,
            search: null
        };

        // RESTAURANT_LOOKUP: When user explicitly asks for restaurant info or name
        // Feature flag: Defaults to true if not set, or checks for "1"/"true"
        const featureEnabled = !process.env.DISCOVERY_RESTAURANT_PROFILE ||
            process.env.DISCOVERY_RESTAURANT_PROFILE === "1" ||
            process.env.DISCOVERY_RESTAURANT_PROFILE === "true";

        if (intent.is_restaurant_lookup && featureEnabled) {
            return {
                action: "RESTAURANT_LOOKUP",
                confidence: 0.9,
                reason: null,
                prefs_patch: null,
                dish_query: null,
                search: null
            };
        }

        // Explicit follow-up detection for Dish Explainer
        if (isDishExplainerQuestion(query)) {
            if (!isStrictDietAllergyQuestion(query)) return {
                action: "EXPLAIN",
                confidence: 1,
                reason: null,
                prefs_patch: null,
                dish_query: null,
                search: null
            };
            // If strictly diet-related, prefer FOLLOWUP (strict grounded) if context exists, else Search
            return grounded
                ? { action: "FOLLOWUP", confidence: 1, reason: null, prefs_patch: null, dish_query: null, search: null }
                : { action: "SEARCH", confidence: 1, reason: null, prefs_patch: null, dish_query: null, search: null };
        }

        if (intent.is_followup && grounded) return {
            action: "FOLLOWUP",
            confidence: 1,
            reason: null,
            prefs_patch: null,
            dish_query: null,
            search: null
        };

        if (isGenericFoodQuery(query) && intent.dietary.length > 0) {
            return {
                action: "SEARCH",
                confidence: 1,
                reason: null,
                prefs_patch: null,
                dish_query: null,
                search: { queryText: null, tags: null, city: null, budgetMaxSek: null }
            };
        }

        if (intent.is_vague && !intent.dish_query && intent.dietary.length === 0) return {
            action: "CLARIFY",
            confidence: 1,
            reason: null,
            prefs_patch: null,
            dish_query: null,
            search: null
        };

        return {
            action: "SEARCH",
            confidence: 1,
            reason: null,
            prefs_patch: null,
            dish_query: null,
            search: null
        };
    })();

    // FIX: When LLM planner is disabled, use deterministic fallback with guardrails
    // This saves ~2s per request (the main performance bottleneck)
    if (!useLLMPlanner) {
        const { plan: safePlan, triggered } = applyGuardrails(fallbackPlan, {
            query,
            chatState,
            grounded,
            curDietary: intent.dietary,
            intent
        });
        return { plan: safePlan, triggered: [...triggered, "fastPath:noLLM"], usedFallback: true, rawAction: fallbackPlan.action };
    }

    try {
        const systemPrompt = `You are a query router for a food discovery app.
Your goal is to choose the best ActionType based on user query and context.

Actions:
- SEARCH: Default. User wants to find food/restaurants.
- EXPLAIN: User asks "what is X?", "how does it taste?", "is it spicy?". General info allowed.
- FOLLOWUP: User refers to explicit result ("is that one vegan?", "where is it?").
- RESHOW: (Rare) User asks to see the same things again.
- CLARIFY: User query is extremely vague ("hungry", "food").
- EXIT_RESTAURANT: User says "back", "exit", "leave".
- SHOW_MENU: User asks for "menu", "list".

Context Rules:
1. Prefer EXPLAIN for "what is X" type questions.
2. Prefer SEARCH for everything else unless specific command.
3. If user query implies a dietary filter (e.g. "veg options"), set prefs_patch.dietary = ["vegetarian"].

Response Format: JSON only matching PlanSchema.
`;

        // 8 Examples for Few-shot
        const userPrompt = `Query: "${query}"
Context: Mode=${chatState?.mode}, Grounded=${!!grounded}, LastQuery="${grounded?.lastQuery || ''}"
Intent: ${JSON.stringify({ ...intent, original_query: undefined })}
`;

        // Use Structured Outputs for guaranteed valid schema
        const completion = await openai.chat.completions.parse({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0,
            response_format: zodResponseFormat(PlanSchema, "plan"),
        });

        const parsedPlan = completion.choices[0]?.message?.parsed;
        if (!parsedPlan) {
            // Refusal or parsing failure (extremely rare with Structured Outputs)
            return { plan: fallbackPlan, triggered: ["fallback:noContent"], usedFallback: true, rawAction: null };
        }

        // Low confidence check
        if (parsedPlan.confidence < 0.7) {
            return { plan: fallbackPlan, triggered: ["fallback:lowConfidence"], usedFallback: true, rawAction: parsedPlan.action };
        }

        // Apply Guardrails
        const { plan: safePlan, triggered } = applyGuardrails(parsedPlan, {
            query,
            chatState,
            grounded,
            curDietary: intent.dietary,
            intent
        });

        return { plan: safePlan, triggered, usedFallback: false, rawAction: parsedPlan.action };

    } catch (error) {
        console.error("Planner unexpected error", error);
        return { plan: fallbackPlan, triggered: ["fallback:exception"], usedFallback: true, rawAction: null };
    }
}
