"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Loader2, CheckCircle2, AlertCircle, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface RestaurantInfo {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
}

export default function ClaimRequestPage() {
  const searchParams = useSearchParams();
  const restaurantId = searchParams.get("restaurant_id");

  const [restaurant, setRestaurant] = useState<RestaurantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [alreadySent, setAlreadySent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  // Fetch restaurant info on mount
  useEffect(() => {
    if (!restaurantId) {
      setError("No restaurant ID provided");
      setLoading(false);
      return;
    }

    const fetchRestaurant = async () => {
      try {
        const response = await fetch(`/api/restaurant/${restaurantId}`);
        if (!response.ok) {
          throw new Error("Restaurant not found");
        }
        const data = await response.json();
        setRestaurant(data);
      } catch (err) {
        setError("Could not load restaurant information");
      } finally {
        setLoading(false);
      }
    };

    fetchRestaurant();
  }, [restaurantId]);

  // Check localStorage for previous submission
  useEffect(() => {
    if (restaurantId && email) {
      const key = `claim_sent:${restaurantId}:${email.toLowerCase()}`;
      if (localStorage.getItem(key)) {
        setAlreadySent(true);
      }
    }
  }, [restaurantId, email]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!restaurantId || !name.trim() || !email.trim()) {
      setError("Please fill in all required fields");
      return;
    }

    // Check again before submit
    const key = `claim_sent:${restaurantId}:${email.toLowerCase()}`;
    if (localStorage.getItem(key)) {
      setAlreadySent(true);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/claim/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurant_id: restaurantId,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim() || null,
          message: message.trim() || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || "Failed to submit request");
      }

      // Success - mark as sent in localStorage
      localStorage.setItem(key, "true");
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error && !restaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50 p-4">
        <Card className="max-w-md w-full p-6 text-center">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-slate-800 mb-2">Error</h1>
          <p className="text-slate-600 mb-4">{error}</p>
          <Link href="/discover">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Discovery
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50 p-4">
        <Card className="max-w-md w-full p-6 text-center">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-slate-800 mb-2">Request Sent!</h1>
          <p className="text-slate-600 mb-4">
            Thank you for claiming <strong>{restaurant?.name}</strong>. We&apos;ll review your request and get back to you at <strong>{email}</strong>.
          </p>
          <Link href="/discover">
            <Button className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Discovery
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="mb-6">
          <Link href="/discover" className="inline-flex items-center text-indigo-600 hover:text-indigo-700 text-sm font-medium mb-4">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Discovery
          </Link>
          <h1 className="text-2xl font-bold text-slate-800">Claim Your Restaurant</h1>
          <p className="text-slate-600 mt-1">
            Verify ownership to manage your restaurant&apos;s listing
          </p>
        </div>

        {/* Restaurant Info */}
        {restaurant && (
          <Card className="p-4 mb-6 bg-white/80 backdrop-blur-sm border-slate-200">
            <h2 className="font-semibold text-lg text-slate-800">{restaurant.name}</h2>
            {(restaurant.address || restaurant.city) && (
              <p className="text-sm text-slate-600 mt-1">
                {restaurant.address}
                {restaurant.address && restaurant.city && ", "}
                {restaurant.city}
              </p>
            )}
          </Card>
        )}

        {/* Already Sent Warning */}
        {alreadySent && (
          <Card className="p-4 mb-6 bg-amber-50 border-amber-200">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-800">Request Already Sent</p>
                <p className="text-sm text-amber-700 mt-1">
                  You have already submitted a claim request for this restaurant with this email address.
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Claim Form */}
        <Card className="p-6 bg-white/90 backdrop-blur-sm border-slate-200 shadow-lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1">
                Your Name <span className="text-red-500">*</span>
              </label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Doe"
                required
                disabled={alreadySent || submitting}
                className="w-full"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                Email Address <span className="text-red-500">*</span>
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setAlreadySent(false); // Reset on email change
                }}
                placeholder="you@restaurant.com"
                required
                disabled={alreadySent || submitting}
                className="w-full"
              />
            </div>

            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-slate-700 mb-1">
                Phone Number <span className="text-slate-400">(optional)</span>
              </label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+46 70 123 4567"
                disabled={alreadySent || submitting}
                className="w-full"
              />
            </div>

            <div>
              <label htmlFor="message" className="block text-sm font-medium text-slate-700 mb-1">
                Message <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us about your role at the restaurant..."
                disabled={alreadySent || submitting}
                rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={alreadySent || submitting || !name.trim() || !email.trim()}
              className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : alreadySent ? (
                "Request Already Sent"
              ) : (
                "Submit Claim Request"
              )}
            </Button>
          </form>
        </Card>

        <p className="text-xs text-slate-500 text-center mt-4">
          By submitting, you confirm that you are authorized to manage this restaurant.
        </p>
      </div>
    </div>
  );
}
