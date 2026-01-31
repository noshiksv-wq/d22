import { NextRequest, NextResponse } from "next/server";
import { searchRestaurantsAndDishes, searchMenuInRestaurant, getPublicMenu } from "@/app/actions/discover";
import { parseUserIntent } from "@/lib/intent-parser";
import { createServiceRoleClient, createClient } from "@/lib/supabase/server";
import { generatePlanSafe, type Plan } from "@/lib/discover/planner";
import { resolveFollowupFromLastResults } from "@/lib/discover/followup-resolver";
import { truncateCards } from "@/lib/discover/result-truncation";
import { findBestRestaurantMatch, type RestaurantProfile } from "@/lib/discover/restaurant-lookup";
import { t } from "@/lib/discover/i18n";
import { translateIfNeeded, pickReplyLang, languageName, normalizeLang } from "@/lib/discover/multilingual";
import type {
  DiscoverChatRequest,
  DiscoverChatResponse,
  ChatState,
  ChatMessage,
  RestaurantCard,
  DishMatch,
  ChatPrefs,
  GroundedState,
  Intent,
  LastResultDish,
  TruncationMeta,
  LastExplain,
  RestaurantCursor,
  MenuSection,
  MenuItem,
  Mode,
} from "@/lib/types/discover";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function isDishExplainerQuestion(q: string) {
  const s = q.toLowerCase().trim();
  return (
    s.startsWith("what is ") ||
    s.startsWith("what’s ") ||
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

function isStrictDietAllergyQuestion(q: string) {
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

// Hard tags that require strict tag-only search (no guessing)
const hardTags = [
  "satvik", "halal", "gluten-free", "nut-free", "dairy-free", "lactose-free",
  "vegetarian", "vegan",
];

// Canonical tag UUID mapping (kept for backward compatibility, but prefer DB lookup)
const CANONICAL_TAG_IDS: Record<string, string> = {
  vegetarian: "a445264b-a969-4606-9507-ba77d0d6fc0c",
  vegan: "3706cb32-a6e3-415e-8a45-31880a484e4d",
  halal: "e37ac27a-9114-423e-ae51-633f2e279e41",
  satvik: "3225bfa4-b07c-4d83-a8d6-67abba545bb7",
};

/**
 * Slugify helper matching DB slug logic: allow uppercase before lowercasing
 */
function slugify(input: string): string {
  return input
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * Strip dietary/tag words from query to extract clean dish search text
 * "veg pizza" -> "pizza", "halal butter chicken" -> "butter chicken"
 */
function stripTagWords(q: string): string {
  return q
    .toLowerCase()
    .replace(/\b(veg|vegan|vegetarian|vegansk|vegetarisk|halal|kosher|satvik|satvic|gluten[-\s]?free|lactose[-\s]?free|dairy[-\s]?free|nut[-\s]?free|vegane|vegetarisch|glutenfrei|laktosefrei|gluteeniton|laktoositon|vegaaninen|vegaani|kasvis)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Routing Helpers for Explicit Scoped Search
 */
function isPlaceInfoQuery(q: string) {
  return /\b(address|phone|website|hours|opening|open now|directions|location)\b/i.test(q);
}

function isAvailabilityOrMenuQuery(q: string) {
  // Removed 'menu', 'list' to let Planner handle SHOW_MENU
  return /\b(do they have|does .* have|have you got|serve|serves|items|dishes|options|veg|vegetarian|vegan|halal|gluten|allergy)\b/i.test(q);
}

function isNameOnly(query: string, restaurantName?: string | null) {
  if (!restaurantName) return false;
  return slugify(query) === slugify(restaurantName);
}

// ============================================================
// RESPONSE SHAPE ENFORCEMENT (Patch 0.1)
// ============================================================

import { finalizeResults } from "@/lib/discover/finalizeResults";

/**
 * Helper to finalize restaurant results using the standardized safety layer
 * Applies: Focus isolation, query token enforcement, vegan strictness
 */
function finalize(
  cards: RestaurantCard[],
  chatState: ChatState | Record<string, unknown> | null,
  intent: Intent | Partial<Intent>
): RestaurantCard[] {
  // If no cards, nothing to finalize
  if (!cards || cards.length === 0) return [];

  const mode = (chatState as any)?.mode || "discovery";
  const currentRestaurantId = (chatState as any)?.currentRestaurantId;

  return finalizeResults({
    mode,
    currentRestaurantId,
    intent,
    cards,
  });
}

/**
 * Strict chip enforcement rule:
 * - kind="restaurant_profile" -> ["Ask about this restaurant"]
 * - All other kinds -> []
 */
function getSafeChips(kind: string): string[] {
  if (kind === "restaurant_profile") {
    return ["Ask about this restaurant"];
  }
  return [];
}

/**
 * Ensure message always has restaurants and followupChips arrays
 * Guarantees API contract: every response has these fields
 */
function ensureMessageShape(message: Partial<ChatMessage>): ChatMessage {
  const restaurants = Array.isArray(message.restaurants) ? message.restaurants : [];

  // STRICT ENFORCEMENT: Chips are derived solely from message.kind
  // Any passed followupChips are ignored to prevent inconsistent UI states
  const kind = message.kind || "results"; // REQUIRED: Default to 'results'
  const followupChips = getSafeChips(kind);

  return {
    id: message.id || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    role: message.role || "assistant",
    content: typeof message.content === "string" ? message.content : "",
    kind,
    restaurants,
    followupChips,
    // Preserve optional fields if present
    ...(message.menu && { menu: message.menu }),
    ...(message.menuUrl && { menuUrl: message.menuUrl }),
  };
}

/**
 * Build a safe response with shape logging
 * Use this for ALL NextResponse.json returns
 */
function buildSafeResponse(
  message: Partial<ChatMessage>,
  chatState: ChatState | Record<string, unknown>,
  logContext?: string,
  grounded?: GroundedState | null,
  meta?: TruncationMeta
): DiscoverChatResponse {
  const safeMessage = ensureMessageShape(message);

  // Defensive: Deduplicate restaurants by ID to prevent React key collision errors
  if (safeMessage.restaurants && Array.isArray(safeMessage.restaurants)) {
    const seenIds = new Set<string>();
    safeMessage.restaurants = safeMessage.restaurants.filter(r => {
      if (seenIds.has(r.id)) {
        console.warn(`[buildSafeResponse] Duplicate restaurant ID dropped: ${r.id} (${r.name})`);
        return false;
      }
      seenIds.add(r.id);
      return true;
    });
  }

  // Compute metrics for logging
  const restaurantsCount = safeMessage.restaurants?.length ?? 0;
  const matchesCount = (safeMessage.restaurants ?? []).reduce(
    (sum, r) => sum + (r.matches?.length ?? 0), 0
  );

  console.log("[discover][shape]", {
    context: logContext || "response",
    restaurantsCount,
    matchesCount,
    hasRestaurantsField: Array.isArray(safeMessage.restaurants),
    hasFollowupChipsField: Array.isArray(safeMessage.followupChips),
    hasGrounded: !!grounded,
    meta: meta ?? null,
  });

  return {
    message: safeMessage,
    chatState: chatState as ChatState,
    grounded: grounded ?? null,
    meta,
  };
}

// ============================================================
// DETERMINISTIC RESPONSE BUILDER
// ============================================================
function buildDeterministicMatchesText(args: {
  replyLanguage: string;
  originalQuery: string;
  dietaryLabel?: string | null;
  restaurants: any[];
}): string {
  const { replyLanguage, dietaryLabel, restaurants } = args;

  // Multilingual headers map
  const headers: Record<string, string> = {
    en: "I found these matches:",
    sv: "Jag hittade dessa matchningar:",
    pl: "Znalazłem te pasujące pozycje:",
    pa: "ਮੈਨੂੰ ਇਹ ਮੇਲ ਖਾਂਦੇ ਵਿਕਲਪ ਮਿਲੇ:", // Punjabi
    hi: "मुझे ये विकल्प मिले:",         // Hindi
    ar: "وجدت هذه النتائج:",            // Arabic
    fr: "J'ai trouvé ces résultats:",
    es: "Encontré estas coincidencias:",
  };

  const taggedHeaders: Record<string, string> = {
    en: `I found dishes tagged '${dietaryLabel}':`,
    sv: `Jag hittade rätter märkta '${dietaryLabel}':`,
    pa: `ਮੈਨੂੰ '${dietaryLabel}' ਟੈਗ ਕੀਤੇ ਪਕਵਾਨ ਮਿਲੇ:`,
    hi: `मुझे '${dietaryLabel}' टैਗ वाले व्यंजन मिले:`,
    ar: `وجدت أطباق بعلامة '${dietaryLabel}':`,
    fr: `J'ai trouvé des plats tagués '${dietaryLabel}':`,
    es: `Encontré platos etiquetados '${dietaryLabel}':`,
  };

  const header = dietaryLabel
    ? (taggedHeaders[replyLanguage] ?? taggedHeaders.en)
    : (headers[replyLanguage] ?? headers.en);

  const lines: string[] = [];
  const top = restaurants.filter(r => (r.matches?.length ?? 0) > 0).slice(0, 3);

  // Early return for empty results - don't say "I found..." with nothing
  if (top.length === 0) {
    return dietaryLabel
      ? `I couldn't find any dishes explicitly tagged '${dietaryLabel}' in the current dataset.`
      : `I couldn't find matches in the current dataset.`;
  }

  for (const r of top) {
    // Clean city display - no empty parentheses
    const cityPart = r.city ? ` (${r.city})` : "";
    lines.push(`**${r.name}**${cityPart}`);
    for (const d of (r.matches || []).slice(0, 3)) {
      const price = d.price != null ? ` (${d.price} kr)` : "";
      lines.push(`- ${d.name}${price}`);
    }
    lines.push(""); // spacing
  }

  return `${header}\n${lines.join("\n").trim()}`;
}

/**
 * Helper to build focused chat state for consistent focus handling
 * Used by RESTAURANT_LOOKUP and SHOW_MENU handlers
 * @param restaurant - The restaurant to focus on
 * @param existingState - Existing chat state to preserve prefs
 * @param menuPreview - Optional menu preview items to populate last_results for followup context
 */
function buildFocusedChatState(
  restaurant: { id: string; name: string },
  existingState?: ChatState | Record<string, unknown> | null,
  menuPreview?: Array<{ id: string; name: string; description?: string | null; price?: number; tags?: Array<{ slug: string }> }>
): ChatState {
  // Ensure we preserve existing preferences
  const prefs = (existingState as ChatState)?.prefs || {};

  // Build last_results from menuPreview for followup resolver context
  const last_results: LastResultDish[] = (menuPreview || []).map(d => ({
    dish_id: d.id,
    dish_name: d.name,
    restaurant_id: restaurant.id,
    restaurant_name: restaurant.name,
    tag_slugs: (d.tags || []).map(t => t.slug),
    price: d.price ?? null,
    description: d.description ?? null,
  }));

  return {
    mode: "restaurant",
    currentRestaurantId: restaurant.id,
    currentRestaurantName: restaurant.name,
    prefs,
    last_results: last_results.length > 0 ? last_results : undefined,
  };
}

/**
 * Normalize any restaurant data into canonical RestaurantCard[] format
 * Prevents "cards not showing" when matches are under different keys
 */
function normalizeRestaurantCards(input: unknown[]): RestaurantCard[] {
  const arr = Array.isArray(input) ? input : [];
  return arr.map((r: unknown) => {
    const restaurant = r as Record<string, unknown>;
    const matches = (restaurant.matches ?? restaurant.matching_dishes ?? restaurant.dishes ?? restaurant.items ?? []) as Array<Record<string, unknown>>;
    return {
      id: String(restaurant.id ?? ""),
      name: String(restaurant.name ?? ""),
      city: restaurant.city ? String(restaurant.city) : null,
      address: restaurant.address ? String(restaurant.address) : null,
      cuisine_type: restaurant.cuisine_type ? String(restaurant.cuisine_type) : null,
      highlight: restaurant.highlight ? String(restaurant.highlight) : (matches?.[0]?.name ? String(matches[0].name) : null),
      distance_km: typeof restaurant.distance_km === "number" ? restaurant.distance_km : null,
      matches: Array.isArray(matches) ? matches.map((d: Record<string, unknown>) => ({
        id: String(d.id ?? ""),
        name: String(d.name ?? ""),
        description: d.description ? String(d.description) : null,
        price: typeof d.price === "number" ? d.price : 0,
        section_name: d.section_name ? String(d.section_name) : null,
        tags: Array.isArray(d.tags) ? d.tags : undefined, // Preserve tags from RPC
      })) : [],
    };
  });
}

/**
 * Normalize query text for strict tag mode
 * Returns null if query is too generic (forces tag-only search)
 */
function normalizeStrictTagQueryText(source: string): string | null {
  let s = (source || "").toLowerCase();
  s = s.replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();

  // Remove dietary words
  const dietaryWords = ["veg", "vegan", "vegetarian", "vegetarisk", "vegansk", "vego", "veggie", "ve", "halal", "satvik"];
  for (const w of dietaryWords) {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), " ").trim();
  }

  // Remove generic filler words
  const generic = new Set(["anything", "something", "whatever", "food", "meal", "eat", "to", "for", "me", "please", "hungry", "want", "craving", "mat", "något", "vad", "kan", "jag"]);
  const tokens = s.split(" ").filter(t => t && !generic.has(t));

  // If less than 2 meaningful tokens, return null (tag-only search)
  if (tokens.length < 2) return null;
  return tokens.join(" ");
}

/**
 * Resolve tag IDs from intent terms using tag_aliases and tags table
 */
async function resolveTagIdsFromIntentTerms(
  terms: string[],
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<{ tagIds: string[]; resolvedTerms: Array<{ term: string; type: string; slug: string }> }> {
  const tagIds: string[] = [];
  const resolvedTerms: Array<{ term: string; type: string; slug: string }> = [];
  const seenTagIds = new Set<string>();

  const normalizedTerms = terms.map(term => {
    const s = term.toLowerCase().trim();
    if (["veg", "ve", "vego", "veggie", "vegetarian", "vegetarisk"].includes(s)) return "vegetarian";
    if (["vegan", "vegansk", "plant-based"].includes(s)) return "vegan";
    if (s === "gluten free" || s === "gluten-free") return "gluten-free";
    if (s === "nut free" || s === "nut-free") return "nut-free";
    if (s === "dairy free" || s === "dairy-free") return "dairy-free";
    if (s === "lactose free" || s === "lactose-free") return "lactose-free";
    return term;
  });

  for (const term of normalizedTerms) {
    let resolved = false;

    try {
      type AliasRow = { tag_type: string; tag_slug: string };
      let aliasData: AliasRow[] | null = null;
      const { data: exactMatch } = (await supabase
        .from("tag_aliases")
        .select("tag_type, tag_slug")
        .ilike("alias", term)
        .limit(1)) as { data: AliasRow[] | null };

      if (exactMatch && exactMatch.length > 0) {
        aliasData = exactMatch;
      } else if (term.includes(" ")) {
        const hyphenated = term.replace(/\s+/g, "-");
        const { data: hyphenMatch } = (await supabase
          .from("tag_aliases")
          .select("tag_type, tag_slug")
          .ilike("alias", hyphenated)
          .limit(1)) as { data: AliasRow[] | null };
        if (hyphenMatch?.length) aliasData = hyphenMatch;
      } else if (term.includes("-")) {
        const spaced = term.replace(/-/g, " ");
        const { data: spaceMatch } = (await supabase
          .from("tag_aliases")
          .select("tag_type, tag_slug")
          .ilike("alias", spaced)
          .limit(1)) as { data: AliasRow[] | null };
        if (spaceMatch?.length) aliasData = spaceMatch;
      }

      if (aliasData && aliasData.length > 0) {
        const { tag_type, tag_slug } = aliasData[0];
        try {
          const { data: tagData } = (await supabase
            .from("tags")
            .select("id, type, slug")
            .eq("type", tag_type)
            .eq("slug", tag_slug)
            .limit(1));

          if (tagData && tagData.length > 0) {
            const tag = tagData[0];
            if (!seenTagIds.has(tag.id)) {
              tagIds.push(tag.id);
              seenTagIds.add(tag.id);
              resolvedTerms.push({ term, type: tag.type, slug: tag.slug });
              resolved = true;
            }
          }
        } catch (err) { }
      }
    } catch (err) { }

    if (!resolved) {
      const slug = slugify(term);
      if (slug.length > 0) {
        try {
          const { data: tagData } = (await supabase
            .from("tags")
            .select("id, type, slug")
            .eq("slug", slug)
            .in("type", ["diet", "dietary", "religious", "allergen"])
            .limit(1));

          if (tagData && tagData.length > 0) {
            const tag = tagData[0];
            if (!seenTagIds.has(tag.id)) {
              tagIds.push(tag.id);
              seenTagIds.add(tag.id);
              resolvedTerms.push({ term, type: tag.type, slug: tag.slug || slug });
              resolved = true;
            }
          }
        } catch (err) {
          const tagVariants = term.includes("-") ? [term, term.replace("-", " ")] : [term];
          const orClauses = tagVariants.map(v => `name.ilike.%${v}%`).join(",");
          const { data: tagDataName } = (await supabase
            .from("tags")
            .select("id, type, name")
            .or(orClauses)
            .in("type", ["diet", "dietary", "religious", "allergen"])
            .limit(1)) as { data: Array<{ id: string; type: string; name: string }> | null };

          if (tagDataName && tagDataName.length > 0) {
            const tag = tagDataName[0];
            if (!seenTagIds.has(tag.id)) {
              tagIds.push(tag.id);
              seenTagIds.add(tag.id);
              resolvedTerms.push({ term, type: tag.type, slug: slugify(tag.name) });
              resolved = true;
            }
          }
        }
      }
    }
  }

  return { tagIds, resolvedTerms };
}

// ============================================
// HANDLER FUNCTIONS
// ============================================

// ============================================
// EXPLAINER HELPER FUNCTIONS (Patch 0.9)
// ============================================

type ExplainSubtype = "DEFINITION" | "DISH_SPECIFIC";

function classifyExplainSubtype(query: string): ExplainSubtype {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(t => t.length > 0);

  // Short noun phrase (<= 3 tokens without question words) → DEFINITION
  // Examples: "gobi", "paneer", "what is gobi"
  const questionStopwords = ["what", "is", "are", "the", "a", "an", "and", "or", "vad", "är"];
  const nonStopTokens = tokens.filter(t => !questionStopwords.includes(t));
  if (nonStopTokens.length <= 2 && nonStopTokens.length > 0) {
    return "DEFINITION";
  }

  // Definition patterns (explicit "what is" style questions)
  const defRegex = /^\s*(what is|what's|define|meaning of|translate|vad är|vad betyder|ki ha|ki aa|ki hai|kya hai|kya hota hai|ਕੀ ਹੈ|ਕੀ ਆ)\b/i;
  const isDef = defRegex.test(q) || q.includes("ki ha") || q.includes("ki aa");

  // Dish-specific patterns (asking about a specific dish's properties)
  const dishSpecificPatterns = [
    /\b(does|do)\s+(it|this|the|that)\s+(contain|have)/i,
    /\bis\s+(it|this|the)\s+(spicy|creamy|sweet|sour|vegan|vegetarian|halal|kosher|gluten)/i,
    /\b(contain|contains|have|has)\s+(nuts|milk|gluten|dairy|egg|allergen)/i,
    /\b(is|are)\s+.*(in|inside)\s+(the|this|that)?\s*(dish|meal|pizza|curry)/i
  ];
  const isDishSpecific = dishSpecificPatterns.some(p => p.test(q));

  if (isDishSpecific) return "DISH_SPECIFIC";
  if (isDef) return "DEFINITION";

  // Default: if short query, treat as definition; otherwise dish-specific
  return tokens.length <= 4 ? "DEFINITION" : "DISH_SPECIFIC";
}

// Legacy wrapper for backward compatibility
function classifyExplainType(query: string): "DEFINITION" | "MENU_FACT" {
  const subtype = classifyExplainSubtype(query);
  return subtype === "DEFINITION" ? "DEFINITION" : "MENU_FACT";
}

function extractKeyTermForDefinition(query: string): string | null {
  const q = query.toLowerCase()
    .replace(/[?!.,]/g, "")
    // Remove definition stopwords in all supported languages
    .replace(/\b(what|is|are|the|a|an|meaning|define|translate|of|vad|är|betyder|det|en|ett|ki|ha|aa|hai|kya|hota|ਕੀ|ਹੈ|ਆ)\b/gi, "")
    .trim();
  return q.length > 2 ? q : null;
}

function findMenuMentions(payload: GroundedState, term: string): string[] {
  const matches: string[] = [];
  const lowerTerm = term.toLowerCase();

  for (const r of payload.restaurants) {
    if (matches.length >= 3) break;
    for (const d of (r.matches || [])) {
      const text = `${d.name} ${d.description ?? ""}`.toLowerCase();
      if (text.includes(lowerTerm)) {
        matches.push(`${d.name} (${r.name})`);
        if (matches.length >= 3) break;
      }
    }
  }
  return matches;
}

// ============================================
// SHOW_MENU HELPER FUNCTIONS (Patch 0.9)
// ============================================

type RestaurantResolveResult = {
  matched: { id: string; name: string } | null;
  candidates: { id: string; name: string; score: number }[];
};

function normalizeForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/[''`]/g, "") // Remove apostrophes
    .replace(/[\s\-_]+/g, "") // Remove spaces, hyphens, underscores
    .replace(/[^a-z0-9]/g, ""); // Remove non-alphanumeric
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

async function resolveRestaurantForMenu(
  query: string,
  intentRestaurantName: string | null,
  grounded: GroundedState | null,
  supabase: any
): Promise<RestaurantResolveResult> {
  const searchTerm = intentRestaurantName || query;
  const normalizedSearch = normalizeForMatch(searchTerm);

  console.log("[discover][show-menu][resolve]", { input: searchTerm, normalizedSearch });

  // 1) Try grounded restaurants first (if any)
  if (grounded?.restaurants?.length) {
    for (const r of grounded.restaurants) {
      if (normalizeForMatch(r.name) === normalizedSearch) {
        console.log("[discover][show-menu][resolve]", { chosen: r.name, source: "exact-grounded" });
        return { matched: { id: r.id, name: r.name }, candidates: [] };
      }
    }
    // Fuzzy match on grounded
    for (const r of grounded.restaurants) {
      if (normalizeForMatch(r.name).includes(normalizedSearch) || normalizedSearch.includes(normalizeForMatch(r.name))) {
        console.log("[discover][show-menu][resolve]", { chosen: r.name, source: "fuzzy-grounded" });
        return { matched: { id: r.id, name: r.name }, candidates: [] };
      }
    }
  }

  // 2) Query database for fuzzy match
  const { data: dbRestaurants } = await supabase
    .from("restaurants")
    .select("id, name")
    .eq("public_searchable", true)
    .limit(50);

  if (!dbRestaurants?.length) {
    return { matched: null, candidates: [] };
  }

  // Score candidates by string similarity
  const scored = dbRestaurants.map((r: { id: string; name: string }) => {
    const normalizedName = normalizeForMatch(r.name);
    let score = 0;

    // Exact match
    if (normalizedName === normalizedSearch) score = 100;
    // Contains match
    else if (normalizedName.includes(normalizedSearch)) score = 80;
    else if (normalizedSearch.includes(normalizedName)) score = 70;
    // Levenshtein similarity
    else {
      const distance = levenshteinDistance(normalizedSearch, normalizedName);
      const maxLen = Math.max(normalizedSearch.length, normalizedName.length);
      score = Math.max(0, 100 - (distance / maxLen) * 100);
    }

    return { id: r.id, name: r.name, score };
  }).filter((r: { score: number }) => r.score > 40)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  const candidates = scored.slice(0, 3);

  console.log("[discover][show-menu][resolve]", {
    chosen: candidates[0]?.name ?? null,
    candidates: candidates.map((c: { name: string; score: number }) => ({ name: c.name, score: c.score }))
  });

  // Return best match if score is high enough
  if (candidates.length > 0 && candidates[0].score >= 60) {
    return { matched: { id: candidates[0].id, name: candidates[0].name }, candidates };
  }

  return { matched: null, candidates };
}

// ============================================
// FALLBACK SEARCH CHAIN (Patch 0.9B)
// ============================================

type FallbackResult = {
  restaurantCards: RestaurantCard[];
  trace: string;
  step: "A" | "B" | "C" | "D" | "E";
  wasTagFiltered: boolean; // True if results came from tag-filtered search
};

async function fallbackSearchChain(args: {
  resolvedTagIds: string[];
  queryText: string | null;
  city: string | null;
  dietaryLabels: string[];
  supabase: any;
  perf?: Record<string, number> | null;
}): Promise<FallbackResult> {
  const { resolvedTagIds, queryText, city, dietaryLabels, supabase, perf } = args;
  const hasStrictTags = resolvedTagIds.length > 0;

  // Helper to convert RPC rows to RestaurantCards
  const rowsToCards = (rows: any[]): RestaurantCard[] => {
    const restaurantsMap = new Map<string, RestaurantCard>();
    rows.forEach((row: any) => {
      if (!restaurantsMap.has(row.restaurant_id)) {
        restaurantsMap.set(row.restaurant_id, {
          id: row.restaurant_id,
          name: row.restaurant_name,
          city: row.restaurant_city || row.city || null,
          matches: []
        });
      }
      if (row.dish_id) {
        restaurantsMap.get(row.restaurant_id)!.matches!.push({
          id: row.dish_id,
          name: row.dish_name,
          description: row.dish_description,
          price: row.dish_price || row.price,
          tags: row.matched_tags,
          section_name: row.section_name || null, // Preserve hydrated section_name for filtering
        });
      }
    });
    return normalizeRestaurantCards(Array.from(restaurantsMap.values()));
  };

  // Helper to hydrate section_name on RPC rows BEFORE converting to cards
  // This enables section-based filtering like "veg pizza" → dishes in "Pizza" section
  const hydrateSectionNames = async (rows: any[]) => {
    const dishIds = rows.map(r => r.dish_id).filter(Boolean);
    if (dishIds.length === 0) return;

    // Query dishes table with section_id FK to sections table
    // FK relationship: dishes.section_id -> sections.id
    const { data, error } = await supabase
      .from("dishes")
      .select("id, section_id, sections:section_id(name)")
      .in("id", dishIds);

    if (error) {
      console.log("[discover][hydrateSectionNames] Error:", error.message);
      return;
    }

    console.log("[discover][hydrateSectionNames] Query result:", {
      dishCount: dishIds.length,
      resultCount: data?.length ?? 0,
      sample: data?.[0] ? { id: data[0].id, section_id: (data[0] as any).section_id, sections: (data[0] as any).sections } : null
    });

    const map = new Map<string, string | null>();
    (data || []).forEach((d: any) => {
      const sectionName = d.sections?.name || null;
      map.set(d.id, sectionName);
    });

    for (const row of rows) {
      row.section_name = map.get(row.dish_id) || null;
    }

    console.log("[discover][hydrateSectionNames] Hydrated:", {
      rowsWithSection: rows.filter(r => r.section_name).length,
      sampleSection: rows[0]?.section_name
    });
  };

  // Helper to hydrate owner_id on RestaurantCards for claimed/unclaimed badge
  const hydrateOwnerIds = async (cards: RestaurantCard[]): Promise<void> => {
    if (cards.length === 0) return;

    const restaurantIds = cards.map(c => c.id);
    const { data, error } = await supabase
      .from("restaurants")
      .select("id, owner_id")
      .in("id", restaurantIds);

    if (error) {
      console.log("[discover][hydrateOwnerIds] Error:", error.message);
      return;
    }

    const ownerMap = new Map<string, string | null>();
    (data || []).forEach((r: { id: string; owner_id: string | null }) => {
      ownerMap.set(r.id, r.owner_id);
    });

    for (const card of cards) {
      card.ownerId = ownerMap.get(card.id) ?? null;
    }

    console.log("[discover][hydrateOwnerIds] Hydrated:", {
      cardsWithOwner: cards.filter(c => c.ownerId).length,
      totalCards: cards.length
    });
  };

  // STEP A: strict tags + query_text + city
  if (hasStrictTags) {
    const tStepA = perf ? performance.now() : 0;
    const { data: stepA, error: errA } = await supabase.rpc("search_public_dishes_by_tags_strict", {
      dietary_tag_ids: resolvedTagIds,
      query_text: queryText,
      limit_count: 20,
      service_filters: null,
      target_city: city
    });
    if (perf) perf.rpcStepA = performance.now() - tStepA;

    if (!errA && stepA?.length > 0) {
      // DEBUG: Check if matched_tags is coming through
      // DEBUG: Check if section_name comes through from RPC
      console.log("[discover][fallback] stepA first row:", {
        dish_name: stepA[0]?.dish_name,
        section_name: stepA[0]?.section_name,  // RPC should return this directly
        matched_tags: stepA[0]?.matched_tags,
      });
      // NOTE: section_name should come directly from RPC, no need for separate hydration
      const cards = rowsToCards(stepA);
      // DEBUG: Check if section survived into cards
      console.log("[discover][fallback] AFTER rowsToCards - first dish:", {
        restaurant_name: cards[0]?.name,
        first_dish_name: cards[0]?.matches?.[0]?.name,
        first_dish_section: (cards[0]?.matches?.[0] as any)?.section_name
      });
      console.log("[discover][fallback]", { step: "A", rows: stepA.length, cardCount: cards.length });
      await hydrateOwnerIds(cards);
      return { restaurantCards: cards, trace: "A: strict tags + query + city", step: "A", wasTagFiltered: true };
    }
    console.log("[discover][fallback]", { step: "A", rows: 0, error: errA?.message ?? null });

    // STEP B: strict tags only (query_text = null)
    const tStepB = perf ? performance.now() : 0;
    const { data: stepB, error: errB } = await supabase.rpc("search_public_dishes_by_tags_strict", {
      dietary_tag_ids: resolvedTagIds,
      query_text: null,
      limit_count: 20,
      service_filters: null,
      target_city: city
    });
    if (perf) perf.rpcStepB = performance.now() - tStepB;

    if (!errB && stepB?.length > 0) {
      // DEBUG: Check if section_name comes through from RPC
      console.log("[discover][fallback] stepB first row:", {
        dish_name: stepB[0]?.dish_name,
        section_name: stepB[0]?.section_name,  // RPC should return this directly
      });
      // NOTE: section_name should come directly from RPC, no need for separate hydration
      const cards = rowsToCards(stepB);
      console.log("[discover][fallback]", { step: "B", rows: stepB.length, cardCount: cards.length, firstDishSection: (cards[0]?.matches?.[0] as any)?.section_name });
      await hydrateOwnerIds(cards);
      return { restaurantCards: cards, trace: "B: strict tags only", step: "B", wasTagFiltered: true };
    }
    console.log("[discover][fallback]", { step: "B", rows: 0, error: errB?.message ?? null });
  }

  // STEP C: query only (no tags) using fuzzy search
  if (queryText && queryText.length > 0) {
    const tStepC = perf ? performance.now() : 0;
    const { data: stepC, error: errC } = await supabase.rpc("search_public_dishes_fuzzy", {
      search_text: queryText,
      target_city: city,
      similarity_threshold: 0.3 // Higher threshold for more relevant results
    });
    if (perf) perf.rpcStepC = performance.now() - tStepC;

    if (!errC && stepC?.length > 0) {
      // This RPC returns matching_dishes as JSONB, need to transform
      const cards = stepC.map((r: any) => ({
        id: r.restaurant_id,
        name: r.restaurant_name,
        city: r.restaurant_city,
        matches: Array.isArray(r.matching_dishes) ? r.matching_dishes.map((d: any) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          price: d.price
        })) : []
      })).filter((c: any) => c.matches.length > 0);

      if (cards.length > 0) {
        console.log("[discover][fallback]", { step: "C", rows: stepC.length, cardCount: cards.length });
        const normalizedCards = normalizeRestaurantCards(cards);
        await hydrateOwnerIds(normalizedCards);
        return { restaurantCards: normalizedCards, trace: "C: query only (fuzzy)", step: "C", wasTagFiltered: false };
      }
    }
    console.log("[discover][fallback]", { step: "C", rows: 0, error: errC?.message ?? null });
  }

  // STEP D: semantic/fuzzy relaxed (broader search, lower threshold, no city filter)
  if (queryText && queryText.length > 0) {
    const { data: stepD, error: errD } = await supabase.rpc("search_public_dishes_fuzzy", {
      search_text: queryText,
      target_city: null, // Ignore city for broader reach
      similarity_threshold: 0.15 // Lower threshold for more results
    });

    if (!errD && stepD?.length > 0) {
      const cards = stepD.map((r: any) => ({
        id: r.restaurant_id,
        name: r.restaurant_name,
        city: r.restaurant_city,
        matches: Array.isArray(r.matching_dishes) ? r.matching_dishes.map((d: any) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          price: d.price
        })) : []
      })).filter((c: any) => c.matches.length > 0);

      if (cards.length > 0) {
        console.log("[discover][fallback]", { step: "D", rows: stepD.length, cardCount: cards.length });
        const normalizedCards = normalizeRestaurantCards(cards);
        await hydrateOwnerIds(normalizedCards);
        return { restaurantCards: normalizedCards, trace: "D: fuzzy relaxed", step: "D", wasTagFiltered: false };
      }
    }
    console.log("[discover][fallback]", { step: "D", rows: 0, error: errD?.message ?? null });
  }

  // STEP E: UI fallback - show top restaurants (no dishes, just restaurant names)
  const { data: topRestaurants } = await supabase
    .from("restaurants")
    .select("id, name, city")
    .eq("public_searchable", true)
    .order("name", { ascending: true })
    .limit(5);

  const topCards: RestaurantCard[] = (topRestaurants || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    matches: [] // No dishes - just restaurant names
  }));

  console.log("[discover][fallback]", { step: "E", rows: 0, cardCount: topCards.length });
  await hydrateOwnerIds(topCards);
  return { restaurantCards: topCards, trace: "E: top restaurants fallback", step: "E", wasTagFiltered: false };
}


async function handleFollowup(args: {
  query: string;
  intent: Intent;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
  openai: any;
}) {
  const { query, intent, groundedFromClient, chatStateFromClient, openai } = args;
  const replyLang = pickReplyLang({
    intentLang: intent.language,
    preferredLang: chatStateFromClient?.preferred_language ?? null,
    query
  });
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Guard: If no grounded context, we can't do a follow-up - return a helpful message
  if (!groundedFromClient || !groundedFromClient.restaurants) {
    console.log("[discover][followup] No grounded context, returning clarification");
    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: "I don't have any previous results to refer to. Could you tell me what you're looking for?",
        restaurants: [],
        followupChips: []
      },
      chatStateFromClient!,
      "handleFollowup_NoContext"
    ));
  }

  const payload = groundedFromClient;

  const explainType = classifyExplainType(query);
  console.log("[discover][dish-explain]", { explainType, query });

  if (explainType === "DEFINITION") {
    // Extract the definition term from the query
    const definitionTerm = extractKeyTermForDefinition(query);

    // Find menu mentions - scan grounded dishes for term in name/description
    const menuMentions = definitionTerm ? findMenuMentions(payload, definitionTerm) : [];
    const menuMentionDishName = menuMentions.length > 0 ? menuMentions[0] : null;

    // Enhanced logging for debugging
    console.log("[discover][followup-def]", {
      query,
      definitionTerm,
      menuMentionDishName,
      totalMentions: menuMentions.length
    });

    // DEFINITION MODE: General knowledge ONLY, with separate menu mentions
    const systemPrompt = `You are a helpful food assistant.
Answer general food knowledge questions ONLY.
Do NOT mention any restaurant/menu facts.
Keep definitions concise (1-2 sentences).
Reply language: ${languageName(replyLang)}.`;

    const userPrompt = `User question: "${query}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3
    });

    let answer = completion.choices[0]?.message?.content?.trim() || "I don't have details on that.";

    // Append menu mention ONLY if term was found in grounded dishes
    if (definitionTerm && menuMentions.length > 0) {
      answer += `\n\nOn this menu, I see "${definitionTerm}" mentioned in: ${menuMentions.join(", ")}.`;
    }

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: answer,
        restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
        followupChips: []
      },
      { ...chatStateFromClient, grounded: payload },
      "handleFollowup_Def"
    ));
  }

  // MENU_FACT MODE (Original Logic with stricter context)

  // Extract query terms for matching (remove stopwords)
  const queryTerms = query
    .toLowerCase()
    .replace(/\b(what|is|are|vad|är|the|a|an|det|en|ett|does|contain|have|har|innehåller)\b/gi, "")
    .replace(/[?!.,]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 2);

  // Find the best matching dish based on query terms
  let bestMatch: { restaurant: string; dish: string; description: string; price: number | null } | null = null;

  for (const r of payload.restaurants.slice(0, 5)) {
    for (const d of (r.matches || []).slice(0, 10)) {
      const dishText = `${d.name} ${d.description ?? ""}`.toLowerCase();
      for (const term of queryTerms) {
        if (dishText.includes(term)) {
          bestMatch = {
            restaurant: r.name,
            dish: d.name,
            description: d.description ?? "",
            price: d.price ?? null
          };
          break;
        }
      }
      if (bestMatch) break;
    }
    if (bestMatch) break;
  }

  // Build single-dish context (If no match found, PROVIDE NO CONTEXT)
  const ctxLines: string[] = [];
  if (bestMatch) {
    const priceStr = bestMatch.price ? ` | Price: ${bestMatch.price} kr` : "";
    ctxLines.push(`Restaurant: ${bestMatch.restaurant} | Dish: ${bestMatch.dish} | Description: ${bestMatch.description}${priceStr}`);
  }

  // If user is asking a FACT but we have no matching dish context -> Clarify or fail gracefully
  if (ctxLines.length === 0) {
    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: replyLang === "sv"
          ? "Jag är osäker på vilken rätt du menar. Kan du precisera? (t.ex. Margherita eller Funghi)"
          : "I'm unsure which dish you mean. Could you specify? (e.g., Margherita or Funghi)",
        restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
        followupChips: []
      },
      { ...chatStateFromClient, grounded: payload },
      "handleFollowup_FactNoMatch"
    ));
  }

  // Updated system prompt: allows general knowledge, restricts menu claims
  const followupSystem = `You are a helpful food assistant.
You can answer general food knowledge questions (ingredients, cooking methods, origins).
Menu/restaurant facts MUST come only from the provided context lines.
Do NOT infer ingredients for dishes not in the context.
Do NOT claim a dish contains or lacks something unless it's explicitly in the context.
If asked about allergens or ingredients not in context, say you don't have that menu detail.

IMPORTANT: You MUST respond entirely in ${languageName(replyLang)}. Do NOT respond in any other language.`;

  const followupUser = `User question: "${query}"
Context:
${ctxLines.join("\n")}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: followupSystem },
      { role: "user", content: followupUser },
    ],
    temperature: 0.3,
  });

  const answer = completion.choices[0]?.message?.content?.trim() || "I don't have details on that.";

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: answer,
      restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
      followupChips: [],
    },
    { ...chatStateFromClient, grounded: payload },
    "handleFollowup_Fact"
  ));
}

async function handleDishExplain(args: {
  query: string;
  intent: Intent;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
  openai: any;
}) {
  const { query, intent, groundedFromClient, chatStateFromClient, openai } = args;
  const replyLang = pickReplyLang({
    intentLang: intent.language,
    preferredLang: chatStateFromClient?.preferred_language ?? null,
    query
  });
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Guard: If no grounded context, use empty payload
  const payload: GroundedState = groundedFromClient ?? {
    restaurants: [],
    lastQuery: undefined,
    lastDietary: null
  };

  const explainType = classifyExplainType(query);

  // Find best dish match (only if query includes a dish name)
  const q = query.toLowerCase();
  let best: { restaurantName: string; restaurantCity?: string; dishName: string; dishDescription?: string } | null = null;

  // Try to find a specific dish mentions in the query
  for (const r of payload.restaurants.slice(0, 5)) {
    for (const d of (r.matches || []).slice(0, 10)) {
      const name = (d.name || "").toLowerCase();
      // Strict match: query must include the dish name
      if (name && q.includes(name)) {
        best = { restaurantName: r.name, restaurantCity: r.city || undefined, dishName: d.name, dishDescription: d.description || undefined };
        break;
      }
    }
    if (best) break;
  }

  console.log("[discover][dish-explain]", { explainType, query, bestDish: best?.dishName ?? null });

  // A) DEFINITION MODE
  if (explainType === "DEFINITION") {
    // Extract the definition term from the query
    const definitionTerm = extractKeyTermForDefinition(query);

    // Find menu mentions - scan grounded dishes for term in name/description
    const menuMentions = definitionTerm ? findMenuMentions(payload, definitionTerm) : [];
    const menuMentionDishName = menuMentions.length > 0 ? menuMentions[0] : null;

    // Enhanced logging for debugging
    console.log("[discover][dish-explain-def]", {
      query,
      definitionTerm,
      menuMentionDishName,
      totalMentions: menuMentions.length
    });

    const defSystem = `You are a helpful food assistant.
