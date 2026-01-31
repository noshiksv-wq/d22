export type Mode = "discovery" | "restaurant" | "restaurant_profile";

export type IntentLike = {
    dish_query?: string | null;
    dietary?: string[] | null;     // <-- our field
    diet_tags?: string[] | null;   // <-- accepted for compatibility
};

export type DishMatchLike = {
    name?: string | null;
    description?: string | null;
    section_name?: string | null;
    tags?: any;
    tag_slugs?: string[] | null;
};

export type RestaurantCardLike = {
    id: string;
    name: string;
    matches?: DishMatchLike[] | null;
};

const DIET_WORDS = new Set([
    "veg", "veggie", "vegetarian", "vegan", "halal", "kosher",
    "glutenfree", "gluten-free", "lactosefree", "lactose-free",
    "dairyfree", "dairy-free",
]);

const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "with", "without", "for", "of", "to", "in", "on", "near", "me",
]);

function normalizeText(s: string) {
    return s
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeQuery(q: string): string[] {
    const norm = normalizeText(q);
    if (!norm) return [];
    return norm
        .split(" ")
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => t.replace(/-/g, "")) // gluten-free -> glutenfree
        .filter(t => !STOPWORDS.has(t))
        .filter(t => !DIET_WORDS.has(t));
}

function requiredTokenMatches(tokens: string[]) {
    if (tokens.length <= 1) return 1;
    return Math.min(2, tokens.length);
}

function getDietTags(intent: IntentLike): string[] {
    return (intent.dietary ?? intent.diet_tags ?? []).filter(Boolean);
}

function getTagSlugs(m: DishMatchLike): string[] {
    if (Array.isArray(m.tag_slugs)) return m.tag_slugs.filter(Boolean);
    const t = m.tags;
    if (Array.isArray(t)) {
        return t
            .map((x: any) => (typeof x === "string" ? x : x?.slug))
            .filter((x: any) => typeof x === "string" && x.length > 0);
    }
    return [];
}

function isSimilar(str1: string, str2: string): boolean {
    const a = normalizeText(str1).replace(/[^\p{L}\p{N}]+/gu, "");
    const b = normalizeText(str2).replace(/[^\p{L}\p{N}]+/gu, "");

    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true; // Containment is good

    // Handle common variations
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

    return false;
}

function matchesDishQuery(match: DishMatchLike, dishQuery: string): boolean {
    const tokens = tokenizeQuery(dishQuery);
    if (tokens.length === 0) return true;

    const haystackWords = [match.name, match.description, match.section_name]
        .filter(Boolean)
        .map(s => normalizeText(s || ""))
        .join(" ")
        .split(" ")
        .filter(Boolean);

    const count = tokens.reduce((acc, tok) => {
        const found = haystackWords.some(word => isSimilar(tok, word));
        return found ? acc + 1 : acc;
    }, 0);

    return count >= requiredTokenMatches(tokens);
}

function isVeganStrict(intent: IntentLike): boolean {
    return getDietTags(intent).map(normalizeText).includes("vegan");
}

function dishIsVegan(match: DishMatchLike): boolean {
    const slugs = getTagSlugs(match).map(normalizeText);
    return slugs.includes("vegan");
}

export function finalizeResults<T extends RestaurantCardLike>(args: {
    mode: Mode;
    intent: IntentLike;
    cards: T[];
    currentRestaurantId?: string | null;
}): T[] {
    const { mode, intent, cards, currentRestaurantId } = args;

    // Rule 1: Focus isolation
    let out = cards;
    if (mode === "restaurant" && currentRestaurantId) {
        out = out.filter(r => r.id === currentRestaurantId);
    }

    // Rule 2 + 3: Match filtering
    const dishQuery = (intent.dish_query ?? "").toString().trim();
    const veganStrict = isVeganStrict(intent);

    out = out
        .map(r => {
            const matches = (r.matches || []).filter(m => {
                if (dishQuery && !matchesDishQuery(m, dishQuery)) return false;
                if (veganStrict && !dishIsVegan(m)) return false;
                return true;
            });
            return { ...r, matches };
        })
        .filter(r => {
            const hasMatches = (r.matches || []).length > 0;
            if (dishQuery || veganStrict) return hasMatches;
            return true;
        });

    return out;
}
