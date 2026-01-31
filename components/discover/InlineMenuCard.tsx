"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Send, Loader2, ExternalLink } from "lucide-react";
import type { MenuPayload } from "@/lib/types/discover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

interface InlineMenuCardProps {
  menu: MenuPayload;
  menuUrl?: string | null;
  onAskQuestion: (question: string) => void;
  isLoading?: boolean;
}

export const InlineMenuCard = React.memo(function InlineMenuCard({ menu, menuUrl, onAskQuestion, isLoading = false }: InlineMenuCardProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [askInput, setAskInput] = useState("");
  const askInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Memoize filtered sections to avoid recalculating on every render
  const filteredSections = useMemo(() =>
    menu.sections.map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!searchQuery.trim()) return true;
        const query = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(query) ||
          (item.description?.toLowerCase().includes(query) ?? false)
        );
      }),
    })).filter((section) => section.items.length > 0),
    [menu.sections, searchQuery]
  );

  const handleAskSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = askInput.trim();
    if (!trimmed || isLoading) return;
    onAskQuestion(trimmed);
    setAskInput("");
  }, [askInput, isLoading, onAskQuestion]);

  // Auto-focus ask input when component mounts
  useEffect(() => {
    setTimeout(() => askInputRef.current?.focus(), 100);
  }, []);

  return (
    <Card className="mt-4 overflow-hidden flex flex-col" style={{ maxHeight: "70vh" }}>
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-base">{menu.restaurantName}</h3>
            {menu.city && (
              <p className="text-sm text-muted-foreground">{menu.city}</p>
            )}
          </div>
          {menuUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(menuUrl, "_blank")}
              className="flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Open in new tab
            </Button>
          )}
        </div>
        {/* In-card search */}
        <Input
          type="text"
          placeholder="Search menu items..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full"
        />

        {/* Disclaimers - show when relevant tags are present */}
        {(() => {
          const FREE_FROM_SLUGS = ['gluten-free', 'dairy-free', 'nut-free', 'lactose-free'];
          const allTags = menu.sections.flatMap(s => s.items.flatMap(i => i.tags || []));
          const hasAllergens = allTags.some(t => t.type === 'allergen');
          const hasFreeFrom = allTags.some(t => t.type === 'diet' && FREE_FROM_SLUGS.includes(t.slug));

          if (!hasAllergens && !hasFreeFrom) return null;

          return (
            <div className="space-y-1 text-xs">
              {hasAllergens && (
                <div className="text-orange-700 bg-orange-50 px-2 py-1 rounded">
                  ⚠️ Allergy info is based on tags. Confirm with the restaurant about cross-contamination.
                </div>
              )}
              {hasFreeFrom && (
                <div className="text-teal-700 bg-teal-50 px-2 py-1 rounded">
                  ℹ️ Free-from labels are based on tags. Confirm cross-contamination if allergy is severe.
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Scrollable Menu Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={cardRef}>
        {filteredSections.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {searchQuery ? "No items found matching your search." : "No menu items available."}
          </div>
        ) : (
          <div className="space-y-6">
            {filteredSections.map((section, sectionIndex) => (
              <details
                key={`${section.name}-${sectionIndex}`}
                open={sectionIndex < 3} // Open first 3 sections by default
                className="group"
              >
                <summary className="cursor-pointer font-semibold text-base mb-2 list-none flex items-center justify-between py-2 hover:text-primary transition-colors">
                  <span>{section.name}</span>
                  <span className="text-xs text-muted-foreground group-open:rotate-180 transition-transform">
                    ▼
                  </span>
                </summary>
                <div className="mt-2 space-y-3 pl-2">
                  {section.items.map((item) => (
                    <div key={item.id} className="border-b pb-3 last:border-b-0">
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex-1">
                          <h4 className="font-medium text-sm">{item.name}</h4>
                          {item.description && (
                            <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
                          )}
                          {/* Grouped Tag Display */}
                          {(() => {
                            const tags = item.tags || [];
                            if (tags.length === 0) return null;

                            // Group tags by type
                            const FREE_FROM_SLUGS = ['gluten-free', 'dairy-free', 'nut-free', 'lactose-free'];
                            const dietary = tags.filter(t => t.type === 'diet' && !FREE_FROM_SLUGS.includes(t.slug));
                            const freeFrom = tags.filter(t => t.type === 'diet' && FREE_FROM_SLUGS.includes(t.slug));
                            const allergens = tags.filter(t => t.type === 'allergen');
                            const religious = tags.filter(t => t.type === 'religious');

                            return (
                              <div className="mt-2 space-y-1">
                                {/* Dietary tags (green) */}
                                {dietary.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {dietary.map((tag) => (
                                      <span key={tag.id} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                                        {tag.name}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {/* Religious tags (purple) */}
                                {religious.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {religious.map((tag) => (
                                      <span key={tag.id} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 border border-purple-200">
                                        {tag.name}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {/* Free-from tags (teal) */}
                                {freeFrom.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {freeFrom.map((tag) => (
                                      <span key={tag.id} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-100 text-teal-800 border border-teal-200">
                                        ✓ {tag.name}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {/* Allergen tags (orange with warning) */}
                                {allergens.length > 0 && (
                                  <div className="text-xs text-orange-700">
                                    <span className="font-medium">Contains: </span>
                                    {allergens.map(t => t.name).join(', ')}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                        {item.price !== null && item.price !== undefined && (
                          <div className="text-sm font-semibold whitespace-nowrap">
                            {typeof item.price === "number" ? `${item.price.toFixed(0)} kr` : item.price}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>

      {/* Sticky Ask Bar */}
      <div className="sticky bottom-0 bg-white border-t px-4 py-3">
        <form onSubmit={handleAskSubmit} className="flex gap-2">
          <Input
            ref={askInputRef}
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            placeholder={`Ask about ${menu.restaurantName}...`}
            disabled={isLoading}
            className="flex-1"
          />
          <Button type="submit" disabled={isLoading || !askInput.trim()}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </form>
      </div>
    </Card>
  );
});

