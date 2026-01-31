import OpenAI from "openai";
import type { Intent, ChatMessage } from "@/lib/types/discover";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

/**
 * Detect language from script (Unicode ranges) - reliable for non-Latin scripts
 * This is zero-cost and more reliable than LLM for Punjabi/Hindi/Arabic
 */
function detectLanguageFromScript(q: string): string | null {
  // Punjabi (Gurmukhi)
  if (/[\u0A00-\u0A7F]/.test(q)) return "pa";
  // Hindi (Devanagari)
  if (/[\u0900-\u097F]/.test(q)) return "hi";
  // Arabic
  if (/[\u0600-\u06FF]/.test(q)) return "ar";
  // Cyrillic (ru/uk/bg etc)
  if (/[\u0400-\u04FF]/.test(q)) return "ru";
  // Add more scripts later if needed
  return null;
}

/**
 * Detect language from romanized keywords (common Punjabi/Hindi phrases in Latin script)
 * Catches queries like "ki ha", "kya hai", "eh ki hai" which use Latin characters
 */
function detectRomanizedLanguage(q: string): string | null {
  const lower = q.toLowerCase();

  // Romanized Punjabi phrases
  const punjabiPhrases = [
    "ki ha", "ki hai", "kee hai", "eh ki", "ki aa", "ki e",
    "ki hunda", "ki hega", "kithe", "kithon", "kinne",
    "menu dasso", "das", "dasso"
  ];
  if (punjabiPhrases.some(p => lower.includes(p))) return "pa";

  // Romanized Hindi phrases  
  const hindiPhrases = [
    "kya hai", "kya he", "ye kya", "yeh kya", "batao", "bataiye",
    "kaisa hai", "kaise", "kitna", "kitne", "kahaan", "kahan"
  ];
  if (hindiPhrases.some(p => lower.includes(p))) return "hi";

  // Romanized Swedish (common question words)
  const swedishPhrases = [
    "vad är", "vad ar", "finns det", "har ni", "visar"
  ];
  if (swedishPhrases.some(p => lower.includes(p))) return "sv";

  return null;
}

/**
 * Check if a query looks like a restaurant name (strict rules)
 * Returns false for questions, dietary queries, and non-Latin scripts
 */
function looksLikeRestaurantName(q: string): boolean {
  const cleaned = q.trim().replace(/\s+/g, " ");
  const words = cleaned.split(" ").filter(w => w.length > 0);

  // Rule 1: Must be <= 4 tokens
  if (words.length > 4 || words.length < 1) return false;

  // Rule 2: Question marks indicate a question, not a name
  if (cleaned.includes("?")) return false;

  // Rule 3: Question/intent words (English + Swedish)
  const questionWords = new Set([
    // English
    "do", "does", "is", "are", "can", "have", "show", "find", "near", "best", "cheap", "options",
    "what", "where", "how", "any", "some", "get", "want", "looking",
    // Swedish
    "har", "finns", "kan", "vill", "något", "vad", "var", "hur", "bästa", "billig", "nära", "alternativ",
    "visa", "hitta", "sök"
  ]);
  const lowerWords = words.map(w => w.toLowerCase());
  if (lowerWords.some(word => questionWords.has(word))) return false;

  // Rule 4: Dietary words (English + Swedish) - dietary queries are NOT restaurant names
  const dietaryWords = new Set([
    "vegan", "vegansk", "vegetarian", "vegetarisk", "halal", "glutenfri", "gluten-free",
    "laktosfri", "lactose-free", "kosher", "veg", "veggie"
  ]);
  if (lowerWords.some(word => dietaryWords.has(word))) return false;

  // Rule 5: Non-Latin script only -> NOT a restaurant name
  // Check if query contains at least one Latin letter (A-Za-z)
  if (!/[a-zA-Z]/.test(cleaned)) return false;

  return true;
}

/**
 * Detect if query looks like a restaurant name lookup (2-4 words, proper noun pattern)
 * Returns true if query is likely a restaurant name, not a dish search
 */
