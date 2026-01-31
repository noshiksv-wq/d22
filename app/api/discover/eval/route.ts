import { NextRequest, NextResponse } from "next/server";
import { searchRestaurantsAndDishes } from "@/app/actions/discover";
import { parseUserIntent } from "@/lib/intent-parser";

/**
 * Evaluation endpoint for testing search functionality
 * Tests 10 hero queries and returns metrics
 */
export async function GET(_request: NextRequest) {
  const heroQueries = [
    "butter naan",
    "vegan pizza in Stockholm",
    "halal chicken",
    "gluten-free pasta",
    "anything",
    "butter naan in göteborg?",
    "vegan options",
    "indian food",
    "pizza",
    "hungry",
  ];

  const results = [];
  let totalResponseTime = 0;
  let totalNoResults = 0;

  for (const query of heroQueries) {
    const startTime = Date.now();
    
    try {
      // Parse intent
      const intent = await parseUserIntent(query);
      
      // Search
      const restaurantCards = await searchRestaurantsAndDishes(intent);
      
      const responseTime = Date.now() - startTime;
      totalResponseTime += responseTime;
      
      if (restaurantCards.length === 0) {
        totalNoResults++;
      }

      results.push({
        query,
        intent: {
          dish_query: intent.dish_query,
          city: intent.city,
          dietary: intent.dietary,
          is_vague: intent.is_vague,
        },
        resultsCount: restaurantCards.length,
        responseTimeMs: responseTime,
        success: true,
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      totalResponseTime += responseTime;
      totalNoResults++;

      results.push({
        query,
        intent: null,
        resultsCount: 0,
        responseTimeMs: responseTime,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const metrics = {
    totalQueries: heroQueries.length,
    noResultsRate: (totalNoResults / heroQueries.length) * 100,
    avgResultsCount: results.reduce((sum, r) => sum + r.resultsCount, 0) / results.length,
    avgResponseTimeMs: totalResponseTime / results.length,
    results: results,
  };

  return NextResponse.json(metrics);
}

