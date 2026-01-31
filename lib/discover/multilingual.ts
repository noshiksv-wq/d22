/**
 * multilingual.ts - LLM-based translation fallback for unsupported languages
 * Only called when the user's language is NOT in the supported dictionary set (en/sv/hi/pa)
 */

import type OpenAI from "openai";
import { isSupportedDictLang } from "./i18n";

// ==========================================
// PART A: Language Normalization & Priority
// ==========================================

const PRIORITY_LANGS = new Set(["sv", "en", "de", "da", "nb", "no", "fi", "hi", "pa", "ar", "ru", "fr", "es", "zh"]);

export function normalizeLang(lang?: string | null): string {
    if (!lang) return "en";
    const base = lang.toLowerCase().split("-")[0];
    if (base === "no") return "nb"; // browser often sends "no"
    return base;
}

export function languageName(code: string): string {
    const c = normalizeLang(code);
    const map: Record<string, string> = {
        en: "English",
        sv: "Swedish",
        de: "German",
        da: "Danish",
        nb: "Norwegian (Bokmål)",
        fi: "Finnish",
        hi: "Hindi (Devanagari script)",
        pa: "Punjabi (Gurmukhi script)",
        ar: "Arabic",
        ru: "Russian (Cyrillic)",
        fr: "French",
        es: "Spanish",
        zh: "Chinese",
    };
    return map[c] ?? "English";
}

export function pickReplyLang(args: {
    intentLang?: string | null;
    preferredLang?: string | null;
    query?: string;
}): string {
    // 1. Prefer explicit preference (browser/user setting)
    const pref = normalizeLang(args.preferredLang);
    if (pref && pref !== "en") return pref;

    // 2. Fallback to intent language (if detected and not English)
    const intent = normalizeLang(args.intentLang);
    if (intent && intent !== "en") return intent;

    // 3. Last resort: Query hints (safer, avoiding ambiguity)
    const q = (args.query || "").toLowerCase();

    // Swedish: specific letters or common words
    if (/[åäö]/i.test(q) || /\b(vad|är|och|utan)\b/i.test(q)) return "sv";

    // Danish/Norwegian: specific letters or common words
    if (/[æø]/i.test(q) || /\b(hvor|ikke|uden|hvordan)\b/i.test(q)) return "nb";

    // German: specific letters or common words
    if (/[ß]/i.test(q) || /\b(bitte|ich|wo|gibt)\b/i.test(q)) return "de";

    // Note: 'vegansk', 'glutenfri' etc are ambiguous (SV/DA/NB), so we default to English 
    // unless preference/intent catches them.

    return "en";
}

/**
 * Translate a short string to the target language using LLM.
 * - Returns text as-is if language is in our dictionary set (en/sv/hi/pa)
 * - Otherwise, uses gpt-4o-mini to translate
 * - Preserves proper nouns in `keep` list (restaurant/dish names)
 */
export async function maybeTranslateShort(
    openai: OpenAI,
    text: string,
    lang: string,
    keep: string[] = []
): Promise<string> {
    const L = (lang || "en").toLowerCase();

    // If language is in our dictionary set, no translation needed
    if (isSupportedDictLang(L)) {
        return text;
    }

    // Build instruction to preserve specific terms
    const keepBlock = keep.length
        ? `Do NOT translate these exact strings (they are proper nouns):\n${keep.map(k => `- "${k}"`).join("\n")}\n`
        : "";

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: `You are a translation engine. Translate the following text to language code: ${L}. ${keepBlock}Keep markdown formatting (bold, lists, etc.) intact. Output ONLY the translated text, nothing else.`,
                },
                { role: "user", content: text },
            ],
        });

        return completion.choices[0]?.message?.content?.trim() || text;
    } catch (error) {
        console.error("[maybeTranslateShort] Translation failed, returning original:", error);
        return text;
    }
}

// In-memory cache for translated strings (reduces repeated API calls)
const translationCache = new Map<string, string>();

/**
 * Translate final response content to target language if not English.
 * Uses caching to avoid repeated translations during demos.
 */
export async function translateIfNeeded(
    openai: OpenAI,
    text: string,
    lang: string | null | undefined
): Promise<string> {
    if (!text) return text;
    if (!lang || lang === "en") return text;

    const L = lang.toLowerCase();
    const cacheKey = `${L}:${text}`;

    // Check cache first
    const cached = translationCache.get(cacheKey);
    if (cached) {
        console.log("[translateIfNeeded] Cache hit for", L);
        return cached;
    }

    // Determine script name for explicit instruction
    const scriptName = languageName(L);

    const systemPrompt = `You are a translator.
Translate the text to ${scriptName} while preserving:
- Dish names, restaurant names, brand names (do NOT translate proper nouns)
- Numbers, prices, currency
- Markdown formatting (**, lists, line breaks)
Keep it natural, friendly, and short.`;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.2,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Target language code: ${L}\nText:\n${text}` },
            ],
        });

        const translated = completion.choices[0]?.message?.content?.trim() || text;
        translationCache.set(cacheKey, translated);
        console.log("[translateIfNeeded] Translated to", L, ":", translated.substring(0, 50) + "...");
        return translated;
    } catch (error) {
        console.error("[translateIfNeeded] Translation failed:", error);
        return text;
    }
}