function detectRestaurantLookup(query: string): boolean {
  // FIRST: Apply strict looksLikeRestaurantName gate
  if (!looksLikeRestaurantName(query)) {
    return false;
  }

  const cleaned = query.trim().replace(/[?.!]+$/, "");
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);

  // Must be 1-5 words (restaurant names are usually short)
  if (words.length < 1 || words.length > 5) return false;

  const lowerQuery = cleaned.toLowerCase();
  const lowerWords = words.map(w => w.toLowerCase());

  // Common dish words - block if query CONTAINS these (dish search, not restaurant name)
  const dishWords = new Set([
    "pizza", "burger", "chicken", "curry", "rice", "naan", "pasta", "salad",
    "soup", "steak", "fish", "lamb", "beef", "pork", "biryani", "tikka",
    "korma", "vindaloo", "tandoori", "kebab", "falafel", "hummus",
    "sushi", "ramen", "pho", "tacos", "burrito", "wings", "fries", "noodles",
    "butter", "paneer", "dal", "daal", "samosa", "pakora", "paratha", "roti",
    "dosa", "idli", "uttapam", "chutney", "raita", "lassi", "chai", "kulfi",
    "gulab", "jamun", "kheer", "halwa", "jalebi", "ladoo", "barfi", "peda",
    "sandwich", "wrap", "roll", "bowl", "platter", "combo", "meal", "thali",
    "margherita", "pepperoni", "hawaiian", "vegetable", "mushroom", "funghi",
    "calzone", "garlic", "bread", "nuggets", "strips", "tenders",
    "anything", "something", "food", "dish", "dishes", "options",
    "roganjosh", "rogan", "josh", "makhani", "masala", "bhuna", "balti",
    "madras", "jalfrezi", "dopiaza", "saag", "palak", "aloo", "gobi", "chana"
  ]);

  // Dietary/filter words - if query contains these, it's a filtered dish search
  const dietaryWords = new Set([
    "veg", "vegan", "vegetarian", "halal", "kosher", "gluten", "dairy", "lactose",
    "spicy", "mild", "hot", "cold", "cheap", "affordable", "best", "good"
  ]);

  // Category/cuisine words
  const categoryWords = new Set([
    "italian", "indian", "chinese", "thai", "mexican", "japanese", "korean",
    "french", "american", "mediterranean", "middle", "eastern", "asian"
  ]);

  // If query contains ANY dish word → it's a dish search, not restaurant lookup
  if (lowerWords.some(word => dishWords.has(word))) {
    return false;
  }

  // If query contains dietary/filter words → it's a filtered dish search
  if (lowerWords.some(word => dietaryWords.has(word))) {
    return false;
  }

  // If single category word → cuisine search, not restaurant
  if (words.length === 1 && categoryWords.has(lowerWords[0])) {
    return false;
  }

  // Location modifiers block (these indicate discovery)
  const locationWords = new Set(["near", "nearby", "close", "around", "in", "at", "from"]);
  if (lowerWords.some(word => locationWords.has(word))) return false;

  // Action words block
  const actionPrefixes = ["show", "find", "get", "what", "where", "how", "is", "are", "do", "does", "any"];
  if (actionPrefixes.includes(lowerWords[0])) return false;

  // 2-5 word phrases WITHOUT dish/dietary words → likely restaurant name
  // This correctly handles "Indian Bites", "Masala Zone", "Pizza Hut"
  if (words.length >= 2 && words.length <= 5) {
    return true;
  }

  // Single capitalized word could be restaurant name
  if (words.length === 1 && /^[A-Z]/.test(cleaned)) {
    return true;
  }

  return false;
}

/**
 * Detect if query has food/dish intent (even if restaurant name is present)
 * Used to override is_restaurant_lookup when user asks about food at a restaurant
 */
function hasFoodOrDishIntent(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  // Food intent verbs - if present, user is asking about food, not place info
  const foodIntentVerbs = [
    "have", "serves", "has", "do they have", "does", "does it have",
    "find", "menu", "dish", "items", "options", "food", "eat",
    "order", "get", "serve", "offer", "make"
  ];

  // Dietary terms always indicate food intent
  const dietaryTerms = [
    "halal", "vegan", "vegetarian", "veg", "kosher", "gluten-free", "gluten free",
    "lactose-free", "lactose free", "dairy-free", "dairy free", "nut-free"
  ];

  // Dish name patterns (2+ words after restaurant context, or known dishes)
  const commonDishes = [
    "chicken", "butter", "paneer", "curry", "biryani", "tikka", "korma",
    "vindaloo", "roganjosh", "rogan josh", "masala", "dal", "daal", "naan",
    "rice", "pizza", "burger", "pasta", "salad", "soup", "kebab", "wrap",
    "makhani", "palak", "saag", "aloo", "gobi", "chana", "samosa", "pakora"
  ];

  // Check for food intent verbs
  if (foodIntentVerbs.some(v => lowerQuery.includes(v))) {
    return true;
  }

  // Check for dietary terms
  if (dietaryTerms.some(t => lowerQuery.includes(t))) {
    return true;
  }

  // Check for dish names
  if (commonDishes.some(d => lowerQuery.includes(d))) {
    return true;
  }

  return false;
}

/**
 * Check if query is asking for place-level info (not food)
 * Only these should trigger RESTAURANT_LOOKUP when restaurant_name is present
 */
function isPlaceLevelQuery(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  const placeKeywords = [
    "address", "phone", "call", "number", "website", "site",
    "opening hours", "open now", "hours", "when", "close", "closed",
    "directions", "location", "where is", "how to get",
    "pet friendly", "pets", "wifi", "parking", "wheelchair", "accessible",
    "reservation", "book", "booking"
  ];

  return placeKeywords.some(k => lowerQuery.includes(k));
}

/**
 * Parse user intent from natural language query
 * Extracts dish query, city, dietary requirements, allergies, price constraints, and language
 * CRITICAL: Prevents "butter naan in göteborg?" from breaking search by extracting clean dish_query
 */
