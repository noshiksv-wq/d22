"use client";

import React, { useMemo } from "react";
import type { DishMatch, MenuItem, TagInfo } from "@/lib/types/discover";

// Flexible type that works with both DishMatch (discovery) and MenuItem (full menu)
type DishRowItem = DishMatch | MenuItem;

interface DishRowProps {
    dish: DishRowItem;
    variant: "compact" | "full";
    showSectionName?: boolean;
    sectionName?: string; // Optional external section name for MenuItem which doesn't have it
}

/**
 * Shared dish display component for consistent styling across:
 * - Discovery results
 * - Menu preview
 * - Full menu sections
 * 
 * Tag grouping:
 * - diet + religious → gradient chips (✓ Vegetarian, ✓ Halal)
 * - allergen → "Contains: Gluten, Dairy" line
 */
export const DishRow = React.memo(function DishRow({ dish, variant, showSectionName = false, sectionName }: DishRowProps) {
    // Memoize tag grouping to avoid recalculating on every render
    const { dietAndReligious, allergens } = useMemo(() => {
        const diet: TagInfo[] = [];
        const allerg: TagInfo[] = [];

        if (dish.tags) {
            for (const tag of dish.tags) {
                if (tag.type === "allergen") {
                    allerg.push(tag);
                } else {
                    diet.push(tag);
                }
            }
        }
        return { dietAndReligious: diet, allergens: allerg };
    }, [dish.tags]);

    const isCompact = variant === "compact";
    const padding = isCompact ? "p-2" : "p-3";
    const gap = isCompact ? "mt-1" : "mt-2";

    // Get section name from prop or from dish (DishMatch has section_name, MenuItem doesn't)
    const displaySectionName = sectionName || ('section_name' in dish ? dish.section_name : undefined);

    return (
        <div className={`bg-slate-50/80 rounded-xl ${padding} border border-slate-100`}>
            {/* Section name (optional, uppercase) */}
            {showSectionName && displaySectionName && (
                <div className="text-xs text-slate-400 mb-1 uppercase tracking-wide">
                    {displaySectionName}
                </div>
            )}

            {/* Dish name + price row */}
            <div className="flex justify-between items-start gap-2">
                <div className="flex-1">
                    <div className={`font-medium text-slate-700 ${isCompact ? "text-sm" : ""}`}>
                        {dish.name}
                    </div>
                </div>
                {dish.price !== null && dish.price !== undefined && dish.price > 0 && (
                    <div className={`font-semibold text-indigo-600 whitespace-nowrap ${isCompact ? "text-xs" : "text-sm"}`}>
                        {dish.price} kr
                    </div>
                )}
            </div>

            {/* Description */}
            {dish.description && (
                <div className={`text-xs text-slate-500 ${gap} ${isCompact ? "line-clamp-1" : "line-clamp-2"}`}>
                    {dish.description}
                </div>
            )}

            {/* Diet + Religious chips */}
            {dietAndReligious.length > 0 && (
                <div className={`flex flex-wrap gap-1.5 ${gap}`}>
                    {dietAndReligious.map((tag) => (
                        <span
                            key={tag.id}
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium 
                       bg-gradient-to-r from-emerald-50 to-teal-50 text-emerald-700 
                       border border-emerald-200/50 shadow-sm"
                        >
                            ✓ {tag.name}
                        </span>
                    ))}
                </div>
            )}

            {/* Allergen line */}
            {allergens.length > 0 && (
                <div className={`text-xs text-amber-600 ${gap}`}>
                    Contains: {allergens.map(t => t.name).join(", ")}
                </div>
            )}
        </div>
    );
});