Answer general food knowledge questions ONLY (origin, ingredients, taste).
Do NOT mention any restaurant/menu facts.
Keep definitions concise (1-2 sentences).

IMPORTANT: You MUST respond entirely in ${languageName(replyLang)}. Do NOT respond in any other language.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: defSystem },
        { role: "user", content: `User question: "${query}"` },
      ],
      temperature: 0.3,
    });

    let answer = completion.choices[0]?.message?.content?.trim() || "I don't have details on that.";

    // Append menu mention ONLY if term was found in grounded dishes
    if (definitionTerm && menuMentions.length > 0) {
      answer += `\n\nOn this menu, I see "${definitionTerm}" mentioned in: ${menuMentions.join(", ")}.`;
    }

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: answer,
        restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
        followupChips: [],
      },
      {
        ...chatStateFromClient,
        grounded: payload,
        last_explain: { text: answer, language: replyLang, dishIds: [] }
      },
      "handleDishExplain_Def"
    ));
  }

  // B) MENU_FACT MODE
  // If best is null -> clarify (don't guess)
  if (!best) {
    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: replyLang === "sv"
          ? "Jag är osäker på vilken rätt du menar. Kan du precisera? (t.ex. Margherita eller Funghi)"
          : "Which dish do you mean? (e.g., Margherita or Funghi)",
        restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
        followupChips: []
      },
      { ...chatStateFromClient, grounded: payload },
      "handleDishExplain_NoMatch"
    ));
  }

  const dishExplainerSystem = `You are a helpful food assistant.
You MAY answer general questions about what a dish is (origin/cuisine, typical style, typical taste).
BUT:
- Any claims about allergens, ingredients, dietary suitability (vegan/gluten-free/halal), or "contains X" MUST come ONLY from the provided menu facts.
- For taste/spice/creaminess/sweetness, use probabilistic language: "typically", "often", "usually".
- End with a short safety note that recipes vary and to confirm with the restaurant.

IMPORTANT: You MUST respond entirely in ${languageName(replyLang)}. Do NOT respond in any other language.`;

  const menuFacts = `Restaurant: ${best.restaurantName}${best.restaurantCity ? ` (${best.restaurantCity})` : ""}
Dish: ${best.dishName}
Menu description: ${best.dishDescription ?? "—"}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: dishExplainerSystem },
      { role: "user", content: `User question: "${query}"\n\nMenu facts:\n${menuFacts}` },
    ],
    temperature: 0.4,
  });

  const answer = completion.choices[0]?.message?.content?.trim() || "I can explain the dish in general, but I don't have more menu details here.";

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: answer,
      restaurants: finalize(payload.restaurants as RestaurantCard[], chatStateFromClient, intent),
      followupChips: [],
    },
    {
      ...chatStateFromClient,
      grounded: payload,
      last_explain: { text: answer, language: replyLang, dishIds: best ? [best.dishName] : [] }
    },
    "handleDishExplain_Fact"
  ));
}

async function handleReshow(args: {
  query: string;
  intent: Intent;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
  prefs: ChatPrefs;
}) {
  const { query, intent, groundedFromClient, chatStateFromClient, prefs } = args;
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const isSwedish = prefs.language === "sv";

  // Anti-loop: Don't reshow if last search had no results
  if (groundedFromClient?.lastWasNoResults) {
    console.log("[discover][antiloop] Blocking RESHOW after no-results");
    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: isSwedish
          ? "Jag hittade inga explicita taggar ännu (eller täckningen är begränsad). Vill du söka efter rättnamn (butter chicken/pizza) eller välja en stad?"
          : "I didn't find explicit tags yet (or coverage is limited). Want to search by dish name (butter chicken/pizza) or pick a city?",
        restaurants: [],
        followupChips: [],
      },
      { ...chatStateFromClient, prefs, lastAnswerKind: "clarify" },
      "handleReshow:blocked"
    ));
  }

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: isSwedish
        ? "Här är de bästa alternativen igen. Vill du att jag filtrerar på en specifik rätt?"
        : "Here are the top options again. Want me to narrow it to a specific dish?",
      restaurants: finalize(normalizeRestaurantCards(groundedFromClient?.restaurants || []), chatStateFromClient, intent),
      followupChips: [],
    },
    { ...chatStateFromClient, prefs, lastAnswerKind: "results", grounded: groundedFromClient },
    "handleReshow"
  ));
}

async function handleExitRestaurant(args: {
  query: string;
  intent: Intent;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
}) {
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: "Back to searching all restaurants. What would you like to find?",
      restaurants: [],
      followupChips: [],
    },
    {
      mode: "discovery",
      currentRestaurantId: null,
      currentRestaurantName: null,
      grounded: args.groundedFromClient!,
    },
    "handleExitRestaurant"
  ));
}

async function handleShowMenu(args: {
  query: string;
  intent: Intent;
  chatStateFromClient: ChatState | null;
  request: NextRequest;
}) {
  const { query, intent, chatStateFromClient, request } = args;
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const buildMenuUrl = (restaurantId: string) => {
    const menuBaseUrl = process.env.NEXT_PUBLIC_MENU_BASE_URL;
    if (menuBaseUrl) return `${menuBaseUrl}/menu/${restaurantId}`;
    const requestOrigin = request.headers.get("origin") || request.headers.get("host");
    const baseUrl = requestOrigin
      ? (requestOrigin.startsWith("http") ? requestOrigin : `https://${requestOrigin}`)
      : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
    return `${baseUrl}/menu/${restaurantId}`;
  };

  // 1) If already in restaurant mode with a current restaurant, use that
  if (chatStateFromClient?.currentRestaurantId) {
    const menuData = await getPublicMenu(chatStateFromClient.currentRestaurantId);
    if (menuData) {
      console.log("[discover][show-menu]", { source: "current-restaurant", name: menuData.restaurantName });
      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: `Here's ${menuData.restaurantName}'s full menu.`,
          menu: menuData,
          menuUrl: buildMenuUrl(chatStateFromClient.currentRestaurantId),
          restaurants: [],
          followupChips: [],
        },
        buildFocusedChatState({
          id: menuData.restaurantId,
          name: menuData.restaurantName
        }, chatStateFromClient),
        "handleShowMenu:current"
      ));
    }
  }

  // 2) Use fuzzy resolution
  const supabaseService = await createServiceRoleClient();
  const resolveResult = await resolveRestaurantForMenu(
    query,
    intent.restaurant_name ?? null,
    null, // No grounded state for SHOW_MENU
    supabaseService
  );

  // 3) If matched, show menu
  if (resolveResult.matched) {
    const menuData = await getPublicMenu(resolveResult.matched.id);
    if (menuData) {
      console.log("[discover][show-menu]", { source: "fuzzy-resolved", name: menuData.restaurantName });
      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: `Here's ${menuData.restaurantName}'s full menu.`,
          menu: menuData,
          menuUrl: buildMenuUrl(resolveResult.matched.id),
          restaurants: [],
          followupChips: [],
        },
        buildFocusedChatState({
          id: menuData.restaurantId,
          name: menuData.restaurantName
        }, chatStateFromClient),
        "handleShowMenu:fuzzy"
      ));
    }
  }

  // 4) No match - ask for clarification with suggestions
  const suggestions = resolveResult.candidates.length > 0
    ? resolveResult.candidates.map(c => c.name)
    : ["Indian Bites", "Tavolino"]; // Fallback suggestions

  console.log("[discover][show-menu]", { source: "no-match", suggestions });

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: `Which restaurant's menu would you like to see? Try one of these: ${suggestions.join(", ")}`,
      restaurants: [],
      followupChips: [],
    },
    { mode: "discovery", currentRestaurantId: null, currentRestaurantName: null },
    "handleShowMenu:clarify"
  ));
}

