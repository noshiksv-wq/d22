/**
 * i18n.ts - Localization dictionary for static strings
 * Supports: en, sv, hi, pa (with English fallback)
 */

export type SupportedLang = "en" | "sv" | "hi" | "pa" | string;

export function t(lang: SupportedLang, key: string, vars?: Record<string, string>): string {
    const L = (lang || "en").toLowerCase();

    const dict: Record<string, Record<string, string>> = {
        en: {
            NO_CONTEXT_FOLLOWUP: "I don't have any previous results to refer to. Could you tell me what you're looking for?",
            FACT_NO_MATCH: "I'm unsure which dish you mean. Could you specify?",
            BACK_TO_SEARCHING: "Back to searching all restaurants. What would you like to find?",
            ALLERGEN_TAGGED_PREFIX: "Contains allergens (tagged): {list}. ⚠️ Tags are guidance; cross-contamination may occur.",
            ALLERGEN_NOT_TAGGED: "No allergens are tagged for {dish}. ⚠️ Tags are guidance; cross-contamination may occur.",
            TAGS_GUIDANCE_DISCLAIMER: "⚠️ Tags are guidance; cross-contamination may occur.",
            FOUND_RESULTS: "I found these matches:",
            FOUND_TAGGED: "I found dishes tagged '{tag}':",
            NO_RESULTS: "I couldn't find any matches for your search.",
            NO_TAGGED_FALLBACK: "I couldn't find any dishes tagged '{tag}'. Here are some popular restaurants to explore:",
            NO_MATCH_TRY_AGAIN: "I couldn't find any '{query}' that is {tag}. Try a different search?",
            YES_PREFIX: "✅ Yes —",
            NO_PREFIX: "❌ No —",
        },
        sv: {
            NO_CONTEXT_FOLLOWUP: "Jag har inga tidigare resultat att utgå från. Vad letar du efter?",
            FACT_NO_MATCH: "Jag är osäker på vilken rätt du menar. Kan du precisera?",
            BACK_TO_SEARCHING: "Tillbaka till sökning bland alla restauranger. Vad vill du hitta?",
            ALLERGEN_TAGGED_PREFIX: "Innehåller allergener (taggade): {list}. ⚠️ Taggar är vägledning; korskontaminering kan förekomma.",
            ALLERGEN_NOT_TAGGED: "Inga allergener är taggade för {dish}. ⚠️ Taggar är vägledning; korskontaminering kan förekomma.",
            TAGS_GUIDANCE_DISCLAIMER: "⚠️ Taggar är vägledning; korskontaminering kan förekomma.",
            FOUND_RESULTS: "Jag hittade dessa resultat:",
            FOUND_TAGGED: "Jag hittade rätter taggade '{tag}':",
            NO_RESULTS: "Jag kunde inte hitta några träffar för din sökning.",
            NO_TAGGED_FALLBACK: "Jag kunde inte hitta några rätter taggade '{tag}'. Här är några populära restauranger:",
            NO_MATCH_TRY_AGAIN: "Jag kunde inte hitta några '{query}' som är {tag}. Prova en annan sökning?",
            YES_PREFIX: "✅ Ja —",
            NO_PREFIX: "❌ Nej —",
        },
        hi: {
            NO_CONTEXT_FOLLOWUP: "मेरे पास पिछले परिणाम नहीं हैं। आप क्या खोज रहे हैं?",
            FACT_NO_MATCH: "मुझे समझ नहीं आया आप किस व्यंजन की बात कर रहे हैं। कृपया स्पष्ट करें?",
            BACK_TO_SEARCHING: "सभी रेस्तराँ खोजने पर वापस। आप क्या खोजना चाहते हैं?",
            ALLERGEN_TAGGED_PREFIX: "एलर्जेन (टैग किए गए): {list}। ⚠️ टैग केवल मार्गदर्शन हैं; क्रॉस-संदूषण हो सकता है।",
            ALLERGEN_NOT_TAGGED: "{dish} के लिए कोई एलर्जेन टैग नहीं किया गया। ⚠️ टैग केवल मार्गदर्शन हैं; क्रॉस-संदूषण हो सकता है।",
            TAGS_GUIDANCE_DISCLAIMER: "⚠️ टैग केवल मार्गदर्शन हैं; क्रॉस-संदूषण हो सकता है।",
            FOUND_RESULTS: "मुझे ये मिला:",
            FOUND_TAGGED: "मुझे '{tag}' टैग वाले व्यंजन मिले:",
            NO_RESULTS: "मुझे आपकी खोज के लिए कोई परिणाम नहीं मिला।",
            NO_TAGGED_FALLBACK: "मुझे '{tag}' टैग वाले कोई व्यंजन नहीं मिले। यहाँ कुछ लोकप्रिय रेस्तराँ हैं:",
            NO_MATCH_TRY_AGAIN: "मुझे कोई '{query}' नहीं मिला जो {tag} हो। कोई और खोज आज़माएँ?",
            YES_PREFIX: "✅ हाँ —",
            NO_PREFIX: "❌ नहीं —",
        },
        pa: {
            NO_CONTEXT_FOLLOWUP: "ਮੇਰੇ ਕੋਲ ਪਿਛਲੇ ਨਤੀਜੇ ਨਹੀਂ ਹਨ। ਤੁਸੀਂ ਕੀ ਲੱਭ ਰਹੇ ਹੋ?",
            FACT_NO_MATCH: "ਮੈਨੂੰ ਸਮਝ ਨਹੀਂ ਆਇਆ ਤੁਸੀਂ ਕਿਹੜੇ ਪਕਵਾਨ ਦੀ ਗੱਲ ਕਰ ਰਹੇ ਹੋ। ਕਿਰਪਾ ਕਰਕੇ ਦੱਸੋ?",
            BACK_TO_SEARCHING: "ਸਾਰੇ ਰੈਸਟੋਰੈਂਟਾਂ ਦੀ ਖੋਜ 'ਤੇ ਵਾਪਸ। ਤੁਸੀਂ ਕੀ ਲੱਭਣਾ ਚਾਹੁੰਦੇ ਹੋ?",
            ALLERGEN_TAGGED_PREFIX: "ਐਲਰਜੀ (ਟੈਗ ਕੀਤੇ): {list}। ⚠️ ਟੈਗ ਸਿਰਫ਼ ਮਾਰਗਦਰਸ਼ਨ ਹਨ; ਕਰਾਸ-ਦੂਸ਼ਣ ਹੋ ਸਕਦਾ ਹੈ।",
            ALLERGEN_NOT_TAGGED: "{dish} ਲਈ ਕੋਈ ਐਲਰਜੀ ਟੈਗ ਨਹੀਂ ਕੀਤਾ। ⚠️ ਟੈਗ ਸਿਰਫ਼ ਮਾਰਗਦਰਸ਼ਨ ਹਨ; ਕਰਾਸ-ਦੂਸ਼ਣ ਹੋ ਸਕਦਾ ਹੈ।",
            TAGS_GUIDANCE_DISCLAIMER: "⚠️ ਟੈਗ ਸਿਰਫ਼ ਮਾਰਗਦਰਸ਼ਨ ਹਨ; ਕਰਾਸ-ਦੂਸ਼ਣ ਹੋ ਸਕਦਾ ਹੈ।",
            FOUND_RESULTS: "ਮੈਨੂੰ ਇਹ ਮਿਲਿਆ:",
            FOUND_TAGGED: "ਮੈਨੂੰ '{tag}' ਟੈਗ ਵਾਲੇ ਪਕਵਾਨ ਮਿਲੇ:",
            NO_RESULTS: "ਮੈਨੂੰ ਤੁਹਾਡੀ ਖੋਜ ਲਈ ਕੋਈ ਨਤੀਜਾ ਨਹੀਂ ਮਿਲਿਆ।",
            NO_TAGGED_FALLBACK: "ਮੈਨੂੰ '{tag}' ਟੈਗ ਵਾਲੇ ਕੋਈ ਪਕਵਾਨ ਨਹੀਂ ਮਿਲੇ। ਇੱਥੇ ਕੁਝ ਪ੍ਰਸਿੱਧ ਰੈਸਟੋਰੈਂਟ ਹਨ:",
            NO_MATCH_TRY_AGAIN: "ਮੈਨੂੰ ਕੋਈ '{query}' ਨਹੀਂ ਮਿਲਿਆ ਜੋ {tag} ਹੋਵੇ। ਕੋਈ ਹੋਰ ਖੋਜ ਅਜ਼ਮਾਓ?",
            YES_PREFIX: "✅ ਹਾਂ —",
            NO_PREFIX: "❌ ਨਹੀਂ —",
        },
    };

    const base = dict[L] || dict.en;
    let s = base[key] || dict.en[key] || "";
    if (vars) {
        for (const k of Object.keys(vars)) {
            s = s.replaceAll(`{${k}}`, vars[k]);
        }
    }
    return s;
}

/**
 * Check if a language code is in our supported dictionary set
 */
export function isSupportedDictLang(lang: string): boolean {
    const L = (lang || "en").toLowerCase();
    return ["en", "sv", "hi", "pa"].includes(L);
}
