export type Role = "user" | "assistant" | "system";

export type Mode = "discovery" | "restaurant" | "restaurant_profile";

export type MessageKind = "answer" | "results" | "restaurant_profile" | "patch";

// Tag with full info for UI categorization
export interface TagInfo {
  id: string;
  name: string;
  slug: string;
  type: 'diet' | 'allergen' | 'religious';
}

export interface DishMatch {
  id: string;
  name: string;
  description: string | null;
  price: number;
  tags?: TagInfo[]; // Full tag info (empty array if not populated)
  section_name?: string | null; // Section name (e.g., "NAAN", "Tandoori", "Antipasti")
}

export interface RestaurantCard {
  id: string;
  name: string;
  city: string | null;
  cuisine_type?: string | null;
  highlight?: string | null; // e.g., matched dish name
  matches?: DishMatch[];
  address?: string | null;
  distance_km?: number | null;
  more_dishes_count?: number; // From result limiter - how many dishes were truncated
  // Per-restaurant pagination
  pagination?: {
    shown: number;        // Number of dishes currently shown
    total: number;        // Total dishes for this restaurant (from search)
    remaining: number;    // Dishes not yet shown (total - shown)
    next_offset?: number; // Next offset for fetching more dishes (undefined if none)
  };
  // Restaurant details for rich display
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  opening_hours?: Record<string, string> | null; // e.g., { "monday": "11:00-22:00" }
  // Service options
  accepts_dine_in?: boolean;
  accepts_takeaway?: boolean;
  accepts_delivery?: boolean;
  accepts_reservations?: boolean;
  // Amenities (child-friendly, wheelchair, parking, etc.)
  amenities?: {
    kid_friendly?: boolean;
    wheelchair_accessible?: boolean;
    outdoor_seating?: boolean;
    has_parking?: boolean;
    has_wifi?: boolean;
    pet_friendly?: boolean;
    has_bar?: boolean;
  } | null;
  // Ownership / claim status
  ownerId?: string | null;      // If set, restaurant is claimed
  verifiedAt?: string | null;   // If set (and ownerId set), restaurant is verified
}

export interface MenuItem {
  id: string;
  name: string;
  description?: string | null;
  price?: number | null;
  tags?: TagInfo[]; // Full tag info (empty array if not populated)
}

export interface MenuSection {
  name: string;
  items: MenuItem[];
}

// A named menu (e.g., "Lunch", "À la carte") containing sections
export interface MenuGroup {
  id: string;
  name: string;
  sections: MenuSection[];
}

export interface MenuPayload {
  restaurantId: string;
  restaurantName: string;
  city?: string | null;
  // Either use flat sections (legacy) or menus array (new)
  sections: MenuSection[]; // Flat sections for backward compatibility
  menus?: MenuGroup[]; // Grouped by menu name (Lunch, À la carte, etc.)
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  kind: MessageKind; // REQUIRED: Explicit message type for UI rendering
  restaurants?: RestaurantCard[]; // For discovery mode responses
  followupChips?: string[]; // e.g., ["Show me vegan options", "What's nearby?"]
  menuUrl?: string | null; // Optional URL to open menu in new tab
  menu?: MenuPayload | null; // Inline menu card data
}

export interface ChatPrefs {
  language?: string | null;            // "en" | "sv" | "hi" etc
  dietary?: string[] | null;           // ["vegetarian","halal"]
  city?: string | null;                // "Göteborg"
  budgetMaxSek?: number | null;        // 120
}

export interface GroundedDish {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
}

export interface GroundedRestaurant {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  matches: GroundedDish[];
}

export interface GroundedState {
  restaurants: GroundedRestaurant[];
  lastQuery?: string;
  lastDietary?: string[] | null;
  lastMatchesCount?: number;      // Total matches in last search
  lastWasNoResults?: boolean;     // True if last search returned 0 results
}

