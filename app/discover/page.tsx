"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, ArrowLeft, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";
import type {
  ChatMessage,
  ChatState,
  RestaurantCard,
  MenuPayload,
} from "@/lib/types/discover";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InlineMenuCard } from "@/components/discover/InlineMenuCard";
import { RestaurantProfileCard } from "@/components/discover/RestaurantProfileCard";
import { DishRow } from "@/components/discover/DishRow";
import { AllergenDisclaimer } from "@/components/discover/AllergenDisclaimer";

export default function DiscoverPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      kind: "answer",
      content:
        "Hi! Tell me what you want to eat and where (e.g. 'halal butter chicken in Göteborg', 'vegan pizza in Stockholm').",
    },
  ]);
  const [chatState, setChatState] = useState<ChatState>({
    mode: "discovery",
    currentRestaurantId: null,
    currentRestaurantName: null,
  });
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // State for in-place menu expansion
  const [expandedMenus, setExpandedMenus] = useState<Record<string, MenuPayload>>({});
  const [loadingMenuId, setLoadingMenuId] = useState<string | null>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input and detect language on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
    // client-side only detection to avoid hydration mismatch
    if (typeof navigator !== 'undefined') {
      setChatState(prev => ({ ...prev, preferred_language: navigator.language }));
    }
  }, []);

  // Fetch full menu for in-place expansion
  const fetchMenuForRestaurant = async (restaurantId: string) => {
    if (expandedMenus[restaurantId]) return; // Already loaded

    setLoadingMenuId(restaurantId);
    try {
      const response = await fetch(`/api/menu/${restaurantId}`);
      if (response.ok) {
        const menuData: MenuPayload = await response.json();
        setExpandedMenus(prev => ({
          ...prev,
          [restaurantId]: menuData
        }));
      }
    } catch (error) {
      console.error("[discover] Error fetching menu:", error);
    } finally {
      setLoadingMenuId(null);
    }
  };

  // Close expanded menu (back to discovery)
  const collapseMenu = (restaurantId: string) => {
    setExpandedMenus(prev => {
      const { [restaurantId]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;

    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      kind: "answer",
      content: trimmedInput,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Prepare messages for API (only user and assistant, no system)
      // CRITICAL: Preserve kind, restaurants, and other metadata for server-side state logic
      const apiMessages = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.content,
          kind: m.kind,
          restaurants: m.restaurants,
          menu: m.menu,
          menuUrl: m.menuUrl,
        }));

      // Add current user message
      apiMessages.push({
        role: "user",
        content: trimmedInput,
        kind: "answer",
        restaurants: undefined,
        menu: undefined,
        menuUrl: undefined,
      });

      // Call API
      const response = await fetch("/api/discover/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: apiMessages,
          chatState,
        }),
      });

      if (!response.ok) {
        // Try to get error message from response
        let errorText = "Failed to get response";
        try {
          const errorData = await response.json();
          errorText = errorData.error || errorData.message || errorText;
        } catch {
          errorText = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorText);
      }

      const data = await response.json();

      console.log("[Discover] API Response:", {
        hasMessage: !!data.message,
        hasChatState: !!data.chatState,
        isPatch: data.type === "patch",
        messageContent: data.message?.content?.substring(0, 100),
        hasRestaurants: Array.isArray(data.message?.restaurants) && data.message.restaurants.length > 0,
        restaurantCount: Array.isArray(data.message?.restaurants) ? data.message.restaurants.length : 0,
        restaurants: data.message?.restaurants,
      });

      // FIX 2: Handle patch responses (from "show more from X" typed commands)
      if (data.type === "patch") {
        console.log("[Discover] Handling patch response for restaurant:", data.restaurantId);

        // Find the latest message containing this restaurant and merge dishes
        setMessages((prev) => {
          // Find the most recent message with this restaurant
          for (let i = prev.length - 1; i >= 0; i--) {
            const msg = prev[i];
            if (msg.restaurants?.some((r) => r.id === data.restaurantId)) {
              // Found it - update this message
              const updated = [...prev];
              updated[i] = {
                ...msg,
                restaurants: msg.restaurants?.map((r) => {
                  if (r.id !== data.restaurantId) return r;
                  // Merge new dishes (dedupe by id)
                  const existingIds = new Set(r.matches?.map((m) => m.id) || []);
                  const newDishes = (data.appendDishes || []).filter(
                    (d: { id: string }) => !existingIds.has(d.id)
                  );
                  return {
                    ...r,
                    matches: [...(r.matches || []), ...newDishes],
                    pagination: data.pagination,
                  };
                }),
              };
              return updated;
            }
          }
          return prev; // No matching message found
        });

        // Update chatState from patch response
        if (data.chatState) {
          setChatState(prev => ({
            ...prev,
            ...data.chatState,
            preferred_language: prev.preferred_language ?? data.chatState?.preferred_language ?? null,
          }));
        }
        return; // Don't add new message for patch responses
      }

      // Check if response has the expected structure
      if (!data.message || !data.chatState) {
        throw new Error("Invalid response format from server");
      }

      const assistantMessage: ChatMessage = data.message;
      const newChatState: ChatState = data.chatState;

      // Ensure restaurants is always an array and never reuse old cards
      const processedMessage: ChatMessage = {
        ...assistantMessage,
        restaurants: Array.isArray(assistantMessage.restaurants) && assistantMessage.restaurants.length > 0
          ? assistantMessage.restaurants
          : [],
      };

      console.log("[Discover] Processed message:", {
        id: processedMessage.id,
        role: processedMessage.role,
        contentLength: typeof processedMessage.content === "string" ? processedMessage.content.length : 0,
        hasRestaurants: Array.isArray(processedMessage.restaurants) && processedMessage.restaurants.length > 0,
        restaurantCount: Array.isArray(processedMessage.restaurants) ? processedMessage.restaurants.length : 0,
      });

      // Update state
      setMessages((prev) => [...prev, processedMessage]);
      setChatState(prev => ({
        ...prev,
        ...newChatState,
        preferred_language: prev.preferred_language ?? newChatState?.preferred_language ?? null,
      }));
    } catch (error) {
      console.error("[Discover] Error:", error);
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        kind: "answer",
        content:
          error instanceof Error
            ? `Error: ${error.message}. Please check your environment variables (Supabase and OpenAI keys) in .env.local`
            : "I'm having trouble processing that request. Could you try again?",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestaurantClick = (restaurant: RestaurantCard) => {
    // Switch to restaurant mode
    const newChatState: ChatState = {
      mode: "restaurant",
      currentRestaurantId: restaurant.id,
      currentRestaurantName: restaurant.name,
      restaurant_focus_id: restaurant.id, // Enable focus pill
    };
    setChatState(newChatState);

    // Add system message
    const systemMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "answer",
      content: `Okay, I'll focus on ${restaurant.name} now. Ask me anything about their menu.`,
    };
    setMessages((prev) => [...prev, systemMessage]);
  };

  const handleBackToDiscovery = () => {
    // Switch back to discovery mode
    const newChatState: ChatState = {
      mode: "discovery",
      currentRestaurantId: null,
      currentRestaurantName: null,
      restaurant_focus_id: undefined, // Clear focus pill
    };
    setChatState(newChatState);

    // Add system message
    const systemMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      kind: "answer",
      content:
        "Back to searching all restaurants. What would you like to find?",
    };
    setMessages((prev) => [...prev, systemMessage]);
  };

  // In-place Load More: patches existing restaurant card instead of creating new message
  const handleLoadMore = async (messageId: string, restaurantId: string, offset: number) => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/discover/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [], // Not needed for UI action
          ui_action: "LOAD_MORE_RESTAURANT",
          targetRestaurantId: restaurantId,
          offset,
          chatState,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to load more: ${response.status}`);
      }

      const data = await response.json();

      if (data.type === "patch") {
        // Update the existing message's restaurant card in-place
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== messageId) return msg;
            return {
              ...msg,
              restaurants: msg.restaurants?.map((r) => {
                if (r.id !== restaurantId) return r;
                // Merge new dishes (dedupe by id)
                const existingIds = new Set(r.matches?.map((m) => m.id) || []);
                const newDishes = (data.appendDishes || []).filter(
                  (d: { id: string }) => !existingIds.has(d.id)
                );
                return {
                  ...r,
                  matches: [...(r.matches || []), ...newDishes],
                  pagination: data.pagination,
                };
              }),
            };
          })
        );

        // Update chatState.last_results with new dishes for follow-up grounding
        if (data.updatedLastResults) {
          setChatState((prev) => ({
            ...prev,
            last_results: [...(prev.last_results || []), ...data.updatedLastResults],
          }));
        }
      }
    } catch (error) {
      console.error("[Discover] Load More error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMenuAskQuestion = async (question: string) => {
    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      kind: "answer",
      content: question,
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      // Prepare messages for API (only user and assistant, no system)
      // CRITICAL: Preserve kind, restaurants, and other metadata for server-side state logic
      const apiMessages = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.content,
          kind: m.kind,
          restaurants: m.restaurants,
          menu: m.menu,
          menuUrl: m.menuUrl,
        }));

      apiMessages.push({
        role: "user",
        content: question,
        kind: "answer",
        restaurants: undefined,
        menu: undefined,
        menuUrl: undefined,
      });

      const response = await fetch("/api/discover/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: apiMessages,
          chatState, // Pass current chatState (should be restaurant mode)
        }),
      });

      if (!response.ok) {
        let errorText = "Failed to get response";
        try {
          const errorData = await response.json();
          errorText = errorData.error || errorData.message || errorText;
        } catch {
          errorText = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorText);
      }

      const data = await response.json();

      if (!data.message || !data.chatState) {
        throw new Error("Invalid response format from server");
      }

      const assistantMessage: ChatMessage = data.message;
      const newChatState: ChatState = data.chatState;

      setMessages((prev) => [...prev, assistantMessage]);
      setChatState(newChatState);
    } catch (error) {
      console.error("[Discover] Error:", error);
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        kind: "answer",
        content:
          error instanceof Error
            ? `Error: ${error.message}. Please check your environment variables (Supabase and OpenAI keys) in .env.local`
            : "I'm having trouble processing that request. Could you try again?",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50">
      {/* Premium Header with Glassmorphism */}
      <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-xl border-b border-white/50 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
            🍽️ Food Discovery
          </h1>

        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 pb-28">
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.map((message) => (
            <div key={message.id} className="space-y-4">
              <div
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"
                  }`}
              >
                <div
                  className={`max-w-[85%] ${message.role === "user"
                    ? "bg-gradient-to-br from-indigo-500 to-purple-600 text-white rounded-2xl rounded-br-md px-5 py-3 shadow-lg shadow-indigo-500/20"
                    : "bg-white/80 backdrop-blur-sm rounded-2xl rounded-bl-md px-5 py-3 shadow-lg shadow-slate-200/50 border border-white/50"
                    }`}
                >
                  <div
                    className={`text-sm whitespace-pre-wrap leading-relaxed ${message.role === "user" ? "text-white" : "text-slate-700"
                      }`}
                  >
                    {message.content}
                  </div>
                </div>
              </div>

              {/* Inline Menu Card (rendered full-width outside assistant bubble) */}
              {message.role === "assistant" && message.menu && (
                <div className="w-full">
                  <InlineMenuCard
                    menu={message.menu}
                    menuUrl={message.menuUrl || null}
                    onAskQuestion={handleMenuAskQuestion}
                    isLoading={isLoading}
                  />
                </div>
              )}

              {/* Premium Restaurant cards with floating design */}
              {message.role === "assistant" &&
                message.restaurants &&
                Array.isArray(message.restaurants) &&
                message.restaurants.length > 0 && (() => {
                  // Check if this is a restaurant_profile response using MESSAGE KIND
                  const isRestaurantProfile = message.kind === "restaurant_profile";
                  const statusText = isRestaurantProfile && message.content ? message.content : undefined;

                  // For restaurant_profile mode, render RestaurantProfileCard
                  if (isRestaurantProfile && message.restaurants.length === 1) {
                    const restaurant = message.restaurants[0];
                    const fullMenu = expandedMenus[restaurant.id] || null;
                    const isLoadingMenu = loadingMenuId === restaurant.id;

                    return (
                      <div className="mt-4">
                        <RestaurantProfileCard
                          restaurant={restaurant}
                          statusText={statusText}
                          fullMenu={fullMenu}
                          isLoadingMenu={isLoadingMenu}
                          onViewFullMenu={() => fetchMenuForRestaurant(restaurant.id)}
                          onBackToDiscovery={() => collapseMenu(restaurant.id)}
                        />
                      </div>
                    );
                  }

                  // Default: render regular restaurant cards
                  return (
                    <div className="mt-4 space-y-4">
                      {message.restaurants.map((restaurant) => {
                        // Per-restaurant expansion: expanded if single restaurant OR this restaurant has loaded more dishes
                        const isSingleRestaurant = message.restaurants!.length === 1;
                        const hasLoadedMore = (restaurant.matches?.length ?? 0) > 3 && restaurant.pagination !== undefined;
                        const isExpanded = isSingleRestaurant || hasLoadedMore;

                        // Cards are clickable unless it's the ONLY restaurant (already focused on it)
                        const isClickable = !isSingleRestaurant;

                        return (
                          <div
                            key={restaurant.id}
                            className={`group relative bg-white/80 backdrop-blur-sm rounded-2xl p-5 
                                     border border-white/50 shadow-lg shadow-slate-200/50
                                     ${isClickable ? 'cursor-pointer hover:shadow-xl hover:shadow-indigo-200/40 hover:border-indigo-200/50 hover:-translate-y-1' : ''}
                                     transition-all duration-300 ease-out`}
                            onClick={() => isClickable && handleRestaurantClick(restaurant)}
                          >
                            {/* Subtle gradient overlay on hover */}
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-50/0 to-purple-50/0 group-hover:from-indigo-50/50 group-hover:to-purple-50/30 rounded-2xl transition-all duration-300" />

                            <div className="relative flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h3 className="font-semibold text-lg text-slate-800 group-hover:text-indigo-700 transition-colors">
                                    {restaurant.name}
                                  </h3>
                                  {/* Claimed / Not claimed badge */}
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
                                <div className="text-sm text-slate-500 mt-1 flex items-center gap-2">
                                  {restaurant.city && (
                                    <span className="flex items-center gap-1">
                                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                      {restaurant.city}
                                    </span>
                                  )}
                                  {restaurant.cuisine_type && (
                                    <span className="text-slate-400">
                                      {restaurant.city ? "•" : ""} {restaurant.cuisine_type}
                                    </span>
                                  )}
                                  {/* Show pagination info in expanded mode */}
                                  {isExpanded && restaurant.pagination && (
                                    <span className="text-indigo-500 font-medium">
                                      • Showing {restaurant.pagination.shown} of {restaurant.pagination.total}
                                    </span>
                                  )}
                                </div>

                                {/* Service icons - compact row */}
                                <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                                  {restaurant.accepts_dine_in && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded-full" title="Dine-in available">
                                      🍽️ Dine-in
                                    </span>
                                  )}
                                  {restaurant.accepts_takeaway && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-orange-50 text-orange-700 rounded-full" title="Takeaway available">
                                      📦 Takeaway
                                    </span>
                                  )}
                                  {restaurant.accepts_delivery && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 rounded-full" title="Delivery available">
                                      🚗 Delivery
                                    </span>
                                  )}
                                  {restaurant.accepts_reservations && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-50 text-purple-700 rounded-full" title="Reservations available">
                                      📅 Reservations
                                    </span>
                                  )}
                                  {restaurant.amenities?.kid_friendly && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-pink-50 text-pink-700 rounded-full" title="Child-friendly">
                                      👶 Child-friendly
                                    </span>
                                  )}
                                  {restaurant.amenities?.wheelchair_accessible && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-teal-50 text-teal-700 rounded-full" title="Wheelchair accessible">
                                      ♿ Accessible
                                    </span>
                                  )}
                                  {restaurant.amenities?.outdoor_seating && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-lime-50 text-lime-700 rounded-full" title="Outdoor seating">
                                      🌿 Outdoor
                                    </span>
                                  )}
                                  {restaurant.amenities?.has_wifi && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-cyan-50 text-cyan-700 rounded-full" title="WiFi available">
                                      📶 WiFi
                                    </span>
                                  )}
                                </div>

                                {/* Contact info - show in expanded mode */}
                                {isExpanded && (restaurant.phone || restaurant.website) && (
                                  <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-600">
                                    {restaurant.phone && (
                                      <a href={`tel:${restaurant.phone}`} className="inline-flex items-center gap-1 hover:text-indigo-600 transition-colors">
                                        📞 {restaurant.phone}
                                      </a>
                                    )}
                                    {restaurant.website && (
                                      <a href={restaurant.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-indigo-600 transition-colors">
                                        🌐 Website
                                      </a>
                                    )}
                                  </div>
                                )}

                                {/* Claim button - only for unclaimed restaurants */}
                                {!restaurant.ownerId && (
                                  <div className="mt-3">
                                    <Link
                                      href={`/claim/request?restaurant_id=${restaurant.id}`}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="text-xs border-amber-300 text-amber-700 hover:bg-amber-50 hover:border-amber-400"
                                      >
                                        Own this restaurant? Claim it
                                      </Button>
                                    </Link>
                                  </div>
                                )}

                                {restaurant.matches && restaurant.matches.length > 0 && (() => {
                                  const visibleDishes = isExpanded ? restaurant.matches : restaurant.matches.slice(0, 3);
                                  const hasAllergens = visibleDishes.some(m => m.tags?.some(t => t.type === "allergen"));

                                  return (
                                    <div className={`mt-4 space-y-3 ${isExpanded ? 'max-h-[500px] overflow-y-auto pr-2' : ''}`}>
                                      {/* Allergen disclaimer - once per container */}
                                      <AllergenDisclaimer visible={hasAllergens} />

                                      {/* Dish rows */}
                                      {visibleDishes.map((m) => (
                                        <DishRow key={m.id} dish={m} variant="full" showSectionName />
                                      ))}

                                      {/* Load More button for expanded mode with pagination */}
                                      {isExpanded && restaurant.pagination?.next_offset !== undefined && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleLoadMore(
                                              message.id,
                                              restaurant.id,
                                              restaurant.pagination!.next_offset!
                                            );
                                          }}
                                          disabled={isLoading}
                                          className="w-full text-center py-3 px-4 mt-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 
                                                 hover:from-indigo-600 hover:to-purple-700 text-white text-sm font-medium 
                                                 transition-all duration-300 shadow-lg shadow-indigo-500/25 hover:shadow-xl
                                                 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                          {isLoading ? "Loading..." : `Load More (${restaurant.pagination.total - restaurant.pagination.shown} remaining)`}
                                        </button>
                                      )}

                                      {/* Show more dishes indicator for Discovery mode */}
                                      {!isExpanded && (restaurant.more_dishes_count ?? 0) > 0 && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            // In Discovery mode, we show 3 dishes initially, so offset starts at 3
                                            handleLoadMore(
                                              message.id,
                                              restaurant.id,
                                              3 // Start from dish 4 (0-indexed offset 3)
                                            );
                                          }}
                                          disabled={isLoading}
                                          className="w-full text-center py-2 px-3 mt-2 rounded-lg bg-indigo-50/50 hover:bg-indigo-100 
                                                 text-indigo-600 text-sm font-medium transition-colors border border-indigo-100/50
                                                 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                          {isLoading ? "Loading..." : `+${restaurant.more_dishes_count} more dishes • Show all`}
                                        </button>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>

                              {/* Arrow indicator - only in Discovery mode */}
                              {!isExpanded && (
                                <div className="ml-4 p-2 rounded-full bg-slate-100 group-hover:bg-indigo-100 transition-colors">
                                  <svg className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                  </svg>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                })()}

              {/* Follow-up Chips */}
              {message.role === "assistant" && message.followupChips && message.followupChips.length > 0 && (() => {
                // Safety Filter: STRICTLY only show chips for restaurant_profile
                // And for restaurant_profile, ONLY show the focus chip
                const chipsToShow = message.kind === "restaurant_profile"
                  ? message.followupChips.filter(c => c === "Ask about this restaurant")
                  : [];

                if (chipsToShow.length === 0) return null;

                return (
                  <div className="flex flex-wrap gap-2 mt-3 ml-1">
                    {chipsToShow.map((chip, i) => (
                      <button
                        key={i}
                        onClick={() => handleMenuAskQuestion(chip)}
                        disabled={isLoading}
                        className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium 
                             bg-white border border-indigo-100 text-indigo-600 shadow-sm
                             hover:bg-indigo-50 hover:border-indigo-200 hover:shadow-md hover:-translate-y-0.5
                             active:scale-95 transition-all duration-200
                             disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl px-5 py-3 shadow-lg border border-white/50">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                  <span className="text-sm text-slate-500">Thinking...</span>
                </div>
              </div>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Floating Input Bar - Full Width with Glassmorphism */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/70 backdrop-blur-xl border-t border-white/50 shadow-2xl shadow-slate-300/50">
        <div className="max-w-4xl mx-auto px-4">
          {/* Restaurant Mode Indicator Bar */}
          {chatState.mode === "restaurant" && chatState.currentRestaurantName && (
            <div className="flex items-center justify-between py-2 border-b border-slate-200/50">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold 
                               bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm">
                  FOCUSED
                </span>
                <span className="text-sm font-medium text-slate-700">
                  {chatState.currentRestaurantName}
                </span>
              </div>
              <button
                onClick={handleBackToDiscovery}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 
                         hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back to Discovery
              </button>
            </div>
          )}

          {/* Chat Input Form */}
          <div className="py-4">
            <form onSubmit={handleSubmit} className="flex gap-3">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  chatState.mode === "restaurant"
                    ? `Ask about ${chatState.currentRestaurantName}...`
                    : "🔍 Search for food and restaurants..."
                }
                disabled={isLoading}
                className="flex-1 h-12 bg-white/80 backdrop-blur-sm border-slate-200 focus:border-indigo-300 focus:ring-indigo-200 rounded-xl shadow-sm text-base px-4"
              />
              <Button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="h-12 px-6 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded-xl shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:shadow-xl hover:shadow-indigo-500/30"
              >
                {isLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}