// ============================================
// RESTAURANT LOOKUP HANDLER (Google-style profile)
// ============================================
async function handleRestaurantLookup(args: {
  query: string;
  intent: Intent;
  chatStateFromClient: ChatState | null;
  openai: any;
}): Promise<NextResponse> {
  const { query, intent, chatStateFromClient, openai } = args;
  // Calculate reply language using priority logic
  const replyLang = pickReplyLang({
    intentLang: intent.language,
    preferredLang: chatStateFromClient?.preferred_language ?? null,
    query
  });
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  console.log("[discover][restaurant-lookup] Starting lookup:", {
    query,
    restaurantName: intent.restaurant_name,
    isRestaurantLookup: intent.is_restaurant_lookup
  });

  try {
    const supabase = await createClient();

    // Use restaurant_name from intent, or the original query
    const searchText = intent.restaurant_name || query;

    const restaurantProfile = await findBestRestaurantMatch({
      queryText: searchText,
      city: intent.city,
      supabase,
    });

    if (!restaurantProfile) {
      // No strong match found
      console.log("[discover][restaurant-lookup] No match found");

      // Check if user explicitly used restaurant intent words
      // Only show "restaurant not found" message if they explicitly asked for a restaurant
      const explicitRestaurantWords = /\b(restaurant|place|cafe|pizzeria|restaurang|ställe|bar|bistro|eatery)\b/i;
      const hasExplicitRestaurantIntent = explicitRestaurantWords.test(query);

      if (hasExplicitRestaurantIntent) {
        // User explicitly asked for restaurant -> show "not found" message
        const message = `I couldn't find an exact restaurant named "${searchText}". Here are some suggestions:`;
        const translatedMessage = await translateIfNeeded(openai, message, replyLang);
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            kind: "answer",
            content: translatedMessage,
            restaurants: [],
            followupChips: [],
          },
          {
            ...chatStateFromClient,
            mode: "discovery"
          },
          "handleRestaurantLookup_NoMatch"
        ));
      }

      // No explicit restaurant intent -> fallback to normal discovery search
      console.log("[discover][restaurant-lookup] Falling back to discovery search");
      const fallbackPlan: Plan = {
        action: "SEARCH",
        confidence: 0.8,
        reason: null,
        prefs_patch: null,
        dish_query: null,
        search: null
      };
      return handleSearch({
        query,
        intent: { ...intent, is_restaurant_lookup: false, restaurant_name: null },
        plan: fallbackPlan,
        groundedFromClient: null,
        chatStateFromClient,
        openai,
        skipRestaurantLookup: true, // Prevent infinite loop
      });
    }

    console.log("[discover][restaurant-lookup] Found restaurant:", {
      id: restaurantProfile.id,
      name: restaurantProfile.name,
      isOpen: restaurantProfile.is_open_now,
      menuPreviewCount: restaurantProfile.menu_preview?.length
    });

    // Build profile response - NO extra assistant text, just the card
    const profileCard: RestaurantCard = {
      id: restaurantProfile.id,
      name: restaurantProfile.name,
      city: restaurantProfile.city,
      address: restaurantProfile.address,
      cuisine_type: restaurantProfile.cuisine_type,
      phone: restaurantProfile.phone,
      // email deliberately omitted from card display (put under "More")
      website: restaurantProfile.website,
      opening_hours: restaurantProfile.opening_hours,
      accepts_dine_in: restaurantProfile.accepts_dine_in,
      accepts_takeaway: restaurantProfile.accepts_takeaway,
      accepts_delivery: restaurantProfile.accepts_delivery,
      accepts_reservations: restaurantProfile.accepts_reservations,
      amenities: restaurantProfile.amenities,
      matches: restaurantProfile.menu_preview || [],
      highlight: restaurantProfile.menu_preview?.[0]?.name || null,
    };

    // Build status text (deterministic, no emojis for UI logic)
    const statusText = restaurantProfile.is_open_now
      ? `Open now` + (restaurantProfile.today_hours ? ` • ${restaurantProfile.today_hours}` : "")
      : `Closed` + (restaurantProfile.today_hours ? ` • Opens: ${restaurantProfile.today_hours}` : "");

    const translatedStatus = await translateIfNeeded(openai, statusText, replyLang);

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        kind: "restaurant_profile", // Explicit kind for UI rendering
        content: translatedStatus,
        restaurants: finalize([profileCard], chatStateFromClient, intent),
        followupChips: ["Ask about this restaurant"],
      },
      // Disable auto-focus: stay in discovery mode
      // The user must click "Ask about this restaurant" to focus
      chatStateFromClient || { mode: "discovery" },
      "handleRestaurantLookup_Success"
    ));

  } catch (error) {
    console.error("[discover][restaurant-lookup] Error:", error);
    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        kind: "answer",
        content: "I had trouble looking up that restaurant. Could you try again?",
        restaurants: [],
        followupChips: [],
      },
      chatStateFromClient || { mode: "discovery" },
      "handleRestaurantLookup_Error"
    ));
  }
}

