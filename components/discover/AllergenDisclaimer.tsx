"use client";

interface AllergenDisclaimerProps {
    visible?: boolean;
    className?: string;
}

/**
 * Allergen disclaimer bar shown once per menu container (not per dish)
 * Only display if any dish has allergen tags
 */
export function AllergenDisclaimer({ visible = true, className = "" }: AllergenDisclaimerProps) {
    if (!visible) return null;

    return (
        <div className={`flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 ${className}`}>
            <span>⚠️</span>
            <span>Dishes may contain allergens. If you have allergies, please contact the restaurant.</span>
        </div>
    );
}