export async function parseUserIntent(
  userQuery: string,
  conversationHistory: ChatMessage[] = [],
  currentChatState?: { mode?: string; currentRestaurantId?: string | null }
): Promise<Intent> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  const systemPrompt = `You are an intent parser for a food discovery app. Extract structured data from queries in ANY language.

Extract:
- dish_query: Clean dish name (English). REMOVE dietary words. REMOVE generic food words (filler).
- city: Normalized city name.
- dietary: Array of requirements (e.g. ["vegan", "halal", "vegetarian"]).
- allergy: Array of allergies.
- ingredients: Array of ingredients mentioned.
- price_max: Maximum price or null.
- is_vague: Boolean.
- restaurant_name: String or null.
- cuisine: Cuisine type if user is searching for a type of restaurant (e.g., "indian", "italian", "chinese", "thai", "mexican", "japanese", "korean", "french", "american", "mediterranean"). Set when user asks for "[cuisine] restaurants/food/places".
- show_menu: Boolean. TRUE ONLY if user explicitly asks to SEE/SHOW a menu (e.g., "show menu", "open menu", "menu please"). FALSE if user just mentions "menu" while searching for a dish (e.g., "does anyone have X in the menu" = SEARCH for X, NOT show_menu).
- is_restaurant_lookup: Boolean. TRUE if user is looking for a SPECIFIC restaurant by name or asking about restaurant attributes (e.g., "phone number of X", "is X open?", "is X pet friendly?", "where is X?", "call X"). FALSE for cuisine searches like "indian restaurants".
- is_drink: Boolean.
      - is_followup: Boolean (true for queries asking for DETAILS about a previously found dish, e.g. "what is that", "ingredients?", "price?", "is it spicy?", "what is aloo gobi?").
      - language: ISO code of the USER'S QUERY (e.g., "en", "sv", "pa", "hi", "ar").

      CRITICAL RULES:
      1. **Generic Food Words = NULL:** If the user asks for "food", "meal", "bhojan", "khana", "mat" *without a specific dish name*, set dish_query: null.
      2. **Dietary Separation:** Dietary words (halal, veg, vegan, gluten-free) MUST go in 'dietary' array.
      3. **Follow-up Detection (CRITICAL):**
         - If the user asks "what is X?" or "ingredients of X?" where X is a specific dish name, set is_followup: true.
         - If the user asks "price of X?", set is_followup: true.
         - General "what is X?" queries should generate is_followup: true, NOT a new search, because the user likely sees X in the results.
      4. **is_vague MUST be false** if dietary/allergy/restaurant_name/show_menu/ingredients/price/cuisine exist.
      5. **Restaurant Lookup Detection:**
         - If query contains explicit restaurant attribute questions like "menu", "call", "phone", "address", "open", "hours", "reservation", "pet friendly", "wifi", "parking", set is_restaurant_lookup: true.
         - If the user is searching for a SPECIFIC restaurant by name (e.g. "Indian Bites", "Tavolino"), set is_restaurant_lookup: true.
         - IMPORTANT: Cuisine searches like "indian restaurants", "italian food", "chinese places" are NOT restaurant lookups - set cuisine instead.
      6. **Cuisine Detection:**
         - If query matches "[cuisine] restaurants/food/places/ställen" pattern, set cuisine to the cuisine type (lowercase).
         - Examples: "indian restaurants" → cuisine: "indian", "italiensk mat" → cuisine: "italian"

      FEW-SHOT EXAMPLES:
      - Query: "ਕੋਈ ਹਲਾਲ ਭੋਜਨ?" (Punjabi: "Any halal food?")
        → {"dish_query": null, "dietary": ["halal"], "language": "pa", "is_vague": false}
      - Query: "veg pizza?"
        → {"dish_query": "pizza", "dietary": ["vegetarian"], "language": "en", "is_vague": false}
      - Query: "indian restaurants"
        → {"dish_query": null, "cuisine": "indian", "is_restaurant_lookup": false, "is_vague": false, "language": "en"}
      - Query: "italian food in stockholm"
        → {"dish_query": null, "cuisine": "italian", "city": "Stockholm", "is_restaurant_lookup": false, "is_vague": false, "language": "en"}
      - Query: "what is prosciutto?"
        → {"dish_query": null, "is_vague": false, "is_followup": true, "language": "en"}
      - Query: "what is aloo gobi?"
        → {"dish_query": null, "is_vague": false, "is_followup": true, "language": "en"}
      - Query: "lamm vindaloo ki ha" (Romanized Punjabi: "what is lamb vindaloo")
        → {"dish_query": null, "is_vague": false, "is_followup": true, "language": "pa"}
      - Query: "butter chicken kya hai" (Romanized Hindi: "what is butter chicken")
        → {"dish_query": null, "is_vague": false, "is_followup": true, "language": "hi"}
      - Query: "show matches"
        → {"dish_query": null, "is_vague": false, "is_followup": false, "language": "en"}

      Return ONLY valid JSON, no other text.`;

  // Build conversation history context (last 6 messages)
  const historyText = conversationHistory
    .slice(-6)
    .map(m => `${m.role}: ${m.content || ""}`)
    .filter(line => line.trim().length > 0)
    .join("\n");

  // Build user prompt with optional history
  let userPrompt = `Parse this query: "${userQuery}"`;

  if (historyText) {
    userPrompt += `\n\nPrevious conversation:\n${historyText}`;
  }

  userPrompt += `\n\nReturn JSON in this exact format:
{
  "dish_query": "clean dish name or null",
  "city": "normalized city name or null",
  "dietary": ["array", "of", "dietary", "requirements"],
  "allergy": ["array", "of", "allergies"],
  "ingredients": ["array", "of", "ingredients"],
  "price_max": number or null,
  "language": "language code",
  "original_query": "exact original query",
  "is_vague": boolean,
  "restaurant_name": "restaurant name or null",
  "show_menu": boolean,
  "is_drink": boolean,
  "is_followup": boolean
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1, // Low temperature for consistent parsing
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from OpenAI");
    }

    const parsed = JSON.parse(content) as Partial<Intent>;

    // Override LLM language detection with reliable script detection
    const scriptLang = detectLanguageFromScript(userQuery);
    if (scriptLang) {
      parsed.language = scriptLang;
    } else {
      // Fallback: detect romanized Punjabi/Hindi/Swedish phrases in Latin script
      const romanizedLang = detectRomanizedLanguage(userQuery);
      if (romanizedLang) {
        parsed.language = romanizedLang;
      }
    }

    // Detect hard constraint keywords in query
    // FIX: Use word boundary regex to prevent "vegan" matching "veg" substring
    const queryLower = userQuery.toLowerCase();
    const detectedHardTags: string[] = [];

    // CRITICAL: Match vegan as a whole word (and Swedish/German/Nordic/Finnish) FIRST
    // This prevents "vegan" from triggering the "veg" -> "vegetarian" match
    const hasVegan = /\b(vegan|vegansk|vegane|vegaaninen|vegaani)\b/.test(queryLower);

    // Match vegetarian/veg as whole word, but NOT if vegan is present
    // (vegan is stricter than vegetarian - don't add vegetarian for vegan queries)
    const hasVegetarian =
      /\b(vegetarian|vegetarisk|vegetarisch|vego|veggie|kasvis)\b/.test(queryLower) ||
      (/\bveg\b/.test(queryLower) && !hasVegan); // "veg" alone means vegetarian, but not if "vegan" is in query

    if (hasVegan && !detectedHardTags.includes("vegan")) {
      detectedHardTags.push("vegan");
    }
    if (hasVegetarian && !detectedHardTags.includes("vegetarian")) {
      detectedHardTags.push("vegetarian");
    }

    // Other hard constraints (no substring collision issues)
    const otherHardConstraints = [
      { pattern: /\b(satvik|sattvic)\b/, tag: "satvik" },
      { pattern: /\b(halal|helal)\b/, tag: "halal" },
      { pattern: /\b(gluten[- ]?free|glutenfri(tt)?|glutenfrei|gluteeniton)\b/, tag: "gluten-free" },
      { pattern: /\b(nut[- ]?free|peanut[- ]?free|tree nut[- ]?free)\b/, tag: "nut-free" },
      { pattern: /\b(lactose[- ]?free|dairy[- ]?free|laktosfri|mjölkfri|laktosefrei|laktoositon)\b/, tag: "lactose-free" },
    ];

    for (const { pattern, tag } of otherHardConstraints) {
      if (pattern.test(queryLower) && !detectedHardTags.includes(tag)) {
        detectedHardTags.push(tag);
      }
    }

    // Also check parsed dietary array for hard constraints (using same word-boundary logic)
    // CRITICAL: Only accept dietary if the term actually appears in the current query
    // This prevents LLM from inheriting dietary from conversation history
    const parsedDietary = Array.isArray(parsed.dietary) ? parsed.dietary : [];

    // Dietary keyword variants for validation (same as used later)
    const dietaryValidationPatterns: Record<string, RegExp> = {
      vegetarian: /\b(veg|vegetarian|vegetarisk|vegetarisch|vego|veggie|kasvis)\b/i,
      vegan: /\b(vegan|vegansk|vegane|vegaaninen|vegaani)\b/i,
      halal: /\b(halal|helal)\b/i,
      satvik: /\b(satvik|sattvic)\b/i,
      "gluten-free": /\b(gluten[- ]?free|glutenfri|glutenfrei|gluteeniton)\b/i,
      "lactose-free": /\b(lactose[- ]?free|dairy[- ]?free|laktosfri|mjölkfri|laktosefrei|laktoositon)\b/i,
      "nut-free": /\b(nut[- ]?free|peanut[- ]?free)\b/i,
    };

    // Filter parsedDietary to only include terms that appear in the current query
    // START SWEDISH DIETARY NORMALIZATION
    // Map non-standard/multilingual dietary tags to canonical English tags
    // This ensures "vegansk" -> "vegan", "vegetarisk" -> "vegetarian" in the final intent
    const DIETARY_SYNONYMS: Record<string, string> = {
      // Swedish
      vegansk: "vegan",
      vegetarisk: "vegetarian",
      glutenfri: "gluten-free",
      laktosfri: "lactose-free",
      "mjölkfri": "lactose-free",

      // German
      vegane: "vegan",
      vegetarisch: "vegetarian",
      glutenfrei: "gluten-free",
      laktosefrei: "lactose-free",

      // Danish / Norwegian
      laktosefri: "lactose-free", // other terms covered by Swedish

      // Finnish
      vegaaninen: "vegan",
      vegaani: "vegan",
      kasvis: "vegetarian",
      gluteeniton: "gluten-free",
      laktoositon: "lactose-free",

      // Common / English (only those not covered above)
      vegan: "vegan",
      vegetarian: "vegetarian",
      "gluten-free": "gluten-free",
      "lactose-free": "lactose-free",
      halal: "halal",
      veg: "vegetarian",
      veggie: "vegetarian",
      ve: "vegetarian",
    };
    // END SWEDISH DIETARY NORMALIZATION

    // Filter parsedDietary to only include terms that appear in the current query
    const validatedDietary = parsedDietary.reduce<string[]>((acc, dietary) => {
      const dietaryLower = dietary.toLowerCase().trim();
      // Use mapping if available, otherwise keep original (will be filtered if invalid)
      const mapped = DIETARY_SYNONYMS[dietaryLower] || dietaryLower;

      // Find the canonical form for validation pattern lookup
      let canonical = mapped;
      if (/^(veg|vego|veggie|ve)$/.test(canonical)) canonical = "vegetarian";
      if (/^(helal)$/.test(canonical)) canonical = "halal";
      if (/^(sattvic)$/.test(canonical)) canonical = "satvik";

      // Check if this dietary term appears in the current query
      const pattern = dietaryValidationPatterns[canonical];
      if (pattern && pattern.test(queryLower)) {
        acc.push(canonical); // Push CAONICAL/MAPPED term
        return acc;
      }

      // Also allow if the exact term appears in the query (check both original and mapped)
      // Use strict word boundary check to prevent "vegan" matching "veg"
      const whole = (text: string, phrase: string) =>
        new RegExp(`(^|\\W)${phrase.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}($|\\W)`, "i").test(text);

      if (whole(queryLower, dietaryLower) || whole(queryLower, mapped)) {
        acc.push(mapped); // Push MAPPED term
        return acc;
      }

      console.log(`[intent-parser] Cleared dietary="${dietary}" - not found in query "${userQuery}"`);
      return acc;
    }, []);

    for (const dietary of validatedDietary) {
      const dietaryLower = dietary.toLowerCase().trim();

      // Vegan/vegetarian with strict matching
      if (/^(vegan|vegansk)$/.test(dietaryLower) && !detectedHardTags.includes("vegan")) {
        detectedHardTags.push("vegan");
      } else if (/^(vegetarian|vegetarisk|veg|vego|veggie)$/.test(dietaryLower) && !detectedHardTags.includes("vegetarian")) {
        detectedHardTags.push("vegetarian");
      }

      // Other constraints
      if (/satvik|sattvic/.test(dietaryLower) && !detectedHardTags.includes("satvik")) {
        detectedHardTags.push("satvik");
      }
      if (/halal|helal/.test(dietaryLower) && !detectedHardTags.includes("halal")) {
        detectedHardTags.push("halal");
      }
      if (/gluten/.test(dietaryLower) && !detectedHardTags.includes("gluten-free")) {
        detectedHardTags.push("gluten-free");
      }
      if (/nut|peanut/.test(dietaryLower) && !detectedHardTags.includes("nut-free")) {
        detectedHardTags.push("nut-free");
      }
      if (/lactose|dairy|mjölk/.test(dietaryLower) && !detectedHardTags.includes("lactose-free")) {
        detectedHardTags.push("lactose-free");
      }
    }

    // Validate and set defaults
    const intent: Intent = {
      dish_query: parsed.dish_query?.trim() || null,
      city: parsed.city?.trim().toUpperCase() || null,
      dietary: validatedDietary,
      allergy: Array.isArray(parsed.allergy) ? parsed.allergy : [],
      ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
      price_max: typeof parsed.price_max === "number" ? parsed.price_max : null,
      language: parsed.language || "en",
      original_query: parsed.original_query || userQuery,
      is_vague: parsed.is_vague === true,
      // CRITICAL: Only accept restaurant_name if it's explicitly mentioned in the query
      // This prevents the LLM from inheriting restaurant context from conversation history
      restaurant_name: (() => {
        const candidateName = parsed.restaurant_name?.trim();
        if (!candidateName) return null;

        // Check if the restaurant name words appear in the actual query
        const queryLower = userQuery.toLowerCase();
        const nameWords = candidateName.toLowerCase().split(/\s+/).filter(w => w.length >= 3);

        // Require at least one significant word from the restaurant name to be in the query
        const foundInQuery = nameWords.some(word => queryLower.includes(word));

        if (!foundInQuery) {
          console.log(`[intent-parser] Cleared restaurant_name="${candidateName}" - not found in query "${userQuery}"`);
          return null;
        }

        return candidateName;
      })(),
      show_menu: parsed.show_menu === true,
      is_drink: parsed.is_drink === true,
      exit_restaurant: parsed.exit_restaurant === true,
      hard_tags: detectedHardTags.length > 0 ? detectedHardTags : undefined,
      // Detect restaurant lookup: either LLM identified restaurant_name or heuristic matches
      is_restaurant_lookup: false, // Will be set correctly below after restaurant_name validation
    };

    // Set is_restaurant_lookup based on validated restaurant_name
    // PRIORITY RULE: If query has food/dish intent, it's NOT a restaurant lookup
    // even if restaurant_name is present (e.g., "does indian bites have halal butter chicken")
    // Only route to RESTAURANT_LOOKUP if:
    // 1. Query is essentially just the restaurant name, OR
    // 2. Query asks for place-level info (address, phone, hours)
    const queryHasFoodIntent = hasFoodOrDishIntent(userQuery);
    const queryIsPlaceLevel = isPlaceLevelQuery(userQuery);

    if (intent.restaurant_name && queryHasFoodIntent && !queryIsPlaceLevel) {
      // Restaurant name + food intent = restaurant-scoped dish search, NOT lookup
      intent.is_restaurant_lookup = false;
      console.log("[intent-parser] Overriding restaurant_lookup: food intent detected with restaurant name");
    } else {
      // Heuristic fallback: If LLM missed it, but it looks like a restaurant name (short, no dish words)
      // verify with heuristic. This catches "Indian Bites" which LLM might treat as generic.
      const heuristicLookup = detectRestaurantLookup(userQuery);

      if (heuristicLookup) {
        intent.is_restaurant_lookup = true;
        // If LLM didn't extract the name, use the query itself
        if (!intent.restaurant_name) {
          intent.restaurant_name = userQuery.replace(/[?!.,]/g, "").trim();
        }
        // Clear dish query to prevent ambiguous routing
        intent.dish_query = null;
        console.log(`[intent-parser] Heuristic set is_restaurant_lookup=true for "${userQuery}"`);
      } else {
        intent.is_restaurant_lookup = !!(intent.restaurant_name);
      }
    }


    const vagueTerms = new Set([
      "anything",
      "something",
      "whatever",
      "hungry",
      "surprise me",
      "random",
    ]);

    const normalizedDishQuery = intent.dish_query?.toLowerCase().trim() || "";

    const dietaryKeywordVariants: Record<string, string[]> = {
      "gluten free": ["gluten free", "gluten-free", "glutenfritt", "glutenfri"],
      "vegetarian": ["vegetarian", "vegetarisk", "veg", "vego", "veggie", "ve", "VE", "meat-free", "köttfri", "vegeterian", "vegatarian", "vegeratian"], // Common misspellings
      "vegan": ["vegan", "vegansk", "plant-based", "växtbaserad"],
      "halal": ["halal", "helal"],
      "kosher": ["kosher"],
      "jain": ["jain"],
      "satvik": ["satvik", "sattvic"],
      "lactose free": ["lactose free", "lactose-free", "laktosfri", "mjölkfri"],
    };

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const containsPhrase = (text: string, phrase: string) => {
      const pattern = new RegExp(`(^|\\W)${escapeRegExp(phrase)}($|\\W)`, "i");
      return pattern.test(text);
    };

    const normalizedQueryText = `${userQuery} ${intent.dish_query ?? ""}`.toLowerCase();

    // Heuristic: Detect menu requests regardless of model output
    // Expanded patterns: "pull/show/open/get/display menu", "full menu", "menu please"
    // If already in restaurant mode, "menu" alone triggers show_menu
    const isInRestaurantMode = currentChatState?.mode === "restaurant" && currentChatState?.currentRestaurantId;

    const menuRequestPatterns = [
      /^(menu|full\s+menu|entire\s+menu|whole\s+menu)$/i, // "menu", "full menu" as standalone
      /(pull|show|open|get|display)\s+(me\s+)?(the\s+)?(full|entire|whole)?\s*menu/i,
      /see\s+(the\s+)?(full|entire|whole)?\s*menu/,
      /menu\s+(please|pls)/i,
      /(need|want)\s+(the\s+)?(full|entire|whole)?\s*menu/,
      /menu\s+of\s+([a-zåäö\s]+)/i, // "menu of Sandhu"
      /(full|entire|whole)\s+menu\s+of\s+([a-zåäö\s]+)/i, // "full menu of Sandhu"
      /show\s+(me\s+)?(the\s+)?menu\s+of\s+([a-zåäö\s]+)/i, // "show menu of Sandhu"
      /(get|open|pull|display)\s+(the\s+)?menu\s+of\s+([a-zåäö\s]+)/i, // "get menu of Sandhu"
    ];

    const matchesMenuPattern = menuRequestPatterns.some((pattern) => pattern.test(normalizedQueryText));

    // If in restaurant mode and user says just "menu", treat as show_menu
    if (isInRestaurantMode && /^(menu|full\s+menu|entire\s+menu|whole\s+menu)$/i.test(normalizedQueryText.trim())) {
      intent.show_menu = true;
      intent.is_vague = false;
    } else if (matchesMenuPattern) {
      intent.show_menu = true;
      // If show_menu is true, ensure is_vague is false
      intent.is_vague = false;

      // CRITICAL FIX 1: Menu requests should NOT have dish_query
      // "pull menu of indian bites" should have dish_query = null, not "pull menu of indian bites"
      intent.dish_query = null;

      // Try to extract restaurant name from patterns like "menu of [name]" or "show menu of [name]"
      if (!intent.restaurant_name) {
        const menuOfMatch = normalizedQueryText.match(/(?:menu|show|get|open|pull|display)\s+(?:the\s+)?(?:full|entire|whole)?\s*menu\s+of\s+([a-zåäö\s]+)/i);
        if (menuOfMatch?.[1]) {
          intent.restaurant_name = menuOfMatch[1].trim();
        }
      }
    }

    for (const [canonical, variants] of Object.entries(dietaryKeywordVariants)) {
      if (variants.some((v) => containsPhrase(normalizedQueryText, v.toLowerCase()))) {
        if (!intent.dietary.some((d) => d.toLowerCase() === canonical)) {
          intent.dietary.push(canonical);
        }
        if (normalizedDishQuery && variants.some((v) => normalizedDishQuery === v.toLowerCase())) {
          intent.dish_query = null;
        }
      }
    }

    // CRITICAL: Treat "veg" as vegetarian (not "vegetable")
    // Check raw query for standalone "veg" token BEFORE other processing
    const vegQueryLower = userQuery.toLowerCase();
    if (/\bveg\b/i.test(vegQueryLower)) {
      // Ensure "vegetarian" is in dietary array
      if (!intent.dietary.some((d: string) => d.toLowerCase() === "vegetarian")) {
        intent.dietary.push("vegetarian");
      }
      // Remove "veg" from dish_query if present
      if (intent.dish_query) {
        intent.dish_query = intent.dish_query.replace(/\bveg\b/gi, "").trim();
        if (intent.dish_query.length === 0) {
          intent.dish_query = null;
        }
      }
    }

    // CRITICAL: Also scan dish_query itself for dietary keywords (in case LLM didn't extract them)
    // This handles cases like "veg pizza" where LLM might return dish_query="veg pizza" but dietary=[]
    if (intent.dish_query) {
      const dishQueryLower = intent.dish_query.toLowerCase();
      for (const [canonical, variants] of Object.entries(dietaryKeywordVariants)) {
        if (variants.some((v) => containsPhrase(dishQueryLower, v.toLowerCase()))) {
          if (!intent.dietary.some((d) => d.toLowerCase() === canonical)) {
            intent.dietary.push(canonical);
          }
        }
      }
    }

    // If intent.dietary has values AND intent.dish_query exists, remove dietary keywords from dish_query
    if (intent.dietary && intent.dietary.length > 0 && intent.dish_query) {
      let cleanedDishQuery = intent.dish_query;

      // Remove all dietary keyword variants from dish_query
      for (const variants of Object.values(dietaryKeywordVariants)) {
        for (const variant of variants) {
          const regex = new RegExp(`\\b${escapeRegExp(variant)}\\b`, "gi");
          cleanedDishQuery = cleanedDishQuery.replace(regex, " ").trim();
        }
      }

      // Remove filler words
      const fillerWords = ["any", "some", "something", "pls", "please", "want", "looking", "find", "show", "me", "do", "they", "have"];
      for (const filler of fillerWords) {
        const regex = new RegExp(`\\b${filler}\\b`, "gi");
        cleanedDishQuery = cleanedDishQuery.replace(regex, " ").trim();
      }

      // Clean up multiple spaces
      cleanedDishQuery = cleanedDishQuery.replace(/\s+/g, " ").trim();

      // Update dish_query if it changed
      const originalDishQueryBeforeStrip = intent.dish_query;
      if (cleanedDishQuery.length > 0) {
        intent.dish_query = cleanedDishQuery;
      } else {
        // If dish_query becomes empty after removing dietary words, set to null (tag-only search)
        intent.dish_query = null;
      }
    }

    // Drink synonym expansion: "mango smoothie" -> expand to include "lassi", "shake", "juice"
    if (intent.dish_query) {
      const dishLower = intent.dish_query.toLowerCase();
      const drinkSynonyms: Record<string, string[]> = {
        "smoothie": ["lassi", "shake", "juice", "drink"],
        "shake": ["lassi", "smoothie", "juice", "drink"],
        "drink": ["lassi", "smoothie", "shake", "juice"],
      };

      // Check if query contains a drink word and a flavor
      const flavorWords = ["mango", "chocolate", "strawberry", "banana", "vanilla", "coffee", "tea"];
      const hasFlavor = flavorWords.some(flavor => dishLower.includes(flavor));

      for (const [drinkWord, synonyms] of Object.entries(drinkSynonyms)) {
        if (dishLower.includes(drinkWord) && hasFlavor) {
          // Find the flavor word
          const flavor = flavorWords.find(f => dishLower.includes(f));
          if (flavor) {
            // Expand query to include synonyms
            const expandedTerms = [intent.dish_query, ...synonyms.map(s => `${flavor} ${s}`.trim())].filter(Boolean);
            intent.dish_query = expandedTerms.join(" ");
            console.log(`[intent-parser] Expanded drink query: "${intent.dish_query}"`);
          }
          break;
        }
      }
    }


    // If dish_query contains only tag words and/or vague filler words, treat it as tag-only.
    if (intent.dish_query) {
      let reduced = intent.dish_query.toLowerCase();

      for (const variants of Object.values(dietaryKeywordVariants)) {
        for (const v of variants) {
          const pattern = new RegExp(`(^|\\W)${escapeRegExp(v.toLowerCase())}($|\\W)`, "gi");
          reduced = reduced.replace(pattern, " ");
        }
      }

      for (const vt of vagueTerms) {
        const pattern = new RegExp(`(^|\\W)${escapeRegExp(vt)}($|\\W)`, "gi");
        reduced = reduced.replace(pattern, " ");
      }

      // Extra common filler words
      for (const filler of [
        "food",
        "dish",
        "dishes",
        "options",
        "option",
        "restaurant",
        "restaurants",
        "recommend",
        "recommended",
        "recommends",
        "recommendation",
        "suggest",
        "suggested",
        "suggestion",
        "show",
        "tell",
        "give",
        "find",
        "looking",
        "looking for",
        "want",
        "need",
        "please",
        "can",
        "could",
        "would",
        "you",
        "me",
      ]) {
        const pattern = new RegExp(`(^|\\W)${escapeRegExp(filler)}($|\\W)`, "gi");
        reduced = reduced.replace(pattern, " ");
      }

      if (reduced.replace(/\s+/g, " ").trim().length === 0 && intent.dietary.length > 0) {
        intent.dish_query = null;
      }
    }

    // CRITICAL: dish_query exists => is_vague = false
    if (intent.dish_query && intent.dish_query.trim().length > 0) {
      intent.is_vague = false;
    } else if (normalizedDishQuery && vagueTerms.has(normalizedDishQuery)) {
      intent.dish_query = null;
      intent.is_vague = true;
    }

    // Tag-only searches like "satvik" or "halal" should never be treated as vague.
    if (intent.dietary.length > 0) {
      intent.is_vague = false;
    }

    // Detect exit restaurant phrases
    const exitPhrases = [
      /^(back|exit)$/i,
      /^(search all|other restaurants|back to discovery|show all restaurants)$/i,
      /^(go back|return|leave|close)$/i,
    ];
    const normalizedQuery = userQuery.toLowerCase().trim();
    if (exitPhrases.some((pattern) => pattern.test(normalizedQuery))) {
      intent.exit_restaurant = true;
    }


    // If dish_query is empty and not vague, try to extract something
    if (
      !intent.dish_query &&
      !intent.is_vague &&
      userQuery.trim().length > 0 &&
      (!intent.dietary || intent.dietary.length === 0)
    ) {
      // Fallback: use cleaned original query
      intent.dish_query = userQuery
        .replace(/\b(in|at|near|close to)\s+[a-zåäö]+\b/gi, "")
        .replace(/[?.!]+$/, "")
        .trim();
    }

    console.log("[parseUserIntent] Parsed intent:", intent);

    // TASK 2 FIX: If ingredients detected and dish_query is generic pattern, clear dish_query
    // This enables discover.ts to use ingredient-based search
    // "dishes with paneer" → dish_query=null, ingredients=['paneer']
    if (intent.ingredients && intent.ingredients.length > 0 && intent.dish_query) {
      const dq = intent.dish_query.toLowerCase().trim();
      // Check for generic "dishes/items/options/food with" patterns
      if (/^(dishes?|items?|options?|food)\s+(with|containing|that have)\s+/i.test(dq)) {
        console.log(`[intent-parser] Clearing generic dish_query="${intent.dish_query}" because ingredients detected: ${intent.ingredients}`);
        intent.dish_query = null;
      }
      // Also clear if dish_query is just "with <ingredient>"
      else if (/^with\s+/i.test(dq)) {
        console.log(`[intent-parser] Clearing "with..." dish_query="${intent.dish_query}" because ingredients detected`);
        intent.dish_query = null;
      }
    }

    return intent;
  } catch (error) {
    console.error("[parseUserIntent] Error parsing intent:", error);

    // Fallback: return basic intent
    return {
      dish_query: userQuery.trim() || null,
      city: null,
      dietary: [],
      allergy: [],
      ingredients: [], // New field for ingredient-based searches
      price_max: null,
      language: "en",
      original_query: userQuery,
      is_vague: false,
      restaurant_name: null,
      show_menu: false,
      is_drink: false,
      exit_restaurant: false,
      is_restaurant_lookup: detectRestaurantLookup(userQuery),
    };
  }
}