async function handleRestaurantScopedSearch(args: {
  query: string;
  intent: Intent;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
  openai: any;
}) {
  const { query, intent, groundedFromClient, chatStateFromClient, openai } = args;
  const supabase = await createClient();

  const restaurantProfile = await findBestRestaurantMatch({
    queryText: intent.restaurant_name || query,
    city: intent.city,
    supabase,
  });

  if (!restaurantProfile) {
    // fallback: normal discovery search
    return await handleSearch({
      query,
      intent,
      plan: { action: "SEARCH", confidence: 1 } as any,
      groundedFromClient,
      chatStateFromClient,
      openai,
    });
  }

  const focusedState = buildFocusedChatState(
    { id: restaurantProfile.id, name: restaurantProfile.name },
    chatStateFromClient,
    restaurantProfile.menu_preview
  );

  // Ensure city is set if missing (optional)
  intent.city = intent.city ?? restaurantProfile.city ?? null;

  // Cleansing: If dish_query is generic "menu", clear it to trigger full menu browse
  // "pull menu" -> null (shows top dishes)
  // "chicken menu" -> "chicken menu" (searches for chicken)
  if (intent.dish_query && /\b(show|pull|dishes|options)\b/i.test(intent.dish_query) && !/\b(chicken|pizza|burger|curry|masala|paneer|dal|sushi|pasta)\b/i.test(intent.dish_query)) {
    console.log("[handleRestaurantScopedSearch] Clearing generic menu query:", intent.dish_query);
    intent.dish_query = null;
  }

  return await handleSearch({
    query,
    intent,
    plan: { action: "SEARCH", confidence: 1 } as any,
    groundedFromClient,
    chatStateFromClient: focusedState,
    openai,
  });
}

async function handleClarify(args: {
  query: string;
  intent: Intent;
  chatStateFromClient: ChatState | null;
  openai: any;
}): Promise<NextResponse> {
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const replyLang = pickReplyLang({
    intentLang: args.intent.language,
    preferredLang: args.chatStateFromClient?.preferred_language ?? null,
    query: args.query
  });
  const text = "What type of cuisine or dish are you in the mood for? I can help you find restaurants based on specific dishes, dietary preferences, or cuisine types.";
  const translated = await translateIfNeeded(args.openai, text, replyLang);

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: translated,
      restaurants: [],
      followupChips: [],
    },
    args.chatStateFromClient || { mode: "discovery" },
    "handleClarify"
  ));
}

