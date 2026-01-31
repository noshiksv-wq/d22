"use client";

import React, { useState, useMemo, useCallback } from "react";
import { Phone, MapPin, Globe, ChevronDown, ChevronUp, ArrowLeft, Search, ShoppingCart, X, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";
import type { RestaurantCard, DishMatch, MenuPayload } from "@/lib/types/discover";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DishRow } from "./DishRow";
import { AllergenDisclaimer } from "./AllergenDisclaimer";

interface RestaurantProfileCardProps {
    restaurant: RestaurantCard;
    statusText?: string; // "🟢 Open now • 11:00-22:00" or "🔴 Closed"
    onViewFullMenu?: () => void;
    onCall?: () => void;
    onDirections?: () => void;
    onBackToDiscovery?: () => void;
    isExpanded?: boolean;
    // For in-place menu expansion
    fullMenu?: MenuPayload | null;
    isLoadingMenu?: boolean;
}

export const RestaurantProfileCard = React.memo(function RestaurantProfileCard({
    restaurant,
    statusText,
    onViewFullMenu,
    onCall,
    onDirections,
    onBackToDiscovery,
    isExpanded = false,
    fullMenu,
    isLoadingMenu = false,
}: RestaurantProfileCardProps) {
    const [showMoreAmenities, setShowMoreAmenities] = useState(false);
    const [menuSearchQuery, setMenuSearchQuery] = useState("");
    const [orderModalOpen, setOrderModalOpen] = useState(false);

    // Memoize order URL computation
    const getOrderUrl = useCallback(() => {
        const baseUrl = process.env.NEXT_PUBLIC_B2B_BASE_URL || 'https://nordix-ai-ho91.vercel.app';
        return `${baseUrl}/menu/${restaurant.id}?utm_source=discovery&utm_medium=order_modal`;
    }, [restaurant.id]);

    // Memoize amenities list
    const amenitiesList = useMemo(() => {
        const list: { emoji: string; label: string }[] = [];
        if (restaurant.amenities) {
            if (restaurant.amenities.kid_friendly) list.push({ emoji: "👶", label: "Kid-friendly" });
            if (restaurant.amenities.wheelchair_accessible) list.push({ emoji: "♿", label: "Accessible" });
            if (restaurant.amenities.outdoor_seating) list.push({ emoji: "🌿", label: "Outdoor" });
            if (restaurant.amenities.has_wifi) list.push({ emoji: "📶", label: "WiFi" });
            if (restaurant.amenities.has_parking) list.push({ emoji: "🅿️", label: "Parking" });
            if (restaurant.amenities.pet_friendly) list.push({ emoji: "🐕", label: "Pet-friendly" });
            if (restaurant.amenities.has_bar) list.push({ emoji: "🍸", label: "Bar" });
        }
        return list;
    }, [restaurant.amenities]);

    const visibleAmenities = showMoreAmenities ? amenitiesList : amenitiesList.slice(0, 3);
    const hasMoreAmenities = amenitiesList.length > 3;

    // Menu preview (top 3 dishes)
    const menuPreview = restaurant.matches?.slice(0, 3) || [];

    // Memoize filtered menus for full menu view
    const filteredMenus = useMemo(() => {
        if (!fullMenu) return [];

        const query = menuSearchQuery.toLowerCase().trim();

        // Use new menus array if available, otherwise fallback to flat sections
        const menusToRender = fullMenu.menus && fullMenu.menus.length > 0
            ? fullMenu.menus
            : [{ id: "default", name: "", sections: fullMenu.sections }];

        // Filter sections/items by search query
        return menusToRender.map(menu => ({
            ...menu,
            sections: menu.sections.map(section => ({
                ...section,
                items: section.items.filter(item =>
                    !query ||
                    item.name.toLowerCase().includes(query) ||
                    item.description?.toLowerCase().includes(query)
                ),
            })).filter(section => section.items.length > 0),
        })).filter(menu => menu.sections.length > 0);
    }, [fullMenu, menuSearchQuery]);

    // Build directions URL
    const getDirectionsUrl = useCallback(() => {
        if (restaurant.address) {
            return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.address + (restaurant.city ? ", " + restaurant.city : ""))}`;
        }
        return null;
    }, [restaurant.address, restaurant.city]);

    return (
        <>
            <Card className="overflow-hidden bg-white/95 backdrop-blur-sm border border-slate-200 shadow-lg">
                {/* Header Section */}
                <div className="px-5 pt-5 pb-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                            {/* Name + Claimed badge */}
                            <div className="flex items-center gap-2 flex-wrap">
                                <h2 className="text-xl font-bold text-slate-900">{restaurant.name}</h2>
                                {restaurant.ownerId ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
                                        <CheckCircle2 className="h-3 w-3" />
                                        Claimed
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-600 rounded-full">
                                        <AlertCircle className="h-3 w-3" />
                                        Not claimed
                                    </span>
                                )}
                            </div>

                            {/* City + Cuisine */}
                            <div className="text-sm text-slate-600 mt-1 flex items-center gap-2">
                                {restaurant.city && <span>{restaurant.city}</span>}
                                {restaurant.city && restaurant.cuisine_type && <span className="text-slate-300">•</span>}
                                {restaurant.cuisine_type && <span>{restaurant.cuisine_type}</span>}
                            </div>
                        </div>
                    </div>

                    {/* Status (Open/Closed) */}
                    {statusText && (
                        <div className="mt-3 text-sm font-medium">
                            {statusText}
                        </div>
                    )}

                    {/* Address */}
                    {restaurant.address && (
                        <div className="mt-2 text-sm text-slate-600 flex items-center gap-1.5">
                            <MapPin className="h-4 w-4 text-slate-400" />
                            <span>{restaurant.address}</span>
                        </div>
                    )}
                </div>

                {/* Action Buttons Row */}
                <div className="px-5 py-3 border-t border-slate-100 flex flex-wrap gap-2">
                    {restaurant.phone && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex items-center gap-2"
                            onClick={() => {
                                if (onCall) onCall();
                                else window.location.href = `tel:${restaurant.phone}`;
                            }}
                        >
                            <Phone className="h-4 w-4" />
                            Call
                        </Button>
                    )}

                    {getDirectionsUrl() && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex items-center gap-2"
                            onClick={() => {
                                if (onDirections) onDirections();
                                else window.open(getDirectionsUrl()!, "_blank");
                            }}
                        >
                            <MapPin className="h-4 w-4" />
                            Directions
                        </Button>
                    )}

                    {restaurant.website && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex items-center gap-2"
                            onClick={() => window.open(restaurant.website!, "_blank")}
                        >
                            <Globe className="h-4 w-4" />
                            Website
                        </Button>
                    )}

                    {/* Order Online - Opens modal with embedded menu */}
                    <Button
                        variant="default"
                        size="sm"
                        className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => setOrderModalOpen(true)}
                    >
                        <ShoppingCart className="h-4 w-4" />
                        Order Online
                    </Button>

                    {/* Claim this restaurant - only for unclaimed */}
                    {!restaurant.ownerId && (
                        <Link href={`/claim/request?restaurant_id=${restaurant.id}`}>
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex items-center gap-2 border-amber-300 text-amber-700 hover:bg-amber-50 hover:border-amber-400"
                            >
                                <AlertCircle className="h-4 w-4" />
                                Claim this restaurant
                            </Button>
                        </Link>
                    )}
                </div>

                {/* Services Badges */}
                <div className="px-5 py-3 border-t border-slate-100">
                    <div className="flex flex-wrap gap-2 text-xs">
                        {restaurant.accepts_dine_in && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-full font-medium">
                                🍽️ Dine-in
                            </span>
                        )}
                        {restaurant.accepts_takeaway && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-orange-50 text-orange-700 rounded-full font-medium">
                                📦 Takeaway
                            </span>
                        )}
                        {restaurant.accepts_delivery && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-full font-medium">
                                🚗 Delivery
                            </span>
                        )}
                        {restaurant.accepts_reservations && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-purple-50 text-purple-700 rounded-full font-medium">
                                📅 Reservations
                            </span>
                        )}
                    </div>
                </div>

                {/* Amenities Chips */}
                {amenitiesList.length > 0 && (
                    <div className="px-5 py-3 border-t border-slate-100">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            {visibleAmenities.map((a, i) => (
                                <span
                                    key={i}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full"
                                >
                                    {a.emoji} {a.label}
                                </span>
                            ))}
                            {hasMoreAmenities && (
                                <button
                                    onClick={() => setShowMoreAmenities(!showMoreAmenities)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors"
                                >
                                    {showMoreAmenities ? (
                                        <>
                                            <ChevronUp className="h-3 w-3" /> Less
                                        </>
                                    ) : (
                                        <>
                                            <ChevronDown className="h-3 w-3" /> +{amenitiesList.length - 3} more
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Full Menu (expanded in-place) */}
                {fullMenu && fullMenu.sections && (
                    <div className="border-t border-slate-200 bg-white">
                        {/* Full Menu Header with Back Button */}
                        <div className="sticky top-0 z-10 bg-white border-b px-4 py-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={onBackToDiscovery}
                                        className="text-indigo-600 hover:text-indigo-700"
                                    >
                                        <ArrowLeft className="h-4 w-4 mr-1" />
                                        Back
                                    </Button>
                                    <h3 className="font-semibold text-base">Full Menu</h3>
                                </div>
                                <span className="text-xs text-slate-500">
                                    {fullMenu.sections.reduce((acc, s) => acc + s.items.length, 0)} items
                                </span>
                            </div>

                            {/* Menu Search */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                <Input
                                    type="text"
                                    placeholder="Search menu..."
                                    value={menuSearchQuery}
                                    onChange={(e) => setMenuSearchQuery(e.target.value)}
                                    className="pl-9 w-full"
                                />
                            </div>
                        </div>

                        {/* Scrollable Menu Content */}
                        <div className="max-h-[50vh] overflow-y-auto px-4 py-4">
                            {filteredMenus.length === 0 ? (
                                <div className="text-center py-8 text-slate-500">
                                    No items match "{menuSearchQuery}"
                                </div>
                            ) : (
                                <div className="space-y-8">
                                    {filteredMenus.map((menu, menuIdx) => (
                                        <div key={menu.id || menuIdx}>
                                            {/* Menu Name Header (Lunch, À la carte, etc.) */}
                                            {menu.name && (
                                                <h3 className="text-lg font-bold text-indigo-700 border-b-2 border-indigo-200 pb-2 mb-4">
                                                    {menu.name}
                                                </h3>
                                            )}
                                            <div className="space-y-6">
                                                {menu.sections.map((section, idx) => (
                                                    <details key={`${menu.id}-${section.name}-${idx}`} open={idx < 3}>
                                                        <summary className="cursor-pointer font-semibold text-sm text-slate-700 py-2 hover:text-indigo-600 list-none flex justify-between items-center">
                                                            <span>{section.name}</span>
                                                            <span className="text-xs text-slate-400">{section.items.length}</span>
                                                        </summary>
                                                        <div className="mt-2 space-y-2 pl-2">
                                                            {section.items.map(item => (
                                                                <DishRow
                                                                    key={item.id}
                                                                    dish={item}
                                                                    variant="full"
                                                                />
                                                            ))}
                                                        </div>
                                                    </details>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Menu Preview (when full menu not loaded) */}
                {!fullMenu && menuPreview.length > 0 && (
                    <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/50">
                        <h3 className="text-sm font-semibold text-slate-700 mb-3">Menu Preview</h3>
                        <div className="space-y-2">
                            {menuPreview.map((dish: DishMatch) => (
                                <div key={dish.id} className="flex justify-between items-start">
                                    <div className="flex-1">
                                        <span className="text-sm font-medium text-slate-800">{dish.name}</span>
                                        {dish.description && (
                                            <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{dish.description}</p>
                                        )}
                                    </div>
                                    {dish.price !== null && dish.price !== undefined && (
                                        <span className="text-sm font-semibold text-slate-600 ml-4">
                                            {dish.price} kr
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* View Full Menu Button */}
                        <Button
                            variant="default"
                            size="sm"
                            className="w-full mt-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700"
                            onClick={onViewFullMenu}
                            disabled={isLoadingMenu}
                        >
                            {isLoadingMenu ? "Loading..." : "View Full Menu →"}
                        </Button>
                    </div>
                )}

                {/* Not Confirmed Warning (if data is missing) */}
                {!restaurant.phone && !restaurant.opening_hours && !fullMenu && (
                    <div className="px-5 py-3 border-t border-slate-100 bg-amber-50/50">
                        <p className="text-xs text-amber-700">
                            ℹ️ Some details not confirmed — please call the restaurant to verify.
                        </p>
                    </div>
                )}
            </Card>

            {/* Order Modal - Fullscreen overlay with iframe */}
            {
                orderModalOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                        <div className="relative w-full max-w-4xl h-[85vh] bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col">
                            {/* Modal Header */}
                            <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-green-600 to-green-700 text-white">
                                <div className="flex items-center gap-2">
                                    <ShoppingCart className="h-5 w-5" />
                                    <span className="font-semibold">Order from {restaurant.name}</span>
                                </div>
                                <button
                                    onClick={() => setOrderModalOpen(false)}
                                    className="p-1 hover:bg-white/20 rounded-full transition-colors"
                                    title="Close"
                                    aria-label="Close order modal"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>

                            {/* Iframe */}
                            <div className="flex-1 relative">
                                <iframe
                                    src={getOrderUrl()}
                                    className="w-full h-full border-0"
                                    title={`Order from ${restaurant.name}`}
                                />
                            </div>
                        </div>
                    </div>
                )
            }
        </>
    );
});