// Dish from last search results for follow-up grounding
export interface LastResultDish {
  dish_id: string;
  dish_name: string;
  restaurant_id: string;
  restaurant_name: string;
  tag_slugs?: string[];  // e.g., ["halal", "vegetarian"]
  price?: number | null;
  description?: string | null;  // Menu description for attribute followups
}

// Stored explanation for translation follow-ups
export interface LastExplain {
  text: string;              // The explanation text to translate
  dishIds?: string[];        // Source dish IDs
  language: string;          // Current language ("en", "sv")
}

// Stored search params for pagination "show more"
export interface LastSearchParams {
  dietary?: string[];
  dishQuery?: string | null;
  city?: string | null;
  offset: number;
}

// Per-restaurant cursor for "show more from X" functionality
export interface RestaurantCursor {
  restaurant_id: string;
  restaurant_name: string;
  shown_count: number;
  total_matches: number;
  next_offset?: number;  // undefined if no more dishes
}

export interface ChatState {
  mode: Mode;
  preferred_language?: string | null;  // Detect from client navigator.language
  restaurant_focus_id?: string | null; // Drives focus pill/back button, NOT mode
  currentRestaurantId?: string | null;
  currentRestaurantName?: string | null;
  grounded?: GroundedState; // Persisted grounded results
  last_results?: LastResultDish[];  // Dishes from last search for follow-ups
  last_explain?: LastExplain;       // Last explanation for translation
  last_search_params?: LastSearchParams;  // For pagination
  next_offset?: number;             // Offset for "show more"
  restaurant_cursors?: RestaurantCursor[];  // Per-restaurant cursors for "show more from X"

  prefs?: ChatPrefs;                   // Long-lived session prefs
  lastAnswerKind?: "results" | "fallback" | "explain" | "clarify" | null;
  lastAnswerSig?: string | null;       // Signature to prevent repeats
}

export interface DiscoverChatRequest {
  messages: { role: Role; content: string }[];
  chatState?: ChatState;
  // UI action for in-place updates (e.g., Load More, View Full Menu)
  ui_action?: "LOAD_MORE_RESTAURANT" | "VIEW_FULL_MENU";
  targetRestaurantId?: string;
  target_message_id?: string; // REQUIRED for patch responses
  offset?: number;
}


export interface TruncationMeta {
  total_restaurants: number;
  total_matches: number;
  truncated: boolean;
  restaurants_returned: number;
  dishes_per_restaurant: number;
  next_offset?: number;  // Offset for next page, undefined if no more
}

// Patch response for in-place UI updates (Load More)
export interface PatchResponse {
  type: "patch";
  restaurantId: string;
  restaurantName: string;
  appendDishes: DishMatch[];
  pagination: {
    shown: number;
    total: number;
    next_offset?: number;
  };
  // Updated last_results for follow-up grounding
  updatedLastResults?: LastResultDish[];
}

export interface DiscoverChatResponse {
  message: ChatMessage;
  chatState: ChatState;
  grounded?: GroundedState | null; // Grounding context for follow-up questions
  meta?: TruncationMeta;
}

export interface Intent {
  dish_query: string | null;
  city: string | null;
  dietary: string[];
  allergy: string[];
  ingredients: string[];
  price_max: number | null;
  language: string;
  original_query: string;
  is_vague: boolean; // For "anything"/"something"/"hungry" queries
  restaurant_name?: string | null; // For menu requests like "show menu of Sandhu restaurant"
  show_menu?: boolean; // True when user wants to see full menu
  is_drink?: boolean; // True when the query is specifically about drinks
  exit_restaurant?: boolean; // True when user wants to exit restaurant mode
  hard_tags?: string[]; // Hard constraint tags (satvik, halal, gluten-free, nut-free, lactose-free, dairy-free) - require explicit tags
  is_followup?: boolean; // True for follow-up questions like "what is X", "is it halal", etc.
  is_restaurant_lookup?: boolean; // True when query looks like a restaurant name (2-4 words, proper noun)
  cuisine?: string | null; // Cuisine type filter (e.g., "indian", "italian", "chinese")
}