async function handleSearch(args: {
  query: string;
  intent: Intent;
  plan: Plan;
  groundedFromClient: GroundedState | null;
  chatStateFromClient: ChatState | null;
  openai: any;
  perf?: Record<string, number> | null;
  t0?: number;
  DEBUG_PERF?: boolean;
  skipRestaurantLookup?: boolean; // Prevent infinite loop when falling back from restaurant lookup
}): Promise<NextResponse> {
  const { query, intent, plan, chatStateFromClient, openai, perf, t0, DEBUG_PERF, skipRestaurantLookup } = args;
  const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Determine effective mode
  const mode = chatStateFromClient?.mode ?? "discovery";
  const currentRestaurantId = chatStateFromClient?.currentRestaurantId;

  // RESTAURANT MODE SEARCH
  if (mode === "restaurant" && currentRestaurantId) {
    const currentRestaurantName = chatStateFromClient?.currentRestaurantName || "This restaurant";

    // A) Fix: Ensure dish_query is passed if it exists
    // Only nullify if planner explicitly says so AND there's no dish_query
    if (plan.search?.queryText === null && !intent.dish_query) {
      intent.dish_query = null;
    } else if (plan.search?.queryText) {
      intent.dish_query = plan.search.queryText;
    }

    // FIX 3: Show menu intercept - if show_menu is true in restaurant mode,
    // redirect to full menu handler instead of running SEARCH_NAME with garbage query
    if (intent.show_menu === true) {
      console.log("[discover][restaurant-mode] Show menu intercept triggered, redirecting to full menu");

      // Get full menu for this restaurant
      const supabase = await createClient();
      const { data: allDishes } = await supabase
        .from("dishes")
        .select("id, name, description, price, section_name")
        .eq("restaurant_id", currentRestaurantId)
        .eq("is_active", true)
        .order("section_name", { ascending: true })
        .order("name", { ascending: true })
        .limit(50);

      const dishes = allDishes || [];
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Build response card
      const menuCards: RestaurantCard[] = [{
        id: currentRestaurantId,
        name: currentRestaurantName,
        city: null,
        matches: dishes.map(d => ({
          id: d.id,
          name: d.name,
          description: d.description ?? null,
          price: d.price ?? 0,
          tags: [],
          section_name: d.section_name ?? null
        })),
        pagination: dishes.length > 10 ? { shown: 10, total: dishes.length, remaining: dishes.length - 10, next_offset: 10 } : undefined
      }];

      const responseContent = `Here's the full menu at ${currentRestaurantName} (${dishes.length} items):`;

      console.log("[discover][shape]", {
        context: "handleSearch:restaurantMode:SHOW_MENU",
        restaurantsCount: 1,
        matchesCount: dishes.length,
        hasRestaurantsField: true,
        hasFollowupChipsField: true,
        hasGrounded: false,
        meta: null
      });

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: responseContent,
          restaurants: finalize(menuCards, { mode: "restaurant", currentRestaurantId, currentRestaurantName }, intent),
          followupChips: []
        },
        {
          mode: "restaurant",
          currentRestaurantId,
          currentRestaurantName
        },
        "handleSearch:restaurantMode:SHOW_MENU"
      ));
    }

    // FIX 2: Ingredient query transformer - if ingredients detected but dish_query is generic,
    // use the ingredient as the dish search term
    if (intent.ingredients && intent.ingredients.length > 0) {
      const dqLower = (intent.dish_query || "").toLowerCase();
      // Check for generic patterns that should use ingredients instead
      if (!intent.dish_query ||
        /^(do they have )?(dishes?|items?|options?|food)?\s*(with|containing)?\s*/i.test(dqLower)) {
        console.log("[discover][restaurant-mode] Ingredient query transform:", {
          original: intent.dish_query,
          ingredients: intent.ingredients,
          newDishQuery: intent.ingredients.join(" ")
        });
        intent.dish_query = intent.ingredients.join(" ");
      }
    }

    // Determine sub-action type
    const hasDishQuery = intent.dish_query && intent.dish_query.trim().length > 0;
    const hasHardTags = intent.hard_tags && intent.hard_tags.length > 0;
    const subAction = hasDishQuery && hasHardTags ? "VERIFY_TAG" :
      hasHardTags ? "LIST_TAGGED" :
        hasDishQuery ? "SEARCH_NAME" : "BROWSE";

    console.log("[discover][restaurant-mode]", {
      subAction,
      restaurantId: currentRestaurantId,
      dishQuery: intent.dish_query,
      hardTags: intent.hard_tags,
      dietary: intent.dietary
    });

    const tRestaurantModeSearch = DEBUG_PERF ? performance.now() : 0;
    const searchResult = await searchMenuInRestaurant(currentRestaurantId, intent);
    if (perf) perf.restaurantModeSearch = performance.now() - tRestaurantModeSearch;
    const dishes = searchResult.dishes;

    // B) Build proper RestaurantCard array - ALWAYS return cards if we have dishes
    const restaurantCards: RestaurantCard[] = [{
      id: currentRestaurantId,
      name: searchResult.restaurant.name || currentRestaurantName,
      city: searchResult.restaurant.city ?? null,
      matches: dishes.map(d => ({
        id: d.id,
        name: d.name,
        description: d.description ?? null,
        price: d.price ?? 0,
        tags: (d as any).tags ?? [],
        section_name: d.section_name ?? null
      }))
    }];

    // Build grounded state for follow-up questions (Perplexity-style)
    const grounded: GroundedState = {
      restaurants: restaurantCards.map(r => ({
        id: r.id,
        name: r.name,
        city: r.city ?? null,
        address: null,
        matches: (r.matches || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? null,
          price: m.price ?? null
        }))
      })),
      lastQuery: intent.original_query || query,
      lastDietary: intent.dietary || [],
    };

    // Build last_results for follow-up grounding (Perplexity-style)
    const lastResults: LastResultDish[] = dishes.map(d => ({
      dish_id: d.id,
      dish_name: d.name,
      description: (d as any).description ?? null, // FIX: Include description for "is it spicy?" followups
      restaurant_id: currentRestaurantId,
      restaurant_name: searchResult.restaurant.name || currentRestaurantName,
      // FIX: Handle both string and object tag formats
      tag_slugs: Array.isArray((d as any).tags)
        ? ((d as any).tags as any[]).map((t: any) => typeof t === "string" ? t : t?.slug).filter(Boolean)
        : [],
      price: d.price ?? null
    }));

    const totalMatches = dishes.length;

    console.log("[discover][restaurant-mode-result]", {
      restaurantsCount: restaurantCards.length,
      matchesCount: totalMatches,
      dishNames: dishes.slice(0, 3).map(d => d.name),
      hasGrounded: true,
      lastResultsCount: lastResults.length
    });

    // C) Deterministic tag-based answer (no LLM for halal/vegan questions)
    // hasDishQuery already declared above
    const tagToCheck = intent.hard_tags?.[0] || intent.dietary?.[0] || null;
    const isTagQuestion = hasHardTags && (
      query.toLowerCase().includes("halal") ||
      query.toLowerCase().includes("vegan") ||
      query.toLowerCase().includes("vegetarian") ||
      query.toLowerCase().includes("is it") ||
      query.toLowerCase().includes("is the") ||
      query.toLowerCase().includes("does") ||
      query.toLowerCase().includes("is this")
    );

    // FIX: Only perform specific yes/no tag verify if we aren't just listing items
    // "does indian bites have lamm vindaloo" -> VERIFY_TAG (has dish) -> Run check
    // "vegan options" -> LIST_TAGGED (no dish) -> Skip check -> Show list
    if (subAction !== "LIST_TAGGED" && isTagQuestion && tagToCheck) {
      // Use bestMatchDish from searchMenuInRestaurant for fuzzy matching
      const matchingDish = searchResult.bestMatchDish;

      console.log("[discover][dish-tag-check]", {
        restaurant: searchResult.restaurant.name,
        dish: intent.dish_query,
        tag: tagToCheck,
        hasMatch: !!matchingDish,
        matchedDishName: matchingDish?.name ?? null,
        totalTaggedDishes: dishes.length
      });

      // Build single-dish card if match found
      let tagCheckCards: RestaurantCard[];
      let deterministicAnswer: string;

      if (matchingDish) {
        // YES - dish found with tag
        tagCheckCards = [{
          id: currentRestaurantId,
          name: searchResult.restaurant.name || currentRestaurantName,
          city: searchResult.restaurant.city ?? null,
          matches: [{
            id: matchingDish.id,
            name: matchingDish.name,
            description: matchingDish.description ?? null,
            price: matchingDish.price ?? 0
          }]
        }];
        deterministicAnswer = `✅ Yes — ${matchingDish.name} at ${searchResult.restaurant.name || currentRestaurantName} is tagged ${tagToCheck}.`;
      } else if (dishes.length > 0) {
        // NO - dish not found but other tagged dishes exist
        tagCheckCards = restaurantCards; // Show all tagged dishes
        deterministicAnswer = `❌ I can't confirm ${intent.dish_query ?? 'that dish'} at ${searchResult.restaurant.name} as ${tagToCheck}. It's not tagged ${tagToCheck} in our data. But I found ${dishes.length} other ${tagToCheck} options.`;
      } else {
        // NO - no tagged dishes at all
        tagCheckCards = restaurantCards; // Still show the card (may have 0 matches)
        deterministicAnswer = `❌ I can't find any dishes tagged ${tagToCheck} at ${searchResult.restaurant.name} in our database.`;
      }

      console.log("[discover][restaurant-mode:TAG_CHECK]", {
        restaurantsCount: tagCheckCards.length,
        matchesCount: tagCheckCards.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0),
        answerYesNo: !!matchingDish
      });

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: deterministicAnswer,
          restaurants: finalize(tagCheckCards, { ...chatStateFromClient, grounded, last_results: lastResults }, intent),
          followupChips: [],
        },
        {
          ...chatStateFromClient,
          grounded,
          last_results: lastResults
        },
        "handleSearch:restaurantMode:TAG_CHECK",
        grounded
      ));
    }

    // Regular restaurant search response
    // Regular restaurant search response
    let responseContent: string;
    if (dishes.length > 0) {
      const dishList = dishes.slice(0, 5).map(d => `- ${d.name} (${d.price} kr)`).join("\n");
      const tagLabel = intent.hard_tags?.[0] || intent.dietary?.[0]; // Use tag context for better answer
      const intro = tagLabel
        ? `Here are ${tagLabel} options I found at ${searchResult.restaurant.name}:`
        : `Here's what I found at ${searchResult.restaurant.name}:`;
      responseContent = `${intro}\n\n${dishList}`;
    } else {
      responseContent = `No dishes found matching your search at ${searchResult.restaurant.name}.`;
    }

    // Log performance timings for restaurant mode
    if (DEBUG_PERF && perf && t0) {
      perf.totalMs = Math.round(performance.now() - t0);
      console.log("[perf]", perf);
    }

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: responseContent,
        restaurants: finalize(restaurantCards, { ...chatStateFromClient, grounded, last_results: lastResults }, intent),
        followupChips: [],
      },
      {
        ...chatStateFromClient,
        grounded,
        last_results: lastResults
      },
      "handleSearch:restaurantMode",
      grounded
    ));
  }

  // VERIFY_TAG PATH: Handle "is [dish] at [restaurant] [tag]?" queries
  // This runs in DISCOVERY mode when restaurant_name + dish_query + hard_tags exist
  const hasVerifyTagQuery = intent.restaurant_name &&
    intent.dish_query &&
    intent.hard_tags &&
    intent.hard_tags.length > 0;

  if (hasVerifyTagQuery) {
    const tagToVerify = intent.hard_tags![0];
    const dishToVerify = intent.dish_query!;
    const restaurantName = intent.restaurant_name!;

    console.log("[discover][verify-tag]", {
      subAction: "VERIFY_TAG",
      restaurant: restaurantName,
      dish: dishToVerify,
      tag: tagToVerify
    });

    // Create supabase client for this lookup
    const verifySupabase = await createServiceRoleClient();

    // Find the restaurant by name
    const { data: restaurants } = await verifySupabase
      .from("restaurants")
      .select("id, name, city")
      .eq("public_searchable", true)
      .ilike("name", `%${restaurantName}%`)
      .limit(1);

    if (restaurants && restaurants.length > 0) {
      const restaurant = restaurants[0];

      // Search for the dish with the tag in this restaurant
      const verifyResult = await searchMenuInRestaurant(restaurant.id, intent);
      const matchedDishes = verifyResult.dishes;

      // Use bestMatchDish from searchMenuInRestaurant for fuzzy matching
      const matchingDish = verifyResult.bestMatchDish;

      console.log("[discover][verify-tag-result]", {
        restaurantsCount: 1,
        matchesCount: matchedDishes.length,
        foundDish: !!matchingDish,
        matchedDishName: matchingDish?.name ?? null
      });

      // Build restaurant cards - single card with matched dish or all tagged dishes
      let verifyCards: RestaurantCard[];
      let verifyAnswer: string;

      if (matchingDish) {
        // YES - dish found with tag, return single dish card
        verifyCards = [{
          id: restaurant.id,
          name: restaurant.name,
          city: restaurant.city ?? null,
          matches: [{
            id: matchingDish.id,
            name: matchingDish.name,
            description: matchingDish.description ?? null,
            price: matchingDish.price ?? 0
          }]
        }];
        verifyAnswer = `✅ Yes — ${matchingDish.name} at ${restaurant.name} is tagged ${tagToVerify}.`;
      } else if (matchedDishes.length > 0) {
        // NO - dish not found but other tagged dishes exist
        verifyCards = [{
          id: restaurant.id,
          name: restaurant.name,
          city: restaurant.city ?? null,
          matches: matchedDishes.map(d => ({
            id: d.id,
            name: d.name,
            description: d.description ?? null,
            price: d.price ?? 0
          }))
        }];
        verifyAnswer = `❌ No — I don't see ${dishToVerify} tagged ${tagToVerify} on ${restaurant.name}'s menu. But I found ${matchedDishes.length} other ${tagToVerify} options.`;
      } else {
        // NO - no tagged dishes at all
        verifyCards = [];
        verifyAnswer = `❌ No — I don't see any dishes tagged ${tagToVerify} at ${restaurant.name} in the database.`;
      }

      console.log("[discover][VERIFY_TAG:response]", {
        restaurantsCount: verifyCards.length,
        matchesCount: verifyCards.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0),
        answerYesNo: !!matchingDish
      });

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: verifyAnswer,
          restaurants: finalize(verifyCards, chatStateFromClient!, intent),
          followupChips: [],
        },
        chatStateFromClient!,
        "handleSearch:VERIFY_TAG"
      ));
    }

    // Restaurant not found - fall through to normal search
    console.log("[discover][verify-tag]", { subAction: "VERIFY_TAG", restaurantNotFound: restaurantName });
  }

  // DISCOVERY MODE SEARCH

  // 1. Tag Resolution

  // FAILSAFE: Extract dietary terms directly from query if intent.dietary is empty
  const dietaryFromQuery: string[] = [];
  const queryLower = (intent.original_query || query).toLowerCase();
  const dietaryKeywords: Record<string, string> = {
    "veg": "vegetarian", "veggie": "vegetarian", "vegetarian": "vegetarian", "vegetarisk": "vegetarian",
    "vegan": "vegan", "vegansk": "vegan",
    "halal": "halal",
    "satvik": "satvik", "satvic": "satvik",
    "gluten-free": "gluten-free", "gluten free": "gluten-free", "glutenfri": "gluten-free",
  };
  for (const [keyword, canonical] of Object.entries(dietaryKeywords)) {
    // FIX: Use word boundary to prevent "veg" matching "vegan"
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, "i");

    if (regex.test(queryLower) && !dietaryFromQuery.includes(canonical)) {
      dietaryFromQuery.push(canonical);
    }
  }

  // Merge intent.dietary with failsafe extraction
  const combinedDietary = [...(intent.dietary || []), ...dietaryFromQuery];
  const uniqueDietary = [...new Set(combinedDietary)];

  // FIX: Diet Resolution - normalize to canonical tag names for RPC
  // CRITICAL: Do NOT expand vegetarian to [vegetarian, vegan]!
  // RPC uses AND logic (requires ALL tags), so passing both would exclude
  // dishes that only have Vegetarian tag (like "Margherita (VE)" in Pizza Bianca section)
  const dietaryNormalized = uniqueDietary.map(d => {
    const s = d.toLowerCase().trim();
    // Normalize variants to canonical names
    if (["veg", "ve", "vego", "veggie", "vegetarian", "vegetarisk"].includes(s)) {
      return "vegetarian";  // Just vegetarian, not both
    }
    if (["vegan", "vegansk"].includes(s)) {
      return "vegan";
    }
    return s;
  }).filter((v, i, a) => a.indexOf(v) === i);

  const allTagTerms = [...dietaryNormalized, ...(intent.allergy || [])];

  // Compute clean search text by stripping dietary/tag words
  const rawQuery = intent.original_query || query;
  const strippedQuery = stripTagWords(rawQuery);
  const searchText = (intent.dish_query && intent.dish_query.trim().length > 0)
    ? intent.dish_query.trim()
    : (strippedQuery.length > 0 ? strippedQuery : null);

  console.log("[discover][query-text]", { raw: rawQuery, dish_query: intent.dish_query, dietary: intent.dietary, hard_tags: intent.hard_tags, searchText });

  // Early debug logging to trace dietary resolution
  console.log("[discover][dietary-trace]", {
    rawIntentDietary: intent.dietary,
    dietaryNormalized,
    allTagTerms,
    intentQuery: intent.original_query
  });

  // Use service role client for tag resolution (bypasses RLS on tags/tag_aliases)
  const admin = await createServiceRoleClient();
  let { tagIds: resolvedTagIds, resolvedTerms } = await resolveTagIdsFromIntentTerms(allTagTerms, admin);

  // CANONICAL fallback: if DB resolution failed but we have known hard tags, use static UUIDs
  if (resolvedTagIds.length === 0 && allTagTerms.length > 0) {
    console.log("[discover][canonical-fallback] DB resolution empty, checking CANONICAL_TAG_IDS...");
    for (const term of allTagTerms) {
      const slug = term.toLowerCase().trim();
      if (CANONICAL_TAG_IDS[slug] && !resolvedTagIds.includes(CANONICAL_TAG_IDS[slug])) {
        resolvedTagIds.push(CANONICAL_TAG_IDS[slug]);
        resolvedTerms.push({ term, type: "canonical", slug });
        console.log(`[discover][canonical-fallback] Added ${slug} -> ${CANONICAL_TAG_IDS[slug]}`);
      }
    }
  }

  const hasStrictTags = resolvedTagIds.length > 0;

  // Logging: Tag resolution details
  console.log("[discover][tag-resolve]", {
    intentDietary: intent.dietary,
    intentAllergy: intent.allergy,
    intentHardTags: intent.hard_tags,
    allTagTerms,
    resolvedTagIds,
    resolvedTermsSlugs: resolvedTerms.map(t => t.slug),
    hasStrictTags
  });

  // Logging: Env sanity check
  console.log("[discover][env]", {
    supabaseHost: process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host : "MISSING"
  });

  // Planner overrides (use searchText computed earlier)
  let effectiveSearchText = searchText;

  // FIX C: Filter out filler words - "something veg" should not search for "something"
  const FILLER_WORDS = new Set(["something", "anything", "some", "any", "stuff", "food", "dish", "dishes", "items", "options", "thing", "things"]);
  if (effectiveSearchText) {
    const cleaned = effectiveSearchText.toLowerCase().trim();
    if (FILLER_WORDS.has(cleaned)) {
      console.log("[discover][filler-filter] Stripping filler word from searchText:", { original: effectiveSearchText });
      effectiveSearchText = null;
    }
  }

  if (plan.search?.queryText === null) effectiveSearchText = null; // Forced tag-only by planner

  let restaurantCards: RestaurantCard[] = [];

  // USE FALLBACK SEARCH CHAIN for all searches
  const tFallbackStart = DEBUG_PERF ? performance.now() : 0;
  const fallbackResult = await fallbackSearchChain({
    resolvedTagIds,
    queryText: effectiveSearchText,
    city: intent.city ?? null,
    dietaryLabels: dietaryNormalized,
    supabase: admin,
    perf
  });
  if (perf) perf.fallbackSearchChain = performance.now() - tFallbackStart;

  console.log("[discover][fallback-result]", {
    step: fallbackResult.step,
    trace: fallbackResult.trace,
    cardCount: fallbackResult.restaurantCards.length,
    wasTagFiltered: fallbackResult.wasTagFiltered
  });

  restaurantCards = fallbackResult.restaurantCards;

  // ============================================
  // PARALLEL LOOKUP STRATEGY (Phase 2)
  // ============================================
  // If dish results are weak, check if the query was actually a restaurant name
  // (Strategy: "Indian Bites" -> 0 dishes -> Check Name -> Found -> Switch Intent)
  const isWeakResult =
    restaurantCards.length === 0 ||
    (restaurantCards.length === 1 && (restaurantCards[0].matches?.length ?? 0) === 0);

  if (isWeakResult) {
    console.log("[handleSearch] Weak dish results, checking parallel restaurant lookup...");
    const supabase = await createClient(); // Reuse or create new client

    const parallelProfile = await findBestRestaurantMatch({
      queryText: intent.dish_query || query,
      city: intent.city,
      supabase,
    });

    if (parallelProfile) {
      console.log(`[handleSearch] Parallel lookup found strong match: ${parallelProfile.name} (${parallelProfile.id})`);

      // RE-ROUTE to restaurant lookup handler
      // Update intent to look like a restaurant lookup
      const lookupIntent: Intent = {
        ...intent,
        is_restaurant_lookup: true,
        restaurant_name: parallelProfile.name, // Use the matched name
      };

      return handleRestaurantLookup({
        query,
        intent: lookupIntent,
        chatStateFromClient,
        openai
      });
    }
  }

  // Apply client-side text filter for tag-filtered results (pizza name matching etc.)
  // CRITICAL: Use intent.dish_query for filtering, NOT searchText which may contain generic words like "anything"
  // This ensures:
  //   - "any veg pizza" → postFilterText = "pizza" → filters correctly
  //   - "anything veg" → postFilterText = null → no filtering, returns all tagged dishes
  // Calculate reply language using priority logic (SV/EN > Tier 2 > English pivot)
  const replyLang = pickReplyLang({
    intentLang: intent.language,
    preferredLang: chatStateFromClient?.preferred_language ?? null,
    query
  });
  const dietLabel = dietaryNormalized[0];
  const postFilterText = intent.dish_query?.trim() || null;

  const tPostFilterStart = DEBUG_PERF ? performance.now() : 0;
  if (fallbackResult.wasTagFiltered && postFilterText && postFilterText.length > 0) {
    const beforeCards = restaurantCards.length;
    const beforeMatches = restaurantCards.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0);

    const searchLower = postFilterText.toLowerCase();

    // Simple fuzzy similarity function (handles common spelling variations)
    const isSimilar = (str1: string, str2: string): boolean => {
      const a = str1.toLowerCase().replace(/[^a-z]/g, '');
      const b = str2.toLowerCase().replace(/[^a-z]/g, '');
      if (a === b) return true;
      if (a.includes(b) || b.includes(a)) return true;

      // Handle common variations (dal/daal, makhani/makhni, etc.)
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

      // 70% character similarity for short strings
      if (Math.abs(a.length - b.length) <= 2 && a.length >= 3) {
        let matches = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          if (a[i] === b[i]) matches++;
        }
        return matches / Math.max(a.length, b.length) >= 0.7;
      }
      return false;
    };

    // Common pizza dish names - if searching for "pizza", these match too
    const pizzaDishNames = ["margherita", "marinara", "funghi", "capricciosa", "quattro formaggi",
      "quattro stagioni", "diavola", "calzone", "prosciutto", "pepperoni", "hawaiian",
      "napoletana", "vegetariana", "vesuvio", "kebabpizza", "pizza"];
    const isPizzaSearch = searchLower.includes("pizza");

    const queryWords = searchLower.split(/\s+/).filter((w: string) => w.length >= 2);

    restaurantCards = restaurantCards.map(card => ({
      ...card,
      matches: (card.matches || []).filter(dish => {
        const dishName = dish.name.toLowerCase();
        const dishDesc = (dish.description || "").toLowerCase();
        const sectionName = ((dish as any).section_name || "").toLowerCase();

        // Standard text match on dish name
        if (dishName.includes(searchLower)) return true;

        // Description match
        if (dishDesc.includes(searchLower)) return true;

        // Section name match - if query matches section, include the dish
        // This fixes "veg pizza" → dishes in "Pizza" section like "Rubi"
        if (sectionName && sectionName.includes(searchLower)) return true;

        // Fuzzy word match - include section words too for better matching
        const dishWords = dishName.split(/\s+/).filter((w: string) => w.length >= 2);
        const sectionWords = sectionName.split(/\s+/).filter((w: string) => w.length >= 2);
        const allWords = [...dishWords, ...sectionWords];

        const hasFuzzyMatch = queryWords.some(qWord =>
          allWords.some((w: string) => isSimilar(qWord, w))
        );
        if (hasFuzzyMatch) return true;

        // Pizza special case - check dish name AND section name
        if (isPizzaSearch) {
          if (sectionName.includes("pizza")) return true;
          if (pizzaDishNames.some(pn => dishName.includes(pn))) return true;
        }

        return false;
      })
    })).filter(card => (card.matches?.length ?? 0) > 0);

    const afterCards = restaurantCards.length;
    const afterMatches = restaurantCards.reduce((sum, c) => sum + (c.matches?.length ?? 0), 0);

    console.log("[discover][text-filter]", {
      postFilterText,
      beforeCards,
      afterCards,
      beforeMatches,
      afterMatches
    });
  }
  if (perf) perf.postTextFilter = performance.now() - tPostFilterStart;

  // Handle different fallback steps with appropriate messaging
  if (fallbackResult.step === "E") {
    // Step E: Top restaurants fallback - be honest about no tagged dishes
    const stepEMessage = dietLabel
      ? t(replyLang, "NO_TAGGED_FALLBACK", { tag: dietLabel })
      : t(replyLang, "NO_RESULTS");

    // Translate fallback message
    const translatedStepE = await translateIfNeeded(openai, stepEMessage, replyLang);

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: translatedStepE,
        restaurants: restaurantCards,
        followupChips: [],
      },
      {
        mode: "discovery",
        currentRestaurantId: null,
        currentRestaurantName: null,
        grounded: {
          restaurants: restaurantCards.map(r => ({
            id: r.id, name: r.name, city: r.city ?? null, address: r.address ?? null, matches: []
          })),
          lastQuery: query,
          lastDietary: dietaryNormalized,
          lastMatchesCount: 0,
          lastWasNoResults: true
        }
      },
      "handleSearch:fallbackE"
    ));
  }

  // Check if text filtering removed all results
  if (restaurantCards.length === 0) {
    const noMatchMsg = t(replyLang, "NO_MATCH_TRY_AGAIN", {
      query: effectiveSearchText || "",
      tag: dietLabel || "tagged as requested"
    });

    // Translate no-match message
    const translatedNoMatch = await translateIfNeeded(openai, noMatchMsg, replyLang);

    return NextResponse.json(buildSafeResponse(
      {
        id: messageId,
        role: "assistant",
        content: translatedNoMatch,
        restaurants: [],
        followupChips: []
      },
      { ...chatStateFromClient, grounded: { restaurants: [], lastQuery: query, lastDietary: dietaryNormalized, lastMatchesCount: 0, lastWasNoResults: true } },
      "handleSearch_NoTextMatch"
    ));
  }

  // Build success response with proper messaging based on step
  const tResponseBuildStart = DEBUG_PERF ? performance.now() : 0;
  // Sort by match count descending (Best First)
  restaurantCards.sort((a, b) => (b.matches?.length ?? 0) - (a.matches?.length ?? 0));

  // Apply truncation (Max 8 restaurants, 4 dishes per restaurant)
  const { cards: truncatedCards, meta } = truncateCards(restaurantCards, {
    maxRestaurants: 8,
    maxDishesPerRestaurant: 4
  });

  // Build human-friendly summary text
  const summaryText = buildHumanSummary({
    replyLang,
    city: intent.city || null,
    dietLabel: fallbackResult.wasTagFiltered ? (dietLabel || null) : null,
    query: effectiveSearchText || intent.original_query || query,
    restaurants: truncatedCards,
    meta,
  });
  if (perf) perf.responseBuild = performance.now() - tResponseBuildStart;

  const matchesCount = truncatedCards.reduce((sum, r) => sum + (r.matches?.length ?? 0), 0);
  const grounded: GroundedState = {
    restaurants: truncatedCards.map(r => ({
      id: r.id,
      name: r.name,
      city: r.city ?? null,
      address: r.address ?? null,
      matches: (r.matches || []).map(d => ({
        id: d.id, name: d.name, description: d.description ?? null, price: d.price ?? null,
      })),
    })),
    lastQuery: intent.original_query || query,
    lastDietary: dietaryNormalized.length > 0 ? dietaryNormalized : null,
    lastMatchesCount: matchesCount,
    lastWasNoResults: matchesCount === 0,
  };

  // Build last_results for follow-up grounding (based on what user actually sees)
  const lastResults: LastResultDish[] = truncatedCards.flatMap(r =>
    (r.matches || []).map(m => ({
      dish_id: m.id,
      dish_name: m.name,
      restaurant_id: r.id,
      restaurant_name: r.name,
      tag_slugs: (m.tags || []).map(t => t.slug),
      price: m.price ?? null
    }))
  );

  console.log("[discover][fallback-success]", {
    step: fallbackResult.step,
    cardCount: restaurantCards.length,
    truncatedCount: truncatedCards.length,
    matchesCount,
    lastResultsCount: lastResults.length,
    truncated: meta.truncated
  });

  // Translate content if needed (covers languages not in buildHumanSummary)
  const translatedContent = await translateIfNeeded(openai, summaryText, replyLang);

  // Log performance timings
  if (DEBUG_PERF && perf && t0) {
    perf.totalMs = Math.round(performance.now() - t0);
    console.log("[perf]", perf);
  }

  return NextResponse.json(buildSafeResponse(
    {
      id: messageId,
      role: "assistant",
      content: translatedContent,
      restaurants: finalize(truncatedCards, {
        mode: "discovery",
        currentRestaurantId: null,
        currentRestaurantName: null,
        grounded,
        last_results: lastResults,
        last_search_params: {
          dietary: dietaryNormalized,
          dishQuery: effectiveSearchText || null,
          city: intent.city || null,
          offset: 0
        },
        next_offset: meta.next_offset,
        restaurant_cursors: truncatedCards.map(r => ({
          restaurant_id: r.id,
          restaurant_name: r.name,
          shown_count: r.pagination?.shown ?? (r.matches?.length ?? 0),
          total_matches: r.pagination?.total ?? (r.matches?.length ?? 0),
          next_offset: r.pagination?.next_offset,
        }))
      }, intent),
      followupChips: [],
    },
    {
      mode: "discovery",
      currentRestaurantId: null,
      currentRestaurantName: null,
      grounded,
      last_results: lastResults,
      last_search_params: {
        dietary: dietaryNormalized,
        dishQuery: effectiveSearchText || null,
        city: intent.city || null,
        offset: 0
      },
      next_offset: meta.next_offset,
      // Build per-restaurant cursors for "show more from X"
      restaurant_cursors: truncatedCards.map(r => ({
        restaurant_id: r.id,
        restaurant_name: r.name,
        shown_count: r.pagination?.shown ?? (r.matches?.length ?? 0),
        total_matches: r.pagination?.total ?? (r.matches?.length ?? 0),
        next_offset: r.pagination?.next_offset,
      }))
    },
    `handleSearch:fallback${fallbackResult.step}`,
    null,
    meta
  ));
}

// Helper to normalize queries for comparison
function normalizeQuery(q: string) {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// Helper to build human-friendly summary text
function buildHumanSummary(args: {
  replyLang: string;
  city: string | null;
  dietLabel: string | null;
  query: string;
  restaurants: Array<{ name: string }>;
  meta: { truncated?: boolean; restaurants_returned?: number; total_restaurants?: number };
}) {
  const { replyLang, city, dietLabel, query, restaurants, meta } = args;

  const cityPart = city ? ` in ${city}` : "";
  const topNames = restaurants.slice(0, 4).map(r => r.name).filter(Boolean);

  // Minimal language support (cheap + deterministic)
  const L = (replyLang || "en").toLowerCase();

  const header =
    dietLabel
      ? (L === "sv"
        ? `Här är några **${dietLabel}**-alternativ jag hittade${cityPart}. Titta i restaurangkorten nedan — använd **Load more** i kortet för fler rätter.`
        : L === "pa"
          ? `ਇੱਥੇ ਕੁਝ **${dietLabel}** ਵਿਕਲਪ ਹਨ ਜੋ ਮੈਨੂੰ ਮਿਲੇ${cityPart}। ਹੇਠਾਂ ਰੈਸਟੋਰੈਂਟ ਕਾਰਡ ਦੇਖੋ — ਹੋਰ ਪਕਵਾਨਾਂ ਲਈ **Load more** ਵਰਤੋ।`
          : L === "hi"
            ? `यहाँ कुछ **${dietLabel}** विकल्प हैं जो मुझे मिले${cityPart}। नीचे रेस्तराँ कार्ड देखें — अधिक व्यंजनों के लिए **Load more** का उपयोग करें।`
            : `Here are some **${dietLabel}** options I found${cityPart}. Browse the restaurant cards below — use **Load more** inside a card to see more dishes.`)
      : (L === "sv"
        ? `Här är de bästa träffarna för "${query}"${cityPart}.`
        : L === "pa"
          ? `ਇੱਥੇ "${query}" ਲਈ ਸਭ ਤੋਂ ਵਧੀਆ ਨਤੀਜੇ ਹਨ${cityPart}।`
          : L === "hi"
            ? `यहाँ "${query}" के लिए सबसे अच्छे परिणाम हैं${cityPart}।`
            : `Here are the best matches for "${query}"${cityPart}.`);

  const placesLine =
    topNames.length > 0
      ? (L === "sv"
        ? `**Restauranger:** ${topNames.join(" • ")}`
        : L === "pa"
          ? `**ਰੈਸਟੋਰੈਂਟ:** ${topNames.join(" • ")}`
          : L === "hi"
            ? `**रेस्तराँ:** ${topNames.join(" • ")}`
            : `**Places:** ${topNames.join(" • ")}`)
      : "";

  const moreLine =
    meta?.truncated && meta.restaurants_returned && meta.total_restaurants
      ? (L === "sv"
        ? `_(Visar ${meta.restaurants_returned} av ${meta.total_restaurants} restauranger)_`
        : `_(Showing ${meta.restaurants_returned} of ${meta.total_restaurants} restaurants)_`)
      : "";

  return [header, placesLine, moreLine].filter(Boolean).join("\n");
}

// ============================================
// LOAD MORE RESTAURANT (Patch Response for in-place UI updates)
// ============================================
async function handleLoadMoreRestaurant(args: {
  restaurantId: string;
  offset: number;
  chatState: ChatState;
}): Promise<NextResponse> {
  const { restaurantId, offset, chatState } = args;

  console.log("[discover][load-more-patch] Starting", { restaurantId, offset });

  try {
    const supabase = await createClient();

    // Get restaurant menu
    const menuPayload = await getPublicMenu(restaurantId);

    if (!menuPayload || !menuPayload.sections) {
      return NextResponse.json({
        type: "patch",
        restaurantId,
        restaurantName: "Unknown",
        appendDishes: [],
        pagination: { shown: 0, total: 0 },
        error: "Restaurant not found"
      });
    }

    // Flatten all menu items
    const allMenuDishes: DishMatch[] = menuPayload.sections.flatMap((section: MenuSection) =>
      (section.items || []).map((item: MenuItem) => ({
        id: item.id,
        name: item.name,
        description: item.description || null,
        price: item.price ?? 0,
        tags: item.tags || [],
        section_name: section.name
      }))
    );

    // Apply dietary filters if they were part of the original search
    const dietaryFilters = chatState.last_search_params?.dietary || [];
    let filteredDishes = allMenuDishes;

    if (dietaryFilters.length > 0) {
      filteredDishes = allMenuDishes.filter(dish => {
        const dishTags = (dish.tags || []).map(t => t.slug.toLowerCase());
        return dietaryFilters.some(diet => {
          const dietLower = diet.toLowerCase();
          return dishTags.some((tag: string) =>
            tag.includes(dietLower) ||
            (dietLower === "veg" && (tag.includes("vegetarian") || tag.includes("vegan"))) ||
            (dietLower === "vegetarian" && tag.includes("vegetarian")) ||
            (dietLower === "vegan" && tag.includes("vegan")) ||
            (dietLower === "halal" && tag.includes("halal"))
          );
        });
      });
    }

    // Get dishes from offset (10 per page)
    const DISHES_PER_PAGE = 10;
    const dishesToAppend = filteredDishes.slice(offset, offset + DISHES_PER_PAGE);
    const totalShown = offset + dishesToAppend.length;
    const hasMore = totalShown < filteredDishes.length;
    const nextOffset = hasMore ? totalShown : undefined;

    console.log("[discover][load-more-patch] Fetched dishes", {
      offset,
      appendCount: dishesToAppend.length,
      totalShown,
      totalAvailable: filteredDishes.length,
      hasMore
    });

    // Build updated last_results for follow-up grounding
    const updatedLastResults: LastResultDish[] = dishesToAppend.map((d: DishMatch) => ({
      dish_id: d.id,
      dish_name: d.name,
      restaurant_id: restaurantId,
      restaurant_name: menuPayload.restaurantName,
      tag_slugs: (d.tags || []).map(t => t.slug),
      price: d.price ?? null
    }));

    return NextResponse.json({
      type: "patch",
      restaurantId,
      restaurantName: menuPayload.restaurantName,
      appendDishes: dishesToAppend,
      pagination: {
        shown: totalShown,
        total: filteredDishes.length,
        remaining: filteredDishes.length - totalShown,
        next_offset: nextOffset
      },
      updatedLastResults
    });

  } catch (error) {
    console.error("[discover][load-more-patch] Error:", error);
    return NextResponse.json({
      type: "patch",
      restaurantId,
      restaurantName: "Unknown",
      appendDishes: [],
      pagination: { shown: 0, total: 0 },
      error: "Failed to load more dishes"
    }, { status: 500 });
  }
}

/**
 * B2C Discovery Chat API
 * Handles both discovery mode (search across restaurants) and restaurant mode (chat with specific restaurant)
 * 
 * NOTE: Restaurant mode requires askAI function. For v1, you can make restaurant mode optional
 * or implement a simplified version. See notes at the bottom of this file.
 */
export async function POST(request: NextRequest) {
  const DEBUG_PERF = process.env.DEBUG_PERF === "1" || process.env.NODE_ENV === "development";
  const t0 = DEBUG_PERF ? performance.now() : 0;
  const perf: Record<string, number> | null = DEBUG_PERF ? {} : null;
  let requestChatState: ChatState | undefined;
  try {
    // Check for required environment variables
    const missingVars: string[] = [];
    if (!process.env.OPENAI_API_KEY) {
      missingVars.push("OPENAI_API_KEY");
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      missingVars.push("NEXT_PUBLIC_SUPABASE_URL");
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      missingVars.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    }

    if (missingVars.length > 0) {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      return NextResponse.json(
        buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: `Configuration error: Missing environment variables (${missingVars.join(", ")}). Please create a .env.local file in the discovery-app directory with these variables.`,
            restaurants: [],
            followupChips: [],
          },
          { mode: "discovery", currentRestaurantId: null, currentRestaurantName: null },
          "error:missingEnvVars"
        ),
        { status: 500 }
      );
    }

    const body: DiscoverChatRequest = await request.json();
    const { messages, chatState } = body;
    requestChatState = chatState || { mode: "discovery", currentRestaurantId: null };

    // ============================================
    // UI ACTION: LOAD_MORE_RESTAURANT (in-place pagination)
    // Bypass all chat logic and return patch response
    // ============================================
    if (body.ui_action === "LOAD_MORE_RESTAURANT" && body.targetRestaurantId) {
      return await handleLoadMoreRestaurant({
        restaurantId: body.targetRestaurantId,
        offset: body.offset || 0,
        chatState: requestChatState,
      });
    }

    // Read grounded state from client (for follow-up mode)
    const groundedFromClient: GroundedState | null = (chatState as ChatState & { grounded?: GroundedState })?.grounded ?? null;

    // EXTRACT SESSION PREFS (Anti-Forgetfulness)
    const prevPrefs = chatState?.prefs ?? {};
    // We will update these after intent parsing

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        buildSafeResponse(
          { role: "assistant", content: "Messages are required to continue.", restaurants: [], followupChips: [] },
          { mode: "discovery" },
          "error:noMessages"
        ),
        { status: 400 }
      );
    }

    // Extract last user message
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMessage) {
      return NextResponse.json(
        buildSafeResponse(
          { role: "assistant", content: "No user message found.", restaurants: [], followupChips: [] },
          { mode: "discovery" },
          "error:noUserMessage"
        ),
        { status: 400 }
      );
    }

    // Clean the query - remove trailing punctuation that might interfere with search
    let query = lastUserMessage.content.trim();

    // Sanitize user text to avoid weird routing (quotes/backticks) and trailing punctuation
    query = query
      .replace(/["'’`]/g, "")
      .replace(/[?.!,;:]+$/, "")
      .trim();

    if (!query) {
      return NextResponse.json(
        buildSafeResponse(
          { role: "assistant", kind: "answer", content: "Query cannot be empty.", restaurants: [], followupChips: [] },
          { mode: "discovery" },
          "error:emptyQuery"
        ),
        { status: 400 }
      );
    }

    // Determine mode
    const mode: Mode =
      chatState?.mode ?? "discovery";
    const currentRestaurantId = chatState?.currentRestaurantId ?? null;
    const currentRestaurantName = chatState?.currentRestaurantName ?? null;

    // Generate message ID
    const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Parse intent first (needed for both modes)
    const conversationHistory: ChatMessage[] = messages.map((m) => ({
      id: `${Date.now()}-${Math.random()}`,
      role: m.role,
      content: m.content,
      kind: "answer" as const, // Default kind for history
    }));

    // ============================================
    // DETERMINISTIC FOCUS TRIGGER (Chip Action)
    // Intercept "Ask about this restaurant" to switch mode securely
    // ============================================
    const focusTriggers = ["ask about this restaurant", "ask about this place", "browsing this restaurant"];
    if (focusTriggers.includes(query.toLowerCase())) {
      const lastAssistantMessage = messages
        .slice()
        .reverse()
        .find((m: any) => m.role === "assistant") as any;

      if (lastAssistantMessage?.kind === "restaurant_profile" && lastAssistantMessage.restaurants?.length === 1) {
        const r = lastAssistantMessage.restaurants[0];
        console.log("[Discover Chat API] Deterministic focus switch to:", r.name);

        // Build response confirming the switch
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: `Browsing **${r.name}**. What would you like to know?`,
            restaurants: finalize([r], buildFocusedChatState({ id: r.id, name: r.name }, requestChatState), {}),
            followupChips: []
          },
          // Use the helper to set mode="restaurant" and populate state
          buildFocusedChatState({ id: r.id, name: r.name }, requestChatState),
          "handleFocusSwitch"
        ));
      }
    }

    let intent;
    const tIntentStart = DEBUG_PERF ? performance.now() : 0;
    try {
      intent = await parseUserIntent(query, conversationHistory, chatState);
      if (perf) perf.parseUserIntent = performance.now() - tIntentStart;
      console.log("[Discover Chat API] Intent parsed:", intent);
    } catch (intentError) {
      console.error("[Discover Chat API] Intent parsing error:", intentError);
      // Fallback: create basic intent
      intent = {
        dish_query: query.trim() || null,
        city: null,
        dietary: [],
        allergy: [],
        ingredients: [],
        price_max: null,
        language: "en",
        original_query: query,
        is_vague: false,
        exit_restaurant: false,
      };
    }

    // FIX: Dietary Leakage Prevention (Safety Rule)
    // If query implies meat (lamb/chicken/etc) and NO explicit "veg/vegan" in this query, 
    // strip inherited vegetarian/vegan tags to prevent "lamm vindaloo" + "vegan" conflict.
    if (intent && ((intent.dietary?.length ?? 0) > 0 || (intent.hard_tags?.length ?? 0) > 0)) {
      const meatRegex = /\b(chicken|lamb|lamm|beef|pork|fish|meat|shrimp|prawn|kebab|burger|kyckling|biff|fisk|kött)\b/i;
      const qLower = query.toLowerCase();

      if (meatRegex.test(qLower)) {
        // Check if user explicitly asked for veg/vegan (rare but possible: "vegan chicken")
        const explicitVeg = /\b(veg|vegan|vegetarian|vegetarisk|vegansk)\b/i.test(qLower);

        if (!explicitVeg) {
          const dropped = intent.dietary?.filter((d: string) => ["vegan", "vegetarian"].includes(d.toLowerCase())) || [];
          if (dropped.length > 0) {
            console.log("[Discover Chat API] Dropping inherited veg tags due to meat query:", dropped);
            intent.dietary = intent.dietary.filter((d: string) => !["vegan", "vegetarian"].includes(d.toLowerCase()));
            if (intent.hard_tags) {
              intent.hard_tags = intent.hard_tags.filter((t: string) => !["vegan", "vegetarian"].includes(t.toLowerCase()));
            }
          }
        }
      }
    }

    // ============================================
    // ROUTING OVERRIDE (Explicit Restaurant + Food Question)
    // "does Indian Bites have halal butter chicken" -> force scoped search
    // overrides planner which might choose FOLLOWUP/EXPLAIN erroneously
    // ============================================
    const hasRestaurantName = !!intent?.restaurant_name?.trim();
    // Exclude generic "show menu" queries - let Planner handle them (Action: SHOW_MENU)
    const isGenericMenuRequest = /\b(menu|list)\b/i.test(query);

    const forceRestaurantScoped =
      hasRestaurantName &&
      !isPlaceInfoQuery(query) &&
      !isNameOnly(query, intent.restaurant_name) &&
      !isGenericMenuRequest &&
      (isAvailabilityOrMenuQuery(query) || (intent.hard_tags?.length ?? 0) > 0 || !!intent.dish_query);

    if (forceRestaurantScoped) {
      console.log("[Discover Chat API] Forcing restaurant-scoped search:", {
        query,
        restaurant: intent.restaurant_name,
        reason: "Explicit restaurant + food intent"
      });
      return await handleRestaurantScopedSearch({
        query,
        intent,
        groundedFromClient: groundedFromClient ?? null,
        chatStateFromClient: requestChatState ?? null,
        openai,
      });
    }

    // ============================================
    // FOLLOWUP RESOLUTION (before planner)
    // Check if user is asking about previously shown dishes
    // ============================================
    // ============================================
    // FOLLOWUP RESOLUTION (before planner)
    // ============================================
    const lastResults = requestChatState?.last_results || [];

    console.log("[discover][followup-check] Resolving followup", {
      count: lastResults.length,
      query
    });

    let followup;
    try {
      followup = await resolveFollowupFromLastResults(
        query,
        intent,
        lastResults
      );
    } catch (error) {
      console.error("[discover][followup-error]", error);
      followup = { type: "PASS" };
    }

    if (followup.type === "RESOLVED" && followup.answer) {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Build restaurant card for the matched dish
      const matchedCards: RestaurantCard[] = followup.matchedDish ? [{
        id: followup.matchedDish.restaurant_id,
        name: followup.matchedDish.restaurant_name,
        city: null,
        matches: [{
          id: followup.matchedDish.dish_id,
          name: followup.matchedDish.dish_name,
          description: null,
          price: followup.matchedDish.price ?? 0,
          tags: (followup.matchedDish.tag_slugs || []).map(s => ({
            id: s,
            name: s,
            slug: s,
            type: 'diet' as const
          }))
        }]
      }] : [];

      console.log("[discover][followup-resolved]", {
        dish: followup.matchedDish?.dish_name,
        tagFound: followup.tagFound,
        answer: followup.answer.substring(0, 50)
      });

      // Translate resolved answer
      const translatedAnswer = await translateIfNeeded(openai, followup.answer, intent.language);

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: translatedAnswer,
          restaurants: finalize(matchedCards, requestChatState, intent),
          followupChips: [],
        },
        {
          ...requestChatState,
          // Preserve last_results for further follow-ups
        },
        "handleFollowupResolved"
      ));
    }

    if (followup.type === "CLARIFY" && followup.answer) {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Build cards for all candidates
      const candidateCards: RestaurantCard[] = (followup.candidates || []).map(c => ({
        id: c.restaurant_id,
        name: c.restaurant_name,
        city: null,
        matches: [{
          id: c.dish_id,
          name: c.dish_name,
          description: null,
          price: c.price ?? 0,
          tags: (c.tag_slugs || []).map(s => ({
            id: s,
            name: s,
            slug: s,
            type: 'diet' as const
          }))
        }]
      }));

      console.log("[discover][followup-clarify]", {
        candidateCount: followup.candidates?.length,
        question: followup.answer
      });

      // Translate clarification
      const translatedClarify = await translateIfNeeded(openai, followup.answer, intent.language);

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: translatedClarify,
          restaurants: finalize(candidateCards, requestChatState, intent),
          followupChips: [],
        },
        requestChatState,
        "handleFollowupClarify"
      ));
    }

    // Handle TRANSLATE_LAST - translate previous explanation
    if (followup.type === "TRANSLATE_LAST" && followup.targetLanguage) {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const lastExplain = requestChatState.last_explain;

      if (!lastExplain?.text) {
        // No previous explanation to translate
        const noExplainMsg = await translateIfNeeded(openai, "I don't have a previous explanation to translate. Ask me about a specific dish first!", intent.language);
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: noExplainMsg,
            restaurants: [],
            followupChips: [],
          },
          requestChatState,
          "handleTranslate_NoExplain"
        ));
      }

      // Translate the explanation
      const langName = followup.targetLanguage === "en" ? "English" : "Swedish";
      const translationPrompt = `Translate the following text to ${langName}. Do not add new facts. Keep dish names as-is. Keep any safety disclaimers.

Text to translate:
${lastExplain.text}`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a translator. Translate accurately without adding information." },
          { role: "user", content: translationPrompt },
        ],
        temperature: 0.2,
      });

      const translatedText = completion.choices[0]?.message?.content?.trim() || lastExplain.text;

      console.log("[discover][translate]", {
        from: lastExplain.language,
        to: followup.targetLanguage,
        originalLength: lastExplain.text.length,
        translatedLength: translatedText.length
      });

      // Keep restaurants the same (no UI jump)
      const existingRestaurants = requestChatState.grounded?.restaurants || [];

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: translatedText,
          restaurants: existingRestaurants as RestaurantCard[],
          followupChips: [],
        },
        {
          ...requestChatState,
          last_explain: {
            ...lastExplain,
            text: translatedText,
            language: followup.targetLanguage
          }
        },
        "handleTranslate_Success"
      ));
    }

    // Handle PAGINATE - show more results using stored search params
    if (followup.type === "PAGINATE") {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const lastSearchParams = requestChatState.last_search_params;
      const nextOffset = requestChatState.next_offset;

      if (!lastSearchParams || nextOffset === undefined) {
        // No previous search to paginate
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: "I don't have more results to show. Try a new search!",
            restaurants: [],
            followupChips: [],
          },
          requestChatState,
          "handlePaginate_NoParams"
        ));
      }

      console.log("[discover][paginate]", {
        offset: nextOffset,
        params: lastSearchParams
      });

      // Re-run the search with the stored params (construct minimal Intent)
      const paginateIntent: Intent = {
        dietary: lastSearchParams.dietary || [],
        dish_query: lastSearchParams.dishQuery || null,
        city: lastSearchParams.city || null,
        allergy: [],
        ingredients: [],
        price_max: null,
        language: "en",
        original_query: "show more",
        is_vague: false
      };

      const allCards = await searchRestaurantsAndDishes(paginateIntent);

      if (!allCards || allCards.length === 0) {
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: "No more results available.",
            restaurants: [],
            followupChips: [],
          },
          requestChatState,
          "handlePaginate_NoMore"
        ));
      }

      // Sort and truncate with offset
      allCards.sort((a: RestaurantCard, b: RestaurantCard) => (b.matches?.length ?? 0) - (a.matches?.length ?? 0));

      const { cards: truncatedCards, meta } = truncateCards(allCards, {
        maxRestaurants: 8,
        maxDishesPerRestaurant: 4,
        offset: nextOffset
      });

      if (truncatedCards.length === 0) {
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: "That's all the results I have!",
            restaurants: [],
            followupChips: [],
          },
          {
            ...requestChatState,
            next_offset: undefined
          },
          "handlePaginate_End"
        ));
      }

      // PATCH: Apply finalize to enforce focus isolation, vegan strictness, query tokens
      const finalizedCards = finalize(truncatedCards, requestChatState, paginateIntent);

      if (!finalizedCards || finalizedCards.length === 0) {
        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: "That's all the results I have!",
            restaurants: [],
            followupChips: [],
          },
          {
            ...requestChatState,
            next_offset: undefined
          },
          "handlePaginate_End_AfterFinalize"
        ));
      }

      // Build last_results from what user will actually see (finalized cards)
      const lastResults: LastResultDish[] = finalizedCards.flatMap(r =>
        (r.matches || []).map(m => ({
          dish_id: m.id,
          dish_name: m.name,
          restaurant_id: r.id,
          restaurant_name: r.name,
          tag_slugs: (m.tags || []).map(t => t.slug),
          price: m.price ?? null
        }))
      );

      return NextResponse.json(buildSafeResponse(
        {
          id: messageId,
          role: "assistant",
          content: `Here are more results:`,
          restaurants: finalizedCards,
          followupChips: [],
        },
        {
          ...requestChatState,
          last_results: lastResults,
          next_offset: meta.next_offset,
          last_search_params: {
            ...lastSearchParams,
            offset: meta.next_offset ?? nextOffset
          }
        },
        "handlePaginate_Success",
        null,
        meta
      ));
    }

    // Handle SHOW_MORE_RESTAURANT - show more dishes from a specific restaurant
    // Handle SHOW_MORE_RESTAURANT - show more dishes from a specific restaurant
    if (followup.type === "SHOW_MORE_RESTAURANT") {
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      let restaurantId = followup.matchedRestaurantId;
      const restaurantNameQuery = followup.matchedRestaurantName || "the restaurant";

      // If we have a name but no ID (e.g. fresh "pull menu" query), look it up
      if (!restaurantId && restaurantNameQuery && restaurantNameQuery.length > 2) {
        try {
          const supabase = await createClient();
          // Fuzzy search by name first, then exact
          const { data: restaurant } = await supabase
            .from("restaurants")
            .select("id, name")
            .ilike("name", `%${restaurantNameQuery}%`)
            .eq("public_searchable", true)
            .limit(1)
            .single();

          if (restaurant) {
            console.log("[discover][show-more] Resolved restaurant from DB:", restaurant);
            restaurantId = restaurant.id;
          }
        } catch (e) {
          console.error("[discover][show-more] Error resolving restaurant name:", e);
        }
      }

      if (!restaurantId) {
        // Fallback to normal planner flow if we can't identify the restaurant
        console.log("[discover][show-more] Could not resolve restaurant ID, falling back to planner");
      } else {
        const restaurantName = followup.matchedRestaurantName || "the restaurant";
        const lastSearchParams = requestChatState.last_search_params;
        const restaurantCursors = requestChatState.restaurant_cursors || [];

        // Find cursor for this restaurant
        const cursor = restaurantCursors.find(c => c.restaurant_id === restaurantId);
        const nextOffset = cursor?.next_offset ?? 0;

        if (cursor && cursor.next_offset === undefined) {
          // No more dishes for this restaurant
          return NextResponse.json(buildSafeResponse(
            {
              id: messageId,
              role: "assistant",
              content: `I've already shown all dishes from ${restaurantName}.`,
              restaurants: [],
              followupChips: [],
            },
            requestChatState,
            "handleShowMoreRestaurant_NoMore"
          ));
        }

        console.log("[discover][show-more-restaurant]", {
          restaurantId,
          restaurantName,
          nextOffset,
          params: lastSearchParams
        });

        // Get the FULL menu for this restaurant (all dishes)
        const menuPayload = await getPublicMenu(restaurantId);

        if (!menuPayload || menuPayload.sections.length === 0) {
          return NextResponse.json(buildSafeResponse(
            {
              id: messageId,
              role: "assistant",
              content: `No menu found for ${restaurantName}.`,
              restaurants: [],
              followupChips: [],
            },
            requestChatState,
            "handleShowMoreRestaurant_NoMenu"
          ));
        }

        // Flatten all dishes from all sections
        const allMenuDishes: DishMatch[] = menuPayload.sections.flatMap(section =>
          section.items.map(item => ({
            id: item.id,
            name: item.name,
            description: item.description || null,
            price: item.price ?? 0,
            tags: item.tags || [],
            section_name: section.name
          }))
        );

        // FIX 0: Only apply dietary filters for PAGINATION (nextOffset > 0), not fresh menu requests
        // Fresh "show menu of X" should show ALL dishes
        // Pagination "show more from X" should respect original search filters
        const isFreshMenuRequest = nextOffset === 0;
        const dietaryFilters = isFreshMenuRequest ? [] : (lastSearchParams?.dietary || []);
        let filteredDishes = allMenuDishes;

        if (dietaryFilters.length > 0) {
          filteredDishes = allMenuDishes.filter(dish => {
            const dishTags = (dish.tags || []).map(t => t.slug.toLowerCase());
            // Check if dish has any of the dietary tags
            return dietaryFilters.some(diet => {
              const dietLower = diet.toLowerCase();
              return dishTags.some((tag: string) =>
                tag.includes(dietLower) ||
                (dietLower === "veg" && (tag.includes("vegetarian") || tag.includes("vegan"))) ||
                (dietLower === "vegetarian" && tag.includes("vegetarian")) ||
                (dietLower === "vegan" && tag.includes("vegan")) ||
                (dietLower === "halal" && tag.includes("halal"))
              );
            });
          });
        }

        console.log("[discover][show-more-restaurant] Dish filtering", {
          allDishesCount: allMenuDishes.length,
          filteredCount: filteredDishes.length,
          dietaryFilters,
          isFreshMenuRequest
        });

        if (filteredDishes.length === 0) {
          return NextResponse.json(buildSafeResponse(
            {
              id: messageId,
              role: "assistant",
              content: `No ${dietaryFilters.join("/")} dishes found at ${restaurantName}.`,
              restaurants: [],
              followupChips: [],
            },
            requestChatState,
            "handleShowMoreRestaurant_Empty"
          ));
        }

        // Get dishes starting from next offset (10 per page for expanded view)
        const dishesToShow = filteredDishes.slice(nextOffset, nextOffset + 10);
        const hasMoreDishes = nextOffset + dishesToShow.length < filteredDishes.length;
        const newNextOffset = hasMoreDishes ? nextOffset + dishesToShow.length : undefined;

        // Build restaurant card with new dishes
        const restaurantCard: RestaurantCard = {
          id: restaurantId,
          name: menuPayload.restaurantName,
          city: menuPayload.city || null,
          matches: dishesToShow,
          pagination: {
            shown: dishesToShow.length,
            total: filteredDishes.length,
            remaining: filteredDishes.length - dishesToShow.length,
            next_offset: newNextOffset,
          },
        };

        // Update the cursor for this restaurant
        const updatedCursors: RestaurantCursor[] = restaurantCursors.filter(c => c.restaurant_id !== restaurantId);
        updatedCursors.push({
          restaurant_id: restaurantId,
          restaurant_name: menuPayload.restaurantName,
          shown_count: nextOffset + dishesToShow.length,
          total_matches: filteredDishes.length,
          next_offset: newNextOffset,
        });

        // Build last_results for follow-up grounding
        const newLastResults: LastResultDish[] = dishesToShow.map((d: DishMatch) => ({
          dish_id: d.id,
          dish_name: d.name,
          restaurant_id: restaurantId,
          restaurant_name: menuPayload.restaurantName,
          tag_slugs: (d.tags || []).map(t => t.slug),
          price: d.price ?? null
        }));

        // FIX 2: Only return patch for pagination (nextOffset > 0)
        // Fresh menu requests (nextOffset = 0) should return a full message
        if (nextOffset > 0) {
          // PAGINATION: Return patch response to merge into existing card
          return NextResponse.json({
            type: "patch",
            restaurantId: restaurantId,
            restaurantName: menuPayload.restaurantName,
            appendDishes: dishesToShow,
            pagination: {
              shown: nextOffset + dishesToShow.length,
              total: filteredDishes.length,
              next_offset: newNextOffset,
            },
            updatedLastResults: newLastResults,
            chatState: {
              ...requestChatState,
              mode: "restaurant" as const,
              currentRestaurantId: restaurantId,
              currentRestaurantName: menuPayload.restaurantName,
              last_results: newLastResults,
              restaurant_cursors: updatedCursors,
            },
          });
        }

        // FRESH MENU REQUEST: Return InlineMenuCard UI (same as handleShowMenu)
        const buildMenuUrl = (restId: string) => {
          const baseUrl = typeof window !== "undefined"
            ? window.location.origin
            : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
          return `${baseUrl}/menu/${restId}`;
        };

        return NextResponse.json(buildSafeResponse(
          {
            id: messageId,
            role: "assistant",
            content: `Here's ${menuPayload.restaurantName}'s full menu.`,
            menu: menuPayload,  // Triggers InlineMenuCard in frontend
            menuUrl: buildMenuUrl(restaurantId),
            restaurants: [],
            followupChips: [],
          },
          {
            ...requestChatState,
            mode: "restaurant",
            currentRestaurantId: restaurantId,
            currentRestaurantName: menuPayload.restaurantName,
            last_results: newLastResults,
            restaurant_cursors: updatedCursors,
          },
          "handleShowMoreRestaurant_Success"
        ));
      }
    }


    // ============================================
    // PLANNER & ROUTING
    // ============================================
    const tPlannerStart = DEBUG_PERF ? performance.now() : 0;
    const { plan, triggered, usedFallback, rawAction } = await generatePlanSafe({
      query,
      intent,
      chatState: (requestChatState ?? null),
      grounded: (groundedFromClient ?? null),
      openai,
    });
    if (perf) perf.planner = performance.now() - tPlannerStart;

    console.log("[discover] plan", { action: plan.action, confidence: plan.confidence, triggered, usedFallback, rawAction });

    // Execute Plan
    switch (plan.action) {
      case "FOLLOWUP":
        return await handleFollowup({ query, intent, groundedFromClient, chatStateFromClient: requestChatState!, openai });

      case "EXPLAIN":
        return await handleDishExplain({ query, intent, groundedFromClient, chatStateFromClient: requestChatState!, openai });

      case "RESHOW":
        return await handleReshow({ query, intent, groundedFromClient, chatStateFromClient: requestChatState!, prefs: requestChatState?.prefs || {} });

      case "EXIT_RESTAURANT":
        return await handleExitRestaurant({ query, intent, groundedFromClient, chatStateFromClient: requestChatState! });

      case "SHOW_MENU":
        return await handleShowMenu({ query, intent, chatStateFromClient: requestChatState!, request });

      case "CLARIFY":
        return await handleClarify({ query, intent, chatStateFromClient: requestChatState!, openai });

      case "RESTAURANT_LOOKUP":
        return await handleRestaurantLookup({ query, intent, chatStateFromClient: requestChatState!, openai });

      case "SEARCH":
      default:
        return await handleSearch({
          query,
          intent,
          plan,
          groundedFromClient,
          chatStateFromClient: requestChatState!,
          openai,
          perf,
          t0,
          DEBUG_PERF
        });
    }


  } catch (error) {
    console.error("[Discover Chat API] Error:", error);
    const response = buildSafeResponse(
      {
        role: "assistant",
        content: "I'm having trouble processing that request. Could you try again?",
        restaurants: [],
        followupChips: ["Try again"],
      },
      {
        mode: requestChatState?.mode ?? "discovery",
        currentRestaurantId: requestChatState?.currentRestaurantId ?? null,
        currentRestaurantName: requestChatState?.currentRestaurantName ?? null,
      },
      "error:catchBlock"
    );

    return NextResponse.json(response, { status: 500 });
  }
}

